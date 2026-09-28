package service

import (
	"testing"

	"github.com/QuantumNous/new-api/model"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const designWorkbenchTestPlugin = `
export const meta = {
	apiVersion: 1,
	key: "design-projection",
	name: "Design Projection",
	version: "1.0.0",
	author: {name: "Test"},
	models: ["design-image-model", "design-unpriced-model"],
	fetchMode: "per_task",
	workbench: {
		schemaVersion: 1,
		capabilities: [
			{
				id: "design-projection:image",
				model: "design-image-model",
				mediaType: "image",
				operations: ["generate"],
				parameterSchema: {
					type: "object",
					required: ["prompt"],
					properties: {prompt: {type: "string"}}
				}
			},
			{
				id: "design-projection:unpriced",
				model: "design-unpriced-model",
				mediaType: "image",
				operations: ["generate"]
			}
		]
	}
};
export function buildSubmitRequest() { return {}; }
export function parseSubmitResponse() { return {}; }
export function parseTaskResult() { return {}; }
export function buildQueryRequest() { return {}; }
export function parseQueryResponse() { return {}; }
`

func setupDesignCapabilityFixture(t *testing.T) {
	t.Helper()
	_, err := pluginruntime.DefaultRegistry.Register(designWorkbenchTestPlugin, pluginruntime.Options{})
	require.NoError(t, err)
	t.Cleanup(func() { pluginruntime.DefaultRegistry.Unregister("design-projection") })

	setting.DesignWorkbenchEnabled = true
	t.Cleanup(func() { setting.DesignWorkbenchEnabled = false })

	require.NoError(t, ratio_setting.UpdateModelPriceByJSONString(`{"design-image-model":0.05}`))
	t.Cleanup(func() {
		_ = ratio_setting.UpdateModelPriceByJSONString(`{}`)
		model.InvalidatePricingCache()
	})

	channel := &model.Channel{Name: "design-test-channel", Type: 1, Status: 1}
	require.NoError(t, model.DB.Create(channel).Error)
	ability := &model.Ability{Group: "default", Model: "design-image-model", ChannelId: channel.Id, Enabled: true}
	require.NoError(t, model.DB.Create(ability).Error)
	t.Cleanup(func() {
		model.DB.Exec("DELETE FROM abilities")
		model.DB.Exec("DELETE FROM channels")
	})
	model.InvalidatePricingCache()
	t.Cleanup(func() { model.InvalidatePricingCache() })
}

func TestDesignCapabilitiesForUserVisibleWhenAllGatesPass(t *testing.T) {
	setupDesignCapabilityFixture(t)

	summaries := DesignCapabilitiesForUser("default")
	require.Len(t, summaries, 1, "the unpriced capability must be invisible")

	summary := summaries[0]
	assert.Equal(t, "design-projection:image", summary.ID)
	assert.Equal(t, "design-image-model", summary.Model)
	assert.Equal(t, "image", summary.MediaType)
	assert.True(t, summary.Available)
	require.NotNil(t, summary.Price)
	assert.Equal(t, 0.05, summary.Price.ModelPrice)
	assert.Positive(t, summary.Price.QuotaPerCall)
	require.NotNil(t, summary.ParameterSchema)
}

func TestDesignCapabilitiesHiddenWhenSwitchOff(t *testing.T) {
	setupDesignCapabilityFixture(t)
	setting.DesignWorkbenchEnabled = false

	assert.Empty(t, DesignCapabilitiesForUser("default"))
}

func TestDesignCapabilitySchemaIncludesDeferred(t *testing.T) {
	setupDesignCapabilityFixture(t)

	schema, err := DesignCapabilitySchema("design-projection:image", "default")
	require.NoError(t, err)
	require.NotNil(t, schema)
	assert.Equal(t, "object", schema["type"])
}
