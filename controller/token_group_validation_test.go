package controller

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// configureTokenGroupValidationTest reproduces the production posture behind
// the 2026-09-25 svip leak: svip carries a group ratio but is deliberately
// absent from UserUsableGroups, so tokens must not be able to select it.
func configureTokenGroupValidationTest(t *testing.T) {
	t.Helper()
	originalUsableGroups := setting.UserUsableGroups2JSONString()
	originalRatios := ratio_setting.GroupRatio2JSONString()
	require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(`{"default":"Default","vip":"VIP"}`))
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1,"vip":1,"svip":1}`))
	t.Cleanup(func() {
		require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(originalUsableGroups))
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(originalRatios))
	})
}

func setupTokenGroupValidationTest(t *testing.T) *model.User {
	t.Helper()
	db := setupTokenControllerTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.User{}))
	user := &model.User{
		Id:       201,
		Username: "token-group-user",
		Password: "password",
		Group:    "default",
		Status:   common.UserStatusEnabled,
	}
	require.NoError(t, db.Create(user).Error)
	return user
}

func newTokenGroupValidationContext(t *testing.T, method string, target string, body any, userID int) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	ctx, recorder := newAuthenticatedContext(t, method, target, body, userID)
	common.SetContextKey(ctx, constant.ContextKeyUserGroup, "default")
	return ctx, recorder
}

func baseTokenValidationRequest(name string, group string) map[string]any {
	return map[string]any{
		"name":            name,
		"expired_time":    -1,
		"remain_quota":    0,
		"unlimited_quota": true,
		"group":           group,
	}
}

func TestAddTokenRejectsGroupOutsideUserUsableGroups(t *testing.T) {
	configureTokenGroupValidationTest(t)
	user := setupTokenGroupValidationTest(t)

	ctx, recorder := newTokenGroupValidationContext(t, http.MethodPost, "/api/token/", baseTokenValidationRequest("group-leak", "svip"), user.Id)
	AddToken(ctx)

	response := decodeAPIResponse(t, recorder)
	require.False(t, response.Success)
	assert.Contains(t, response.Message, "svip")
	var count int64
	require.NoError(t, model.DB.Model(&model.Token{}).Where("name = ?", "group-leak").Count(&count).Error)
	assert.Zero(t, count)
}

func TestAddTokenAllowsSelectableGroup(t *testing.T) {
	configureTokenGroupValidationTest(t)
	user := setupTokenGroupValidationTest(t)

	ctx, recorder := newTokenGroupValidationContext(t, http.MethodPost, "/api/token/", baseTokenValidationRequest("selectable", "vip"), user.Id)
	AddToken(ctx)

	response := decodeAPIResponse(t, recorder)
	require.True(t, response.Success, response.Message)
	var token model.Token
	require.NoError(t, model.DB.Where("name = ?", "selectable").First(&token).Error)
	assert.Equal(t, "vip", token.Group)
}

func TestAddTokenEmptyGroupFollowsUserGroup(t *testing.T) {
	configureTokenGroupValidationTest(t)
	user := setupTokenGroupValidationTest(t)

	request := baseTokenValidationRequest("follow-user", "")
	ctx, recorder := newTokenGroupValidationContext(t, http.MethodPost, "/api/token/", request, user.Id)
	AddToken(ctx)

	response := decodeAPIResponse(t, recorder)
	require.True(t, response.Success, response.Message)
	var token model.Token
	require.NoError(t, model.DB.Where("name = ?", "follow-user").First(&token).Error)
	assert.Empty(t, token.Group)
}

func TestUpdateTokenRejectsGroupOutsideUserUsableGroups(t *testing.T) {
	configureTokenGroupValidationTest(t)
	user := setupTokenGroupValidationTest(t)
	token := seedToken(t, model.DB, user.Id, "update-group", "update-group-key")

	request := baseTokenValidationRequest("update-group", "svip")
	request["id"] = token.Id
	request["status"] = common.TokenStatusEnabled
	ctx, recorder := newTokenGroupValidationContext(t, http.MethodPut, "/api/token/", request, user.Id)
	UpdateToken(ctx)

	response := decodeAPIResponse(t, recorder)
	require.False(t, response.Success)
	assert.Contains(t, response.Message, "svip")
	var updated model.Token
	require.NoError(t, model.DB.First(&updated, token.Id).Error)
	assert.Equal(t, "default", updated.Group)
}

func TestUpdateTokenAllowsSelectableGroup(t *testing.T) {
	configureTokenGroupValidationTest(t)
	user := setupTokenGroupValidationTest(t)
	token := seedToken(t, model.DB, user.Id, "update-group-ok", "update-group-ok-key")

	request := baseTokenValidationRequest("update-group-ok", "vip")
	request["id"] = token.Id
	request["status"] = common.TokenStatusEnabled
	ctx, recorder := newTokenGroupValidationContext(t, http.MethodPut, "/api/token/", request, user.Id)
	UpdateToken(ctx)

	response := decodeAPIResponse(t, recorder)
	require.True(t, response.Success, response.Message)
	var updated model.Token
	require.NoError(t, model.DB.First(&updated, token.Id).Error)
	assert.Equal(t, "vip", updated.Group)
}
