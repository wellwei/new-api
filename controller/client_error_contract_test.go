package controller

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// End-to-end shape check for the client-facing error contract, exercised
// through the real response writers rather than the helpers directly.
func TestClientFacingErrorContract(t *testing.T) {
	require.NoError(t, i18n.Init())
	gin.SetMode(gin.TestMode)

	// A body a real upstream produces, containing material that must not reach
	// a caller: the upstream's host, a pooled account, an internal model id.
	const upstreamBody = `{"error":{"type":"invalid_request_error","code":"INFERENCE_CAP_ERROR",` +
		`"message":"Daily free limit reached on model deepseek/deepseek-v4.1-flash for ` +
		`ywellwei@gmail.com via api.cline.bot (channel 4)"}}`

	cases := []struct {
		name       string
		path       string
		err        *types.NewAPIError
		wantStatus int
		wantCode   string
		mustNotSay []string
	}{
		{
			name:       "upstream rate limit",
			path:       "/v1/chat/completions",
			err:        upstreamMarked(types.ErrorCodeBadResponseStatusCode, http.StatusTooManyRequests, upstreamBody),
			wantStatus: http.StatusTooManyRequests,
			wantCode:   string(types.ErrorCodeModelRateLimited),
			mustNotSay: []string{"cline.bot", "ywellwei@gmail.com", "deepseek/deepseek-v4.1-flash", "channel 4", "Daily free limit"},
		},
		{
			name:       "upstream server error",
			path:       "/v1/chat/completions",
			err:        upstreamMarked(types.ErrorCodeBadResponseStatusCode, http.StatusInternalServerError, upstreamBody),
			wantStatus: http.StatusBadGateway,
			wantCode:   string(types.ErrorCodeUpstreamUnavailable),
			mustNotSay: []string{"cline.bot", "ywellwei@gmail.com", "Daily free limit"},
		},
		{
			name:       "insufficient quota",
			path:       "/v1/chat/completions",
			err:        types.NewErrorWithStatusCode(errors.New("quota exhausted"), types.ErrorCodeInsufficientUserQuota, http.StatusForbidden),
			wantStatus: http.StatusForbidden,
			wantCode:   string(types.ErrorCodeInsufficientUserQuota),
		},
		{
			name: "no capacity for a served model stays retryable",
			path: "/v1/chat/completions",
			// NoAvailableChannel carries ErrorCodeModelNotFound with a 503. The
			// status result depends on whether the test database knows the
			// model, which is the point of the narrowing: a model this gateway
			// serves keeps its retryable 503; one it does not serve becomes a
			// 404. Both are correct answers — assert on the contract, not on
			// which branch the fixture happens to take.
			err:      types.NewErrorWithStatusCode(errors.New("no available channel"), types.ErrorCodeModelNotFound, http.StatusServiceUnavailable),
			wantCode: string(types.ErrorCodeModelNotFound),
			// status asserted below
		},
		{
			name:       "local protocol error keeps its instruction",
			path:       "/v1/chat/completions",
			err:        types.NewErrorWithStatusCode(errors.New("field messages is required"), types.ErrorCodeInvalidRequest, http.StatusBadRequest),
			wantStatus: http.StatusBadRequest,
			wantCode:   string(types.ErrorCodeInvalidRequest),
			// The caller needs this text: it says which field to fix.
			// (asserted separately below)
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			router := gin.New()
			router.POST("/v1/chat/completions", func(c *gin.Context) {
				common.SetContextKey(c, constant.ContextKeyOriginalModel, "deepseek-v4.1-flash")
				service.RespondClientError(c, tc.err)
			})
			router.POST("/v1/messages", func(c *gin.Context) {
				common.SetContextKey(c, constant.ContextKeyOriginalModel, "deepseek-v4.1-flash")
				service.RespondClientError(c, tc.err)
			})

			for _, path := range []string{"/v1/chat/completions", "/v1/messages"} {
				recorder := httptest.NewRecorder()
				req := httptest.NewRequest(http.MethodPost, path, nil)
				req.Header.Set("Accept-Language", "en")
				router.ServeHTTP(recorder, req)

				// The model-unavailable case narrows 503 to 404 only when the
				// database confirms the model is not served; either answer is
				// correct depending on the fixture's abilities table.
				if tc.wantStatus != 0 {
					assert.Equal(t, tc.wantStatus, recorder.Code, "status must describe the failure")
				} else {
					assert.Contains(t, []int{http.StatusServiceUnavailable, http.StatusNotFound}, recorder.Code,
						"a model-unavailable error must stay retryable or become a definitive 404")
				}

				if path == "/v1/messages" {
					// Anthropic clients get the Anthropic envelope.
					var body struct {
						Type  string `json:"type"`
						Error struct {
							Type    string `json:"type"`
							Message string `json:"message"`
						} `json:"error"`
					}
					require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
					assert.Equal(t, "error", body.Type)
					assert.Equal(t, tc.wantCode, body.Error.Type)
					for _, secret := range tc.mustNotSay {
						assert.NotContains(t, body.Error.Message, secret)
					}
				} else {
					var body struct {
						Error struct {
							Message string `json:"message"`
							Code    string `json:"code"`
						} `json:"error"`
					}
					require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
					assert.Equal(t, tc.wantCode, body.Error.Code)
					for _, secret := range tc.mustNotSay {
						assert.NotContains(t, body.Error.Message, secret)
					}
					if tc.name == "local protocol error keeps its instruction" {
						assert.Contains(t, body.Error.Message, "messages",
							"a local validation error must say what to fix")
					}
				}
			}
		})
	}
}

// The message a caller sees must not vary with the upstream's wording: same
// failure class, same words. Otherwise the wording is a covert channel.
func TestClientMessageIsIndependentOfUpstreamWording(t *testing.T) {
	require.NoError(t, i18n.Init())
	gin.SetMode(gin.TestMode)

	render := func(body string) string {
		router := gin.New()
		router.POST("/v1/chat/completions", func(c *gin.Context) {
			service.RespondClientError(c, upstreamMarked(types.ErrorCodeBadResponseStatusCode, http.StatusInternalServerError, body))
		})
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
		req.Header.Set("Accept-Language", "en")
		router.ServeHTTP(recorder, req)
		var parsed struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(recorder.Body.Bytes(), &parsed)
		return parsed.Error.Message
	}

	first := render(`{"error":{"message":"account abc123 exceeded its budget on host-a.internal"}}`)
	second := render(`{"error":{"message":"totally unrelated upstream failure text"}}`)
	assert.Equal(t, first, second, "client message must not depend on upstream wording")
	assert.NotContains(t, strings.ToLower(first), "internal")
}

func upstreamMarked(code types.ErrorCode, status int, body string) *types.NewAPIError {
	err := types.NewOpenAIError(errors.New(body), code, status)
	err.MarkUpstreamOrigin()
	return err
}
