package service

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/gin-gonic/gin"
)

// Client-facing relay errors.
//
// The gateway fronts several upstreams whose raw failures are written for
// operators, not callers: they name the upstream host, quote an account, print
// an internal model id, or surface a body nobody outside can act on. Passing
// that through is both unhelpful and a disclosure. So every relay failure that
// reaches a client is reduced to one of a few categories and worded here:
// what went wrong, and what the caller can do about it.
//
// The real cause is not lost — it stays in the error log and in the request
// policy decisions, which is where an operator looks. What the client gets is
// the category, a stable code, and a next step.
//
// This is deliberately a closed mapping: a category the caller cannot act on
// differently does not get its own message.

// clientMessageKeys maps a category to its catalogue entry.
var clientMessageKeys = map[types.ClientErrorCategory]string{
	types.ClientErrModelUnavailable:  i18n.MsgRelayModelUnavailable,
	types.ClientErrRateLimited:       i18n.MsgRelayRateLimited,
	types.ClientErrInsufficientQuota: i18n.MsgRelayInsufficientQuota,
	types.ClientErrInvalidRequest:    i18n.MsgRelayInvalidRequest,
	types.ClientErrContentBlocked:    i18n.MsgRelayContentBlocked,
	types.ClientErrUpstream:          i18n.MsgRelayUpstream,
	types.ClientErrInternal:          i18n.MsgRelayUpstream,
}

// ClientMessageFor renders the client-facing message in the given language.
// Paths without a gin context (websocket frames) resolve the language from the
// request and call this directly.
func ClientMessageFor(lang, modelName string, err *types.NewAPIError) string {
	if err == nil {
		return ""
	}
	category := err.ClientCategory()
	if !err.IsUpstreamOrigin() && category == types.ClientErrInvalidRequest {
		if isDecodeError(err) {
			// A JSON decoder error names Go types and struct fields
			// (`json: cannot unmarshal string into Go struct field
			// ***.messages of type []***.Message`). That is this service's
			// internals, not the caller's request, so it is replaced.
			if msg := translate(lang, modelName, i18n.MsgRelayInvalidRequest); msg != "" {
				return msg
			}
			return err.ClientMessage()
		}
		return err.MaskSensitiveError()
	}
	key, ok := clientMessageKeys[category]
	if !ok {
		return err.ClientMessage()
	}
	if msg := translate(lang, modelName, key); msg != "" {
		return msg
	}
	return err.ClientMessage()
}

// isDecodeError reports whether the failure came from the JSON decoder rather
// than from this gateway's own validation. The distinction matters because the
// two deserve different treatment: a decoder error talks about Go types, while
// a validation error talks about the caller's own fields ("field messages is
// required") and is the single most useful thing to pass along.
func isDecodeError(err *types.NewAPIError) bool {
	if err == nil {
		return false
	}
	var syntaxErr *json.SyntaxError
	var typeErr *json.UnmarshalTypeError
	return errors.As(err, &syntaxErr) || errors.As(err, &typeErr)
}

// translate renders a catalogue entry with the caller's model name, returning
// "" when the catalogue cannot answer.
func translate(lang, modelName, key string) string {
	args := map[string]any{}
	if modelName != "" {
		args["Model"] = modelName
	}
	if msg := i18n.Translate(lang, key, args); msg != "" && msg != key {
		return msg
	}
	return ""
}

// ClientErrorMessage renders the message a client should receive.
//
// Two kinds of failure reach here and they deserve different treatment:
//
//   - An error carrying upstream text is always replaced. The upstream writes
//     for its operator, not for our caller, and its wording discloses hosts,
//     accounts and internal model ids. Those categories also have a next step
//     worth stating ("switch models", "top up").
//   - A local validation error describes the caller's own request. Its text is
//     the useful half of the answer — "field messages is required" tells the
//     caller what to fix, where a generic "invalid request" does not — so it is
//     kept, masked of anything sensitive.
//
// The gateway's internal vocabulary is removed either way: local messages that
// used to name a channel, group or component are reworded in the catalogue.
func ClientErrorMessage(c *gin.Context, err *types.NewAPIError) string {
	if err == nil {
		return ""
	}
	// The caller's own model name is safe to echo: it is what they sent, not
	// anything this gateway resolved it to.
	return ClientMessageFor(i18n.GetLangFromContext(c),
		common.GetContextKeyString(c, constant.ContextKeyOriginalModel), err)
}

