package controller

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/ratio_setting"

	"github.com/gin-gonic/gin"
)

// Design workbench API (design doc §7.2). Session-authenticated browser
// surface for the AI design workbench, Phase 1: capability projection,
// project/step/asset management, and shared-barrier task submission. The
// browser never sees token secrets; submissions run through
// controller/design_submit.go, which reuses the public relay's durable task
// barrier.

const (
	designProjectDraft                = "draft"
	designProjectAwaitingConfirmation = "awaiting_confirmation"
	designProjectReady                = "ready"
	designProjectGenerating           = "generating"
	designProjectCompleted            = "completed"
	designProjectPartial              = "partial"

	designStepPending       = "pending"
	designStepSubmitted     = "submitted"
	designStepSucceeded     = "succeeded"
	designStepFailed        = "failed"
	designFailureSubmission = "submission_rejected"
	designFailureUpstream   = "upstream_failed"
)

// --- Wire types -------------------------------------------------------------

type designAssetView struct {
	model.DesignAsset
	URL string `json:"url"`
}

type designStepView struct {
	model.DesignStep
	Estimate *designPriceView  `json:"estimate,omitempty"`
	Assets   []designAssetView `json:"assets,omitempty"`
}

type designPriceView struct {
	ModelPrice   float64 `json:"model_price"`
	GroupRatio   float64 `json:"group_ratio"`
	QuotaPerCall int64   `json:"quota_per_call"`
}

type designProjectView struct {
	model.DesignProject
	Steps    []designStepView `json:"steps"`
	Estimate *designPriceView `json:"estimate,omitempty"`
}

// --- Capability endpoints ---------------------------------------------------

func sessionUserGroup(c *gin.Context) string {
	group := c.GetString("group")
	if group == "" {
		group = c.GetString("user_group")
	}
	return group
}

// GetDesignCapabilities lists the workbench capabilities visible to the
// session user (§5.1 summary interface).
func GetDesignCapabilities(c *gin.Context) {
	common.ApiSuccess(c, service.DesignCapabilitiesForUser(sessionUserGroup(c)))
}

// GetDesignCapabilitySchema serves the full parameter schema of one capability
// on demand (§5.1 detail interface, deferSchema).
func GetDesignCapabilitySchema(c *gin.Context) {
	capabilityID := strings.TrimSpace(c.Param("id"))
	for _, capability := range service.DesignCapabilitiesForUser(sessionUserGroup(c)) {
		if capability.ID != capabilityID {
			continue
		}
		schema, err := service.DesignCapabilitySchema(capabilityID, sessionUserGroup(c))
		if err != nil || schema == nil {
			common.ApiErrorMsg(c, "该能力未声明参数 schema")
			return
		}
		common.ApiSuccess(c, schema)
		return
	}
	c.JSON(http.StatusNotFound, gin.H{"success": false, "message": "capability not found"})
}

// --- Project CRUD -----------------------------------------------------------

type designProjectRequest struct {
	Name       string         `json:"name"`
	Kind       string         `json:"kind"`
	Brief      string         `json:"brief"`
	TokenID    int            `json:"token_id"`
	Role       string         `json:"role"`
	Capability string         `json:"capability_id"`
	Parameters map[string]any `json:"parameters"`
}

func (req *designProjectRequest) parametersJSON() (string, error) {
	if len(req.Parameters) == 0 {
		return "", nil
	}
	encoded, err := common.Marshal(req.Parameters)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// CreateDesignProject starts a draft workspace.
func CreateDesignProject(c *gin.Context) {
	userID := c.GetInt("id")
	var req designProjectRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiErrorMsg(c, "请求格式错误")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		common.ApiErrorMsg(c, "项目名称不能为空")
		return
	}
	if len(req.Name) > 191 {
		common.ApiErrorMsg(c, "项目名称过长")
		return
	}
	kind := req.Kind
	if kind != "image" && kind != "video" {
		common.ApiErrorMsg(c, "交付形态仅支持 image 或 video")
		return
	}
	parameters, err := req.parametersJSON()
	if err != nil {
		common.ApiErrorMsg(c, "参数格式错误")
		return
	}
	project := &model.DesignProject{
		UserID:            userID,
		Name:              req.Name,
		Kind:              kind,
		Status:            designProjectDraft,
		Brief:             req.Brief,
		Role:              strings.TrimSpace(req.Role),
		DefaultCapability: strings.TrimSpace(req.Capability),
		TokenID:           req.TokenID,
		Parameters:        parameters,
	}
	if err := model.InsertDesignProject(project); err != nil {
		common.ApiErrorMsg(c, "创建项目失败")
		return
	}
	common.ApiSuccess(c, project)
}

