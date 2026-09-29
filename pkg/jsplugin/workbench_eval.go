package jsplugin

import (
	"errors"
	"fmt"
	"math"
	"strings"
)

// Server-side evaluation of a workbench parameterSchema against a concrete
// parameter object (design doc §7.2 item 4). The plugin's protocol hook stays
// the authoritative validator; this is the pre-submit double check so a stale
// or hand-edited client cannot push parameters the rendered form would have
// rejected. It enforces only the constrained keyword subset accepted by
// validateWorkbenchParamSchema: required / type / enum / minimum / maximum /
// minLength / maxLength / additionalProperties, plus array items. `constraints`
// and `x-*` stay render-only annotations and are never evaluated here.

var ErrWorkbenchParamRejected = errors.New("workbench parameter rejected")

func workbenchParamErrorf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrWorkbenchParamRejected, fmt.Sprintf(format, args...))
}

// ApplyWorkbenchDefaults materializes schema defaults and `x-fixed-model` /
// `x-append` annotations into a copy of params so the frozen step in
// PlanDesignProject displays every effective specification value on the
// confirmation sheet (miora-creative-core §二).
func ApplyWorkbenchDefaults(schema map[string]any, params map[string]any) map[string]any {
	return applyWorkbenchDefaults(schema, params, 0)
}

func applyWorkbenchDefaults(schema map[string]any, params map[string]any, depth int) map[string]any {
	out := make(map[string]any, len(params))
	for k, v := range params {
		out[k] = v
	}
	if schema == nil || depth > workbenchMaxParamDepth {
		return out
	}

	if fixedModel, ok := schema["x-fixed-model"].(string); ok && strings.TrimSpace(fixedModel) != "" {
		out["model"] = strings.TrimSpace(fixedModel)
	}

	if properties, ok := schema["properties"].(map[string]any); ok {
		for name, rawProp := range properties {
			propObj, ok := rawProp.(map[string]any)
			if !ok {
				continue
			}
			val, present := out[name]
			isEmptyString := false
			if s, ok := val.(string); ok && strings.TrimSpace(s) == "" {
				isEmptyString = true
			}
			if !present || val == nil || isEmptyString {
				if def, hasDef := propObj["default"]; hasDef && def != nil {
					out[name] = def
					val = def
					present = true
				}
			}
			if fixed, ok := propObj["x-fixed-model"].(string); ok && strings.TrimSpace(fixed) != "" {
				out[name] = strings.TrimSpace(fixed)
				val = out[name]
				present = true
			}
			if suffix, ok := propObj["x-append"].(string); ok && strings.TrimSpace(suffix) != "" {
				if text, ok := val.(string); ok && strings.TrimSpace(text) != "" {
					trimmedSuffix := strings.TrimSpace(suffix)
					if !strings.Contains(text, trimmedSuffix) {
						out[name] = strings.TrimSpace(text) + " " + trimmedSuffix
					}
				}
			}
			if propType, _ := propObj["type"].(string); propType == "object" && present {
				if nested, ok := val.(map[string]any); ok {
					out[name] = applyWorkbenchDefaults(propObj, nested, depth+1)
				}
			}
		}
	}

	if suffix, ok := schema["x-append"].(string); ok && strings.TrimSpace(suffix) != "" {
		if text, ok := out["prompt"].(string); ok && strings.TrimSpace(text) != "" {
			trimmedSuffix := strings.TrimSpace(suffix)
			if !strings.Contains(text, trimmedSuffix) {
				out["prompt"] = strings.TrimSpace(text) + " " + trimmedSuffix
			}
		}
	}

	return out
}

// EvaluateWorkbenchParams validates params against schema. It returns a
// wrapped ErrWorkbenchParamRejected on the first violation. Unknown keywords
// and absent optional properties are ignored, mirroring the render subset.
func EvaluateWorkbenchParams(schema map[string]any, params map[string]any) error {
	return evaluateWorkbenchParams(schema, params, "", 0)
}

