package model

import (
	"errors"
	"time"

	"gorm.io/gorm"
)

// Design tables for the AI design workbench (Phase 1). These organize user
// intent, generation steps and durable asset references around the existing
// `tasks` rows — the actual generation/billing still runs through the task
// system. Binary bytes are never stored here; they live in the
// TaskArtifactStore (filesystem backend) and are referenced by
// (task_id, artifact_key).

// DesignProject is one design workspace owned by a user.
type DesignProject struct {
	ID        int64 `json:"id" gorm:"primary_key"`
	CreatedAt int64 `json:"created_at" gorm:"bigint;index"`
	UpdatedAt int64 `json:"updated_at" gorm:"bigint;index"`

	UserID int    `json:"user_id" gorm:"index"`
	Name   string `json:"name" gorm:"type:varchar(191)"`
	// Kind is the delivery form family: "image" or "video" for Phase 1.
	Kind   string `json:"kind" gorm:"type:varchar(32);index"`
	Status string `json:"status" gorm:"type:varchar(40);index"`

	// CreatedVia records which surface opened the workspace: "web" for a
	// dashboard session, "agent" for a PAT-authenticated call. The server
	// stamps it from the credential kind and never from the request body, so
	// an agent cannot claim it came from the page. No GORM default tag: an
	// empty value is a business rule (legacy rows predate the column) that
	// the read side resolves to "web", and a tag would make AutoMigrate
	// re-issue ALTER TABLE on MySQL/PostgreSQL restarts. No index — two
	// values.
	CreatedVia string `json:"created_via" gorm:"type:varchar(16)"`

	// PlanRevision increments whenever the confirmed plan changes; steps and
	// assets carry the revision they belong to so a stale confirm is rejected.
	PlanRevision int `json:"plan_revision" gorm:"default:0"`

	// Brief is the free-form requirement snapshot the user provided.
	Brief string `json:"brief" gorm:"type:text"`
	// DefaultCapability / TokenID scope which declared capability and which of
	// the user's own tokens the project bills through. The raw token secret is
	// never stored or returned.
	DefaultCapability string `json:"default_capability" gorm:"type:varchar(128)"`
	TokenID           int    `json:"token_id" gorm:"index"`

	// Role / Parameters hold the Phase 1 draft-level spec (single semantic
	// step). Parameters is the live form JSON; plan() copies both into the
	// step and freezes them under a new PlanRevision.
	Role       string `json:"role" gorm:"type:varchar(128)"`
	Parameters string `json:"parameters" gorm:"type:text"`

	// Anchor asset + the invariants captured when it was chosen (Phase 3
	// derivation chain). Columns exist in Phase 1 so migrations are stable.
	AnchorAssetID    *int64 `json:"anchor_asset_id" gorm:"index"`
	AnchorPrompt     string `json:"anchor_prompt" gorm:"type:text"`
	AnchorInvariants string `json:"anchor_invariants" gorm:"type:text"` // JSON
}

func (DesignProject) TableName() string { return "design_projects" }

// Workspace origins. See DesignProject.CreatedVia for why the value is
// server-stamped and why the empty string resolves to "web".
const (
	DesignCreatedViaWeb   = "web"
	DesignCreatedViaAgent = "agent"
)

// CreatedViaOrDefault resolves the origin for display, mapping rows written
// before the column existed to "web". The PAT path is new, so an empty value
// can only be legacy data.
func (project *DesignProject) CreatedViaOrDefault() string {
	if project.CreatedVia == "" {
		return DesignCreatedViaWeb
	}
	return project.CreatedVia
}