// ListDesignProjects returns the user's workspaces.
func ListDesignProjects(c *gin.Context) {
	userID := c.GetInt("id")
	page, _ := strconv.Atoi(c.DefaultQuery("p", "1"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))
	projects, total, err := model.ListDesignProjects(userID, (page-1)*size, size)
	if err != nil {
		common.ApiErrorMsg(c, "查询项目失败")
		return
	}
	common.ApiSuccess(c, gin.H{"items": projects, "total": total, "page": page, "size": size})
}

// GetDesignProject returns one workspace with synced steps and assets.
func GetDesignProject(c *gin.Context) {
	project, ok := loadOwnDesignProject(c)
	if !ok {
		return
	}
	view := buildDesignProjectView(c, project)
	common.ApiSuccess(c, view)
}

// UpdateDesignProject edits the draft spec. Any scope/spec/model change after
// a plan invalidates the confirmation (§4.3): the revision is bumped and the
// project returns to draft for a fresh plan + confirm.
func UpdateDesignProject(c *gin.Context) {
	project, ok := loadOwnDesignProject(c)
	if !ok {
		return
	}
	var req designProjectRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiErrorMsg(c, "请求格式错误")
		return
	}
	switch project.Status {
	case designProjectGenerating:
		common.ApiErrorMsg(c, "项目正在生成中，暂不可修改")
		return
	case designProjectCompleted, designProjectPartial:
		common.ApiErrorMsg(c, "项目已交付，暂不可修改")
		return
	}

	parameters, err := req.parametersJSON()
	if err != nil {
		common.ApiErrorMsg(c, "参数格式错误")
		return
	}
	specChanged := false
	if req.Name != "" {
		project.Name = strings.TrimSpace(req.Name)
	}
	if (req.Kind == "image" || req.Kind == "video") && req.Kind != project.Kind {
		project.Kind = req.Kind
		specChanged = true
	}
	if req.Brief != "" {
		project.Brief = req.Brief
		specChanged = true
	}
	if req.TokenID != 0 && req.TokenID != project.TokenID {
		project.TokenID = req.TokenID
		specChanged = true
	}
	if req.Capability != "" && req.Capability != project.DefaultCapability {
		project.DefaultCapability = strings.TrimSpace(req.Capability)
		specChanged = true
	}
	if req.Role != "" {
		project.Role = strings.TrimSpace(req.Role)
		specChanged = true
	}
	if req.Parameters != nil {
		project.Parameters = parameters
		specChanged = true
	}
	if specChanged && project.Status == designProjectReady {
		// A confirmed plan is stale now.
		project.PlanRevision++
		project.Status = designProjectDraft
	}
	if err := model.SaveDesignProject(project); err != nil {
		common.ApiErrorMsg(c, "保存项目失败")
		return
	}
	common.ApiSuccess(c, project)
}

// DeleteDesignProject removes the workspace rows. Persisted artifact objects
// stay in the store until the retention job reclaims them (§8.3), so nothing
// referenced by an in-flight task is destroyed eagerly.
func DeleteDesignProject(c *gin.Context) {
	project, ok := loadOwnDesignProject(c)
	if !ok {
		return
	}
	if project.Status == designProjectGenerating {
		common.ApiErrorMsg(c, "项目正在生成中，暂不可删除")
		return
	}
	if err := model.DeleteDesignProject(project); err != nil {
		common.ApiErrorMsg(c, "删除项目失败")
		return
	}
	common.ApiSuccess(c, gin.H{"deleted": true})
}

// --- Workflow: plan / confirm / run / retry ---------------------------------

