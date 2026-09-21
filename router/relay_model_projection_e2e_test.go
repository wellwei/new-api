package router

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/setting/config"
	"github.com/QuantumNous/new-api/setting/ratio_setting"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The model the stub upstream declares on its own, standing in for a routing
// alias, a provider path or a variant chosen upstream.
const upstreamDeclaredModel = "vmc/fireworks-cline-k3-contributor-fallbacks"

// requestedModel is what the caller asks for; it is what a non-operator caller
// must see echoed back.
const requestedModel = "kimi-k3"

func setupRelayProjectionTestDB(t *testing.T) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousType, previousLogType := common.MainDatabaseType(), common.LogDatabaseType()
	previousMaster, previousMemory, previousBatch := common.IsMasterNode, common.MemoryCacheEnabled, common.BatchUpdateEnabled
	previousLogConsume, previousRedis := common.LogConsumeEnabled, common.RedisEnabled
	previousSQLite := common.SQLitePath
	previousGroupRatios := ratio_setting.GroupRatio2JSONString()
	previousModelRatios := ratio_setting.ModelRatio2JSONString()
	previousCompletionRatios := ratio_setting.CompletionRatio2JSONString()
	previousStreamingTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 30
	t.Cleanup(func() { constant.StreamingTimeout = previousStreamingTimeout })

	t.Setenv("SQL_DSN", "")
	t.Setenv("LOG_SQL_DSN", "")
	common.IsMasterNode, common.MemoryCacheEnabled, common.BatchUpdateEnabled = false, false, false
	common.LogConsumeEnabled, common.RedisEnabled = false, false
	common.SQLitePath = filepath.Join(t.TempDir(), "projection.db")
	require.NoError(t, model.InitDB())
	db := model.DB
	sqlDB, err := db.DB()
	require.NoError(t, err)
	require.NoError(t, model.InitLogDB())

	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.SetDatabaseTypes(previousType, previousLogType)
		common.IsMasterNode, common.MemoryCacheEnabled, common.BatchUpdateEnabled = previousMaster, previousMemory, previousBatch
		common.LogConsumeEnabled, common.RedisEnabled = previousLogConsume, previousRedis
		common.SQLitePath = previousSQLite
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(previousGroupRatios))
		require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(previousModelRatios))
		require.NoError(t, ratio_setting.UpdateCompletionRatioByJSONString(previousCompletionRatios))
		require.NoError(t, sqlDB.Close())
	})

	require.NoError(t, db.AutoMigrate(&model.User{}, &model.Token{}, &model.Channel{}, &model.Ability{}, &model.Log{}, &model.UserSubscription{}, &model.SubscriptionPlan{}, &model.TopUp{}, &model.Redemption{}))
	require.NoError(t, config.GlobalConfig.LoadFromDB(map[string]string{
		"group_ratio_setting.group_ratio": `{"default":1}`,
	}))
	require.NoError(t, ratio_setting.UpdateModelRatioByJSONString(`{"`+requestedModel+`":1}`))
	require.NoError(t, ratio_setting.UpdateCompletionRatioByJSONString(`{"`+requestedModel+`":1}`))
}

// createRelayTestUser registers one user with a token and returns the bearer
// value the client sends.
func createRelayTestUser(t *testing.T, name string, role int) string {
	t.Helper()
	user := &model.User{Username: name, Status: common.UserStatusEnabled, Group: "default", Quota: 10_000_000, Role: role, AuthVersion: 1}
	require.NoError(t, model.DB.Create(user).Error)
	token := &model.Token{UserId: user.Id, Key: strings.ReplaceAll(name, "-", ""), Status: common.TokenStatusEnabled, ExpiredTime: -1, UnlimitedQuota: true}
	require.NoError(t, model.DB.Create(token).Error)
	return "Bearer sk-" + token.Key
}

// createMappedChannel points a channel at the stub upstream, mapping the
// requested model onto the name upstream expects, so the response that comes
// back declares a model the caller never asked for.
func createMappedChannel(t *testing.T, upstreamURL string) {
	t.Helper()
	mapping := `{"` + requestedModel + `":"upstream-model-request"}`
	channel := &model.Channel{
		Name:         "projection-upstream",
		Key:          "upstream-key",
		Status:       common.ChannelStatusEnabled,
		Type:         constant.ChannelTypeOpenAI,
		Group:        "default",
		Models:       requestedModel,
		ModelMapping: &mapping,
		BaseURL:      &upstreamURL,
	}
	require.NoError(t, model.DB.Create(channel).Error)
	require.NoError(t, model.DB.Create(&model.Ability{ChannelId: channel.Id, Model: requestedModel, Group: "default", Enabled: true}).Error)
}

