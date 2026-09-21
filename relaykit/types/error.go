package types

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	kitutil "github.com/QuantumNous/new-api/relaykit/relayconvert/kitutil"
)

type OpenAIError struct {
	Message  string          `json:"message"`
	Type     string          `json:"type"`
	Param    string          `json:"param"`
	Code     any             `json:"code"`
	Metadata json.RawMessage `json:"metadata,omitempty"`
}

type ClaudeError struct {
	Type    string `json:"type,omitempty"`
	Message string `json:"message,omitempty"`
}

type ErrorType string

const (
	ErrorTypeNewAPIError     ErrorType = "new_api_error"
	ErrorTypeOpenAIError     ErrorType = "openai_error"
	ErrorTypeClaudeError     ErrorType = "claude_error"
	ErrorTypeMidjourneyError ErrorType = "midjourney_error"
	ErrorTypeGeminiError     ErrorType = "gemini_error"
	ErrorTypeRerankError     ErrorType = "rerank_error"
	ErrorTypeUpstreamError   ErrorType = "upstream_error"
)

type ErrorCode string

const (
	ErrorCodeInvalidRequest         ErrorCode = "invalid_request"
	ErrorCodeSensitiveWordsDetected ErrorCode = "sensitive_words_detected"
	ErrorCodeViolationFeeGrokCSAM   ErrorCode = "violation_fee.grok.csam"

	// new api error
	ErrorCodeCountTokenFailed   ErrorCode = "count_token_failed"
	ErrorCodeModelPriceError    ErrorCode = "model_price_error"
	ErrorCodeInvalidApiType     ErrorCode = "invalid_api_type"
	ErrorCodeJsonMarshalFailed  ErrorCode = "json_marshal_failed"
	ErrorCodeDoRequestFailed    ErrorCode = "do_request_failed"
	ErrorCodeGetChannelFailed   ErrorCode = "get_channel_failed"
	ErrorCodeGenRelayInfoFailed ErrorCode = "gen_relay_info_failed"

	// channel error
	ErrorCodeChannelNoAvailableKey        ErrorCode = "channel:no_available_key"
	ErrorCodeChannelParamOverrideInvalid  ErrorCode = "channel:param_override_invalid"
	ErrorCodeChannelHeaderOverrideInvalid ErrorCode = "channel:header_override_invalid"
	ErrorCodeChannelModelMappedError      ErrorCode = "channel:model_mapped_error"
	ErrorCodeChannelAwsClientError        ErrorCode = "channel:aws_client_error"
	ErrorCodeChannelInvalidKey            ErrorCode = "channel:invalid_key"
	ErrorCodeChannelResponseTimeExceeded  ErrorCode = "channel:response_time_exceeded"

	// client request error
	ErrorCodeReadRequestBodyFailed ErrorCode = "read_request_body_failed"
	ErrorCodeConvertRequestFailed  ErrorCode = "convert_request_failed"
	ErrorCodeAccessDenied          ErrorCode = "access_denied"

	// request error
	ErrorCodeBadRequestBody ErrorCode = "bad_request_body"

	// response error
	ErrorCodeReadResponseBodyFailed ErrorCode = "read_response_body_failed"
	ErrorCodeBadResponseStatusCode  ErrorCode = "bad_response_status_code"
	ErrorCodeBadResponse            ErrorCode = "bad_response"
	ErrorCodeBadResponseBody        ErrorCode = "bad_response_body"
	ErrorCodeEmptyResponse          ErrorCode = "empty_response"
	ErrorCodeAwsInvokeError         ErrorCode = "aws_invoke_error"
	ErrorCodeModelNotFound          ErrorCode = "model_not_found"
	ErrorCodePromptBlocked          ErrorCode = "prompt_blocked"

	// sql error
	ErrorCodeQueryDataError  ErrorCode = "query_data_error"
	ErrorCodeUpdateDataError ErrorCode = "update_data_error"

	// quota error
	ErrorCodeInsufficientUserQuota      ErrorCode = "insufficient_user_quota"
	ErrorCodePreConsumeTokenQuotaFailed ErrorCode = "pre_consume_token_quota_failed"

	// client-facing error codes. These are what a client sees after upstream
	// text has been replaced by a curated message; they are stable so a client
	// can branch on them.
	ErrorCodeModelRateLimited       ErrorCode = "model_rate_limited"
	ErrorCodeContentPolicyViolation ErrorCode = "content_policy_violation"
	ErrorCodeUpstreamUnavailable    ErrorCode = "upstream_unavailable"
)