// PlanDesignProject freezes the draft into a single semantic step with a
// costed confirmation sheet (§4.3). Re-planning always bumps PlanRevision so
// a stale confirm can never submit.
func PlanDesignProject(c *gin.Context) {
	project, ok := loadOwnDesignProject(c)
	if !ok {
		return
	}
	if project.Status != designProjectDraft && project.Status != designProjectAwaitingConfirmation {
		common.ApiErrorMsg(c, "当前状态不可生成计划，请先修改草稿")
		return
	}
	userID := c.GetInt("id")
	userGroup := sessionUserGroup(c)

	capability, err := resolveDesignCapability(project.DefaultCapability, userGroup)
	if err != nil {
		common.ApiErrorMsg(c, err.Error())
		return
	}
	if project.TokenID == 0 {
		common.ApiErrorMsg(c, "请先选择用于计费的令牌")
		return
	}
	token, err := loadOwnDesignToken(userID, project.TokenID)
	if err != nil {
		common.ApiErrorMsg(c, err.Error())
		return
	}
	parameters := map[string]any{}
	if project.Parameters != "" {
		if err := common.Unmarshal([]byte(project.Parameters), &parameters); err != nil {
			common.ApiErrorMsg(c, "草稿参数格式错误，请重新编辑")
			return
		}
	}
	schema, err := service.DesignCapabilitySchema(capability.ID, userGroup)
	if err != nil || schema == nil {
		common.ApiErrorMsg(c, "该能力未声明参数 schema，无法生成计划")
		return
	}
	parameters = pluginruntime.ApplyWorkbenchDefaults(schema, parameters)
	if err := pluginruntime.EvaluateWorkbenchParams(schema, parameters); err != nil {
		common.ApiErrorMsg(c, "参数校验未通过："+err.Error())
		return
	}
	frozenParametersJSON := ""
	if len(parameters) > 0 {
		encoded, marshalErr := common.Marshal(parameters)
		if marshalErr != nil {
			common.ApiErrorMsg(c, "参数格式错误")
			return
		}
		frozenParametersJSON = string(encoded)
	}

	role := project.Role
	if role == "" {
		role = "主视觉"
	}
	operation := designStepOperation(capability.MediaType, capability.Operations)
	if operation == "" {
		common.ApiErrorMsg(c, "该能力不支持首期操作")
		return
	}

	if capability.MediaType == "image" || capability.MediaType == "video" {
		project.Kind = capability.MediaType
	}
	project.Parameters = frozenParametersJSON
	project.PlanRevision++
	project.Status = designProjectAwaitingConfirmation
	step := &model.DesignStep{
		ProjectID:       project.ID,
		Role:            role,
		Operation:       fmt.Sprintf("%s.%s", capability.MediaType, operation),
		CapabilityID:    capability.ID,
		Model:           capability.Model,
		Parameters:      frozenParametersJSON,
		PlanRevision:    project.PlanRevision,
		ConfirmRevision: 0,
		Attempt:         0,
		Status:          designStepPending,
	}
	err = model.ReplaceDesignSteps(project, []*model.DesignStep{step})
	if err != nil {
		common.ApiErrorMsg(c, "保存计划失败")
		return
	}
	if err := model.SaveDesignProject(project); err != nil {
		common.ApiErrorMsg(c, "保存项目失败")
		return
	}
	_ = token
	view := buildDesignProjectView(c, project)
	common.ApiSuccess(c, view)
}

// ConfirmDesignProject records the user's approval of the current plan batch.
func ConfirmDesignProject(c *gin.Context) {
	project, ok := loadOwnDesignProject(c)
	if !ok {
		return
	}
	if project.Status != designProjectAwaitingConfirmation {
		common.ApiErrorMsg(c, "项目不在待确认状态")
		return
	}
	steps, err := model.GetDesignSteps(project.ID)
	if err != nil || len(steps) == 0 {
		common.ApiErrorMsg(c, "项目没有可确认的步骤，请先生成计划")
		return
	}
	project.Status = designProjectReady
	if err := model.SaveDesignProject(project); err != nil {
		common.ApiErrorMsg(c, "确认失败")
		return
	}
	for i := range steps {
		steps[i].ConfirmRevision = project.PlanRevision
		if err := model.SaveDesignStep(&steps[i]); err != nil {
			common.ApiErrorMsg(c, "确认失败")
			return
		}
	}
	common.ApiSuccess(c, buildDesignProjectView(c, project))
}

