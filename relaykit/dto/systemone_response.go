package dto

import "encoding/json"

// SystemOneUsage is the token accounting a System One endpoint reports. The
// model generates no output tokens, so only the input side is ever populated;
// it is kept optional because upstreams may omit usage entirely.
type SystemOneUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
	InputTokens      int `json:"input_tokens"`
	OutputTokens     int `json:"output_tokens"`
}

// SystemOneResponse is the part of a System One reply this gateway reads. The
// body itself is forwarded byte-for-byte; this struct only lifts the usage out
// of it for billing, so every field is optional.
type SystemOneResponse struct {
	Model  string          `json:"model"`
	Usage  *SystemOneUsage `json:"usage"`
	Cost   any             `json:"cost"`
	Errors json.RawMessage `json:"error"`
}