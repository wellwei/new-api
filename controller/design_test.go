package controller

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

const designControllerTestPlugin = `
export const meta = {
	apiVersion: 1,
	key: "design-ctrl-test",
	name: "Design Controller Test",
	version: "1.0.0",
	author: {name: "Test"},
	models: ["design-ctrl-image"],
	fetchMode: "per_task",
	workbench: {
		schemaVersion: 1,
		capabilities: [
			{
				id: "design-ctrl-test:image",
				model: "design-ctrl-image",
				mediaType: "image",
				operations: ["generate"],
				parameterSchema: {
					type: "object",
					required: ["prompt"],
					properties: {
						prompt: {type: "string", "x-append": "商业海报级光影"},
						size: {type: "string", default: "1536x1024"}
					}
				}
			}
		]
	}
};
export function buildSubmitRequest() { return {}; }
export function parseSubmitResponse() { return {}; }
export function parseTaskResult() { return {}; }
export function buildQueryRequest() { return {}; }
export function parseQueryResponse() { return {}; }
`

func setupDesignControllerTestEnv(t *testing.T) (int, int) {
	t.Helper()

	gin.SetMode(gin.TestMode)
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	common.RedisEnabled = false
	if common.CryptoSecret == "" {
		common.CryptoSecret = "0123456789abcdef0123456789abcdef"
	}

	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", strings.ReplaceAll(t.Name(), "/", "_"))
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	require.NoError(t, err)
	model.DB = db
	model.LOG_DB = db
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	require.NoError(t, db.AutoMigrate(
		&model.User{},
		&model.Token{},
		&model.Channel{},
		&model.Ability{},
		&model.Model{},
		&model.Vendor{},
		&model.Task{},
		&model.TaskArtifactObject{},
		&model.DesignProject{},
		&model.DesignStep{},
		&model.DesignAsset{},
		&model.DesignExternalObject{},
		&model.UserSession{},
	))

	_, err = pluginruntime.DefaultRegistry.Register(designControllerTestPlugin, pluginruntime.Options{})
	require.NoError(t, err)
	t.Cleanup(func() { pluginruntime.DefaultRegistry.Unregister("design-ctrl-test") })

	setting.DesignWorkbenchEnabled = true
	t.Cleanup(func() { setting.DesignWorkbenchEnabled = false })

	require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(`{"design-ctrl-image":0.05}`))
	t.Cleanup(func() {
		_ = ratio_setting.UpdateModelPriceByJSONString(`{}`)
		model.InvalidatePricingCache()
	})

	// Deliverable registration needs a real volume. Without one the route
	// answers "storage disabled" before the MIME gate ever runs, which lets a
	// type rejection pass for the wrong reason.
	t.Cleanup(service.RegisterExternalArtifactStore(service.NewFilesystemArtifactStore(
		system_setting.TaskArtifactStoreConfig{
			Mode:                     system_setting.TaskArtifactStoreModeFilesystem,
			FilesystemPath:           t.TempDir(),
			FilesystemMaxObjectBytes: 4 << 20,
		})))

	user := &model.User{
		Username: "designer",
		Status:   common.UserStatusEnabled,
		Role:     common.RoleCommonUser,
		Group:    "default",
		Quota:    1000000,
	}
	require.NoError(t, db.Create(user).Error)

	token := &model.Token{
		UserId:      user.Id,
		Name:        "design-key",
		Key:         "123456789012345678901234567890123456789012345678",
		Status:      common.TokenStatusEnabled,
		ExpiredTime: -1,
		Group:       "default",
	}
	require.NoError(t, db.Create(token).Error)

	channel := &model.Channel{Name: "design-ctrl-ch", Type: 1, Status: 1}
	require.NoError(t, db.Create(channel).Error)
	ability := &model.Ability{Group: "default", Model: "design-ctrl-image", ChannelId: channel.Id, Enabled: true}
	require.NoError(t, db.Create(ability).Error)
	model.InvalidatePricingCache()

	return user.Id, token.Id
}