// RunDesignProject submits every confirmed pending step through the shared
// task barrier. Submission errors never strand billing: the barrier refunds
// before a durable task row exists.
func RunDesignProject(c *gin.Context) {
	project, ok := loadOwnDesignProject(c)
	if !ok {
		return
	}
	if project.Status != designProjectReady {
		common.ApiErrorMsg(c, "项目未处于可运行状态（需先确认计划）")
		return
	}
	userID := c.GetInt("id")
	userRole := c.GetInt("role")
	token, err := loadOwnDesignToken(userID, project.TokenID)
	if err != nil {
		common.ApiErrorMsg(c, err.Error())
		return
	}

	steps, err := model.GetDesignSteps(project.ID)
	if err != nil || len(steps) == 0 {
		common.ApiErrorMsg(c, "项目没有可运行的步骤，请先生成计划")
		return
	}

	// §4.6: a step that already carries a task id must never be resubmitted.
	submitErr := error(nil)
	submitted := false
	for i := range steps {
		step := &steps[i]
		if step.Status != designStepPending && step.Status != designStepFailed {
			continue
		}
		if step.TaskID != "" {
			continue
		}
		if step.ConfirmRevision != project.PlanRevision {
			common.ApiErrorMsg(c, "存在未按当前计划确认的步骤，请重新确认")
			return
		}
		if step.IdempotencyKey == "" {
			step.IdempotencyKey = designIdempotencyKey(project.ID, project.PlanRevision, step.ID, step.Attempt)
		}
		// Idempotent double-run: the same logical attempt must not pre-consume
		// or submit twice (§10). A crash between submission and step save
		// leaves the key behind; the recovery path re-enters here.
		if existing, _ := model.DesignStepByIdempotencyKey(userID, step.IdempotencyKey); existing != nil && existing.ID != step.ID {
			continue
		}
		step.Status = designStepSubmitted
		if err := model.SaveDesignStep(step); err != nil {
			common.ApiErrorMsg(c, "保存步骤状态失败")
			return
		}
		result, taskErr, bridgeErr := submitDesignStepTask(designStepSubmit{
			UserID:     userID,
			UserRole:   userRole,
			Token:      token,
			MediaType:  designMediaTypeFromStep(step.Operation, project.Kind),
			Operation:  designOperationFromStep(step.Operation),
			ModelName:  step.Model,
			Parameters: stepParametersMap(step.Parameters),
		})
		if bridgeErr != nil {
			step.Status = designStepFailed
			step.FailureClass = designFailureSubmission
			_ = model.SaveDesignStep(step)
			submitErr = bridgeErr
			break
		}
		if taskErr != nil {
			step.Status = designStepFailed
			step.FailureClass = designFailureSubmission
			if taskErr.StatusCode == http.StatusBadRequest {
				step.FailureClass = "parameter_rejected"
			}
			_ = model.SaveDesignStep(step)
			submitErr = errors.New(taskErr.Message)
			break
		}
		submitted = true
		step.TaskID = result.Outcome.Task.TaskID
		step.Status = designStepSubmitted
		if result.Outcome.Task.Status == model.TaskStatusSuccess {
			step.Status = designStepSucceeded
		} else if result.Outcome.Task.Status == model.TaskStatusFailure {
			step.Status = designStepFailed
			step.FailureClass = designFailureUpstream
		}
		if err := model.SaveDesignStep(step); err != nil {
			common.ApiErrorMsg(c, "保存步骤结果失败")
			return
		}
		if result.Outcome.Task.Status == model.TaskStatusSuccess {
			// Immediate-terminal tasks never revisit the poller, so trigger
			// artifact persistence + asset backfill after the step's TaskID is
			// durable in the DB.
			service.PersistArtifactsForTask(c.Request.Context(), result.Outcome.Task)
		}
	}
	if submitted && project.Status == designProjectReady {
		project.Status = designProjectGenerating
		_ = model.SaveDesignProject(project)
	}
	// The single-step project that failed before any durable task keeps the
	// workspace runnable (§4.6: user decides; never auto-retry).
	syncDesignProjectStatus(project)

	view := buildDesignProjectView(c, project)
	if submitErr != nil {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"message": common.MaskSensitiveInfo(submitErr.Error()),
			"data":    view,
		})
		return
	}
	common.ApiSuccess(c, view)
}

// RetryDesignStep re-arms a step that failed before a durable task existed.
// Per §4.6, a step with a task id is only ever queried, never resubmitted.
func RetryDesignStep(c *gin.Context) {
	project, ok := loadOwnDesignProject(c)
	if !ok {
		return
	}
	stepID, _ := strconv.ParseInt(c.Param("step_id"), 10, 64)
	step, err := model.GetDesignStepByID(project.ID, stepID)
	if err != nil {
		common.ApiErrorMsg(c, "步骤不存在")
		return
	}
	if step.TaskID != "" {
		common.ApiErrorMsg(c, "该步骤已有任务，只能查询原任务，不能重新提交")
		return
	}
	if step.Status != designStepFailed && step.Status != designStepPending {
		common.ApiErrorMsg(c, "当前步骤状态不可重试")
		return
	}
	step.Attempt++
	step.IdempotencyKey = designIdempotencyKey(project.ID, project.PlanRevision, step.ID, step.Attempt)
	step.Status = designStepPending
	step.FailureClass = ""
	if err := model.SaveDesignStep(step); err != nil {
		common.ApiErrorMsg(c, "重试失败")
		return
	}
	common.ApiSuccess(c, buildDesignProjectView(c, project))
}

