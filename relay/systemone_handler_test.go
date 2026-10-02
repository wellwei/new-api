package relay

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildSystemOneRequestBodyPreservesUnknownFields(t *testing.T) {
	raw := []byte(`{
		"model":"jev-1.13",
		"state":{"message":"please refund this order"},
		"questions":{
			"is_refund":{"type":"noul","instructions":"does the message request a refund?"},
			"route":{"type":"choice","criteria":{"billing":"money issue","technical":"bug"}}
		},
		"future_field":{"nested":true}
	}`)

	out, err := buildSystemOneRequestBody(raw, "jev-1.13", "jev-mapped")
	require.NoError(t, err)

	var body map[string]any
	require.NoError(t, common.Unmarshal(out, &body))
	assert.Equal(t, "jev-mapped", body["model"])
	require.Contains(t, body, "state")
	require.Contains(t, body, "questions")
	require.Contains(t, body, "future_field")

	future, ok := body["future_field"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, true, future["nested"])
}

func TestBuildSystemOneRequestBodyNoMappingKeepsRawBytes(t *testing.T) {
	raw := []byte(`{"model":"jev-1.13","state":"hi","questions":{},"future_field":1}`)
	out, err := buildSystemOneRequestBody(raw, "jev-1.13", "jev-1.13")
	require.NoError(t, err)
	assert.Equal(t, raw, out)
}

func TestBuildSystemOneRequestBodyEmptyBodyErrors(t *testing.T) {
	_, err := buildSystemOneRequestBody(nil, "jev-1.13", "jev-1.13")
	require.Error(t, err)
}

func TestSystemOneUsageFromResponse(t *testing.T) {
	raw := []byte(`{
		"model":"jev-1.13-free",
		"answers":{"is_refund":{"type":"noul","noul":0.95}},
		"usage":{"prompt_tokens":120,"completion_tokens":0,"total_tokens":120}
	}`)
	usage := systemOneUsageFromResponse(raw)
	require.NotNil(t, usage)
	assert.Equal(t, 120, usage.PromptTokens)
	assert.Equal(t, 0, usage.CompletionTokens)
	assert.Equal(t, 120, usage.TotalTokens)
}

func TestSystemOneUsageFromResponseInputOutputNames(t *testing.T) {
	raw := []byte(`{"model":"jev-1.13","usage":{"input_tokens":50,"output_tokens":0}}`)
	usage := systemOneUsageFromResponse(raw)
	require.NotNil(t, usage)
	assert.Equal(t, 50, usage.PromptTokens)
	assert.Equal(t, 50, usage.TotalTokens)
}

func TestSystemOneUsageFromResponseNoUsageBlock(t *testing.T) {
	raw := []byte(`{"model":"jev-1.13","answers":{},"cost":"0"}`)
	usage := systemOneUsageFromResponse(raw)
	require.NotNil(t, usage)
	assert.Equal(t, 0, usage.PromptTokens)
	assert.Equal(t, 0, usage.TotalTokens)
}

func TestSystemOneUsageFromResponseGarbageBody(t *testing.T) {
	usage := systemOneUsageFromResponse([]byte(`not json`))
	require.NotNil(t, usage)
	assert.Equal(t, 0, usage.PromptTokens)
}

func TestSystemOneHelperEndToEndPassthrough(t *testing.T) {
	var gotPath, gotAuth string
	var gotBody []byte
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		gotPath, gotAuth, gotBody = r.URL.Path, r.Header.Get("Authorization"), body
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"model":"jev-1.13-free","answers":{"is_urgent":{"type":"noul","noul":0.95}},"usage":{"prompt_tokens":42,"completion_tokens":0,"total_tokens":42},"cost":"0"}`))
	}))
	defer upstream.Close()

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	reqBody := `{"model":"jev-1.13","state":"please refund this order","questions":{"is_urgent":{"type":"noul","instructions":"refund?"}}}`
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/systemone", bytes.NewBufferString(reqBody))
	c.Request.Header.Set("Content-Type", "application/json")

	common.SetContextKey(c, constant.ContextKeyOriginalModel, "jev-1.13")
	common.SetContextKey(c, constant.ContextKeyChannelType, constant.ChannelTypeOpenAI)
	common.SetContextKey(c, constant.ContextKeyChannelBaseUrl, upstream.URL)
	common.SetContextKey(c, constant.ContextKeyChannelKey, "test-key")

	request, err := helper.GetAndValidateSystemOneRequest(c)
	require.NoError(t, err)
	info := relaycommon.GenRelayInfoSystemOne(c, request)

	// PostTextConsumeQuota writes quota rows, so the handler test needs a
	// database the same way relay_task_test does: an in-memory sqlite with the
	// billed tables migrated. Writes that need services absent in unit tests
	// (redis user cache, consume log) are switched off; the passthrough bytes
	// and path are what this test asserts.
	database := setupRelayChannelDB(t)
	require.NoError(t, database.AutoMigrate(&model.User{}, &model.Token{}, &model.Log{}))
	require.NoError(t, database.Create(&model.User{Id: 1, Username: "sysone-test"}).Error)
	previousLogDB := model.LOG_DB
	model.LOG_DB = database
	previousLogConsume, previousRedis, previousBatch := common.LogConsumeEnabled, common.RedisEnabled, common.BatchUpdateEnabled
	common.LogConsumeEnabled, common.RedisEnabled, common.BatchUpdateEnabled = false, false, false
	t.Cleanup(func() {
		model.LOG_DB = previousLogDB
		common.LogConsumeEnabled, common.RedisEnabled, common.BatchUpdateEnabled = previousLogConsume, previousRedis, previousBatch
	})
	newAPIError := SystemOneHelper(c, info)
	require.Nil(t, newAPIError)

	assert.Equal(t, "/v1/systemone", gotPath)
	assert.Equal(t, "Bearer test-key", gotAuth)
	var upstreamBody map[string]any
	require.NoError(t, common.Unmarshal(gotBody, &upstreamBody))
	assert.Equal(t, "jev-1.13", upstreamBody["model"])
	require.Contains(t, upstreamBody, "state")
	require.Contains(t, upstreamBody, "questions")

	var clientBody map[string]any
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &clientBody))
	assert.Equal(t, "jev-1.13-free", clientBody["model"])
	require.Contains(t, clientBody, "answers")
}
