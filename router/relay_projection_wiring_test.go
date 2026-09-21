package router

import (
	"reflect"
	"testing"

	"github.com/QuantumNous/new-api/middleware"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

// carriesProjection reports whether a handler chain includes the response-model
// projection, identified by function pointer so an anonymous wrapper cannot be
// mistaken for it.
func carriesProjection(handlers []gin.HandlerFunc) bool {
	want := reflect.ValueOf(middleware.ResponseModelProjection()).Pointer()
	for _, handler := range handlers {
		if reflect.ValueOf(handler).Pointer() == want {
			return true
		}
	}
	return false
}

// TestPluginProtocolResponsesRouteCarriesProjection covers the surface that the
// /v1 middleware group cannot reach: POST /v1/responses is registered from the
// host protocol registry, so it has to install the projection itself or a normal
// caller reads back whichever model upstream declared.
func TestPluginProtocolResponsesRouteCarriesProjection(t *testing.T) {
	gin.SetMode(gin.TestMode)

	for _, operation := range []string{"create"} {
		handlers, err := taskPluginProtocolHandlers("openai_responses", operation)
		assert.NoError(t, err)
		assert.True(t, carriesProjection(handlers), "openai_responses.%s must project the response model", operation)
	}
}

// TestOtherPluginProtocolRoutesAreNotProjected keeps the projection where it
// belongs: the image and video surfaces do not echo a model of their own, so
// wrapping them would only add a buffer in front of binary payloads.
func TestOtherPluginProtocolRoutesAreNotProjected(t *testing.T) {
	gin.SetMode(gin.TestMode)

	for _, operation := range []string{"generate", "edit"} {
		handlers, err := taskPluginProtocolHandlers("openai_image", operation)
		assert.NoError(t, err)
		assert.False(t, carriesProjection(handlers), "openai_image.%s has no model member to project", operation)
	}

	handlers, err := taskPluginProtocolHandlers("openai_responses", "retrieve")
	assert.NoError(t, err)
	assert.False(t, carriesProjection(handlers), "openai_responses.retrieve returns stored state, not a relayed model")

	for _, operation := range []string{"retrieve", "content"} {
		videoHandlers, err := taskPluginProtocolHandlers("openai_video", operation)
		assert.NoError(t, err)
		assert.False(t, carriesProjection(videoHandlers), "openai_video.%s returns stored state, not a relayed model", operation)
	}
}
