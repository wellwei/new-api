package service

import (
	"context"
	"sync"

	"github.com/QuantumNous/new-api/model"
)

// ArtifactPersistHook copies a succeeded task's generated artifacts into the
// configured TaskArtifactStore. It is injected by the controller package at
// init (controller already imports both service and relay, so it can build the
// adaptor-based fetch); the service-side task poller calls it here to avoid an
// import cycle.
type ArtifactPersistHook func(ctx context.Context, task *model.Task)

var (
	artifactPersistHookMu sync.RWMutex
	artifactPersistHook   ArtifactPersistHook
)

// SetArtifactPersistHook injects the concrete persistence implementation. It
// is called once from controller's init and is not safe for concurrent re-set.
func SetArtifactPersistHook(hook ArtifactPersistHook) {
	artifactPersistHookMu.Lock()
	defer artifactPersistHookMu.Unlock()
	artifactPersistHook = hook
}

// maybePersistArtifacts runs the injected hook if present. Persistence
// failures are logged by the hook and never propagate — the task already
// succeeded, and serving falls back to live upstream proxying. Afterwards the
// design asset backfill maps any freshly persisted ledger rows into
// design_assets; it is ledger-driven, so it is a no-op when nothing persisted.
func maybePersistArtifacts(ctx context.Context, task *model.Task) {
	artifactPersistHookMu.RLock()
	hook := artifactPersistHook
	artifactPersistHookMu.RUnlock()
	if hook != nil {
		hook(ctx, task)
	}
	BackfillDesignAssetsForTask(ctx, task)
}

// PersistArtifactsForTask is the exported entry for callers that finish a task
// outside the polling loop — most notably the design workbench submitting
// through the shared barrier, which can return an immediately terminal task
// that no poller will ever re-visit. Safe to call for any task state; the
// hook and the backfill both filter internally.
func PersistArtifactsForTask(ctx context.Context, task *model.Task) {
	if task == nil || task.Status != model.TaskStatusSuccess {
		return
	}
	maybePersistArtifacts(ctx, task)
}
