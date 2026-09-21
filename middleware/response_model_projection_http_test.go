package middleware

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// serveProjection runs one request through the projection middleware with the
// given role and handler, returning the recorded response.
func serveProjection(t *testing.T, role int, requested string, contentType string, handler gin.HandlerFunc) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)

	router := gin.New()
	router.Use(func(c *gin.Context) {
		common.SetContextKey(c, constant.ContextKeyUserRole, role)
		common.SetContextKey(c, constant.ContextKeyOriginalModel, requested)
		c.Next()
	})
	router.Use(ResponseModelProjection())
	router.POST("/test", func(c *gin.Context) {
		if contentType != "" {
			c.Writer.Header().Set("Content-Type", contentType)
		}
		handler(c)
	})

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/test", nil)
	router.ServeHTTP(recorder, request)
	return recorder
}

// TestResponseModelProjectionRewritesNonOperatorBodies covers the ordinary
// non-stream response: the model the caller asked for replaces the one upstream
// declared, and the declared length is restated for the shorter body.
func TestResponseModelProjectionRewritesNonOperatorBodies(t *testing.T) {
	const upstream = `{"id":"c1","model":"vmc/fireworks-cline-k3-contributor-fallbacks","choices":[]}`

	recorder := serveProjection(t, common.RoleCommonUser, "kimi-k3", "application/json", func(c *gin.Context) {
		_, _ = c.Writer.WriteString(upstream)
	})

	require.Equal(t, http.StatusOK, recorder.Code)
	const want = `{"id":"c1","model":"kimi-k3","choices":[]}`
	assert.Equal(t, want, recorder.Body.String())
	assert.Equal(t, strconv.Itoa(len(want)), recorder.Header().Get("Content-Length"))
}

// TestResponseModelProjectionLeavesOperatorBodiesAlone pins the other half of
// the rule: an admin or root caller keeps the upstream declaration, because
// which pool answered is exactly what they are looking at.
func TestResponseModelProjectionLeavesOperatorBodiesAlone(t *testing.T) {
	const upstream = `{"id":"c1","model":"vmc/fireworks-cline-k3-contributor-fallbacks","choices":[]}`

	for _, role := range []int{common.RoleAdminUser, common.RoleRootUser} {
		recorder := serveProjection(t, role, "kimi-k3", "application/json", func(c *gin.Context) {
			_, _ = c.Writer.WriteString(upstream)
		})
		assert.Equal(t, upstream, recorder.Body.String(), "role %d must see the upstream model", role)
	}
}

// TestResponseModelProjectionRewritesSplitStreamWrites covers the streaming
// case, where the member, its colon and its value arrive in separate writes: the
// rewrite holds only a live partial match, and drops the stale length.
func TestResponseModelProjectionRewritesSplitStreamWrites(t *testing.T) {
	writes := []string{
		`data: {"id":"c1","mod`,
		`el":`,
		`"upstream/model-x"`,
		`,"choices":[]}` + "\n\n",
	}

	recorder := serveProjection(t, common.RoleCommonUser, "kimi-k3", "text/event-stream", func(c *gin.Context) {
		for _, w := range writes {
			_, _ = c.Writer.WriteString(w)
		}
	})

	require.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, "data: {\"id\":\"c1\",\"model\":\"kimi-k3\",\"choices\":[]}\n\n", recorder.Body.String())
	assert.Empty(t, recorder.Header().Get("Content-Length"))
	assert.NotContains(t, recorder.Body.String(), "upstream/model-x")
}

// TestResponseModelProjectionFlushesPartialMatchVerbatim proves nothing is lost
// when a body ends mid-match: the withheld bytes are released as they came.
func TestResponseModelProjectionFlushesPartialMatchVerbatim(t *testing.T) {
	// The body stops after `"mod`, which can no longer become a model member.
	const truncated = `{"id":"c1","mod`

	recorder := serveProjection(t, common.RoleCommonUser, "kimi-k3", "application/json", func(c *gin.Context) {
		_, _ = c.Writer.WriteString(truncated)
	})
	assert.Equal(t, truncated, recorder.Body.String())
}

// TestResponseModelProjectionPassesNonJSONThrough pins that audio and image
// payloads are neither scanned nor re-framed.
func TestResponseModelProjectionPassesNonJSONThrough(t *testing.T) {
	binary := []byte{0x00, 0x01, 0xff, 0xfe, '"', 'm', 'o', 'd', 'e', 'l', '"', ':'}

	recorder := serveProjection(t, common.RoleCommonUser, "kimi-k3", "audio/mpeg", func(c *gin.Context) {
		_, _ = c.Writer.Write(binary)
	})
	assert.Equal(t, binary, recorder.Body.Bytes())
}

// TestResponseModelProjectionSkipsWhenNoModelWasResolved keeps the projector
// out of the way of responses that never went through channel selection.
func TestResponseModelProjectionSkipsWhenNoModelWasResolved(t *testing.T) {
	const upstream = `{"model":"upstream-name"}`

	recorder := serveProjection(t, common.RoleCommonUser, "", "application/json", func(c *gin.Context) {
		_, _ = c.Writer.WriteString(upstream)
	})
	assert.Equal(t, upstream, recorder.Body.String())
}

// TestResponseModelProjectionKeepsStatusAndSizeIntact checks the writer's own
// contract: a handler that sets a status and measures its output still reads
// values consistent with what the caller receives.
func TestResponseModelProjectionKeepsStatusAndSizeIntact(t *testing.T) {
	var status int
	var size int
	recorder := serveProjection(t, common.RoleCommonUser, "kimi-k3", "application/json", func(c *gin.Context) {
		c.Status(http.StatusCreated)
		_, _ = c.Writer.WriteString(`{"model":"upstream-name"}`)
		status = c.Writer.Status()
		size = c.Writer.Size()
	})

	assert.Equal(t, http.StatusCreated, recorder.Code)
	assert.Equal(t, http.StatusCreated, status)
	assert.Equal(t, recorder.Body.Len(), size, "Size must report the bytes the caller receives")
	assert.Equal(t, `{"model":"kimi-k3"}`, recorder.Body.String())
}
