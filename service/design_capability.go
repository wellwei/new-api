package service

import (
	"sort"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
)

// Capability projection for the design workbench (design doc §5.1). A
// capability is visible to one user only when every gate holds:
//
//	global switch ∩ plugin enabled ∩ ≥1 enabled channel ∩ model priced
//	∩ user's usable groups.
//
// The projection is render metadata only — submission re-validates everything
// through the shared task barrier (token model limits, channel selection,
// billing), and the plugin protocol hook re-validates parameters.

// DesignCapabilitySummary is one projected workbench capability.
type DesignCapabilitySummary struct {
	ID          string   `json:"id"`
	PluginKey   string   `json:"plugin_key"`
	PluginName  string   `json:"plugin_name"`
	Model       string   `json:"model"`
	MediaType   string   `json:"media_type"`
	Operations  []string `json:"operations"`
	DeferSchema bool     `json:"defer_schema"`

	// ParameterSchema is present unless DeferSchema is set; the schema
	// endpoint serves it on demand.
	ParameterSchema map[string]any         `json:"parameter_schema,omitempty"`
	ReferenceLimits map[string]int         `json:"reference_limits,omitempty"`
	Presets         []map[string]any       `json:"presets,omitempty"`
	Delivery        map[string]any         `json:"delivery,omitempty"`
	Price           *DesignCapabilityPrice `json:"price,omitempty"`
	Available       bool                   `json:"available"`
	UnavailableWhy  string                 `json:"unavailable_reason,omitempty"`
}

// DesignCapabilityPrice carries the per-call fixed price used by the
// confirmation sheet. Workbench capabilities must be per-call priced
// (ModelPrice): a ratio-priced task model cannot be quoted exactly before
// submit, and §4.3 forbids offering such a confirm sheet.
type DesignCapabilityPrice struct {
	ModelPrice float64 `json:"model_price"` // USD per call, before group ratio
	GroupRatio float64 `json:"group_ratio"`
	// QuotaPerCall is what one call is expected to deduct, in quota units.
	QuotaPerCall int64 `json:"quota_per_call"`
}

// DesignCapabilitiesForUser projects every declared workbench capability for
// one user's group. A capability that fails any gate is absent from the
// result entirely — the acceptance rule says a disabled plugin, channel,
// price, or switch must make it disappear from the normal user view, not
// merely grey out.
func DesignCapabilitiesForUser(userGroup string) []DesignCapabilitySummary {
	if !setting.DesignWorkbenchEnabled {
		return nil
	}
	usableGroups := GetUserUsableGroups(userGroup)
	pricing := designCapabilityPriceIndex(usableGroups)
	channelModels := designCapabilityChannelIndex(usableGroups)

	registry := pluginruntime.DefaultRegistry.Snapshot()
	summaries := make([]DesignCapabilitySummary, 0, 8)
	appendMeta := func(meta pluginruntime.Meta) {
		if meta.Workbench == nil {
			return
		}
		for i := range meta.Workbench.Capabilities {
			capability := &meta.Workbench.Capabilities[i]
			summary := projectCapability(meta, capability, userGroup, pricing, channelModels)
			if !summary.Available {
				continue
			}
			summaries = append(summaries, summary)
		}
	}
	for _, meta := range registry.Factory {
		appendMeta(meta)
	}
	for _, meta := range registry.Override {
		appendMeta(meta)
	}
	sort.Slice(summaries, func(i, j int) bool { return summaries[i].ID < summaries[j].ID })
	return summaries
}

// DesignCapabilitySchema returns the full parameter schema of one projected
// capability, including deferred ones. Callers use it for the on-demand
// schema endpoint and for server-side evaluation before submit.
func DesignCapabilitySchema(capabilityID, userGroup string) (map[string]any, error) {
	for _, summary := range DesignCapabilitiesForUser(userGroup) {
		if summary.ID != capabilityID {
			continue
		}
		// Re-read from the registry: the projection drops deferred schemas.
		registry := pluginruntime.DefaultRegistry.Snapshot()
		for _, meta := range registry.Factory {
			if schema, ok := capabilitySchemaFromMeta(meta, capabilityID); ok {
				return schema, nil
			}
		}
		for _, meta := range registry.Override {
			if schema, ok := capabilitySchemaFromMeta(meta, capabilityID); ok {
				return schema, nil
			}
		}
		return nil, nil
	}
	return nil, nil
}

