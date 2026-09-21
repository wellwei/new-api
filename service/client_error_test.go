package service

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/relaykit/types"
)

// The contract these tests protect: whatever an upstream says, the client sees
// a curated message and a status that describes the failure honestly — and
// never learns the upstream's host, account or internal naming.

func upstreamErr(status int, body string) *types.NewAPIError {
	err := types.NewOpenAIError(errors.New(body), types.ErrorCodeBadResponseStatusCode, status)
	err.MarkUpstreamOrigin()
	return err
}

func TestClientMessageNeverLeaksUpstreamText(t *testing.T) {
	const leak = "Daily free limit reached on model deepseek/deepseek-v4.1-flash; " +
		"account ywellwei@gmail.com on host api.cline.bot (channel 4)"

	for _, status := range []int{400, 401, 403, 404, 429, 500, 502, 503} {
		err := upstreamErr(status, leak)
		msg := err.ClientMessage()
		for _, secret := range []string{
			"cline.bot", "ywellwei@gmail.com", "deepseek/deepseek-v4.1-flash",
			"channel 4", "Daily free limit",
		} {
			if strings.Contains(msg, secret) {
				t.Errorf("status %d: client message leaks %q: %s", status, secret, msg)
			}
		}
		if msg == "" {
			t.Errorf("status %d: client message is empty", status)
		}
	}
}

func TestClientErrorSerialsationHidesUpstreamIdentity(t *testing.T) {
	const leak = "upstream says: quota exhausted for acct-42 via api.example.internal"
	for _, status := range []int{400, 404, 429, 500, 503} {
		err := upstreamErr(status, leak)

		oai := err.ToClientOpenAIError()
		if strings.Contains(oai.Message, "example.internal") || strings.Contains(oai.Message, "acct-42") {
			t.Errorf("status %d: OpenAI payload leaks upstream: %q", status, oai.Message)
		}
		if oai.Type != string(types.ErrorTypeNewAPIError) {
			t.Errorf("status %d: type = %q", status, oai.Type)
		}
		if oai.Code == nil || oai.Code == "" {
			t.Errorf("status %d: code must be set so clients can branch", status)
		}

		claude := err.ToClientClaudeError()
		if strings.Contains(claude.Message, "example.internal") || strings.Contains(claude.Message, "acct-42") {
			t.Errorf("status %d: Claude payload leaks upstream: %q", status, claude.Message)
		}
		if claude.Type == "" {
			t.Errorf("status %d: Claude error type must be set", status)
		}
	}
}

func TestClientStatusCodeMapping(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    *types.NewAPIError
		expect int
	}{
		{
			// A 5xx from the upstream is this gateway's bad gateway, not the
			// caller's failure.
			name:   "upstream 500 becomes 502",
			err:    upstreamErr(http.StatusInternalServerError, "internal boom"),
			expect: http.StatusBadGateway,
		},
		{
			// The upstream saw the request this gateway built, so its 4xx is
			// attributed to the gateway rather than blamed on the caller.
			name:   "upstream 400 becomes 502",
			err:    upstreamErr(http.StatusBadRequest, "bad input"),
			expect: http.StatusBadGateway,
		},
		{
			// Throttling is the exception: the caller can act on it.
			name:   "upstream 429 stays 429",
			err:    upstreamErr(http.StatusTooManyRequests, "slow down"),
			expect: http.StatusTooManyRequests,
		},
		{
			// A local validation error is the caller's to fix, and stays 400.
			name:   "local 400 stays 400",
			err:    types.NewErrorWithStatusCode(errors.New("field messages is required"), types.ErrorCodeInvalidRequest, http.StatusBadRequest),
			expect: http.StatusBadRequest,
		},
		{
			name:   "quota exhaustion stays 403",
			err:    types.NewErrorWithStatusCode(errors.New("no quota"), types.ErrorCodeInsufficientUserQuota, http.StatusForbidden),
			expect: http.StatusForbidden,
		},
		{
			// "No available channel" carries ErrorCodeModelNotFound, so the
			// status alone cannot tell a missing model from a temporarily
			// capacity-less one. ClientStatusCode keeps the 503 it came with;
			// PrepareClientError narrows it to 404 only when the model is
			// genuinely absent from the abilities table.
			name:   "capacity-less channel stays 503",
			err:    types.NewErrorWithStatusCode(errors.New("no channel"), types.ErrorCodeModelNotFound, http.StatusServiceUnavailable),
			expect: http.StatusServiceUnavailable,
		},
		{
			// A model that is not served at all will never work by retrying.
			name:   "missing model becomes 404",
			err:    types.NewErrorWithStatusCode(errors.New("unknown model"), types.ErrorCodeModelNotFound, http.StatusNotFound),
			expect: http.StatusNotFound,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.err.ClientStatusCode(); got != tc.expect {
				t.Errorf("ClientStatusCode() = %d, want %d", got, tc.expect)
			}
		})
	}
}