type NewAPIError struct {
	Err            error
	RelayError     any
	skipRetry      bool
	recordErrorLog *bool
	errorType      ErrorType
	errorCode      ErrorCode
	StatusCode     int
	Metadata       json.RawMessage
	// upstreamOrigin marks an error whose message was taken from an upstream
	// response body. Its text is diagnostic (it may name the upstream host,
	// account or internal model id) and must never reach a client verbatim;
	// ClientCategory uses this to route it to a curated message instead.
	// Local errors (validation, quota, routing) carry no upstream text and are
	// safe to describe precisely.
	upstreamOrigin bool
}

// Unwrap enables errors.Is / errors.As to work with NewAPIError by exposing the underlying error.
func (e *NewAPIError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func (e *NewAPIError) GetErrorCode() ErrorCode {
	if e == nil {
		return ""
	}
	return e.errorCode
}

func (e *NewAPIError) GetErrorType() ErrorType {
	if e == nil {
		return ""
	}
	return e.errorType
}

// IsUpstreamOrigin reports whether this error carries text taken from an
// upstream response. Callers that print to a client must not do so verbatim.
func (e *NewAPIError) IsUpstreamOrigin() bool {
	return e != nil && e.upstreamOrigin
}

// MarkUpstreamOrigin records that this error's message came from an upstream
// response body. See NewAPIError.upstreamOrigin.
func (e *NewAPIError) MarkUpstreamOrigin() {
	if e != nil {
		e.upstreamOrigin = true
	}
}

// ClientErrorCategory is the client-facing class of a failure. It is derived
// from the status code and error code only, never from the message text, so a
// curated message can replace upstream wording without changing behaviour.
type ClientErrorCategory string

const (
	ClientErrInsufficientQuota ClientErrorCategory = "insufficient_quota"
	ClientErrModelUnavailable  ClientErrorCategory = "model_unavailable"
	ClientErrRateLimited       ClientErrorCategory = "rate_limited"
	ClientErrInvalidRequest    ClientErrorCategory = "invalid_request"
	ClientErrContentBlocked    ClientErrorCategory = "content_blocked"
	ClientErrUpstream          ClientErrorCategory = "upstream_error"
	ClientErrInternal          ClientErrorCategory = "internal_error"
)

// ClientCategory classifies the error for a client-facing response.
func (e *NewAPIError) ClientCategory() ClientErrorCategory {
	if e == nil {
		return ClientErrInternal
	}
	// Local errors first: their text is precise, and the gateway knows exactly
	// what it rejected.
	switch e.errorCode {
	case ErrorCodeInsufficientUserQuota, ErrorCodePreConsumeTokenQuotaFailed:
		return ClientErrInsufficientQuota
	case ErrorCodeModelNotFound:
		return ClientErrModelUnavailable
	case ErrorCodeCountTokenFailed, ErrorCodeSensitiveWordsDetected,
		ErrorCodeViolationFeeGrokCSAM, ErrorCodePromptBlocked:
		return ClientErrContentBlocked
	case ErrorCodeReadRequestBodyFailed, ErrorCodeConvertRequestFailed,
		ErrorCodeBadRequestBody, ErrorCodeInvalidRequest, ErrorCodeInvalidApiType:
		return ClientErrInvalidRequest
	}
	if IsChannelError(e) || e.errorCode == ErrorCodeChannelNoAvailableKey ||
		e.errorCode == ErrorCodeChannelInvalidKey {
		return ClientErrUpstream
	}
	// An upstream rejection is attributed to the upstream even when it looks
	// like a client mistake. The request the upstream saw is the one this
	// gateway built from the caller's, so a 400 there may well be a conversion
	// fault — telling the caller to fix a request that was fine sends them the
	// wrong way. The one exception is throttling, which has a next step the
	// caller can act on (retry, or switch models).
	if e.upstreamOrigin {
		switch e.StatusCode {
		case http.StatusRequestTimeout, http.StatusTooManyRequests:
			return ClientErrRateLimited
		case http.StatusNotFound, http.StatusMethodNotAllowed:
			return ClientErrModelUnavailable
		default:
			return ClientErrUpstream
		}
	}
	switch e.StatusCode {
	case http.StatusRequestTimeout, http.StatusTooManyRequests:
		return ClientErrRateLimited
	case http.StatusBadRequest, http.StatusRequestEntityTooLarge, http.StatusUnprocessableEntity:
		return ClientErrInvalidRequest
	case http.StatusForbidden:
		return ClientErrInsufficientQuota
	case http.StatusNotFound, http.StatusMethodNotAllowed:
		return ClientErrModelUnavailable
	}
	if e.StatusCode >= 500 || e.StatusCode == 0 {
		return ClientErrUpstream
	}
	return ClientErrInternal
}

func (e *NewAPIError) Error() string {
	if e == nil {
		return ""
	}
	if e.Err == nil {
		// fallback message when underlying error is missing
		return string(e.errorCode)
	}
	return e.Err.Error()
}

func (e *NewAPIError) ErrorWithStatusCode() string {
	if e == nil {
		return ""
	}
	msg := e.Error()
	if e.StatusCode == 0 {
		return msg
	}
	if msg == "" {
		return fmt.Sprintf("status_code=%d", e.StatusCode)
	}
	return fmt.Sprintf("status_code=%d, %s", e.StatusCode, msg)
}

func (e *NewAPIError) MaskSensitiveError() string {
	if e == nil {
		return ""
	}
	if e.Err == nil {
		return string(e.errorCode)
	}
	errStr := e.Err.Error()
	if e.errorCode == ErrorCodeCountTokenFailed {
		return errStr
	}
	return kitutil.MaskSensitiveInfo(errStr)
}

func (e *NewAPIError) MaskSensitiveErrorWithStatusCode() string {
	if e == nil {
		return ""
	}
	msg := e.MaskSensitiveError()
	if e.StatusCode == 0 {
		return msg
	}
	if msg == "" {
		return fmt.Sprintf("status_code=%d", e.StatusCode)
	}
	return fmt.Sprintf("status_code=%d, %s", e.StatusCode, msg)
}

func (e *NewAPIError) SetMessage(message string) {
	e.Err = errors.New(message)
}

func (e *NewAPIError) ToOpenAIError() OpenAIError {
	var result OpenAIError
	switch e.errorType {
	case ErrorTypeOpenAIError:
		if openAIError, ok := e.RelayError.(OpenAIError); ok {
			result = openAIError
		}
	case ErrorTypeClaudeError:
		if claudeError, ok := e.RelayError.(ClaudeError); ok {
			result = OpenAIError{
				Message: e.Error(),
				Type:    claudeError.Type,
				Param:   "",
				Code:    e.errorCode,
			}
		}
	default:
		result = OpenAIError{
			Message: e.Error(),
			Type:    string(e.errorType),
			Param:   "",
			Code:    e.errorCode,
		}
	}
	if e.errorCode != ErrorCodeCountTokenFailed {
		result.Message = kitutil.MaskSensitiveInfo(result.Message)
	}
	if result.Message == "" {
		result.Message = string(e.errorType)
	}
	return result
}

func (e *NewAPIError) ToClaudeError() ClaudeError {
	var result ClaudeError
	switch e.errorType {
	case ErrorTypeOpenAIError:
		if openAIError, ok := e.RelayError.(OpenAIError); ok {
			result = ClaudeError{
				Message: e.Error(),
				Type:    fmt.Sprintf("%v", openAIError.Code),
			}
		}
	case ErrorTypeClaudeError:
		if claudeError, ok := e.RelayError.(ClaudeError); ok {
			result = claudeError
		}
	default:
		result = ClaudeError{
			Message: e.Error(),
			Type:    string(e.errorType),
		}
	}
	if e.errorCode != ErrorCodeCountTokenFailed {
		result.Message = kitutil.MaskSensitiveInfo(result.Message)
	}
	if result.Message == "" {
		result.Message = string(e.errorType)
	}
	return result
}

// ClientStatusCode is the status a client should receive. It mirrors the relay
// status except where that status would mislead: an upstream 4xx is not the
// caller's bad request (the gateway built that request), so it is reported as
// a gateway failure, and a model this gateway does not serve is a 404 rather
// than a 503 the caller would keep retrying.
func (e *NewAPIError) ClientStatusCode() int {
	if e == nil {
		return http.StatusInternalServerError
	}
	status := e.StatusCode
	if status < 100 || status > 599 {
		status = http.StatusInternalServerError
	}
	switch e.ClientCategory() {
	case ClientErrModelUnavailable:
		// Keep what the caller was given: "no available channel" arrives as a
		// 503 for both a model that does not exist and one that exists with no
		// capacity right now, and this layer cannot tell them apart. The host
		// narrows a genuinely absent model to 404 where it can consult the
		// model table (see service.PrepareClientError).
		return status
	case ClientErrUpstream:
		return http.StatusBadGateway
	}
	return status
}

// ClientErrorCode is the stable, non-leaking code a client can branch on.
func (e *NewAPIError) ClientErrorCode() ErrorCode {
	switch e.ClientCategory() {
	case ClientErrInsufficientQuota:
		return ErrorCodeInsufficientUserQuota
	case ClientErrModelUnavailable:
		return ErrorCodeModelNotFound
	case ClientErrRateLimited:
		return ErrorCodeModelRateLimited
	case ClientErrInvalidRequest:
		return ErrorCodeInvalidRequest
	case ClientErrContentBlocked:
		return ErrorCodeContentPolicyViolation
	default:
		return ErrorCodeUpstreamUnavailable
	}
}

// ToClientOpenAIError renders the error for an OpenAI-shaped client: curated
// message, stable code, no upstream text or identity.
func (e *NewAPIError) ToClientOpenAIError() OpenAIError {
	code := e.ClientErrorCode()
	return OpenAIError{
		Message: e.ClientMessage(),
		Type:    string(ErrorTypeNewAPIError),
		Code:    code,
	}
}

// ToClientClaudeError renders the error for an Anthropic-shaped client.
func (e *NewAPIError) ToClientClaudeError() ClaudeError {
	return ClaudeError{
		Message: e.ClientMessage(),
		Type:    string(e.ClientErrorCode()),
	}
}

type NewAPIErrorOptions func(*NewAPIError)

func NewError(err error, errorCode ErrorCode, ops ...NewAPIErrorOptions) *NewAPIError {
	var newErr *NewAPIError
	// 保留深层传递的 new err
	if errors.As(err, &newErr) {
		for _, op := range ops {
			op(newErr)
		}
		return newErr
	}
	e := &NewAPIError{
		Err:        err,
		RelayError: nil,
		errorType:  ErrorTypeNewAPIError,
		StatusCode: http.StatusInternalServerError,
		errorCode:  errorCode,
	}
	for _, op := range ops {
		op(e)
	}
	return e
}

func NewOpenAIError(err error, errorCode ErrorCode, statusCode int, ops ...NewAPIErrorOptions) *NewAPIError {
	var newErr *NewAPIError
	// 保留深层传递的 new err
	if errors.As(err, &newErr) {
		if newErr.RelayError == nil {
			openaiError := OpenAIError{
				Message: newErr.Error(),
				Type:    string(errorCode),
				Code:    errorCode,
			}
			newErr.RelayError = openaiError
		}
		for _, op := range ops {
			op(newErr)
		}
		return newErr
	}
	openaiError := OpenAIError{
		Message: err.Error(),
		Type:    string(errorCode),
		Code:    errorCode,
	}
	return WithOpenAIError(openaiError, statusCode, ops...)
}

func InitOpenAIError(errorCode ErrorCode, statusCode int, ops ...NewAPIErrorOptions) *NewAPIError {
	openaiError := OpenAIError{
		Type: string(errorCode),
		Code: errorCode,
	}
	return WithOpenAIError(openaiError, statusCode, ops...)
}

func NewErrorWithStatusCode(err error, errorCode ErrorCode, statusCode int, ops ...NewAPIErrorOptions) *NewAPIError {
	e := &NewAPIError{
		Err: err,
		RelayError: OpenAIError{
			Message: err.Error(),
			Type:    string(errorCode),
		},
		errorType:  ErrorTypeNewAPIError,
		StatusCode: statusCode,
		errorCode:  errorCode,
	}
	for _, op := range ops {
		op(e)
	}

	return e
}

func WithOpenAIError(openAIError OpenAIError, statusCode int, ops ...NewAPIErrorOptions) *NewAPIError {
	code, ok := openAIError.Code.(string)
	if !ok {
		if openAIError.Code != nil {
			code = fmt.Sprintf("%v", openAIError.Code)
		} else {
			code = "unknown_error"
		}
	}
	if openAIError.Type == "" {
		openAIError.Type = "upstream_error"
	}
	e := &NewAPIError{
		RelayError: openAIError,
		errorType:  ErrorTypeOpenAIError,
		StatusCode: statusCode,
		Err:        errors.New(openAIError.Message),
		errorCode:  ErrorCode(code),
	}
	// OpenRouter
	if len(openAIError.Metadata) > 0 {
		openAIError.Message = fmt.Sprintf("%s (%s)", openAIError.Message, openAIError.Metadata)
		e.Metadata = openAIError.Metadata
		e.RelayError = openAIError
		e.Err = errors.New(openAIError.Message)
	}
	for _, op := range ops {
		op(e)
	}
	return e
}

func WithClaudeError(claudeError ClaudeError, statusCode int, ops ...NewAPIErrorOptions) *NewAPIError {
	if claudeError.Type == "" {
		claudeError.Type = "upstream_error"
	}
	e := &NewAPIError{
		RelayError: claudeError,
		errorType:  ErrorTypeClaudeError,
		StatusCode: statusCode,
		Err:        errors.New(claudeError.Message),
		errorCode:  ErrorCode(claudeError.Type),
	}
	for _, op := range ops {
		op(e)
	}
	return e
}

func IsChannelError(err *NewAPIError) bool {
	if err == nil {
		return false
	}
	return strings.HasPrefix(string(err.errorCode), "channel:")
}

func IsSkipRetryError(err *NewAPIError) bool {
	if err == nil {
		return false
	}

	return err.skipRetry
}

func ErrOptionWithSkipRetry() NewAPIErrorOptions {
	return func(e *NewAPIError) {
		e.skipRetry = true
	}
}

// ErrOptionWithUpstreamOrigin marks the error as carrying upstream response
// text. See NewAPIError.upstreamOrigin.
func ErrOptionWithUpstreamOrigin() NewAPIErrorOptions {
	return func(e *NewAPIError) {
		e.upstreamOrigin = true
	}
}

// clientMessageBuilder is installed by the host module (which owns the i18n
// catalogue and the gin context). relaykit stays free of both: it classifies,
// the host words the message.
var clientMessageBuilder func(category ClientErrorCategory, err *NewAPIError) string

// SetClientMessageBuilder installs the localizer for client-facing messages.
func SetClientMessageBuilder(fn func(category ClientErrorCategory, err *NewAPIError) string) {
	clientMessageBuilder = fn
}

// ClientMessage returns the message a client should see: the localizer's text
// when installed, and category-independent wording otherwise, so an unset
// builder can never leak upstream text.
func (e *NewAPIError) ClientMessage() string {
	category := e.ClientCategory()
	if clientMessageBuilder != nil {
		if msg := clientMessageBuilder(category, e); msg != "" {
			return msg
		}
	}
	switch category {
	case ClientErrInsufficientQuota:
		return "insufficient account quota, please top up and retry"
	case ClientErrModelUnavailable:
		return "the requested model is not available"
	case ClientErrRateLimited:
		return "the model is rate limited right now, please retry later or switch to another model"
	case ClientErrInvalidRequest:
		return "the request is invalid"
	case ClientErrContentBlocked:
		return "the request was rejected by the content policy"
	default:
		return "the service is temporarily unavailable, please retry later"
	}
}

func ErrOptionWithNoRecordErrorLog() NewAPIErrorOptions {
	return func(e *NewAPIError) {
		e.recordErrorLog = kitutil.GetPointer(false)
	}
}

func ErrOptionWithStatusCode(statusCode int) NewAPIErrorOptions {
	return func(e *NewAPIError) {
		e.StatusCode = statusCode
	}
}

func ErrOptionWithHideErrMsg(replaceStr string) NewAPIErrorOptions {
	return func(e *NewAPIError) {
		if kitutil.Debug.Load() {
			fmt.Printf("ErrOptionWithHideErrMsg: %s, origin error: %s", replaceStr, e.Err)
		}
		e.Err = errors.New(replaceStr)
	}
}

func IsRecordErrorLog(e *NewAPIError) bool {
	if e == nil {
		return false
	}
	if e.recordErrorLog == nil {
		// default to true if not set
		return true
	}
	return *e.recordErrorLog
}