func capabilitySchemaFromMeta(meta pluginruntime.Meta, capabilityID string) (map[string]any, bool) {
	if meta.Workbench == nil {
		return nil, false
	}
	for i := range meta.Workbench.Capabilities {
		capability := &meta.Workbench.Capabilities[i]
		if capability.ID == capabilityID {
			return capability.ParameterSchema, true
		}
	}
	return nil, false
}

func projectCapability(
	meta pluginruntime.Meta,
	capability *pluginruntime.WorkbenchCapability,
	userGroup string,
	pricing map[string]*model.Pricing,
	channelModels map[string]struct{},
) DesignCapabilitySummary {
	summary := DesignCapabilitySummary{
		ID:              capability.ID,
		PluginKey:       meta.Key,
		PluginName:      meta.Name,
		Model:           capability.Model,
		MediaType:       capability.MediaType,
		Operations:      capability.Operations,
		DeferSchema:     capability.DeferSchema,
		ReferenceLimits: capability.ReferenceLimits,
		Presets:         capability.Presets,
		Delivery:        capability.Delivery,
		Available:       true,
	}
	if !capability.DeferSchema {
		summary.ParameterSchema = capability.ParameterSchema
	}

	pricingEntry, priced := pricing[capability.Model]
	if !priced {
		summary.Available = false
		summary.UnavailableWhy = "model_not_priced"
		return summary
	}
	if _, served := channelModels[capability.Model]; !served {
		summary.Available = false
		summary.UnavailableWhy = "no_available_channel"
		return summary
	}
	groupRatio := userGroupRatio(userGroup)
	summary.Price = &DesignCapabilityPrice{
		ModelPrice:   pricingEntry.ModelPrice,
		GroupRatio:   groupRatio,
		QuotaPerCall: int64(pricingEntry.ModelPrice * common.QuotaPerUnit * groupRatio),
	}
	return summary
}

// designCapabilityPriceIndex keeps per-call priced models whose enable groups
// intersect the user's usable groups. Everything else is dropped — the
// workbench cannot quote it, so it must not offer it (§4.3, §10).
func designCapabilityPriceIndex(usableGroups map[string]string) map[string]*model.Pricing {
	index := make(map[string]*model.Pricing)
	for i := range model.GetPricing() {
		entry := &model.GetPricing()[i]
		if entry.QuotaType != 1 || entry.ModelPrice <= 0 {
			continue
		}
		if !enableGroupsIntersect(entry.EnableGroup, usableGroups) {
			continue
		}
		index[entry.ModelName] = entry
	}
	return index
}

func designCapabilityChannelIndex(usableGroups map[string]string) map[string]struct{} {
	index := make(map[string]struct{})
	for _, ability := range model.GetAllEnableAbilities() {
		if _, usable := usableGroups[ability.Group]; !usable {
			continue
		}
		index[ability.Model] = struct{}{}
	}
	return index
}

func enableGroupsIntersect(enableGroups []string, usableGroups map[string]string) bool {
	if len(enableGroups) == 0 {
		return false
	}
	for _, group := range enableGroups {
		if group == "all" {
			return true
		}
		if _, usable := usableGroups[group]; usable {
			return true
		}
	}
	return false
}

// userGroupRatio mirrors HandleGroupRatio for a submission whose effective
// group is the user's own group.
func userGroupRatio(userGroup string) float64 {
	if special, ok := ratio_setting.GetGroupGroupRatio(userGroup, userGroup); ok {
		return special
	}
	return ratio_setting.GetGroupRatio(userGroup)
}