func TestClientCategoryClassification(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    *types.NewAPIError
		expect types.ClientErrorCategory
	}{
		{"quota", types.NewErrorWithStatusCode(errors.New("x"), types.ErrorCodeInsufficientUserQuota, 403), types.ClientErrInsufficientQuota},
		{"pre-consume quota", types.NewErrorWithStatusCode(errors.New("x"), types.ErrorCodePreConsumeTokenQuotaFailed, 403), types.ClientErrInsufficientQuota},
		{"model missing", types.NewErrorWithStatusCode(errors.New("x"), types.ErrorCodeModelNotFound, 503), types.ClientErrModelUnavailable},
		{"rate limit", upstreamErr(http.StatusTooManyRequests, "429"), types.ClientErrRateLimited},
		{"content policy", types.NewErrorWithStatusCode(errors.New("x"), types.ErrorCodePromptBlocked, 400), types.ClientErrContentBlocked},
		{"upstream 5xx", upstreamErr(http.StatusBadGateway, "boom"), types.ClientErrUpstream},
		{"channel key", types.NewErrorWithStatusCode(errors.New("x"), types.ErrorCodeChannelNoAvailableKey, 500), types.ClientErrUpstream},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.err.ClientCategory(); got != tc.expect {
				t.Errorf("ClientCategory() = %q, want %q", got, tc.expect)
			}
		})
	}
}

// A category must be derived from status and code, never from message text:
// two errors that differ only in wording must classify identically. This is
// what makes it safe to reword upstream text.
func TestClassificationIgnoresMessageText(t *testing.T) {
	a := upstreamErr(http.StatusTooManyRequests, "free limit reached on model some/model")
	b := upstreamErr(http.StatusTooManyRequests, "totally different upstream wording")
	if a.ClientCategory() != b.ClientCategory() {
		t.Errorf("same status classified differently: %q vs %q", a.ClientCategory(), b.ClientCategory())
	}
	if a.ClientMessage() != b.ClientMessage() {
		t.Errorf("same status produced different client messages: %q vs %q", a.ClientMessage(), b.ClientMessage())
	}
}

// A nil localizer must still never let upstream text through.
func TestClientMessageWithoutLocalizerIsStillSafe(t *testing.T) {
	types.SetClientMessageBuilder(nil)
	defer types.SetClientMessageBuilder(defaultTestBuilder)

	err := upstreamErr(http.StatusInternalServerError, "secret internal detail")
	if msg := err.ClientMessage(); strings.Contains(msg, "secret") {
		t.Errorf("fallback message leaked upstream text: %q", msg)
	}
}

// defaultTestBuilder restores the wiring other tests expect.
func defaultTestBuilder(category types.ClientErrorCategory, err *types.NewAPIError) string {
	return ""
}

// The 404 narrowing must depend on the model table, not on the error text, and
// must stay retryable whenever it cannot tell.
func TestModelUnavailableStatusNarrowing(t *testing.T) {
	const unreachable = http.StatusServiceUnavailable

	// No model name to check: keep the retryable status rather than guess.
	if got := ModelUnavailableStatus("", unreachable); got != unreachable {
		t.Errorf("empty model name: got %d, want %d", got, unreachable)
	}

	// A model the table does not know is definitively absent.
	if got := ModelUnavailableStatus("definitely-not-a-served-model", unreachable); got != http.StatusNotFound {
		t.Errorf("unknown model: got %d, want %d", got, http.StatusNotFound)
	}

	// The narrowing only ever turns 503 into 404; other statuses pass through.
	for _, status := range []int{http.StatusBadRequest, http.StatusForbidden, http.StatusTooManyRequests} {
		if got := ModelUnavailableStatus("definitely-not-a-served-model", status); got != status {
			t.Errorf("status %d must pass through unchanged, got %d", status, got)
		}
	}
}