func callDesignHandler(t *testing.T, handler gin.HandlerFunc, userID int, method, path string, params gin.Params, body any) (int, map[string]any) {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		require.NoError(t, json.NewEncoder(&buf).Encode(body))
	}
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(method, path, &buf)
	c.Request.Header.Set("Content-Type", "application/json")
	c.Set("id", userID)
	c.Set("role", common.RoleCommonUser)
	c.Set("group", "default")
	c.Params = params
	handler(c)

	var resp map[string]any
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
	return recorder.Code, resp
}

func TestDesignPlanMaterializesDefaultsAndInvalidatesOnSpecEdit(t *testing.T) {
	userID, tokenID := setupDesignControllerTestEnv(t)

	// 1. Create draft project with video kind initially, then switch to image capability
	_, createResp := callDesignHandler(t, CreateDesignProject, userID, http.MethodPost, "/api/design/projects", nil, map[string]any{
		"name":          "秋季新品海报",
		"kind":          "video",
		"role":          "主视觉海报",
		"capability_id": "design-ctrl-test:image",
		"token_id":      tokenID,
		"parameters": map[string]any{
			"prompt": "一杯热拿铁放在木桌上",
		},
	})
	require.Equal(t, true, createResp["success"])
	data := createResp["data"].(map[string]any)
	projectID := int64(data["id"].(float64))
	idParam := gin.Params{{Key: "id", Value: strconv.FormatInt(projectID, 10)}}

	// 2. Plan project: should materialize default size ("1536x1024") and x-append on prompt, and sync kind -> "image"
	_, planResp := callDesignHandler(t, PlanDesignProject, userID, http.MethodPost, "/api/design/projects/1/plan", idParam, nil)
	require.Equal(t, true, planResp["success"], "plan response: %v", planResp)
	planView := planResp["data"].(map[string]any)
	assert.Equal(t, "awaiting_confirmation", planView["status"])
	assert.Equal(t, "image", planView["kind"])
	assert.Equal(t, float64(1), planView["plan_revision"])

	steps := planView["steps"].([]any)
	require.Len(t, steps, 1)
	stepObj := steps[0].(map[string]any)
	var frozenParams map[string]any
	require.NoError(t, json.Unmarshal([]byte(stepObj["parameters"].(string)), &frozenParams))
	assert.Equal(t, "1536x1024", frozenParams["size"])
	assert.Equal(t, "一杯热拿铁放在木桌上 商业海报级光影", frozenParams["prompt"])

	// 3. Confirm project -> ready
	_, confirmResp := callDesignHandler(t, ConfirmDesignProject, userID, http.MethodPost, "/api/design/projects/1/confirm", idParam, nil)
	require.Equal(t, true, confirmResp["success"])
	confirmView := confirmResp["data"].(map[string]any)
	assert.Equal(t, "ready", confirmView["status"])

	// 4. Editing spec after confirmation resets status to draft and increments plan_revision
	_, updateResp := callDesignHandler(t, UpdateDesignProject, userID, http.MethodPatch, "/api/design/projects/1", idParam, map[string]any{
		"role": "电商详情首屏",
	})
	require.Equal(t, true, updateResp["success"])
	updated := updateResp["data"].(map[string]any)
	assert.Equal(t, "draft", updated["status"])
	assert.Equal(t, float64(2), updated["plan_revision"])
}

