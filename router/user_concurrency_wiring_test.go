package router

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// carriesConcurrencyGate reports whether a handler chain includes the per-user
// in-flight gate. The gate is a named function rather than a closure so this
// comparison is stable: a fresh closure would only ever match itself.
func carriesConcurrencyGate(handlers []gin.HandlerFunc) bool {
	want := reflect.ValueOf(middleware.UserConcurrencyLimit()).Pointer()
	for _, handler := range handlers {
		if reflect.ValueOf(handler).Pointer() == want {
			return true
		}
	}
	return false
}

// TestPluginProtocolRoutesCarryConcurrencyGate covers the surfaces registered
// outside the /v1 group through the protocol registry, which have to install the
// gate themselves; the group-level registration cannot reach them.
func TestPluginProtocolRoutesCarryConcurrencyGate(t *testing.T) {
	gin.SetMode(gin.TestMode)

	for _, operation := range []string{"create"} {
		handlers, err := taskPluginProtocolHandlers("openai_responses", operation)
		assert.NoError(t, err)
		assert.True(t, carriesConcurrencyGate(handlers), "openai_responses.%s must pass the gate", operation)
	}

	for _, operation := range []string{"generate", "edit"} {
		handlers, err := taskPluginProtocolHandlers("openai_image", operation)
		assert.NoError(t, err)
		assert.True(t, carriesConcurrencyGate(handlers), "openai_image.%s consumes upstream capacity and must pass the gate", operation)
	}

	handlers, err := taskPluginProtocolHandlers("openai_video", "create")
	assert.NoError(t, err)
	assert.True(t, carriesConcurrencyGate(handlers), "openai_video.create must pass the gate")

	// Retrieval and content reads return stored state; they hold no slot.
	for _, operation := range []string{"retrieve", "content"} {
		handlers, err := taskPluginProtocolHandlers("openai_video", operation)
		assert.NoError(t, err)
		assert.False(t, carriesConcurrencyGate(handlers), "openai_video.%s returns stored state, not a relay", operation)
	}
	retrieveHandlers, err := taskPluginProtocolHandlers("openai_responses", "retrieve")
	assert.NoError(t, err)
	assert.False(t, carriesConcurrencyGate(retrieveHandlers), "openai_responses.retrieve returns stored state, not a relay")
}

// withGroupConcurrency installs the gate configuration for one test and restores
// the previous state afterwards. The limiter is process-wide by design, so the
// counters must not leak between tests.
func withGroupConcurrency(t *testing.T, limits map[string]int) {
	t.Helper()
	previousEnabled := setting.UserConcurrencyLimitEnabled
	previousLimits := setting.UserConcurrencyLimitGroup
	setting.UserConcurrencyLimitEnabled = true
	setting.UserConcurrencyLimitGroup = limits
	t.Cleanup(func() {
		setting.UserConcurrencyLimitEnabled = previousEnabled
		setting.UserConcurrencyLimitGroup = previousLimits
	})
}

// createGatedRelayUser registers a user in the given group with its own token.
func createGatedRelayUser(t *testing.T, name, group string, role int) string {
	t.Helper()
	user := &model.User{Username: name, Status: common.UserStatusEnabled, Group: group, Quota: 10_000_000, Role: role, AuthVersion: 1}
	require.NoError(t, model.DB.Create(user).Error)
	token := &model.Token{UserId: user.Id, Key: strings.ReplaceAll(name, "-", ""), Status: common.TokenStatusEnabled, ExpiredTime: -1, UnlimitedQuota: true}
	require.NoError(t, model.DB.Create(token).Error)
	return "Bearer sk-" + token.Key
}

// createGatedChannel points a channel at the stub upstream for one group, so a
// test can exercise a tier other than the default one.
func createGatedChannel(t *testing.T, upstreamURL, group string) {
	t.Helper()
	channel := &model.Channel{
		Name:    "gated-upstream-" + group,
		Key:     "upstream-key",
		Status:  common.ChannelStatusEnabled,
		Type:    constant.ChannelTypeOpenAI,
		Group:   group,
		Models:  requestedModel,
		BaseURL: &upstreamURL,
	}
	require.NoError(t, model.DB.Create(channel).Error)
	require.NoError(t, model.DB.Create(&model.Ability{ChannelId: channel.Id, Model: requestedModel, Group: group, Enabled: true}).Error)
}

