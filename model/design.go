package model

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

	// Anchor asset + the invariants captured when it was chosen (Phase 3
	// derivation chain). Columns exist in Phase 1 so migrations are stable.
	AnchorAssetID    *int64 `json:"anchor_asset_id" gorm:"index"`
	AnchorPrompt     string `json:"anchor_prompt" gorm:"type:text"`
	AnchorInvariants string `json:"anchor_invariants" gorm:"type:text"` // JSON
}

func (DesignProject) TableName() string { return "design_projects" }

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
