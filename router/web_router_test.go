package router

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestAPIOnlyFallbackKeepsPluginDispatchAndJSONErrors(testContext *testing.T) {
	server := gin.New()
	SetAPIOnlyRouter(server, func(context *gin.Context) {
		if context.Request.URL.Path == "/custom-plugin/task" {
			context.AbortWithStatusJSON(http.StatusAccepted, gin.H{"task": "accepted"})
			return
		}
		context.Next()
	})
	pluginResponse := httptest.NewRecorder()
	server.ServeHTTP(pluginResponse, httptest.NewRequest(http.MethodPost, "/custom-plugin/task", nil))
	assert.Equal(testContext, http.StatusAccepted, pluginResponse.Code)
	assert.JSONEq(testContext, `{"task":"accepted"}`, pluginResponse.Body.String())

	for _, requestPath := range []string{"/api/missing", "/v1beta/missing", "/unknown-plugin", "/design", "/assets/missing.js"} {
		testContext.Run(requestPath, func(testContext *testing.T) {
			response := httptest.NewRecorder()
			server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, requestPath, nil))
			assert.Equal(testContext, http.StatusNotFound, response.Code)
			assert.Contains(testContext, response.Header().Get("Content-Type"), "application/json")
			assert.Contains(testContext, response.Header().Get("Cache-Control"), "no-store")
			assert.Empty(testContext, response.Header().Get("Location"))
			assert.Contains(testContext, response.Body.String(), "Invalid URL")
		})
	}
}

func TestAPIOnlyModeNeverRedirectsToFrontendBaseURL(testContext *testing.T) {
	testContext.Setenv("FRONTEND_BASE_URL", "https://frontend.example")
	server := gin.New()
	SetRouter(server, WebAssets{APIOnly: true})
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/unregistered-page", nil))
	assert.Equal(testContext, http.StatusNotFound, response.Code)
	assert.Empty(testContext, response.Header().Get("Location"))
}
