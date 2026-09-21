package middleware

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/setting"

	"github.com/gin-gonic/gin"
)

// UserConcurrencyLimit caps how many relay requests one user may have in
// flight at once. The ceiling comes from the caller's own user group, so a
// token pointed at another group cannot raise it, and a group the operator
// did not list is unrestricted.
//
// The gate fails fast: a request arriving with every slot in use is rejected
// with 429 rather than queued. Queuing would turn the ceiling into a latency
// staircase that callers cannot see, and the slots are held for the whole
// streaming response.
func UserConcurrencyLimit() gin.HandlerFunc {
	return userConcurrencyLimit
}

// userConcurrencyLimit is the handler itself, named so a test can assert which
// route chains carry it: some surfaces (the plugin-protocol routes) are
// registered outside the middleware groups that install it.
func userConcurrencyLimit(c *gin.Context) {
	if !setting.UserConcurrencyLimitEnabled {
		c.Next()
		return
	}

	userId := c.GetInt("id")
	if userId <= 0 {
		c.Next()
		return
	}

	// Operators keep their own tooling and diagnostics usable; the ceiling
	// exists for the callers below them.
	if role, ok := common.GetContextKeyType[int](c, constant.ContextKeyUserRole); ok && role >= common.RoleAdminUser {
		c.Next()
		return
	}

	group := ""
	if value, ok := common.GetContextKeyType[string](c, constant.ContextKeyUserGroup); ok {
		group = value
	}
	limit, found := setting.GetGroupConcurrencyLimit(group)
	if !found {
		c.Next()
		return
	}

	release, err := acquireUserConcurrencySlot(c.Request.Context(), userId, limit)
	if err != nil {
		// A limiter that cannot reach its store must not block traffic:
		// let the request through and record the failure.
		common.SysLog(fmt.Sprintf("user concurrency limit check failed for user %d: %v", userId, err))
		c.Next()
		return
	}
	if release == nil {
		abortWithOpenAiMessage(c, http.StatusTooManyRequests,
			common.TranslateMessage(c, i18n.MsgConcurrencyLimitReached, map[string]any{"Max": limit}),
			types.ErrorCodeConcurrencyLimitExceeded)
		return
	}
	// Unconditional: the slot must come back on success, failure, panic and
	// client disconnect alike. Nothing about the response decides this.
	defer release()
	c.Next()
}

// concurrencyKeyTTL is the Redis safety net for a slot whose owner never got to
// release it (process death between acquire and release). It has to outlive the
// longest possible single request but still bound how long a stale slot can
// wedge a user, so it is derived from the streaming timeout.
func concurrencyKeyTTL() time.Duration {
	seconds := constant.StreamingTimeout
	if seconds <= 0 {
		seconds = 300
	}
	return time.Duration(seconds)*time.Second + 60*time.Second
}

func userConcurrencyKey(userId int) string {
	return fmt.Sprintf("userConcurrency:%d", userId)
}

// acquireUserConcurrencySlot takes one slot for userId. A nil release with a
// nil error means the ceiling is already reached; a non-nil release gives the
// slot back.
func acquireUserConcurrencySlot(ctx context.Context, userId int, limit int) (func(), error) {
	// A configured-but-unreachable Redis must degrade to the in-process counter
	// rather than fail every request; the counter is authoritative for one
	// instance either way.
	if common.RedisEnabled && common.RDB != nil {
		return acquireUserConcurrencySlotRedis(ctx, userId, limit)
	}
	if !userConcurrencyCounter.tryAcquire(userId, limit) {
		return nil, nil
	}
	return func() { userConcurrencyCounter.release(userId) }, nil
}

func acquireUserConcurrencySlotRedis(ctx context.Context, userId int, limit int) (func(), error) {
	key := userConcurrencyKey(userId)
	if ctx == nil {
		ctx = context.Background()
	}
	// The context travels with a request that may already be cancelled on a
	// disconnect; the counter itself must still be consistent.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()

	count, err := common.RDB.Incr(ctx, key).Result()
	if err != nil {
		return nil, err
	}
	if count > int64(limit) {
		// Hand back the slot we did not get, so one reject does not leave the
		// counter permanently skewed.
		if err := common.RDB.Decr(ctx, key).Err(); err != nil {
			common.SysLog(fmt.Sprintf("user concurrency limit: failed to return slot for user %d: %v", userId, err))
		}
		return nil, nil
	}
	if err := common.RDB.Expire(ctx, key, concurrencyKeyTTL()).Err(); err != nil {
		common.SysLog(fmt.Sprintf("user concurrency limit: failed to set ttl for user %d: %v", userId, err))
	}
	released := false
	return func() {
		if released {
			return
		}
		released = true
		releaseCtx, releaseCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer releaseCancel()
		if err := common.RDB.Decr(releaseCtx, key).Err(); err != nil {
			common.SysLog(fmt.Sprintf("user concurrency limit: failed to release slot for user %d: %v", userId, err))
		}
	}, nil
}

// userConcurrencyCounter is the in-process fallback used when no Redis is
// configured. It is only correct for a single instance, which is how this
// deployment runs; the Redis path exists for a scaled-out one.
var userConcurrencyCounter = &concurrencyCounter{inflight: make(map[int]int64)}

type concurrencyCounter struct {
	mu       sync.Mutex
	inflight map[int]int64
}

func (counter *concurrencyCounter) tryAcquire(userId int, limit int) bool {
	counter.mu.Lock()
	defer counter.mu.Unlock()

	if counter.inflight[userId] >= int64(limit) {
		return false
	}
	counter.inflight[userId]++
	return true
}

func (counter *concurrencyCounter) release(userId int) {
	counter.mu.Lock()
	defer counter.mu.Unlock()

	if counter.inflight[userId] <= 1 {
		// Drop the entry so the map tracks active users, not every user seen.
		delete(counter.inflight, userId)
		return
	}
	counter.inflight[userId]--
}