const gatedCompletionBody = `{"id":"c1","object":"chat.completion","created":1,"model":"upstream","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`

// holdFirstUpstream answers every request immediately except the first, which it
// holds until released. Holdings only the first request lets a test pin one
// request inside its slot while follow-ups — issued synchronously by the test
// itself — still complete.
func holdFirstUpstream(t *testing.T) (*httptest.Server, <-chan struct{}, chan<- struct{}) {
	t.Helper()
	reached := make(chan struct{})
	release := make(chan struct{})
	var mu sync.Mutex
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		isFirst := calls == 1
		mu.Unlock()
		if isFirst {
			close(reached)
			<-release
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(gatedCompletionBody))
	}))
	t.Cleanup(server.Close)
	return server, reached, release
}

// holdFirstStreamUpstream answers the first request with an event stream that
// stays open until released, and later requests with a plain completion.
func holdFirstStreamUpstream(t *testing.T) (*httptest.Server, <-chan struct{}, chan<- struct{}) {
	t.Helper()
	started := make(chan struct{})
	release := make(chan struct{})
	var mu sync.Mutex
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		isFirst := calls == 1
		mu.Unlock()
		if !isFirst {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(gatedCompletionBody))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		if flusher != nil {
			flusher.Flush()
		}
		_, _ = w.Write([]byte(`data: {"id":"c1","object":"chat.completion.chunk","model":"upstream","choices":[{"index":0,"delta":{"content":"ok"}}]}` + "\n\n"))
		if flusher != nil {
			flusher.Flush()
		}
		close(started)
		<-release
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	t.Cleanup(server.Close)
	return server, started, release
}