func TestDesignRetryDisciplineAndSucceededStepAssetBackfill(t *testing.T) {
	userID, tokenID := setupDesignControllerTestEnv(t)

	project := &model.DesignProject{
		UserID:            userID,
		Name:              "同步出图回填测试",
		Kind:              "image",
		Status:            designProjectGenerating,
		Role:              "品牌Logo",
		DefaultCapability: "design-ctrl-test:image",
		TokenID:           tokenID,
		PlanRevision:      1,
	}
	require.NoError(t, model.InsertDesignProject(project))

	// Step 1: already has task_id and status succeeded (simulating immediate-terminal image task)
	stepWithTask := &model.DesignStep{
		ProjectID:       project.ID,
		Role:            "品牌Logo",
		Operation:       "image.generate",
		CapabilityID:    "design-ctrl-test:image",
		Model:           "design-ctrl-image",
		PlanRevision:    1,
		ConfirmRevision: 1,
		TaskID:          "task_sync_image_1",
		Status:          designStepSucceeded,
	}
	require.NoError(t, model.InsertDesignStep(stepWithTask))

	// Create matching Task and TaskArtifactObject
	taskRow := &model.Task{
		TaskID:     "task_sync_image_1",
		UserId:     userID,
		Status:     model.TaskStatusSuccess,
		Quota:      25000,
		Properties: model.Properties{OriginModelName: "design-ctrl-image"},
	}
	require.NoError(t, model.DB.Create(taskRow).Error)
	artifactRow := &model.TaskArtifactObject{
		TaskID:       "task_sync_image_1",
		ArtifactKey:  "image-0",
		RelativePath: "2026/09/29/task_sync_image_1/image-0.png",
		MimeType:     "image/png",
		Size:         4096,
		Width:        1024,
		Height:       1024,
	}
	require.NoError(t, model.DB.Create(artifactRow).Error)

	// GET project must backfill design_assets even though step.Status is already "succeeded"
	idParam := gin.Params{{Key: "id", Value: strconv.FormatInt(project.ID, 10)}}
	_, getResp := callDesignHandler(t, GetDesignProject, userID, http.MethodGet, "/api/design/projects/1", idParam, nil)
	require.Equal(t, true, getResp["success"])
	view := getResp["data"].(map[string]any)
	assert.Equal(t, "completed", view["status"])
	steps := view["steps"].([]any)
	require.Len(t, steps, 1)
	assets := steps[0].(map[string]any)["assets"].([]any)
	require.Len(t, assets, 1)
	asset := assets[0].(map[string]any)
	assert.Equal(t, "image-0", asset["artifact_key"])
	assert.Contains(t, asset["url"].(string), "/v1/tasks/task_sync_image_1/artifacts/image-0/content")

	// Retry on a step that already has task_id MUST be rejected
	retryParams := gin.Params{
		{Key: "id", Value: strconv.FormatInt(project.ID, 10)},
		{Key: "step_id", Value: strconv.FormatInt(stepWithTask.ID, 10)},
	}
	_, retryWithTaskResp := callDesignHandler(t, RetryDesignStep, userID, http.MethodPost, "/api/design/projects/1/steps/1/retry", retryParams, nil)
	assert.Equal(t, false, retryWithTaskResp["success"])
	assert.Contains(t, retryWithTaskResp["message"].(string), "该步骤已有任务")

	// Step without task_id (submission_rejected) CAN be retried and increments attempt
	stepRejected := &model.DesignStep{
		ProjectID:       project.ID,
		Role:            "延展海报",
		Operation:       "image.generate",
		CapabilityID:    "design-ctrl-test:image",
		Model:           "design-ctrl-image",
		PlanRevision:    1,
		ConfirmRevision: 1,
		TaskID:          "",
		Status:          designStepFailed,
		FailureClass:    designFailureSubmission,
	}
	require.NoError(t, model.InsertDesignStep(stepRejected))
	retryRejectedParams := gin.Params{
		{Key: "id", Value: strconv.FormatInt(project.ID, 10)},
		{Key: "step_id", Value: strconv.FormatInt(stepRejected.ID, 10)},
	}
	_, retryOkResp := callDesignHandler(t, RetryDesignStep, userID, http.MethodPost, "/api/design/projects/1/steps/2/retry", retryRejectedParams, nil)
	require.Equal(t, true, retryOkResp["success"])
	reloadedStep, err := model.GetDesignStepByID(project.ID, stepRejected.ID)
	require.NoError(t, err)
	assert.Equal(t, designStepPending, reloadedStep.Status)
	assert.Equal(t, 1, reloadedStep.Attempt)
	assert.Empty(t, reloadedStep.FailureClass)
}