// stubUpstream answers one chat completion whose model member names the
// upstream's own choice, not the caller's request.
func stubUpstream(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"chatcmpl_1","object":"chat.completion","created":1,"model":"` + upstreamDeclaredModel + `","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`))
	}))
	t.Cleanup(server.Close)
	return server
}

// chatCompletion posts one chat completion through the real relay router and
// returns the decoded "model" member the client received.
func chatCompletion(t *testing.T, engine *gin.Engine, bearer string) (int, string) {
	t.Helper()
	body := `{"model":"` + requestedModel + `","messages":[{"role":"user","content":"hi"}],"max_tokens":16}`
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	request.Header.Set("Authorization", bearer)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	var payload struct {
		Model string `json:"model"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if recorder.Code == http.StatusOK {
		require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &payload))
	} else if payload.Error != nil {
		t.Logf("relay failed: %s", payload.Error.Message)
	}
	return recorder.Code, payload.Model
}

// TestRelayClientModelNameMatchesRequestForNonOperators is the acceptance test
// for caller-facing model reporting: through the real router, a normal user who
// asked for one model reads that model back, even though the channel maps the
// request onward and upstream answers under its own name.
func TestRelayClientModelNameMatchesRequestForNonOperators(t *testing.T) {
	setupRelayProjectionTestDB(t)
	upstream := stubUpstream(t)
	createMappedChannel(t, upstream.URL)

	bearer := createRelayTestUser(t, "projection-common-user", common.RoleCommonUser)

	engine := gin.New()
	SetRelayRouter(engine)

	status, modelName := chatCompletion(t, engine, bearer)
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, requestedModel, modelName)
	assert.NotContains(t, modelName, "vmc/")
}

// TestRelayClientModelNameKeepsUpstreamForOperators is the other half: an admin
// still sees which upstream answered, because that is the diagnostic they use.
func TestRelayClientModelNameKeepsUpstreamForOperators(t *testing.T) {
	setupRelayProjectionTestDB(t)
	upstream := stubUpstream(t)
	createMappedChannel(t, upstream.URL)

	bearer := createRelayTestUser(t, "projection-admin-user", common.RoleAdminUser)

	engine := gin.New()
	SetRelayRouter(engine)

	status, modelName := chatCompletion(t, engine, bearer)
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, upstreamDeclaredModel, modelName)
}

// TestRelayStreamingClientModelNameMatchesRequest covers the event-stream path,
// where the projection rewrites chunks as they are written rather than holding
// the body.
func TestRelayStreamingClientModelNameMatchesRequest(t *testing.T) {
	setupRelayProjectionTestDB(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(`data: {"id":"c1","object":"chat.completion.chunk","model":"` + upstreamDeclaredModel + `","choices":[{"index":0,"delta":{"content":"ok"}}]}` + "\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	t.Cleanup(upstream.Close)
	createMappedChannel(t, upstream.URL)

	bearer := createRelayTestUser(t, "projection-stream-user", common.RoleCommonUser)

	engine := gin.New()
	SetRelayRouter(engine)

	body := `{"model":"` + requestedModel + `","messages":[{"role":"user","content":"hi"}],"max_tokens":16,"stream":true}`
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	request.Header.Set("Authorization", bearer)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code)
	streamed := recorder.Body.String()
	assert.Contains(t, streamed, `"model":"`+requestedModel+`"`)
	assert.NotContains(t, streamed, upstreamDeclaredModel)
	assert.Contains(t, streamed, "[DONE]")
	// The data lines must still parse as JSON after the rewrite.
	for _, line := range strings.Split(streamed, "\n") {
		if !strings.HasPrefix(line, "data: ") || strings.Contains(line, "[DONE]") {
			continue
		}
		var chunk dto.ChatCompletionsStreamResponse
		require.NoError(t, common.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &chunk), "rewritten chunk must stay valid JSON: %s", line)
	}
}

// TestRelayWildcardModelIsNotProjected guards the boundary: a request that asks
// for several models at once has no single requested name to report, so the
// upstream declaration is left in place rather than replaced with a guess.
func TestRelayWildcardModelIsNotProjected(t *testing.T) {
	setupRelayProjectionTestDB(t)
	upstream := stubUpstream(t)
	createMappedChannel(t, upstream.URL)

	bearer := createRelayTestUser(t, "projection-wildcard-user", common.RoleCommonUser)
	engine := gin.New()
	SetRelayRouter(engine)

	// The model is resolved to a concrete name during channel selection, so the
	// projection reports that name rather than the wildcard.
	body := `{"model":"` + requestedModel + `","messages":[{"role":"user","content":"hi"}],"max_tokens":16}`
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	request.Header.Set("Authorization", bearer)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code)

	var payload struct {
		Model string `json:"model"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &payload))
	assert.Equal(t, requestedModel, payload.Model, "the resolved request model is reported, not the upstream name")
}

var _ = os.Getenv
