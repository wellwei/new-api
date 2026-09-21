package setting

import (
	"fmt"
	"sync"

	"github.com/QuantumNous/new-api/common"
)

// UserConcurrencyLimitGroup maps a user group to the maximum number of relay
// requests that may be in flight for one user of that group. It is consulted
// with the user's own group, never the token's, so a caller cannot raise its
// own ceiling by pointing a token at another group.
var UserConcurrencyLimitGroup = map[string]int{}
var UserConcurrencyLimitEnabled = false
var UserConcurrencyLimitMutex sync.RWMutex

// maxUserConcurrencyLimit bounds a single group's ceiling. The counter is an
// int64 per user; a five-digit ceiling is already far past what one account
// pool can serve, so anything larger is a configuration mistake.
const maxUserConcurrencyLimit = 100000

func UserConcurrencyLimitGroup2JSONString() string {
	UserConcurrencyLimitMutex.RLock()
	defer UserConcurrencyLimitMutex.RUnlock()

	jsonBytes, err := common.Marshal(UserConcurrencyLimitGroup)
	if err != nil {
		common.SysLog("error marshalling user concurrency limit: " + err.Error())
	}
	return string(jsonBytes)
}

func UpdateUserConcurrencyLimitGroupByJSONString(jsonStr string) error {
	UserConcurrencyLimitMutex.Lock()
	defer UserConcurrencyLimitMutex.Unlock()

	UserConcurrencyLimitGroup = make(map[string]int)
	return common.Unmarshal([]byte(jsonStr), &UserConcurrencyLimitGroup)
}

// GetGroupConcurrencyLimit reports the ceiling for one user group. A group
// that is not listed has no ceiling: the operator opts in per group, and an
// unlisted group is unrestricted rather than blocked.
func GetGroupConcurrencyLimit(group string) (int, bool) {
	UserConcurrencyLimitMutex.RLock()
	defer UserConcurrencyLimitMutex.RUnlock()

	if UserConcurrencyLimitGroup == nil {
		return 0, false
	}
	limit, found := UserConcurrencyLimitGroup[group]
	if !found {
		return 0, false
	}
	return limit, true
}

// CheckUserConcurrencyLimitGroup validates a candidate configuration before it
// is persisted. A limit below 1 would deny every request to that group, which
// an operator never means to express — a group that should be blocked belongs
// in the model access list, not here.
func CheckUserConcurrencyLimitGroup(jsonStr string) error {
	checkUserConcurrencyLimitGroup := make(map[string]int)
	if err := common.Unmarshal([]byte(jsonStr), &checkUserConcurrencyLimitGroup); err != nil {
		return err
	}
	for group, limit := range checkUserConcurrencyLimitGroup {
		if group == "" {
			return fmt.Errorf("group name must not be empty")
		}
		if limit < 1 {
			return fmt.Errorf("group %s has a non-positive concurrency limit: %d", group, limit)
		}
		if limit > maxUserConcurrencyLimit {
			return fmt.Errorf("group %s concurrency limit %d exceeds max %d", group, limit, maxUserConcurrencyLimit)
		}
	}
	return nil
}
