package middleware

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/setting"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// concurrencyTestContext restores the gate's global state after the test: the
// limiter is process-wide by design, so tests must not leak into each other.
func withConcurrencyLimit(t *testing.T, enabled bool, limits map[string]int) {
	t.Helper()
	previousEnabled := setting.UserConcurrencyLimitEnabled
	previousLimits := setting.UserConcurrencyLimitGroup
	setting.UserConcurrencyLimitEnabled = enabled
	setting.UserConcurrencyLimitGroup = limits
	t.Cleanup(func() {
		setting.UserConcurrencyLimitEnabled = previousEnabled
		setting.UserConcurrencyLimitGroup = previousLimits
		userConcurrencyCounter.mu.Lock()
		userConcurrencyCounter.inflight = make(map[int]int64)
		userConcurrencyCounter.mu.Unlock()
	})
}

// serveGatedRequest runs one request through the gate as the given identity.
// handler runs inside the slot, which is where a test holds it open.
func serveGatedRequest(t *testing.T, userId int, role int, group string, handler gin.HandlerFunc) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)

	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set("id", userId)
		common.SetContextKey(c, constant.ContextKeyUserRole, role)
		common.SetContextKey(c, constant.ContextKeyUserGroup, group)
		c.Next()
	})
	router.Use(UserConcurrencyLimit())
	router.POST("/test", handler)

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/test", nil))
	return recorder
}

// TestUserConcurrencyLimitRejectsSecondRequest pins the core behaviour: one
// user holds the single slot their group allows, and a second concurrent
// request is refused immediately rather than queued.
func TestUserConcurrencyLimitRejectsSecondRequest(t *testing.T) {
	withConcurrencyLimit(t, true, map[string]int{"default": 1})

	entered := make(chan struct{})
	hold := make(chan struct{})
	firstDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		firstDone <- serveGatedRequest(t, 42, common.RoleCommonUser, "default", func(c *gin.Context) {
			close(entered)
			<-hold
			c.Status(http.StatusOK)
		})
	}()
	<-entered

	second := serveGatedRequest(t, 42, common.RoleCommonUser, "default", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})
	require.Equal(t, http.StatusTooManyRequests, second.Code)
	assert.Contains(t, second.Body.String(), "concurrency_limit_exceeded")

	// The slot comes back once the first request finishes.
	close(hold)
	require.Equal(t, http.StatusOK, (<-firstDone).Code)

	third := serveGatedRequest(t, 42, common.RoleCommonUser, "default", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})
	assert.Equal(t, http.StatusOK, third.Code)
}

// TestUserConcurrencyLimitIsPerUser pins that one user's slot does not consume
// another's: the ceiling is a per-user budget, not a shared pool.
func TestUserConcurrencyLimitIsPerUser(t *testing.T) {
	withConcurrencyLimit(t, true, map[string]int{"default": 1})

	entered := make(chan struct{})
	hold := make(chan struct{})
	firstDone := make(chan struct{})
	go func() {
		serveGatedRequest(t, 1, common.RoleCommonUser, "default", func(c *gin.Context) {
			close(entered)
			<-hold
			c.Status(http.StatusOK)
		})
		close(firstDone)
	}()
	<-entered
	defer func() {
		close(hold)
		<-firstDone
	}()

	other := serveGatedRequest(t, 2, common.RoleCommonUser, "default", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})
	assert.Equal(t, http.StatusOK, other.Code)
}

// TestUserConcurrencyLimitGroupCeiling pins that the ceiling follows the user's
// own group, so a higher-tier user is not throttled by the free tier's number.
func TestUserConcurrencyLimitGroupCeiling(t *testing.T) {
	withConcurrencyLimit(t, true, map[string]int{"default": 1, "vip": 2})

	entered := make(chan struct{})
	release := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func() {
			defer wg.Done()
			serveGatedRequest(t, 7, common.RoleCommonUser, "vip", func(c *gin.Context) {
				entered <- struct{}{}
				<-release
				c.Status(http.StatusOK)
			})
		}()
	}
	<-entered
	<-entered

	over := serveGatedRequest(t, 7, common.RoleCommonUser, "vip", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})
	assert.Equal(t, http.StatusTooManyRequests, over.Code)

	close(release)
	wg.Wait()
}

