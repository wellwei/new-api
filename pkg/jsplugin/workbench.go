package jsplugin

import (
	"errors"
	"fmt"
	"unicode"
	"unicode/utf8"
)

// Workbench capability declaration (design doc §5.2, Phase 1). A plugin's meta
// may carry an optional `workbench` object that tells the design workbench how
// to render the parameter form and what the capability offers. It is the JS
// transliteration of the capability-manifests YAML (snake_case -> camelCase,
// `media` -> `mediaType`); `x-*` and `constraints` pass through unchanged. It
// is render metadata only — the plugin's protocol hook is the authoritative
// validator, and the UI never overrides it.

const (
	// WorkbenchSchemaVersion is the only supported workbench schema version.
	WorkbenchSchemaVersion = 1

	workbenchMaxCapabilities = 64
	workbenchMaxIDRunes      = 128
	workbenchMaxModelRunes   = 128
	workbenchMaxMediaRunes   = 32
	workbenchMaxParamDepth   = 6
)

// Workbench is the optional meta.workbench payload.
type Workbench struct {
	SchemaVersion int                   `json:"schemaVersion"`
	Capabilities  []WorkbenchCapability `json:"capabilities,omitempty"`
}

// WorkbenchCapability describes one design capability a plugin offers.
type WorkbenchCapability struct {
	ID        string `json:"id"`
	Model     string `json:"model"`
	MediaType string `json:"mediaType"` // "image" | "video" | ...
	// Operations are workbench verbs, e.g. "generate", "edit".
	Operations []string `json:"operations,omitempty"`
	// DeferSchema asks the workbench to fetch the parameter schema on demand.
	DeferSchema bool `json:"deferSchema,omitempty"`
	// ReferenceLimits carries render-only limits (e.g. max reference images).
	ReferenceLimits map[string]int `json:"referenceLimits,omitempty"`
	// ParameterSchema is a constrained JSON Schema subset for the form. Stored
	// as raw JSON so unrecognized keywords (x-*, constraints) round-trip.
	ParameterSchema map[string]any `json:"parameterSchema,omitempty"`
	// Presets are named parameter templates.
	Presets []map[string]any `json:"presets,omitempty"`
	// Delivery hints how to present the result.
	Delivery map[string]any `json:"delivery,omitempty"`
}

// ValidateWorkbench enforces the constrained shape. It rejects anything that
// could smuggle executable content or unbounded nesting; the plugin protocol
// hook re-validates parameters authoritatively at submit time.
func ValidateWorkbench(wb *Workbench) error {
	if wb == nil {
		return nil
	}
	if wb.SchemaVersion != WorkbenchSchemaVersion {
		return fmt.Errorf("workbench schemaVersion must be %d", WorkbenchSchemaVersion)
	}
	if len(wb.Capabilities) > workbenchMaxCapabilities {
		return fmt.Errorf("workbench declares too many capabilities (%d)", len(wb.Capabilities))
	}
	seen := make(map[string]struct{}, len(wb.Capabilities))
	for i := range wb.Capabilities {
		cap := &wb.Capabilities[i]
		if err := validateWorkbenchCapability(cap); err != nil {
			return fmt.Errorf("workbench capability %d: %w", i, err)
		}
		key := cap.ID
		if _, dup := seen[key]; dup {
			return fmt.Errorf("workbench capability %q is duplicated", cap.ID)
		}
		seen[key] = struct{}{}
	}
	return nil
}

