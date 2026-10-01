package middleware

import (
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"

	"github.com/gin-gonic/gin"
)

// RequireDashboardSession rejects personal access token credentials on
// actions that stand in for a human decision. It complements
// SessionCookieOriginGuard, which only proves the request came from the
// site's own pages: a PAT is an ambient bearer credential, so any component
// holding it — an agent, a script, a leaked config — could otherwise replay
// the click. Install it on the individual routes that authorize spending or
// destroy state, never on a whole route group: agents legitimately create
// projects, request quotes, submit tasks and read results through a PAT.
func RequireDashboardSession() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetBool("use_access_token") {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"success": false,
				"code":    "AUTH_SESSION_REQUIRED",
				"message": common.TranslateMessage(c, i18n.MsgAuthSessionRequired),
			})
			return
		}
		c.Next()
	}
}
