package controller

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	relaychannel "github.com/QuantumNous/new-api/relay/channel"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/types"
)

// Background artifact persistence (design doc §8.2). When a task succeeds we
// copy each generated artifact from the (expiring) upstream provider URL into
// the configured TaskArtifactStore exactly once. Failures only degrade to live
// upstream proxying — they never fail the task, which has already succeeded.

var artifactPersistHTTPClient = service.GetHttpClient()

// persistArtifactsForTask copies every projected artifact of a succeeded task
// into the store. It is invoked via the service hook after task success.
func persistArtifactsForTask(ctx context.Context, task *model.Task) {
	store := service.GetTaskArtifactStore()
	if !store.Enabled() {
		return
	}
	if task == nil || task.Status != model.TaskStatusSuccess ||
		!taskHasPluginExecution(task) || !task.ResultRetrievable() {
		return
	}
	artifacts, err := projectTaskArtifacts(task)
	if err != nil || len(artifacts) == 0 {
		return
	}
	for _, artifact := range artifacts {
		persistOneArtifact(ctx, store, task, artifact)
	}
}

func persistOneArtifact(ctx context.Context, store service.TaskArtifactStore, task *model.Task, artifact relaychannel.TaskArtifact) {
	// Skip when already persisted (idempotent across restarts / re-polls).
	if ref, resolveErr := store.Resolve(task, artifact.Key); resolveErr == nil && ref != nil {
		return
	}
	content, mime, err := fetchArtifactContent(task, artifact.Key)
	if err != nil {
		common.SysError("artifact persist fetch failed task=" + task.TaskID + " key=" + artifact.Key + ": " + err.Error())
		return
	}
	defer func() { _ = content.Close() }()
	ta := types.TaskArtifact{Key: artifact.Key, Type: artifact.Type, MimeType: artifact.MimeType}
	if ta.MimeType == "" {
		ta.MimeType = mime
	}
	if _, err := store.Persist(ctx, task, ta, content); err != nil {
		common.SysError("artifact persist failed task=" + task.TaskID + " key=" + artifact.Key + ": " + err.Error())
	}
}

// fetchArtifactContent resolves the upstream content request for an artifact
// and returns its body. It reuses the plugin's BuildContentRequest so the exact
// same signed URL / headers / auth the live proxy uses are preserved.
func fetchArtifactContent(task *model.Task, artifactKey string) (io.ReadCloser, string, error) {
	adaptor, err := initTaskArtifactAdaptor(task)
	if err != nil {
		return nil, "", err
	}
	provider, ok := adaptor.(relaychannel.TaskContentRequestProvider)
	if !ok {
		return nil, "", errors.New("artifact content provider unavailable")
	}
	descriptor, err := provider.BuildContentRequest(task, artifactKey, relaychannel.TaskArtifactClientRequest{Method: http.MethodGet})
	if err != nil || descriptor == nil {
		return nil, "", errors.New("artifact content request build failed")
	}

	req, err := http.NewRequestWithContext(context.Background(), descriptor.Method, descriptor.URL, strings.NewReader(string(descriptor.Body)))
	if err != nil {
		return nil, "", err
	}
	for k, v := range descriptor.Headers {
		req.Header.Set(k, v)
	}
	resp, err := artifactPersistHTTPClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()
		return nil, "", errors.New("artifact content upstream status " + resp.Status)
	}
	return resp.Body, resp.Header.Get("Content-Type"), nil
}

// init wires the completion hook. The hook type lives in service so the task
// poller (service) can call it without an import cycle; controller injects the
// concrete implementation here at startup.
func init() {
	service.SetArtifactPersistHook(persistArtifactsForTask)
}