func validateWorkbenchCapability(cap *WorkbenchCapability) error {
	if cap.ID == "" {
		return errors.New("id is required")
	}
	if n := utf8.RuneCountInString(cap.ID); n > workbenchMaxIDRunes {
		return fmt.Errorf("id must not exceed %d characters", workbenchMaxIDRunes)
	}
	for _, r := range cap.ID {
		if unicode.IsControl(r) {
			return errors.New("id must not contain control characters")
		}
	}
	if cap.Model == "" {
		return errors.New("model is required")
	}
	if n := utf8.RuneCountInString(cap.Model); n > workbenchMaxModelRunes {
		return fmt.Errorf("model must not exceed %d characters", workbenchMaxModelRunes)
	}
	switch cap.MediaType {
	case "image", "video":
	default:
		return fmt.Errorf("mediaType must be image or video, got %q", cap.MediaType)
	}
	if len(cap.Operations) == 0 {
		return errors.New("operations must not be empty")
	}
	allowedOps := map[string]struct{}{"generate": {}, "edit": {}, "remix": {}, "upscale": {}}
	for _, op := range cap.Operations {
		if _, ok := allowedOps[op]; !ok {
			return fmt.Errorf("unsupported operation %q", op)
		}
	}
	for k, v := range cap.ReferenceLimits {
		if v < 0 || v > 64 {
			return fmt.Errorf("referenceLimits[%q] must be between 0 and 64", k)
		}
	}
	if cap.ParameterSchema != nil {
		if err := validateWorkbenchParamSchema(cap.ParameterSchema, 0); err != nil {
			return fmt.Errorf("parameterSchema: %w", err)
		}
	}
	return nil
}

// validateWorkbenchParamSchema bounds the JSON Schema subset we accept for
// form rendering. It is intentionally conservative: no remote $ref, no
// nested composition beyond a small depth, scalar/enum leaf types only.
func validateWorkbenchParamSchema(schema map[string]any, depth int) error {
	if depth > workbenchMaxParamDepth {
		return errors.New("parameterSchema nests too deeply")
	}
	typ, _ := schema["type"].(string)
	switch typ {
	case "", "object", "string", "integer", "number", "boolean", "array":
	default:
		return fmt.Errorf("unsupported schema type %q", typ)
	}
	if ref, ok := schema["$ref"].(string); ok && ref != "" {
		return errors.New("parameterSchema $ref is not supported")
	}
	// Only allow a vetted keyword set; anything else (x-*, constraints) is a
	// pass-through annotation we keep but never execute.
	allowed := map[string]struct{}{
		"type": {}, "properties": {}, "required": {}, "enum": {}, "default": {},
		"minimum": {}, "maximum": {}, "minLength": {}, "maxLength": {},
		"items": {}, "additionalProperties": {}, "description": {}, "title": {},
		"constraints": {}, "x-hidden": {}, "x-append": {}, "x-fixed-model": {},
	}
	for key := range schema {
		if _, ok := allowed[key]; ok {
			continue
		}
		// Unknown keys are treated as inert annotations only if they do not
		// look like executable/active composition keywords.
		switch key {
		case "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "dependencies", "dependentSchemas", "patternProperties", "contains", "format":
			return fmt.Errorf("parameterSchema keyword %q is not supported", key)
		}
	}
	if props, ok := schema["properties"].(map[string]any); ok {
		for name, sub := range props {
			subObj, ok := sub.(map[string]any)
			if !ok {
				return fmt.Errorf("parameterSchema property %q must be an object", name)
			}
			if err := validateWorkbenchParamSchema(subObj, depth+1); err != nil {
				return fmt.Errorf("property %q: %w", name, err)
			}
		}
	}
	if items, ok := schema["items"].(map[string]any); ok {
		if err := validateWorkbenchParamSchema(items, depth+1); err != nil {
			return fmt.Errorf("items: %w", err)
		}
	}
	return nil
}

// decodeWorkbench parses a raw meta.workbench JSON object into a Workbench. It
// is invoked from jsplugin's meta decoder; kept here so the type, validation,
// and projection share one home. Returns (nil, nil) when workbench is absent.
func decodeWorkbench(value any) (*Workbench, error) {
	if value == nil {
		return nil, nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("workbench must be an object")
	}
	for key := range object {
		switch key {
		case "schemaVersion", "capabilities":
		default:
			return nil, fmt.Errorf("workbench has unknown field %q", key)
		}
	}
	wb := &Workbench{}
	var err error
	if wb.SchemaVersion, err = intField(object, "schemaVersion"); err != nil {
		return nil, fmt.Errorf("workbench: %w", err)
	}
	rawCaps, present := object["capabilities"]
	if !present {
		return wb, nil
	}
	items, ok := rawCaps.([]any)
	if !ok {
		return nil, errors.New("workbench capabilities must be an array")
	}
	wb.Capabilities = make([]WorkbenchCapability, 0, len(items))
	for index, item := range items {
		capObject, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("workbench capability %d must be an object", index)
		}
		cap, err := decodeWorkbenchCapability(capObject, index)
		if err != nil {
			return nil, err
		}
		wb.Capabilities = append(wb.Capabilities, *cap)
	}
	return wb, nil
}