// --- Shared helpers ---------------------------------------------------------

func loadOwnDesignProject(c *gin.Context) (*model.DesignProject, bool) {
	userID := c.GetInt("id")
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "message": "project not found"})
		return nil, false
	}
	project, err := model.GetDesignProjectByID(id, userID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "message": "project not found"})
		return nil, false
	}
	return project, true
}

// loadOwnDesignToken loads one of the session user's tokens for billing. The
// secret never leaves the server (§7.2).
func loadOwnDesignToken(userID, tokenID int) (*model.Token, error) {
	token, err := model.GetTokenByIds(tokenID, userID)
	if err != nil {
		return nil, errors.New("令牌不存在或不属于当前用户")
	}
	if token.Status != common.TokenStatusEnabled {
		return nil, errors.New("令牌已被禁用")
	}
	if token.ExpiredTime != -1 && token.ExpiredTime < time.Now().Unix() {
		return nil, errors.New("令牌已过期")
	}
	return token, nil
}

func resolveDesignCapability(capabilityID, userGroup string) (*service.DesignCapabilitySummary, error) {
	capabilityID = strings.TrimSpace(capabilityID)
	if capabilityID == "" {
		return nil, errors.New("项目未选择能力")
	}
	summaries := service.DesignCapabilitiesForUser(userGroup)
	for i := range summaries {
		if summaries[i].ID == capabilityID {
			return &summaries[i], nil
		}
	}
	return nil, errors.New("能力不可用或不存在")
}

func designStepOperation(mediaType string, operations []string) string {
	for _, operation := range operations {
		if designProtocolEndpoint(mediaType, operation) != "" {
			return operation
		}
	}
	return ""
}

func designMediaTypeFromStep(operation, fallbackKind string) string {
	if idx := strings.Index(operation, "."); idx > 0 {
		media := operation[:idx]
		if media == "image" || media == "video" {
			return media
		}
	}
	return fallbackKind
}

func designOperationFromStep(operation string) string {
	// step.Operation is "<mediaType>.<operation>"; the bridge needs the
	// trailing operation verb.
	if idx := strings.LastIndex(operation, "."); idx >= 0 {
		return operation[idx+1:]
	}
	return operation
}

func stepParametersMap(parametersJSON string) map[string]any {
	parameters := map[string]any{}
	if parametersJSON == "" {
		return parameters
	}
	_ = common.Unmarshal([]byte(parametersJSON), &parameters)
	return parameters
}

// designIdempotencyKey follows §4.6: sha256(project + plan_revision + step +
// attempt).
func designIdempotencyKey(projectID int64, planRevision int, stepID int64, attempt int) string {
	digest := sha256.Sum256([]byte(fmt.Sprintf("design:%d:%d:%d:%d", projectID, planRevision, stepID, attempt)))
	return hex.EncodeToString(digest[:16])
}

// syncDesignProjectStatus recomputes the workspace status from its steps.
// failed-without-task steps are retryable, so they keep the project runnable.
func syncDesignProjectStatus(project *model.DesignProject) {
	if project.Status == designProjectDraft || project.Status == designProjectAwaitingConfirmation {
		return
	}
	steps, err := model.GetDesignSteps(project.ID)
	if err != nil || len(steps) == 0 {
		return
	}
	anyRunning := false
	anyRetryable := false
	anySucceeded := false
	allTerminal := true
	for _, step := range steps {
		switch step.Status {
		case designStepSubmitted:
			anyRunning = true
			allTerminal = false
		case designStepPending:
			anyRetryable = true
			allTerminal = false
		case designStepSucceeded:
			anySucceeded = true
		case designStepFailed:
			if step.TaskID == "" {
				anyRetryable = true
				allTerminal = false
			}
		}
	}
	switch {
	case anyRunning:
		project.Status = designProjectGenerating
	case allTerminal:
		if anySucceeded {
			project.Status = designProjectCompleted
		} else {
			project.Status = designProjectPartial
		}
	case anyRetryable, project.Status == designProjectGenerating:
		project.Status = designProjectReady
	}
	_ = model.SaveDesignProject(project)
}