// gatedChatCompletion posts one chat completion through the real relay router.
func gatedChatCompletion(engine *gin.Engine, bearer string, stream bool) (*httptest.ResponseRecorder, *http.Request) {
	body := `{"model":"` + requestedModel + `","messages":[{"role":"user","content":"hi"}],"max_tokens":16}`
	if stream {
		body = `{"model":"` + requestedModel + `","messages":[{"role":"user","content":"hi"}],"max_tokens":16,"stream":true}`
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	request.Header.Set("Authorization", bearer)
	request.Header.Set("Content-Type", "application/json")
	return httptest.NewRecorder(), request
}

// startHeldRequest issues one request in the background and waits until it is
// inside its slot, which is signalled by the stub upstream being reached.
func startHeldRequest(t *testing.T, engine *gin.Engine, bearer string, stream bool, reached <-chan struct{}) <-chan int {
	t.Helper()
	done := make(chan int, 1)
	go func() {
		recorder, request := gatedChatCompletion(engine, bearer, stream)
		engine.ServeHTTP(recorder, request)
		done <- recorder.Code
	}()
	select {
	case <-reached:
	case <-time.After(15 * time.Second):
		t.Fatal("the held request never reached the upstream")
	}
	return done
}

// TestUserConcurrencyGateRejectsSecondConcurrentRelay is the acceptance test for
// the ceiling: through the real router, one user holding the single slot their
// group allows gets their second concurrent request refused with 429 before it
// can reach a channel.
func TestUserConcurrencyGateRejectsSecondConcurrentRelay(t *testing.T) {
	setupRelayProjectionTestDB(t)
	withGroupConcurrency(t, map[string]int{"default": 1})

	upstream, reached, release := holdFirstUpstream(t)
	createGatedChannel(t, upstream.URL, "default")
	bearer := createGatedRelayUser(t, "gated-free-user", "default", common.RoleCommonUser)

	engine := gin.New()
	SetRelayRouter(engine)

	firstDone := startHeldRequest(t, engine, bearer, false, reached)

	second, secondRequest := gatedChatCompletion(engine, bearer, false)
	engine.ServeHTTP(second, secondRequest)
	require.Equal(t, http.StatusTooManyRequests, second.Code)
	assert.Contains(t, second.Body.String(), "concurrency_limit_exceeded")

	close(release)
	assert.Equal(t, http.StatusOK, <-firstDone)

	// The slot comes back once the request completes.
	third, thirdRequest := gatedChatCompletion(engine, bearer, false)
	engine.ServeHTTP(third, thirdRequest)
	assert.Equal(t, http.StatusOK, third.Code)
}

// TestUserConcurrencyGateHoldsSlotThroughStreaming pins the release point that
// matters most: a streamed response keeps its slot until the stream ends, not
// until the headers are written.
func TestUserConcurrencyGateHoldsSlotThroughStreaming(t *testing.T) {
	setupRelayProjectionTestDB(t)
	withGroupConcurrency(t, map[string]int{"default": 1})

	upstream, started, release := holdFirstStreamUpstream(t)
	createGatedChannel(t, upstream.URL, "default")
	bearer := createGatedRelayUser(t, "gated-stream-user", "default", common.RoleCommonUser)

	engine := gin.New()
	SetRelayRouter(engine)

	firstDone := startHeldRequest(t, engine, bearer, true, started)

	second, secondRequest := gatedChatCompletion(engine, bearer, true)
	engine.ServeHTTP(second, secondRequest)
	assert.Equal(t, http.StatusTooManyRequests, second.Code, "the stream still holds the slot")

	close(release)
	assert.Equal(t, http.StatusOK, <-firstDone)

	// After the stream ends the slot is free again.
	third, thirdRequest := gatedChatCompletion(engine, bearer, false)
	engine.ServeHTTP(third, thirdRequest)
	assert.Equal(t, http.StatusOK, third.Code)
}

// TestUserConcurrencyGateLeavesUnlistedGroupsAlone pins that installing the gate
// for one tier does not throttle a group the operator did not list.
func TestUserConcurrencyGateLeavesUnlistedGroupsAlone(t *testing.T) {
	setupRelayProjectionTestDB(t)
	withGroupConcurrency(t, map[string]int{"default": 1})

	upstream, reached, release := holdFirstUpstream(t)
	createGatedChannel(t, upstream.URL, "vip")
	bearer := createGatedRelayUser(t, "gated-vip-user", "vip", common.RoleCommonUser)

	engine := gin.New()
	SetRelayRouter(engine)

	firstDone := startHeldRequest(t, engine, bearer, false, reached)

	second, secondRequest := gatedChatCompletion(engine, bearer, false)
	engine.ServeHTTP(second, secondRequest)
	assert.Equal(t, http.StatusOK, second.Code, "a group the operator did not list has no ceiling")

	close(release)
	<-firstDone
}

// TestUserConcurrencyGateExemptsOperators pins that the operator's own tooling
// is not throttled by the ceiling meant for the tiers below them.
func TestUserConcurrencyGateExemptsOperators(t *testing.T) {
	setupRelayProjectionTestDB(t)
	withGroupConcurrency(t, map[string]int{"default": 1})

	upstream, reached, release := holdFirstUpstream(t)
	createGatedChannel(t, upstream.URL, "default")
	bearer := createGatedRelayUser(t, "gated-admin-user", "default", common.RoleAdminUser)

	engine := gin.New()
	SetRelayRouter(engine)

	firstDone := startHeldRequest(t, engine, bearer, false, reached)

	second, secondRequest := gatedChatCompletion(engine, bearer, false)
	engine.ServeHTTP(second, secondRequest)
	assert.Equal(t, http.StatusOK, second.Code, "an operator is exempt from the ceiling")

	close(release)
	<-firstDone
}

// TestConcurrencyLimitableRoutesAreRegistered guards the gate's coverage against
// a route moving or being renamed: these are the surfaces a caller reaches to
// spend upstream capacity, so each must exist under the path this test and the
// documentation assume.
func TestConcurrencyLimitableRoutesAreRegistered(t *testing.T) {
	setupRelayProjectionTestDB(t)

	engine := gin.New()
	SetRelayRouter(engine)
	SetVideoRouter(engine)
	SetTaskRouter(engine)
	SetPluginRouter(engine)
	SetTaskPluginProtocolRouter(engine)

	registered := make(map[string]bool)
	for _, route := range engine.Routes() {
		registered[route.Method+" "+route.Path] = true
	}

	for _, route := range []string{
		"POST /v1/chat/completions",
		"POST /v1/completions",
		"POST /v1/messages",
		"POST /v1/responses/compact",
		"POST /v1/embeddings",
		"POST /v1/rerank",
		"POST /v1beta/models/*path",
		"POST /pg/chat/completions",
		"POST /v1/video/generations",
		"POST /v1/videos/:video_id/remix",
		"POST /v1/tasks/:key",
	} {
		assert.True(t, registered[route], "route %s must be registered so the gate can protect it", route)
	}
}
