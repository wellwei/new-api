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
// succeeded, and serving falls back to live upstream proxying.
func maybePersistArtifacts(ctx context.Context, task *model.Task) {
	artifactPersistHookMu.RLock()
	hook := artifactPersistHook
	artifactPersistHookMu.RUnlock()
	if hook == nil {
		return
	}
	hook(ctx, task)
}