// DesignStep is one semantic generation step inside a project. One step maps
// to exactly one task (one semantic role → one task); multiple returned images
// are only candidate versions of that role, not multiple roles.
type DesignStep struct {
	ID        int64 `json:"id" gorm:"primary_key"`
	CreatedAt int64 `json:"created_at" gorm:"bigint;index"`
	UpdatedAt int64 `json:"updated_at" gorm:"bigint;index"`

	ProjectID int64 `json:"project_id" gorm:"index"`
	// Role is the semantic role, e.g. "主视觉" / "场景一".
	Role string `json:"role" gorm:"type:varchar(128)"`
	// Operation is the workbench operation, e.g. "image.generate".
	Operation    string `json:"operation" gorm:"type:varchar(64);index"`
	CapabilityID string `json:"capability_id" gorm:"type:varchar(128)"`
	Model        string `json:"model" gorm:"type:varchar(128)"`

	// DependsOn / References are JSON arrays describing step dependencies and
	// reference asset roles. Kept as text; parsed by the service layer.
	DependsOn  string `json:"depends_on" gorm:"type:text"`
	References string `json:"references" gorm:"type:text"`

	// Parameters is the confirmed JSON parameter snapshot for this step.
	Parameters string `json:"parameters" gorm:"type:text"`

	// PlanRevision / ConfirmRevision bind the step to the plan it was confirmed
	// under; Attempt counts retries, IdempotencyKey dedupes paid submission.
	PlanRevision    int    `json:"plan_revision" gorm:"index"`
	ConfirmRevision int    `json:"confirm_revision"`
	Attempt         int    `json:"attempt" gorm:"default:0"`
	IdempotencyKey  string `json:"idempotency_key" gorm:"type:varchar(128);index"`

	// TaskID links to the existing new-api task that actually ran the step.
	TaskID string `json:"task_id" gorm:"type:varchar(191);index"`
	Status string `json:"status" gorm:"type:varchar(40);index"`
	// FailureClass categorizes a failure for the UI's "allowed next action".
	FailureClass string `json:"failure_class" gorm:"type:varchar(64)"`
}

func (DesignStep) TableName() string { return "design_steps" }

// DesignAsset is one durable, confirmed-or-candidate output of a step. It
// references an object in the TaskArtifactStore by (task_id, artifact_key);
// it never holds bytes. CandidateIndex distinguishes multiple versions of the
// same semantic role.
type DesignAsset struct {
	ID        int64 `json:"id" gorm:"primary_key"`
	CreatedAt int64 `json:"created_at" gorm:"bigint;index"`
	UpdatedAt int64 `json:"updated_at" gorm:"bigint;index"`

	ProjectID int64 `json:"project_id" gorm:"index"`
	StepID    int64 `json:"step_id" gorm:"index"`

	SemanticRole   string `json:"semantic_role" gorm:"type:varchar(128)"`
	CandidateIndex int    `json:"candidate_index" gorm:"default:0"`

	TaskID      string `json:"task_id" gorm:"type:varchar(191);index"`
	ArtifactKey string `json:"artifact_key" gorm:"type:varchar(128)"`

	// Content metadata, filled once the artifact object exists locally.
	MimeType string `json:"mime_type" gorm:"type:varchar(128)"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	Duration int    `json:"duration"` // seconds, video/audio
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256" gorm:"type:varchar(64)"`

	// AnchorVersion marks which plan revision's anchor this asset fed;
	// Acceptance / Selection capture user decisions.
	AnchorVersion int  `json:"anchor_version" gorm:"default:0"`
	Accepted      bool `json:"accepted" gorm:"default:false"`
	Selected      bool `json:"selected" gorm:"default:false"`
}

func (DesignAsset) TableName() string { return "design_assets" }

