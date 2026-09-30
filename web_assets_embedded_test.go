//go:build !headless

package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestEmbeddedAssetsKeepHTMLAndAnalyticsInjection(testContext *testing.T) {
	originalPage := indexPage
	testContext.Cleanup(func() { indexPage = originalPage })
	indexPage = []byte("<html><!--umami-->\n<!--Google Analytics-->\n</html>")
	testContext.Setenv("UMAMI_WEBSITE_ID", "test-site")
	testContext.Setenv("UMAMI_SCRIPT_URL", "https://analytics.example/script.js")
	testContext.Setenv("GOOGLE_ANALYTICS_ID", "G-TEST123")
	assets := prepareWebAssets()
	assert.False(testContext, assets.APIOnly)
	assert.Contains(testContext, string(assets.IndexPage), `data-website-id="test-site"`)
	assert.Contains(testContext, string(assets.IndexPage), "G-TEST123")
	entries, err := assets.BuildFS.ReadDir("web/dist")
	require.NoError(testContext, err)
	assert.NotEmpty(testContext, entries)
}
