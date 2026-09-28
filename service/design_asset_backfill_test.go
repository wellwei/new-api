package service

import (
	"context"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Backfill maps persisted task artifacts into design_assets exactly once per
// (step, task, artifact key), and never surfaces pending (still-writing)
// ledger rows as durable assets.

func insertBackfillFixture(t *testing.T) (*model.DesignProject, *model.DesignStep) {
	t.Helper()
	project := &model.DesignProject{
		UserID: 42,
		Name:   "backfill-project",
		Kind:   "image",
		Status: "generating",
	}
	require.NoError(t, model.InsertDesignProject(project))
	step := &model.DesignStep{
		ProjectID: project.ID,
		Role:      "主视觉",
		Operation: "image.generate",
		TaskID:    "task_backfill_1",
		Status:    "submitted",
	}
	require.NoError(t, model.InsertDesignStep(step))
	t.Cleanup(func() {
		model.DB.Exec("DELETE FROM design_projects")
		model.DB.Exec("DELETE FROM design_steps")
		model.DB.Exec("DELETE FROM design_assets")
		model.DB.Exec("DELETE FROM task_artifact_objects")
	})
	return project, step
}

func TestBackfillDesignAssetsForTaskIdempotent(t *testing.T) {
	_, step := insertBackfillFixture(t)

	objects := []model.TaskArtifactObject{
		{TaskID: step.TaskID, ArtifactKey: "image-0", MimeType: "image/png", Size: 1024, Width: 1024, Height: 1024},
		{TaskID: step.TaskID, ArtifactKey: "image-1", MimeType: "image/png", Size: 2048, Width: 1024, Height: 1024},
		{TaskID: step.TaskID, ArtifactKey: "pending-2", MimeType: "image/png", Pending: true},
	}
	for i := range objects {
		objects[i].CreatedAt = time.Now().Unix()
		require.NoError(t, model.DB.Create(&objects[i]).Error)
	}

	task := &model.Task{TaskID: step.TaskID, UserId: 42, Status: model.TaskStatusSuccess}
	BackfillDesignAssetsForTask(context.Background(), task)

	assets, err := model.GetDesignAssets(step.ProjectID)
	require.NoError(t, err)
	require.Len(t, assets, 2, "pending ledger rows must not become assets")
	assert.Equal(t, "image-0", assets[0].ArtifactKey)
	assert.Equal(t, 0, assets[0].CandidateIndex)
	assert.Equal(t, "image-1", assets[1].ArtifactKey)
	assert.Equal(t, 1, assets[1].CandidateIndex)
	assert.Equal(t, "主视觉", assets[0].SemanticRole)
	assert.Equal(t, int64(1024), assets[0].Size)

	// Re-running (e.g. on every read-side sync) must not duplicate rows.
	BackfillDesignAssetsForTask(context.Background(), task)
	assets, err = model.GetDesignAssets(step.ProjectID)
	require.NoError(t, err)
	assert.Len(t, assets, 2)
}

func TestBackfillDesignAssetsForTaskWithoutStep(t *testing.T) {
	// Ordinary task rows have no design step: backfill is a no-op.
	task := &model.Task{TaskID: "task_backfill_orphan", UserId: 1, Status: model.TaskStatusSuccess}
	BackfillDesignAssetsForTask(context.Background(), task)
	var count int64
	require.NoError(t, model.DB.Table("design_assets").Count(&count).Error)
	assert.Equal(t, int64(0), count)
}