// TaskArtifactObject is the ledger mapping (task_id, artifact_key) to a
// persisted artifact object in the filesystem store. It holds metadata only,
// never bytes. Owned by model so migration stays co-located with the other
// design tables it references.
type TaskArtifactObject struct {
	ID           int64  `json:"id" gorm:"primary_key"`
	CreatedAt    int64  `json:"created_at" gorm:"bigint;index"`
	TaskID       string `json:"task_id" gorm:"type:varchar(191);index;uniqueIndex:uk_task_artifact,priority:1"`
	ArtifactKey  string `json:"artifact_key" gorm:"type:varchar(128);uniqueIndex:uk_task_artifact,priority:2"`
	UserID       int    `json:"user_id" gorm:"index"`
	Backend      string `json:"backend" gorm:"type:varchar(32)"`
	RelativePath string `json:"relative_path" gorm:"type:varchar(512)"`
	MimeType     string `json:"mime_type" gorm:"type:varchar(128)"`
	Size         int64  `json:"size"`
	SHA256       string `json:"sha256" gorm:"type:varchar(64)"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	Duration     int    `json:"duration"`
	// Pending is true until the object is fully written + renamed; pending
	// rows are never served.
	Pending bool `json:"pending" gorm:"index"`
}

func (TaskArtifactObject) TableName() string { return "task_artifact_objects" }

// DesignExternalObject is the ledger for a deliverable the workbench did not
// generate: a reference image the user supplied, or an editable file (drawio /
// docx / pptx / pdf) an agent produced outside the task system.
//
// It is deliberately a separate table rather than a task_id-less row in
// task_artifact_objects. That table's primary key is (task_id, artifact_key)
// and its storage path embeds the task id, so a nameless row would collide
// with every other nameless row on the same artifact key — and the artifact
// content route authorizes on the task, which an external object does not
// have. Referencing the owning project instead keeps every read scoped to a
// workspace the session user already owns.
type DesignExternalObject struct {
	ID        int64 `json:"id" gorm:"primary_key"`
	CreatedAt int64 `json:"created_at" gorm:"bigint;index"`
	UpdatedAt int64 `json:"updated_at" gorm:"bigint"`

	UserID    int   `json:"user_id" gorm:"index"`
	ProjectID int64 `json:"project_id" gorm:"index"`

	// ObjectKey is server-generated and unique: it is the storage name and the
	// HMAC signing input, so a client-supplied name can never collide with or
	// overwrite another object's bytes.
	ObjectKey    string `json:"object_key" gorm:"type:varchar(128);uniqueIndex"`
	SemanticRole string `json:"semantic_role" gorm:"type:varchar(128);index"`
	// Source records where the bytes came from ("upload" or "url") so triage
	// can tell a pasted link from a dropped file.
	Source   string `json:"source" gorm:"type:varchar(16)"`
	FileName string `json:"file_name" gorm:"type:varchar(191)"`

	Backend      string `json:"backend" gorm:"type:varchar(32)"`
	RelativePath string `json:"relative_path" gorm:"type:varchar(512)"`
	MimeType     string `json:"mime_type" gorm:"type:varchar(128)"`
	Size         int64  `json:"size"`
	SHA256       string `json:"sha256" gorm:"type:varchar(64)"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
}

func (DesignExternalObject) TableName() string { return "design_external_objects" }

// --- Queries used by the design workbench API (controller/design.go) and the
// --- asset backfill hook (service). Ownership is always part of the WHERE so
// --- one user can never read or mutate another user's workspace.

func GetDesignProjectByID(id int64, userID int) (*DesignProject, error) {
	if id <= 0 || userID <= 0 {
		return nil, errors.New("invalid design project lookup")
	}
	var project DesignProject
	err := DB.Where("id = ? and user_id = ?", id, userID).First(&project).Error
	if err != nil {
		return nil, err
	}
	return &project, nil
}

func InsertDesignProject(project *DesignProject) error {
	now := time.Now().Unix()
	project.CreatedAt = now
	project.UpdatedAt = now
	return DB.Create(project).Error
}

func SaveDesignProject(project *DesignProject) error {
	project.UpdatedAt = time.Now().Unix()
	return DB.Save(project).Error
}

func DeleteDesignProject(project *DesignProject) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("project_id = ?", project.ID).Delete(&DesignAsset{}).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ?", project.ID).Delete(&DesignStep{}).Error; err != nil {
			return err
		}
		return tx.Delete(project).Error
	})
}

