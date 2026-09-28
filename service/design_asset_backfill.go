package service

import (
	"context"

	"github.com/QuantumNous/new-api/model"
)

// Design asset backfill (design doc §7.2 item 5). Once a succeeded task's
// artifacts are persisted into the TaskArtifactStore (ledger table
// task_artifact_objects), any design step bound to that task gets a
// design_assets row per persisted object. Rows are keyed by
// (step, task_id, artifact_key), so running this repeatedly — on every task
// terminalization and on every workbench read-side sync — is idempotent.

// BackfillDesignAssetsForTask copies persisted artifact objects of a task into
// the design_assets table for every step that references the task. It never
// returns errors to the caller: the task has already succeeded, and a
// backfill failure only means the workbench shows fewer assets until the next
// sync — the artifacts themselves remain resolvable.
func BackfillDesignAssetsForTask(ctx context.Context, task *model.Task) {
	if task == nil || task.TaskID == "" {
		return
	}
	steps, err := model.DesignStepsByTaskID(task.TaskID)
	if err != nil || len(steps) == 0 {
		return
	}
	objects, err := model.GetPersistedTaskArtifactObjects(task.TaskID)
	if err != nil || len(objects) == 0 {
		return
	}
	for _, step := range steps {
		backfillStepAssets(ctx, step, objects)
	}
}

func backfillStepAssets(ctx context.Context, step model.DesignStep, objects []model.TaskArtifactObject) {
	existing, err := model.CountDesignAssetsForStepTask(step.ID, step.TaskID)
	if err != nil {
		return
	}
	for _, object := range objects {
		exists, err := model.DesignAssetExists(step.ID, step.TaskID, object.ArtifactKey)
		if err != nil {
			return
		}
		if exists {
			continue
		}
		asset := &model.DesignAsset{
			ProjectID:      step.ProjectID,
			StepID:         step.ID,
			SemanticRole:   step.Role,
			CandidateIndex: existing,
			TaskID:         step.TaskID,
			ArtifactKey:    object.ArtifactKey,
			MimeType:       object.MimeType,
			Width:          object.Width,
			Height:         object.Height,
			Duration:       object.Duration,
			Size:           object.Size,
			SHA256:         object.SHA256,
		}
		if err := model.InsertDesignAsset(asset); err != nil {
			return
		}
		existing++
	}
}
