package relay

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
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
