package dto

import (
	"encoding/json"
	"net/http"

	"github.com/QuantumNous/new-api/relaykit/types"
)

// SystemOneQuestion is one typed question in a System One request. The three
// primitives (choice / score / noul) each carry a different payload, so the
// members stay loose: this gateway forwards the request untouched and only
// checks that a question names a known primitive.
type SystemOneQuestion struct {
	Type         string          `json:"type"`
	Instructions string          `json:"instructions,omitempty"`
	Criteria     json.RawMessage `json:"criteria,omitempty"`
	Levels       json.RawMessage `json:"levels,omitempty"`
}

// SystemOneRequest is a System One decision request: a state to judge plus the
// questions to judge it against. Unlike every other relay format it carries no
// message list and no generated output — a System One model returns typed
// answers with probabilities, never prose.
//
// RawBody preserves the original JSON so unknown members survive the hop; only
// "model" is rewritten when a channel maps it.
type SystemOneRequest struct {
	Model     string                       `json:"model"`
	State     json.RawMessage              `json:"state"`
	Questions map[string]SystemOneQuestion `json:"questions"`
	RawBody   json.RawMessage              `json:"-"`
}

func (r *SystemOneRequest) GetTokenCountMeta() *types.TokenCountMeta {
	combineText := ""
	if len(r.RawBody) > 0 {
		combineText = string(r.RawBody)
	}
	return &types.TokenCountMeta{
		CombineText: combineText,
		TokenType:   types.TokenTypeTokenizer,
	}
}

func (r *SystemOneRequest) IsStream(_ *http.Request) bool {
	// A System One response is one typed decision object, not a token stream.
	return false
}

func (r *SystemOneRequest) SetModelName(modelName string) {
	if modelName != "" {
		r.Model = modelName
	}
}