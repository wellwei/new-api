package openai

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// 上游（如 cline2api 透传 Cline/Vercel 的 in-band 错误）在 200 SSE 的第一个
// data 帧给出错误对象、随后紧跟 [DONE] 的形态。该帧曾触发
// responses_via_chat 在赋值 streamErr 之前调用 sr.Stop(typed-nil) 的 panic。
const upstreamErrorSSEBody = "data: {\"error\":{\"code\":\"stream_initialization_failed\",\"message\":\"Failed to create stream: inference request failed: failed to generate stream from Vercel.\",\"request_id\":\"duLWbtwGPvyFbUeBHBEszRospqRJGLVn\",\"type\":\"stream_error\"}}\n" +
	"\n" +
	"data: [DONE]\n" +
	"\n"

func newResponsesUpstreamErrorContext(t *testing.T) (*gin.Context, *httptest.ResponseRecorder, *http.Response, *relaycommon.RelayInfo) {
	t.Helper()

	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })

	oldTimeout := constant.StreamingTimeout
	constant.StreamingTimeout = 30
	t.Cleanup(func() { constant.StreamingTimeout = oldTimeout })

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	c.Set(common.RequestIdKey, "upstream-error-frame-test")

	resp := &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(upstreamErrorSSEBody)),
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
	}
	info := &relaycommon.RelayInfo{
		ChannelMeta:        &relaycommon.ChannelMeta{UpstreamModelName: "cline-free/gemini-3.8-flash"},
		IsStream:           true,
		RelayFormat:        types.RelayFormatOpenAIResponses,
		ShouldIncludeUsage: true,
		DisablePing:        true,
	}
	return c, recorder, resp, info
}

// TestOaiChatToResponsesStreamHandlerUpstreamErrorFrameStopsWithError 断言：
// 流内首帧错误对象 → 向客户端转发 error/response.failed 事件、handler 返回
// 上游错误（不再被 typed-nil 吞成“成功”）、StreamStatus 记录真实错误文本。
func TestOaiChatToResponsesStreamHandlerUpstreamErrorFrameStopsWithError(t *testing.T) {
	c, recorder, resp, info := newResponsesUpstreamErrorContext(t)

	usage, apiErr := OaiChatToResponsesStreamHandler(c, info, resp)

	require.Nil(t, usage)
	require.NotNil(t, apiErr, "handler must surface the upstream error instead of treating the stream as a success")
	require.Contains(t, apiErr.Error(), "Failed to create stream")

	body := recorder.Body.String()
	require.Contains(t, body, `"type":"error"`)
	require.Contains(t, body, "Failed to create stream")
	require.Contains(t, body, `"type":"response.failed"`)

	status := info.StreamStatus
	require.NotNil(t, status)
	require.Equal(t, 1, status.TotalErrorCount())
	require.NotEmpty(t, status.Errors[0].Message, "recorded stream error must carry the upstream message")
	require.Contains(t, status.Errors[0].Message, "Failed to create stream")
}