// PrepareClientError rewrites a relay error in place so that every serialiser
// downstream (HTTP JSON, websocket frames, task responses) emits the curated
// message and a status that describes the failure honestly. Call it once, at
// the point the error is about to be returned, and log the original first.
func PrepareClientError(c *gin.Context, err *types.NewAPIError) *types.NewAPIError {
	if err == nil {
		return nil
	}
	err.SetMessage(ClientErrorMessage(c, err))
	err.StatusCode = clientStatusFor(c, err)
	return err
}

// clientStatusFor picks the client-facing status. It starts from the error's
// own status and corrects the one case that misleads callers: "no available
// channel" is 503 when the model exists but has no capacity right now (retry
// later), and 404 when this gateway does not serve the model at all (asking
// again will never help — switch models).
func clientStatusFor(c *gin.Context, err *types.NewAPIError) int {
	status := err.ClientStatusCode()
	if err.ClientCategory() != types.ClientErrModelUnavailable {
		return status
	}
	narrowed := ModelUnavailableStatus(contextModelName(c), status)
	if narrowed == http.StatusNotFound && status != http.StatusNotFound {
		// The status now says "this model does not exist here", so the message
		// must stop suggesting a retry — a caller told to retry a model that
		// will never resolve learns the wrong lesson.
		err.SetMessage(catalogMessage(c, i18n.MsgRelayModelNotServed))
	}
	return narrowed
}

// contextModelName returns the model the caller asked for (never the one this
// gateway resolved it to).
func contextModelName(c *gin.Context) string {
	if name := common.GetContextKeyString(c, constant.ContextKeyOriginalModel); name != "" {
		return name
	}
	if c == nil {
		return ""
	}
	return c.GetString("original_model")
}

// catalogMessage renders a catalogue entry with the caller's model name.
func catalogMessage(c *gin.Context, key string) string {
	args := map[string]any{}
	if model := contextModelName(c); model != "" {
		args["Model"] = model
	}
	msg := common.TranslateMessage(c, key, args)
	if msg == "" || msg == key {
		return ""
	}
	return msg
}

// ModelUnavailableStatus resolves the status for a model that could not be
// served: 404 when the gateway does not serve the model at all, otherwise the
// caller's original status (503 — the model exists but has no capacity now).
//
// Only a 503 is reconsidered. Other statuses already say something specific
// the caller should act on, and rewriting them to 404 would lose that. An
// unknown model name or an unavailable model table keeps the retryable status,
// because a wrong 404 tells a working caller their model is gone.
func ModelUnavailableStatus(modelName string, fallback int) int {
	if fallback != http.StatusServiceUnavailable {
		return fallback
	}
	if modelName == "" || model.IsModelEnabled(modelName) {
		return fallback
	}
	return http.StatusNotFound
}

// isClaudeShaped reports whether the request came in on the Anthropic protocol,
// which renders errors as {"type":"error","error":{...}}.
func isClaudeShaped(c *gin.Context) bool {
	if c == nil || c.Request == nil || c.Request.URL == nil {
		return false
	}
	return c.Request.URL.Path == "/v1/messages"
}

// RespondClientError writes a relay error to an HTTP client in the shape of the
// protocol the request arrived on. It localises the message and normalises the
// status first, so every caller of this helper gets the same contract.
func RespondClientError(c *gin.Context, err *types.NewAPIError) {
	if err == nil {
		return
	}
	PrepareClientError(c, err)
	status := err.StatusCode
	code := string(err.ClientErrorCode())
	message := err.Error()

	if isClaudeShaped(c) {
		c.JSON(status, gin.H{
			"type": "error",
			"error": gin.H{
				"type":    code,
				"message": message,
			},
		})
		return
	}
	c.JSON(status, gin.H{
		"error": gin.H{
			"message": message,
			"type":    string(types.ErrorTypeNewAPIError),
			"code":    code,
		},
	})
}

// ClientErrorPayload returns the error body for callers that build their own
// envelope (websocket events, task responses).
func ClientErrorPayload(c *gin.Context, err *types.NewAPIError) (int, any) {
	if err == nil {
		return http.StatusInternalServerError, nil
	}
	if isClaudeShaped(c) {
		return err.ClientStatusCode(), err.ToClientClaudeError()
	}
	return err.ClientStatusCode(), err.ToClientOpenAIError()
}