func ListDesignProjects(userID int, offset, limit int) ([]DesignProject, int64, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	var projects []DesignProject
	var total int64
	if err := DB.Model(&DesignProject{}).Where("user_id = ?", userID).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	err := DB.Where("user_id = ?", userID).
		Order("updated_at desc").Offset(offset).Limit(limit).Find(&projects).Error
	return projects, total, err
}

func GetDesignSteps(projectID int64) ([]DesignStep, error) {
	var steps []DesignStep
	err := DB.Where("project_id = ?", projectID).Order("id asc").Find(&steps).Error
	return steps, err
}

func GetDesignStepByID(projectID, stepID int64) (*DesignStep, error) {
	var step DesignStep
	err := DB.Where("id = ? and project_id = ?", stepID, projectID).First(&step).Error
	if err != nil {
		return nil, err
	}
	return &step, nil
}

func InsertDesignStep(step *DesignStep) error {
	now := time.Now().Unix()
	step.CreatedAt = now
	step.UpdatedAt = now
	return DB.Create(step).Error
}

func SaveDesignStep(step *DesignStep) error {
	step.UpdatedAt = time.Now().Unix()
	return DB.Save(step).Error
}

func GetDesignAssets(projectID int64) ([]DesignAsset, error) {
	var assets []DesignAsset
	err := DB.Where("project_id = ?", projectID).Order("id asc").Find(&assets).Error
	return assets, err
}

func GetDesignAssetByID(projectID, assetID int64) (*DesignAsset, error) {
	var asset DesignAsset
	err := DB.Where("id = ? and project_id = ?", assetID, projectID).First(&asset).Error
	if err != nil {
		return nil, err
	}
	return &asset, nil
}

// DesignAssetUpdate is the partial, field-present form of an asset decision.
// A nil field is left untouched, which is what lets the UI send only the one
// decision it changed and keeps "uncheck selection" expressible.
type DesignAssetUpdate struct {
	Accepted *bool
	Selected *bool
}

// UpdateDesignAssetFlags applies an acceptance / finalization decision.
//
// Selection is mutually exclusive per (project_id, semantic_role): one
// semantic role resolves to exactly one chosen candidate, so the clear and the
// set must land in one transaction under a row lock, or two concurrent
// decisions would both survive with Selected true. Acceptance is not
// exclusive — several candidates can be accepted — and neither flag implies
// the other: "approved" is not "this is the one we ship".
//
// The target asset is re-read under the lock with project_id in the WHERE, so
// a foreign asset_id is reported as not found rather than mutated. Ownership
// of the project itself is the caller's check (loadOwnDesignProject), which
// already scoped the project id to the session user.
func UpdateDesignAssetFlags(projectID, assetID int64, update DesignAssetUpdate) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var asset DesignAsset
		if err := lockForUpdate(tx).
			Where("id = ? and project_id = ?", assetID, projectID).
			First(&asset).Error; err != nil {
			return err
		}
		now := time.Now().Unix()
		if update.Selected != nil {
			if *update.Selected {
				if err := tx.Model(&DesignAsset{}).
					Where("project_id = ? and semantic_role = ? and id != ? and selected = ?", projectID, asset.SemanticRole, asset.ID, true).
					Update("selected", false).Error; err != nil {
					return err
				}
			}
			asset.Selected = *update.Selected
		}
		if update.Accepted != nil {
			asset.Accepted = *update.Accepted
		}
		asset.UpdatedAt = now
		return tx.Model(&DesignAsset{}).Where("id = ?", asset.ID).Updates(map[string]any{
			"selected":   asset.Selected,
			"accepted":   asset.Accepted,
			"updated_at": now,
		}).Error
	})
}

// DesignStepByIdempotencyKey resolves a previously submitted step for an
// idempotent re-run. Ownership is enforced through the project's user id.
func DesignStepByIdempotencyKey(userID int, idempotencyKey string) (*DesignStep, error) {
	if idempotencyKey == "" {
		return nil, nil
	}
	var step DesignStep
	err := DB.Joins("join design_projects on design_projects.id = design_steps.project_id").
		Where("design_projects.user_id = ? and design_steps.idempotency_key = ?", userID, idempotencyKey).
		First(&step).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &step, nil
}