// TestUserConcurrencyLimitUnlistedGroupIsUnrestricted pins the opt-in rule: a
// group the operator did not list has no ceiling.
func TestUserConcurrencyLimitUnlistedGroupIsUnrestricted(t *testing.T) {
	withConcurrencyLimit(t, true, map[string]int{"default": 1})

	for i := 0; i < 3; i++ {
		recorder := serveGatedRequest(t, 9, common.RoleCommonUser, "svip", func(c *gin.Context) {
			c.Status(http.StatusOK)
		})
		require.Equal(t, http.StatusOK, recorder.Code)
	}
}

// TestUserConcurrencyLimitDisabledIsPassthrough pins the zero-regression
// switch: with the gate off, even a request that would exceed the ceiling
// passes.
func TestUserConcurrencyLimitDisabledIsPassthrough(t *testing.T) {
	withConcurrencyLimit(t, false, map[string]int{"default": 1})

	entered := make(chan struct{})
	hold := make(chan struct{})
	firstDone := make(chan struct{})
	go func() {
		serveGatedRequest(t, 5, common.RoleCommonUser, "default", func(c *gin.Context) {
			close(entered)
			<-hold
			c.Status(http.StatusOK)
		})
		close(firstDone)
	}()
	<-entered
	defer func() {
		close(hold)
		<-firstDone
	}()

	recorder := serveGatedRequest(t, 5, common.RoleCommonUser, "default", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})
	assert.Equal(t, http.StatusOK, recorder.Code)
}

// TestUserConcurrencyLimitExemptsOperators pins that an operator is not
// throttled by the tier meant for callers below them.
func TestUserConcurrencyLimitExemptsOperators(t *testing.T) {
	for _, role := range []int{common.RoleAdminUser, common.RoleRootUser} {
		withConcurrencyLimit(t, true, map[string]int{"default": 1})

		entered := make(chan struct{})
		hold := make(chan struct{})
		firstDone := make(chan struct{})
		go func() {
			serveGatedRequest(t, 3, role, "default", func(c *gin.Context) {
				close(entered)
				<-hold
				c.Status(http.StatusOK)
			})
			close(firstDone)
		}()
		<-entered

		second := serveGatedRequest(t, 3, role, "default", func(c *gin.Context) {
			c.Status(http.StatusOK)
		})
		close(hold)
		<-firstDone
		assert.Equal(t, http.StatusOK, second.Code, "role %d", role)
	}
}

// TestUserConcurrencyLimitReleasesOnPanic pins that a panicking handler cannot
// leak the slot: the release is deferred, not conditional on the response.
func TestUserConcurrencyLimitReleasesOnPanic(t *testing.T) {
	withConcurrencyLimit(t, true, map[string]int{"default": 1})

	func() {
		defer func() {
			_ = recover()
		}()
		serveGatedRequest(t, 11, common.RoleCommonUser, "default", func(c *gin.Context) {
			panic("handler exploded")
		})
	}()

	recorder := serveGatedRequest(t, 11, common.RoleCommonUser, "default", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})
	assert.Equal(t, http.StatusOK, recorder.Code)
}

// TestUserConcurrencyLimitIgnoresTokenGroup pins that the ceiling is looked up
// with the user's own group: setting the request's using-group to a higher tier
// must not raise it.
func TestUserConcurrencyLimitIgnoresTokenGroup(t *testing.T) {
	withConcurrencyLimit(t, true, map[string]int{"default": 1, "vip": 8})

	entered := make(chan struct{})
	hold := make(chan struct{})
	firstDone := make(chan struct{})
	go func() {
		serveGatedRequest(t, 13, common.RoleCommonUser, "default", func(c *gin.Context) {
			close(entered)
			<-hold
			c.Status(http.StatusOK)
		})
		close(firstDone)
	}()
	<-entered
	defer func() {
		close(hold)
		<-firstDone
	}()

	// The user group stays "default" even though the request asked for "vip".
	second := serveGatedRequest(t, 13, common.RoleCommonUser, "default", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})
	assert.Equal(t, http.StatusTooManyRequests, second.Code)
}