// buildDesignProjectView assembles the read-side view: steps synced from
// their tasks, assets resolved to signed content URLs, and the confirmation
// sheet's price estimate.
func buildDesignProjectView(c *gin.Context, project *model.DesignProject) designProjectView {
	userID := c.GetInt("id")
	syncDesignStepsFromTasks(c, userID, project)

	steps, _ := model.GetDesignSteps(project.ID)
	assets, _ := model.GetDesignAssets(project.ID)
	assetsByStep := make(map[int64][]designAssetView)
	for _, asset := range assets {
		contentURL, err := buildDesignAssetURL(asset.TaskID, asset.ArtifactKey)
		if err != nil {
			continue
		}
		assetsByStep[asset.StepID] = append(assetsByStep[asset.StepID], designAssetView{DesignAsset: asset, URL: contentURL})
	}

	capability, _ := resolveDesignCapability(project.DefaultCapability, sessionUserGroup(c))
	var estimate *designPriceView
	if capability != nil && capability.Price != nil {
		if ratio, ok := designTokenGroupRatio(userID, project.TokenID); ok {
			estimate = &designPriceView{
				ModelPrice:   capability.Price.ModelPrice,
				GroupRatio:   ratio,
				QuotaPerCall: int64(capability.Price.ModelPrice * common.QuotaPerUnit * ratio),
			}
		}
	}

	syncDesignProjectStatus(project)
	view := designProjectView{DesignProject: *project, Estimate: estimate}
	for _, step := range steps {
		stepView := designStepView{DesignStep: step, Assets: assetsByStep[step.ID]}
		if estimate != nil {
			stepView.Estimate = estimate
		}
		view.Steps = append(view.Steps, stepView)
	}
	return view
}

// syncDesignStepsFromTasks mirrors durable task state into steps and reruns
// the asset backfill for succeeded tasks (idempotent, ledger-driven).
func syncDesignStepsFromTasks(c *gin.Context, userID int, project *model.DesignProject) {
	steps, err := model.GetDesignSteps(project.ID)
	if err != nil {
		return
	}
	for i := range steps {
		step := &steps[i]
		if step.TaskID == "" ||
			step.Status == designStepFailed && step.FailureClass == designFailureUpstream {
			continue
		}
		if step.Status == designStepSucceeded {
			if task, found, err := model.GetByTaskId(userID, step.TaskID); err == nil && found && task != nil {
				service.PersistArtifactsForTask(c.Request.Context(), task)
			}
			continue
		}
		task, found, err := model.GetByTaskId(userID, step.TaskID)
		if err != nil || !found || task == nil {
			continue
		}
		switch task.Status {
		case model.TaskStatusSuccess:
			step.Status = designStepSucceeded
			step.FailureClass = ""
			service.PersistArtifactsForTask(c.Request.Context(), task)
		case model.TaskStatusFailure:
			step.Status = designStepFailed
			step.FailureClass = designFailureUpstream
		default:
			continue
		}
		_ = model.SaveDesignStep(step)
	}
}

// designTokenGroupRatio prices the confirmation sheet with the effective
// group of the token the project bills through (not just the user's default
// group).
func designTokenGroupRatio(userID, tokenID int) (float64, bool) {
	token, err := loadOwnDesignToken(userID, tokenID)
	if err != nil {
		return 0, false
	}
	group := token.Group
	if group == "" {
		userCache, err := model.GetUserCache(userID)
		if err != nil {
			return 0, false
		}
		group = userCache.Group
	}
	if special, ok := ratio_setting.GetGroupGroupRatio(group, group); ok {
		return special, true
	}
	return ratio_setting.GetGroupRatio(group), true
}

func buildDesignAssetURL(taskID, artifactKey string) (string, error) {
	if contentURL, err := service.BuildTaskArtifactContentURL(taskID, artifactKey); err == nil {
		return contentURL, nil
	}
	access, err := service.IssueTaskArtifactAccess(taskID, artifactKey)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf(
		"/v1/tasks/%s/artifacts/%s/content?%s=%s",
		url.PathEscape(taskID),
		url.PathEscape(artifactKey),
		service.TaskArtifactAccessQueryParameter,
		url.QueryEscape(access),
	), nil
}
