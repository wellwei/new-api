package controller

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	taskdto "github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/relay"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/ratio_setting"

	"github.com/gin-gonic/gin"
)

// Shared task submission for the design workbench (design doc §7.2). The
// workbench must reuse the public relay's durable task barrier — model
// permission, channel selection, request rate limit, user in-flight
// concurrency, pre-consume/settle/refund, task log — and must never call
// /v1/* over HTTP or clone a simplified billing path.
//
// It cannot reuse the HTTP route chain directly because the workbench
// authenticates by browser session and picks one of the user's own tokens
// server-side, while /v1/* authenticates by the API key itself. The bridge
// below registers the protocol routes' exact middleware chain plus
// executeTaskSubmission on a throwaway gin engine and dispatches a synthetic
// request through it. The barrier, retry policy, and billing path are
// therefore the public ones — including their failure refund semantics.

const (
	designImageGeneratePath = "/v1/images/generations"
	designVideoCreatePath   = "/v1/videos"
)

// designProtocolEndpoint resolves the canonical host-protocol endpoint for a
// workbench media type + operation. An empty path means the operation is not
// part of Phase 1 (edit and anchor chains are Phase 3, §11).
func designProtocolEndpoint(mediaType, operation string) string {
	switch mediaType {
	case "image":
		if operation == "generate" {
			return designImageGeneratePath
		}
	case "video":
		if operation == "generate" || operation == "create" {
			return designVideoCreatePath
		}
	}
	return ""
}

// designStepSubmit carries everything the bridge needs to run one step.
type designStepSubmit struct {
	UserID   int
	UserRole int
	Token    *model.Token
	// MediaType + Operation select the host protocol endpoint, e.g.
	// ("image", "generate") -> POST /v1/images/generations.
	MediaType string
	Operation string
	// ModelName is the workbench capability's model, already validated against
	// the projected capability.
	ModelName string
	// Parameters is the confirmed step parameter object; "model" is merged in
	// from ModelName.
	Parameters map[string]any
}

// designSubmissionResult carries the durable outcome of one submission.
type designSubmissionResult struct {
	Outcome *taskSubmissionOutcome
}

