package jsplugin

import (
	"errors"
	"testing"
)

func TestEvaluateWorkbenchParamsRequired(t *testing.T) {
	schema := map[string]any{
		"type":     "object",
		"required": []any{"prompt"},
		"properties": map[string]any{
			"prompt": map[string]any{"type": "string"},
		},
	}
	if err := EvaluateWorkbenchParams(schema, map[string]any{"prompt": "hello"}); err != nil {
		t.Fatalf("expected pass, got %v", err)
	}
	err := EvaluateWorkbenchParams(schema, map[string]any{})
	if !errors.Is(err, ErrWorkbenchParamRejected) {
		t.Fatalf("expected ErrWorkbenchParamRejected, got %v", err)
	}
}

func TestEvaluateWorkbenchParamsEnum(t *testing.T) {
	schema := map[string]any{
		"properties": map[string]any{
			"quality": map[string]any{"type": "string", "enum": []any{"low", "high"}},
		},
	}
	if err := EvaluateWorkbenchParams(schema, map[string]any{"quality": "high"}); err != nil {
		t.Fatalf("expected pass, got %v", err)
	}
	if err := EvaluateWorkbenchParams(schema, map[string]any{"quality": "ultra"}); err == nil {
		t.Fatal("expected enum violation")
	}
}

func TestEvaluateWorkbenchParamsNumericBounds(t *testing.T) {
	schema := map[string]any{
		"properties": map[string]any{
			"steps":   map[string]any{"type": "integer", "minimum": 1, "maximum": 8},
			"seconds": map[string]any{"type": "number", "minimum": 4},
		},
	}
	if err := EvaluateWorkbenchParams(schema, map[string]any{"steps": float64(4), "seconds": 5.5}); err != nil {
		t.Fatalf("expected pass, got %v", err)
	}
	if err := EvaluateWorkbenchParams(schema, map[string]any{"steps": float64(9)}); err == nil {
		t.Fatal("expected maximum violation")
	}
	if err := EvaluateWorkbenchParams(schema, map[string]any{"steps": float64(0)}); err == nil {
		t.Fatal("expected minimum violation")
	}
	if err := EvaluateWorkbenchParams(schema, map[string]any{"steps": 1.5}); err == nil {
		t.Fatal("expected integer violation")
	}
}

func TestEvaluateWorkbenchParamsAdditionalProperties(t *testing.T) {
	schema := map[string]any{
		"additionalProperties": false,
		"properties": map[string]any{
			"prompt": map[string]any{"type": "string"},
		},
	}
	if err := EvaluateWorkbenchParams(schema, map[string]any{"prompt": "hi"}); err != nil {
		t.Fatalf("expected pass, got %v", err)
	}
	if err := EvaluateWorkbenchParams(schema, map[string]any{"evil": "x"}); err == nil {
		t.Fatal("expected unknown property violation")
	}
}

func TestEvaluateWorkbenchParamsStringLength(t *testing.T) {
	schema := map[string]any{
		"properties": map[string]any{
			"prompt": map[string]any{"type": "string", "minLength": 2, "maxLength": 4},
		},
	}
	if err := EvaluateWorkbenchParams(schema, map[string]any{"prompt": "好的"}); err != nil {
		t.Fatalf("expected pass, got %v", err)
	}
	if err := EvaluateWorkbenchParams(schema, map[string]any{"prompt": "太"}); err == nil {
		t.Fatal("expected minLength violation")
	}
	if err := EvaluateWorkbenchParams(schema, map[string]any{"prompt": "太长了太长了"}); err == nil {
		t.Fatal("expected maxLength violation")
	}
}

func TestEvaluateWorkbenchParamsUnknownKeywordsIgnored(t *testing.T) {
	schema := map[string]any{
		"properties": map[string]any{
			"size": map[string]any{
				"type":        "string",
				"constraints": map[string]any{"foo": "bar"},
				"x-hidden":    true,
			},
		},
	}
	if err := EvaluateWorkbenchParams(schema, map[string]any{"size": "1024x1024"}); err != nil {
		t.Fatalf("expected pass-through annotations to be inert, got %v", err)
	}
}

func TestEvaluateWorkbenchParamsNestedObjectAndArray(t *testing.T) {
	schema := map[string]any{
		"properties": map[string]any{
			"meta": map[string]any{
				"type":     "object",
				"required": []any{"ratio"},
				"properties": map[string]any{
					"ratio": map[string]any{"type": "string"},
				},
			},
			"tags": map[string]any{
				"type":  "array",
				"items": map[string]any{"type": "string", "maxLength": 3},
			},
		},
	}
	params := map[string]any{
		"meta": map[string]any{"ratio": "1:1"},
		"tags": []any{"a", "bc"},
	}
	if err := EvaluateWorkbenchParams(schema, params); err != nil {
		t.Fatalf("expected pass, got %v", err)
	}
	badMeta := map[string]any{"meta": map[string]any{}}
	if err := EvaluateWorkbenchParams(schema, badMeta); err == nil {
		t.Fatal("expected nested required violation")
	}
	badTags := map[string]any{"tags": []any{"too-long"}}
	if err := EvaluateWorkbenchParams(schema, badTags); err == nil {
		t.Fatal("expected array item violation")
	}
}

func TestEvaluateWorkbenchParamsMissingOptionalAllowed(t *testing.T) {
	schema := map[string]any{
		"required": []any{"prompt"},
		"properties": map[string]any{
			"prompt": map[string]any{"type": "string"},
			"size":   map[string]any{"type": "string"},
		},
	}
	if err := EvaluateWorkbenchParams(schema, map[string]any{"prompt": "hi"}); err != nil {
		t.Fatalf("expected pass, got %v", err)
	}
}