// --- Backfill queries: map persisted task artifacts into design_assets. ---

// DesignStepsByTaskID returns every step bound to a task. Normally at most one
// step owns a task (one semantic role → one task), but the query stays a list
// so a malformed double bind can never silently drop assets.
func DesignStepsByTaskID(taskID string) ([]DesignStep, error) {
	var steps []DesignStep
	err := DB.Where("task_id = ?", taskID).Find(&steps).Error
	return steps, err
}

// DesignAssetExists reports whether an asset row for (step, task, artifact key)
// was already written. The backfill runs on every read-side sync, so it must
// stay idempotent.
func DesignAssetExists(stepID int64, taskID, artifactKey string) (bool, error) {
	var count int64
	err := DB.Model(&DesignAsset{}).
		Where("step_id = ? and task_id = ? and artifact_key = ?", stepID, taskID, artifactKey).
		Count(&count).Error
	return count > 0, err
}

func InsertDesignAsset(asset *DesignAsset) error {
	now := time.Now().Unix()
	asset.CreatedAt = now
	asset.UpdatedAt = now
	return DB.Create(asset).Error
}

// ReplaceDesignSteps freezes a new plan: all previous steps are dropped and
// the new batch is inserted under the project's current revision. Phase 1
// plans a single step; the batch shape keeps the API Phase-3 ready.
func ReplaceDesignSteps(project *DesignProject, steps []*DesignStep) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("project_id = ?", project.ID).Delete(&DesignStep{}).Error; err != nil {
			return err
		}
		for _, step := range steps {
			now := time.Now().Unix()
			step.CreatedAt = now
			step.UpdatedAt = now
			if err := tx.Create(step).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func CountDesignAssetsForStepTask(stepID int64, taskID string) (int, error) {
	var count int64
	err := DB.Model(&DesignAsset{}).
		Where("step_id = ? and task_id = ?", stepID, taskID).
		Count(&count).Error
	return int(count), err
}

// GetPersistedTaskArtifactObjects returns the fully written ledger rows of one
// task, oldest first. Pending rows are excluded: their bytes are not on disk
// yet, and design assets must only reference durable objects (§8.2).
func GetPersistedTaskArtifactObjects(taskID string) ([]TaskArtifactObject, error) {
	var objects []TaskArtifactObject
	err := DB.Where("task_id = ? and pending = ?", taskID, false).
		Order("id asc").Find(&objects).Error
	return objects, err
}

// --- External design objects: owned by a project, not by a task. ---

// InsertDesignExternalObject stamps the creation time and writes the ledger
// row. The caller has already persisted the bytes; a ledger row without bytes
// is never produced because the write happens after the object is published.
func InsertDesignExternalObject(object *DesignExternalObject) error {
	now := time.Now().Unix()
	object.CreatedAt = now
	object.UpdatedAt = now
	return DB.Create(object).Error
}

// ListDesignExternalObjects returns one project's registered deliverables,
// oldest first.
func ListDesignExternalObjects(projectID int64) ([]DesignExternalObject, error) {
	if projectID <= 0 {
		return nil, errors.New("invalid design project lookup")
	}
	var objects []DesignExternalObject
	err := DB.Where("project_id = ?", projectID).Order("id asc").Find(&objects).Error
	return objects, err
}

// DesignExternalObjectByKey resolves a registered object inside one project.
// The project id is part of the lookup so a key from another workspace reads
// as missing instead of leaking.
func DesignExternalObjectByKey(projectID int64, objectKey string) (*DesignExternalObject, error) {
	if projectID <= 0 || objectKey == "" {
		return nil, errors.New("invalid design external object lookup")
	}
	var object DesignExternalObject
	err := DB.Where("project_id = ? and object_key = ?", projectID, objectKey).First(&object).Error
	if err != nil {
		return nil, err
	}
	return &object, nil
}