func evaluateWorkbenchParams(schema map[string]any, params map[string]any, path string, depth int) error {
	if depth > workbenchMaxParamDepth {
		return workbenchParamErrorf("%s nests too deeply", orEmpty(path, "schema"))
	}
	typ, _ := schema["type"].(string)
	if typ == "" {
		typ = "object"
	}

	if required, ok := stringSlice(schema["required"]); ok {
		for _, name := range required {
			if _, present := params[name]; !present {
				return workbenchParamErrorf("parameter %q is required", joinPath(path, name))
			}
		}
	}

	if typ != "object" {
		// The top level is always an object in practice; nested non-objects are
		// validated through evaluateWorkbenchValue below.
		return evaluateWorkbenchValue(schema, params, path, depth)
	}

	additional := true
	if flag, ok := schema["additionalProperties"].(bool); ok {
		additional = flag
	}
	properties, _ := schema["properties"].(map[string]any)

	for name, value := range params {
		propSchema, declared := properties[name]
		if !declared {
			if !additional {
				return workbenchParamErrorf("parameter %q is not allowed", joinPath(path, name))
			}
			continue
		}
		propObject, ok := propSchema.(map[string]any)
		if !ok {
			continue
		}
		if err := evaluateWorkbenchValue(propObject, value, joinPath(path, name), depth+1); err != nil {
			return err
		}
	}
	return nil
}

func evaluateWorkbenchValue(schema map[string]any, value any, path string, depth int) error {
	if value == nil {
		return nil
	}
	typ, _ := schema["type"].(string)

	switch typ {
	case "string":
		text, ok := value.(string)
		if !ok {
			return workbenchParamErrorf("parameter %q must be a string", path)
		}
		if allowed, ok := enumValues(schema); ok && !allowedContainsString(allowed, text) {
			return workbenchParamErrorf("parameter %q must be one of %v", path, allowed)
		}
		if n, ok := numericConstraint(schema["minLength"]); ok && float64(len([]rune(text))) < n {
			return workbenchParamErrorf("parameter %q must be at least %v characters", path, n)
		}
		if n, ok := numericConstraint(schema["maxLength"]); ok && float64(len([]rune(text))) > n {
			return workbenchParamErrorf("parameter %q must be at most %v characters", path, n)
		}
	case "integer", "number":
		number, ok := numericValue(value)
		if !ok {
			return workbenchParamErrorf("parameter %q must be a number", path)
		}
		if typ == "integer" && number != math.Trunc(number) {
			return workbenchParamErrorf("parameter %q must be an integer", path)
		}
		if allowed, ok := enumValues(schema); ok && !allowedContainsNumber(allowed, number) {
			return workbenchParamErrorf("parameter %q must be one of %v", path, allowed)
		}
		if min, ok := numericConstraint(schema["minimum"]); ok && number < min {
			return workbenchParamErrorf("parameter %q must be at least %v", path, min)
		}
		if max, ok := numericConstraint(schema["maximum"]); ok && number > max {
			return workbenchParamErrorf("parameter %q must be at most %v", path, max)
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return workbenchParamErrorf("parameter %q must be a boolean", path)
		}
	case "array":
		items, ok := value.([]any)
		if !ok {
			return workbenchParamErrorf("parameter %q must be an array", path)
		}
		itemSchema, _ := schema["items"].(map[string]any)
		if itemSchema == nil {
			return nil
		}
		for index, item := range items {
			if err := evaluateWorkbenchValue(itemSchema, item, fmt.Sprintf("%s[%d]", path, index), depth+1); err != nil {
				return err
			}
		}
	case "object":
		nested, ok := value.(map[string]any)
		if !ok {
			return workbenchParamErrorf("parameter %q must be an object", path)
		}
		if err := evaluateWorkbenchParams(schema, nested, path, depth+1); err != nil {
			return err
		}
	case "":
		// Untyped property: accept anything, matching the render side.
	default:
		return workbenchParamErrorf("parameter %q has unsupported schema type %q", path, typ)
	}
	return nil
}

func enumValues(schema map[string]any) ([]any, bool) {
	raw, ok := schema["enum"].([]any)
	if !ok || len(raw) == 0 {
		return nil, false
	}
	return raw, true
}

func allowedContainsString(allowed []any, text string) bool {
	for _, item := range allowed {
		if s, ok := item.(string); ok && s == text {
			return true
		}
	}
	return false
}

func allowedContainsNumber(allowed []any, number float64) bool {
	for _, item := range allowed {
		if n, ok := numericValue(item); ok && n == number {
			return true
		}
	}
	return false
}

func numericValue(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case jsonNumber:
		parsed, err := v.Float()
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

// jsonNumber adapts encoding/json.Number without importing it here (values
// decoded through common.Unmarshal arrive as float64; this covers callers that
// hand over UseNumber payloads).
type jsonNumber interface {
	Float() (float64, error)
}

func numericConstraint(value any) (float64, bool) {
	return numericValue(value)
}

func stringSlice(value any) ([]string, bool) {
	raw, ok := value.([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out, len(out) > 0
}

func joinPath(prefix, name string) string {
	if prefix == "" {
		return name
	}
	return prefix + "." + name
}

func orEmpty(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