// submitDesignStepTask runs one submission through the shared barrier. A nil
// TaskError implies a durable task row exists.
func submitDesignStepTask(submit designStepSubmit) (*designSubmissionResult, *taskdto.TaskError, error) {
	token := submit.Token
	if token == nil || submit.UserID <= 0 {
		return nil, nil, errors.New("design submission requires an authenticated user and token")
	}
	endpoint := designProtocolEndpoint(submit.MediaType, submit.Operation)
	if endpoint == "" {
		return nil, nil, fmt.Errorf("unsupported design operation %s.%s", submit.MediaType, submit.Operation)
	}

	// The synthetic request body is the exact protocol request a direct API
	// caller would have sent: {"model": ..., ...parameters}.
	body := make(map[string]any, len(submit.Parameters)+1)
	for key, value := range submit.Parameters {
		body[key] = value
	}
	body["model"] = submit.ModelName
	bodyBytes, err := common.Marshal(body)
	if err != nil {
		return nil, nil, err
	}
	httpRequest, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, nil, err
	}
	httpRequest.Header.Set("Content-Type", "application/json")

	recorder := httptest.NewRecorder()
	engine := gin.New()

	var (
		outcome  *taskSubmissionOutcome
		taskErr  *taskdto.TaskError
		innerErr error
	)
	identityHandler := func(c *gin.Context) {
		if err := setupDesignSubmitIdentity(c, submit); err != nil {
			innerErr = err
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": gin.H{"message": err.Error(), "type": "invalid_request_error"}})
			return
		}
		// The workbench serves assets from the TaskArtifactStore, so the
		// durable snapshot must survive even where the host protocol would
		// discard it for one-shot synchronous callers.
		common.SetContextKey(c, constant.ContextKeyRetainTaskResult, true)
		c.Next()
	}
	finalHandler := func(c *gin.Context) {
		if _, exists := c.Get(pluginruntime.ContextKeyPinnedEndpoint); !exists {
			innerErr = errors.New("design submission was not claimed by a task plugin protocol")
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": gin.H{"message": "Task protocol request failed", "type": "new_api_error"}})
			return
		}
		// A disconnected workbench client must not cancel submission,
		// persistence, or billing settlement — the same bounded lifetime the
		// protocol bridge gives every submission.
		clientRequest := c.Request
		func() {
			submissionContext, cancelSubmission := context.WithTimeout(
				context.WithoutCancel(clientRequest.Context()),
				designSubmissionTimeout(),
			)
			c.Request = clientRequest.Clone(submissionContext)
			defer func() {
				c.Request = clientRequest
				cancelSubmission()
			}()

			relayInfo, relayInfoErr := relaycommon.GenRelayInfo(c, types.RelayFormatTask, nil, nil)
			if relayInfoErr != nil {
				innerErr = relayInfoErr
				return
			}
			relayInfo.RelayMode = relayconstant.RelayModeVideoSubmit
			relayInfo.IsStream = false
			relayInfo.OriginModelName = c.GetString("resolved_task_model")

			if taskErr = relay.ResolveOriginTask(c, relayInfo); taskErr != nil {
				return
			}
			if taskErr = relay.ApplyOriginTaskAffinity(c, relayInfo); taskErr != nil {
				return
			}
			outcome, taskErr = executeTaskSubmission(c, relayInfo)
		}()
	}

	// The middleware order mirrors router/task-plugin-protocol-router.go's
	// openai_image.generate / openai_video.create chains, preceded by the
	// session-identity shim. The concurrency slot is held for the whole
	// submission: the gate's defer sits above the final handler, exactly as
	// on the HTTP route.
	engine.POST(endpoint,
		identityHandler,
		middleware.UserConcurrencyLimit(),
		middleware.ModelRequestRateLimit(),
		middleware.PinTaskPluginEndpoint(),
		middleware.PrepareTaskPluginEndpoint(),
		middleware.Distribute(),
		finalHandler,
	)
	engine.ServeHTTP(recorder, httpRequest)

	if innerErr != nil {
		return nil, nil, innerErr
	}
	if taskErr != nil {
		return nil, taskErr, nil
	}
	if outcome == nil || outcome.Task == nil {
		// A middleware rejected the request (concurrency, rate limit, token
		// model whitelist, no channel...). Surface its status and message.
		status := recorder.Code
		if status < 400 {
			status = http.StatusInternalServerError
		}
		return nil, service.TaskErrorWrapperLocal(
			errors.New(designRejectReason(recorder.Body)),
			"design_submit_rejected",
			status,
		), nil
	}
	return &designSubmissionResult{Outcome: outcome}, nil, nil
}

func designRejectReason(body *bytes.Buffer) string {
	if body == nil {
		return "design submission rejected"
	}
	var decoded struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := common.Unmarshal(body.Bytes(), &decoded); err == nil && decoded.Error.Message != "" {
		return decoded.Error.Message
	}
	return "design submission rejected"
}

func designSubmissionTimeout() time.Duration {
	seconds := constant.TaskPluginProtocolTimeoutSeconds
	if seconds <= 0 {
		return 10 * time.Minute
	}
	return time.Duration(seconds) * time.Second
}

// setupDesignSubmitIdentity replicates TokenAuth's user/group resolution for a
// session-authenticated caller submitting with one of their own tokens.
func setupDesignSubmitIdentity(ctx *gin.Context, submit designStepSubmit) error {
	userCache, err := model.GetUserCache(submit.UserID)
	if err != nil {
		return fmt.Errorf("load user for design submission: %w", err)
	}
	if userCache.Status != common.UserStatusEnabled {
		return errors.New("user is disabled")
	}
	userCache.WriteContext(ctx)
	common.SetContextKey(ctx, constant.ContextKeyUserRole, submit.UserRole)

	userGroup := userCache.Group
	tokenGroup := submit.Token.Group
	if tokenGroup != "" {
		if _, ok := service.GetUserUsableGroups(userGroup)[tokenGroup]; !ok {
			return fmt.Errorf("无权访问 %s 分组", tokenGroup)
		}
		if !ratio_setting.ContainsGroupRatio(tokenGroup) && tokenGroup != "auto" {
			return fmt.Errorf("分组 %s 已被弃用", tokenGroup)
		}
		userGroup = tokenGroup
	}
	common.SetContextKey(ctx, constant.ContextKeyUsingGroup, userGroup)

	if err := middleware.SetupContextForToken(ctx, submit.Token); err != nil {
		return err
	}
	logger.LogDebug(ctx, "design submit identity resolved user=%d token=%d group=%s", submit.UserID, submit.Token.Id, userGroup)
	return nil
}
