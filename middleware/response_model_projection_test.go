package middleware

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// project is the test entry point for whole-payload projection, the shape
// WebSocket frames take.
func project(t *testing.T, payload, model string) string {
	t.Helper()
	return string(ProjectModelNames([]byte(payload), model))
}

func TestProjectModelNamesRewritesEveryModelMember(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		want    string
	}{
		{
			name:    "chat completion",
			payload: `{"id":"c1","model":"vmc/fireworks-k3-fallbacks","choices":[]}`,
			want:    `{"id":"c1","model":"kimi-k3","choices":[]}`,
		},
		{
			name:    "spacing around the colon survives as canonical",
			payload: `{"model" : "upstream-name", "x": 1}`,
			want:    `{"model":"kimi-k3", "x": 1}`,
		},
		{
			name:    "several model members, as usage events carry",
			payload: `{"model":"a","response":{"model":"b"},"nested":{"model":"c"}}`,
			want:    `{"model":"kimi-k3","response":{"model":"kimi-k3"},"nested":{"model":"kimi-k3"}}`,
		},
		{
			name:    "claude messages envelope",
			payload: `{"type":"message_start","message":{"id":"msg_1","model":"claude-3-5-sonnet-20241022","content":[]}}`,
			want:    `{"type":"message_start","message":{"id":"msg_1","model":"kimi-k3","content":[]}}`,
		},
		{
			name:    "id other than model is untouched",
			payload: `{"model_id":"keep","model_name":"keep","model":"replace"}`,
			want:    `{"model_id":"keep","model_name":"keep","model":"kimi-k3"}`,
		},
		{
			name:    "modelName and nested model key are not the member",
			payload: `{"modelName":"keep","meta":{"model":"replace"}}`,
			want:    `{"modelName":"keep","meta":{"model":"kimi-k3"}}`,
		},
		{
			name:    "a quoted model inside content is left alone",
			payload: `{"model":"upstream","choices":[{"message":{"content":"say \"model\":\"hello\""}}]}`,
			want:    `{"model":"kimi-k3","choices":[{"message":{"content":"say \"model\":\"hello\""}}]}`,
		},
		{
			name:    "model member whose value has escapes",
			payload: `{"model":"a\/b\"c","ok":true}`,
			want:    `{"model":"kimi-k3","ok":true}`,
		},
		{
			name:    "no model member at all",
			payload: `{"error":{"message":"boom"}}`,
			want:    `{"error":{"message":"boom"}}`,
		},
		{
			name:    "empty payload",
			payload: ``,
			want:    ``,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, project(t, tc.payload, "kimi-k3"))
		})
	}
}

// TestProjectModelNamesKeepsJSONValid guards the property that matters most:
// whatever the projection does, the caller still receives parseable JSON of the
// same shape.
func TestProjectModelNamesKeepsJSONValid(t *testing.T) {
	payload := `{"id":"r1","model":"vmc/fireworks-cline-k3-contributor-fallbacks","output":[{"type":"message","content":[{"text":"{\"model\":\"inside text\"}"}]}],"usage":{"total_tokens":3}}`

	projected := project(t, payload, "kimi-k3")

	assert.NotContains(t, projected, "vmc/fireworks")
	assert.Contains(t, projected, `"model":"kimi-k3"`)
	assert.Contains(t, projected, `{\"model\":\"inside text\"}`)
	// The escaped text inside content must not have been rewritten.
	assert.Equal(t, 1, strings.Count(projected, `"model":"`))
}

func TestProjectModelNamesEscapesTheReplacement(t *testing.T) {
	projected := project(t, `{"model":"upstream"}`, `weird"name\`)
	assert.Equal(t, `{"model":"weird\"name\\"}`, projected)
}

func TestProjectModelNamesWithoutModelIsNoop(t *testing.T) {
	payload := `{"model":"upstream"}`
	assert.Equal(t, payload, project(t, payload, ""))
}