func decodeWorkbenchCapability(object map[string]any, index int) (*WorkbenchCapability, error) {
	for key := range object {
		switch key {
		case "id", "model", "mediaType", "operations", "deferSchema", "referenceLimits", "parameterSchema", "presets", "delivery":
		default:
			return nil, fmt.Errorf("workbench capability %d has unknown field %q", index, key)
		}
	}
	cap := &WorkbenchCapability{}
	var err error
	if cap.ID, err = stringField(object, "id"); err != nil {
		return nil, fmt.Errorf("workbench capability %d: %w", index, err)
	}
	if cap.Model, err = stringField(object, "model"); err != nil {
		return nil, fmt.Errorf("workbench capability %d: %w", index, err)
	}
	if cap.MediaType, err = stringField(object, "mediaType"); err != nil {
		return nil, fmt.Errorf("workbench capability %d: %w", index, err)
	}
	if cap.Operations, err = stringSliceField(object, "operations"); err != nil {
		return nil, fmt.Errorf("workbench capability %d: %w", index, err)
	}
	if cap.DeferSchema, err = boolField(object, "deferSchema"); err != nil {
		return nil, fmt.Errorf("workbench capability %d: %w", index, err)
	}
	if raw, present := object["referenceLimits"]; present {
		limits, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("workbench capability %d referenceLimits must be an object", index)
		}
		cap.ReferenceLimits = make(map[string]int, len(limits))
		for k, v := range limits {
			n, ok := v.(float64)
			if !ok {
				return nil, fmt.Errorf("workbench capability %d referenceLimits[%q] must be a number", index, k)
			}
			cap.ReferenceLimits[k] = int(n)
		}
	}
	if raw, present := object["parameterSchema"]; present {
		schema, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("workbench capability %d parameterSchema must be an object", index)
		}
		cap.ParameterSchema = schema
	}
	if raw, present := object["presets"]; present {
		items, ok := raw.([]any)
		if !ok {
			return nil, fmt.Errorf("workbench capability %d presets must be an array", index)
		}
		cap.Presets = make([]map[string]any, 0, len(items))
		for i, item := range items {
			m, ok := item.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("workbench capability %d preset %d must be an object", index, i)
			}
			cap.Presets = append(cap.Presets, m)
		}
	}
	if raw, present := object["delivery"]; present {
		d, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("workbench capability %d delivery must be an object", index)
		}
		cap.Delivery = d
	}
	return cap, nil
}

func intField(object map[string]any, name string) (int, error) {
	raw, present := object[name]
	if !present {
		return 0, nil
	}
	n, ok := raw.(float64)
	if !ok {
		return 0, fmt.Errorf("field %q must be a number", name)
	}
	return int(n), nil
}

func stringField(object map[string]any, name string) (string, error) {
	raw, present := object[name]
	if !present {
		return "", nil
	}
	s, ok := raw.(string)
	if !ok {
		return "", fmt.Errorf("field %q must be a string", name)
	}
	return s, nil
}

func boolField(object map[string]any, name string) (bool, error) {
	raw, present := object[name]
	if !present {
		return false, nil
	}
	b, ok := raw.(bool)
	if !ok {
		return false, fmt.Errorf("field %q must be a boolean", name)
	}
	return b, nil
}

func stringSliceField(object map[string]any, name string) ([]string, error) {
	raw, present := object[name]
	if !present {
		return nil, nil
	}
	items, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("field %q must be an array", name)
	}
	out := make([]string, 0, len(items))
	for i, item := range items {
		s, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("field %q item %d must be a string", name, i)
		}
		out = append(out, s)
	}
	return out, nil
}
