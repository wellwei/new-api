package openai

import (
	"fmt"
	"io"
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/logger"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

func OaiResponsesHandler(c *gin.Context, info *relaycommon.RelayInfo, resp *http.Response) (*dto.Usage, *types.NewAPIError) {
	defer service.CloseResponseBodyGracefully(resp)

	// read response body
	var responsesResponse dto.OpenAIResponsesResponse
	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, types.NewOpenAIError(err, types.ErrorCodeReadResponseBodyFailed, http.StatusInternalServerError)
	}
	err = common.Unmarshal(responseBody, &responsesResponse)
	if err != nil {
		return nil, types.NewOpenAIError(err, types.ErrorCodeBadResponseBody, http.StatusInternalServerError)
	}
	if oaiError := responsesResponse.GetOpenAIError(); oaiError != nil && oaiError.Type != "" {
		return nil, types.WithOpenAIError(*oaiError, resp.StatusCode)
	}

	info.ObserveResponseModel(responsesResponse.Model)
	responseBody = rewriteSGLangResponsesCreatedAt(info, responseBody, "created_at", responsesResponse.CreatedAt)

	// 写入新的 response body
	service.IOCopyBytesGracefully(c, resp, responseBody)

	// compute usage
	usage := &dto.Usage{}
	service.ApplyResponsesUsage(usage, responsesResponse.Usage)
	// Count actual tool invocations from Output (not tool declarations).
	for _, output := range responsesResponse.Output {
		switch output.Type {
		case dto.BuildInCallWebSearchCall:
			info.CountBillableToolCall(dto.BuildInCallWebSearchCall, "")
		case dto.BuildInCallFileSearchCall:
			info.CountBillableToolCall(dto.BuildInCallFileSearchCall, "")
		case dto.BuildInCallFunctionCall:
			info.CountBillableToolCall(dto.BuildInCallFunctionCall, output.Name)
		}
	}

	imageCounter := &relaycommon.ImageGenerationCallCounter{}
	if !relaycommon.IsNonBillableResponsesStatus(responsesResponse.Status) {
		for i := range responsesResponse.Output {
			idx := i
			imageCounter.Observe(&responsesResponse.Output[i], &idx)
		}
	}
	imageCounter.Commit(info)

	return usage, nil
}

func OaiResponsesStreamHandler(c *gin.Context, info *relaycommon.RelayInfo, resp *http.Response) (*dto.Usage, *types.NewAPIError) {
	if resp == nil || resp.Body == nil {
		logger.LogError(c, "invalid response or response body")
		return nil, types.NewError(fmt.Errorf("invalid response"), types.ErrorCodeBadResponse)
	}

	defer service.CloseResponseBodyGracefully(resp)

	accumulator := service.NewResponsesUsageAccumulator(info)
	hasSentErrorEvent := false

	helper.StreamScannerHandler(c, resp, info, func(data string, sr *helper.StreamResult) {

		// 检查当前数据是否包含 completed 状态和 usage 信息
		var streamResponse dto.ResponsesStreamResponse
		if err := common.UnmarshalJsonStr(data, &streamResponse); err != nil {
			logger.LogError(c, "failed to unmarshal stream response: "+err.Error())
			sr.Error(err)
			return
		}
		if streamResponse.Type == "error" {
			hasSentErrorEvent = true
		}
		if streamResponse.Response != nil {
			data = string(rewriteSGLangResponsesCreatedAt(info, []byte(data), "response.created_at", streamResponse.Response.CreatedAt))
		}

		isFailedTerminal := streamResponse.Type == "response.failed" ||
			(streamResponse.Response != nil && string(streamResponse.Response.Status) == `"failed"`)
		if isFailedTerminal && !hasSentErrorEvent {
			code := "server_error"
			message := "upstream response failed"
			if streamResponse.Code != "" {
				code = streamResponse.Code
			}
			if streamResponse.Message != "" {
				message = streamResponse.Message
			}
			if streamResponse.Response != nil {
				if oaiErr := streamResponse.Response.GetOpenAIError(); oaiErr != nil {
					if oaiErr.Code != nil {
						code = fmt.Sprint(oaiErr.Code)
					}
					if oaiErr.Message != "" {
						message = oaiErr.Message
					}
				}
			}
			errorResp := dto.ResponsesStreamResponse{
				Type:    "error",
				Code:    code,
				Message: message,
			}
			if errorData, err := common.Marshal(errorResp); err == nil {
				sendResponsesStreamData(c, errorResp, string(errorData))
				accumulator.Observe(&errorResp)
				hasSentErrorEvent = true
			}
		}

		sendResponsesStreamData(c, streamResponse, data)
		accumulator.Observe(&streamResponse)
	})

	outcome := info.StreamStatus.ResponseOutcome()
	if outcome == "" && !accumulator.HasOutput() && (info.StreamStatus.EndReason == relaycommon.StreamEndReasonEOF || info.StreamStatus.EndReason == relaycommon.StreamEndReasonDone) {
		code := "upstream_error"
		message := "upstream stream ended prematurely with no output"
		errorResp := dto.ResponsesStreamResponse{
			Type:    "error",
			Code:    code,
			Message: message,
		}
		if errorData, err := common.Marshal(errorResp); err == nil {
			sendResponsesStreamData(c, errorResp, string(errorData))
			accumulator.Observe(&errorResp)
		}
		failedResp := dto.ResponsesStreamResponse{
			Type: "response.failed",
			Response: &dto.OpenAIResponsesResponse{
				Object: "response",
				Status: []byte(`"failed"`),
				Error: map[string]any{
					"code":    code,
					"message": message,
				},
			},
		}
		if failedData, err := common.Marshal(failedResp); err == nil {
			sendResponsesStreamData(c, failedResp, string(failedData))
			accumulator.Observe(&failedResp)
		}
		info.StreamStatus.MarkFailed(code, "server_error", http.StatusBadGateway)
	}

	common.SetContextKey(c, constant.ContextKeyResponseStreamStatus, info.StreamStatus)
	info.StreamStatus.RequireTerminal()
	return accumulator.Finish(), nil
}

func rewriteSGLangResponsesCreatedAt(info *relaycommon.RelayInfo, payload []byte, path string, createdAt dto.IntValue) []byte {
	if info.GetChannelType() != constant.ChannelTypeSGLang {
		return payload
	}
	if !gjson.GetBytes(payload, path).Exists() {
		return payload
	}
	patched, err := sjson.SetBytes(payload, path, int(createdAt))
	if err != nil {
		return payload
	}
	return patched
}
