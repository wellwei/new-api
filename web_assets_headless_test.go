//go:build headless

package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestHeadlessAssetsHaveNoFrontendPayload(testContext *testing.T) {
	assets := prepareWebAssets()
	assert.True(testContext, assets.APIOnly)
	assert.Empty(testContext, assets.IndexPage)
	_, err := assets.BuildFS.ReadDir("web/dist")
	assert.Error(testContext, err)
}
