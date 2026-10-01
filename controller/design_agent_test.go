package controller

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Backend regression cover for the personal design agent work: P-1 (session
// gate + quote binding), P-2 (acceptance / finalization), P-3 (external
// deliverable registration) and P-4 (origin stamp). They live in one file on
// purpose: the four share the same fixture and each is a half of one
// invariant — "a machine may drive, a human must decide".

// designAgentRouter wires the workbench routes exactly as router/api-router.go
// does, so the guards under test are the production guards, not a re-creation.
func designAgentRouter() *gin.Engine {
	r := gin.New()
	design := r.Group("/api/design")
	design.Use(middleware.UserAuth(), middleware.DisableCache())
	{
		design.POST("/projects", middleware.SessionCookieOriginGuard(), CreateDesignProject)
		design.GET("/projects/:id", GetDesignProject)
		design.DELETE("/projects/:id", middleware.SessionCookieOriginGuard(), middleware.RequireDashboardSession(), DeleteDesignProject)
		design.POST("/projects/:id/plan", middleware.SessionCookieOriginGuard(), PlanDesignProject)
		design.POST("/projects/:id/confirm", middleware.SessionCookieOriginGuard(), middleware.RequireDashboardSession(), ConfirmDesignProject)
		design.POST("/projects/:id/run", middleware.SessionCookieOriginGuard(), RunDesignProject)
		design.POST("/projects/:id/steps/:step_id/retry", middleware.SessionCookieOriginGuard(), RetryDesignStep)
		design.PATCH("/projects/:id/assets/:asset_id", middleware.SessionCookieOriginGuard(), middleware.RequireDashboardSession(), UpdateDesignAsset)
		design.POST("/projects/:id/assets", middleware.SessionCookieOriginGuard(), RegisterDesignExternalAsset)
	}
	return r
}

// designAgentRequest issues a request authenticated by a PAT. It goes through
// the production UserAuth middleware, so use_access_token is set by
// production code rather than injected by the test.
func designAgentRequest(t *testing.T, router http.Handler, userID int, method, path, body string, asPAT bool, sessionID string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if asPAT {
		user, err := model.GetUserById(userID, true)
		require.NoError(t, err)
		require.NotNil(t, user.AccessToken)
		request.Header.Set("Authorization", "Bearer "+*user.AccessToken)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

// designAgentSession issues a dashboard access token bound to a live session
// row, which is exactly the credential a browser produces and the one the
// session guard has to accept. A PAT and a session differ only in how the
// middleware classified them, so exercising both proves the guard reads the
// classification rather than the transport. The session id is unique per
// call so a test can issue several identities against one fixture.
func designAgentSession(t *testing.T, userID int, sessionID string) string {
	t.Helper()
	user, err := model.GetUserById(userID, true)
	require.NoError(t, err)
	now := time.Now().Unix()
	refreshHash := strings.Repeat("a", 64)
	session := &model.UserSession{
		SID:             sessionID,
		UserID:          userID,
		Version:         1,
		UserAuthVersion: user.AuthVersion,
		Status:          model.UserSessionStatusActive,
		RefreshHash:     refreshHash,
		LoginMethod:     "password",
		LastActiveAt:    now,
		ExpiresAt:       now + 3600,
	}
	require.NoError(t, model.CreateUserSession(session))
	accessToken, _, err := service.IssueAccessToken(service.AuthIdentity{
		UserID:          userID,
		SessionID:       session.SID,
		UserAuthVersion: session.UserAuthVersion,
		SessionVersion:  session.Version,
	})
	require.NoError(t, err)
	return accessToken
}

// designAgentSessionRequest issues a request carrying a dashboard session
// credential.
func designAgentSessionRequest(t *testing.T, router http.Handler, userID int, method, path, body, sessionID string) *httptest.ResponseRecorder {
	t.Helper()
	accessToken := designAgentSession(t, userID, sessionID)
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+accessToken)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func designAgentDecode(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var resp map[string]any
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
	return resp
}

func designAgentSeedProject(t *testing.T, userID, tokenID int, status string) *model.DesignProject {
	t.Helper()
	project := &model.DesignProject{
		UserID:            userID,
		Name:              "Agent 后端验收",
		Kind:              "image",
		Status:            status,
		Role:              "主视觉",
		DefaultCapability: "design-ctrl-test:image",
		TokenID:           tokenID,
		PlanRevision:      3,
		// The test capability declares prompt as required, so a project that
		// has to be plannable must carry one.
		Parameters: `{"prompt":"一杯热拿铁放在木桌上"}`,
	}
	require.NoError(t, model.InsertDesignProject(project))
	return project
}

// --- P-1: the billing gate is a human decision -------------------------------

func TestDesignConfirmRequiresSessionAndBindsQuoteRevision(t *testing.T) {
	userID, tokenID := setupDesignControllerTestEnv(t)
	require.NoError(t, model.UpdateUserAccessToken(userID, "design-agent-pat"))
	router := designAgentRouter()

	project := designAgentSeedProject(t, userID, tokenID, designProjectAwaitingConfirmation)
	require.NoError(t, model.ReplaceDesignSteps(project, []*model.DesignStep{{
		ProjectID:    project.ID,
		Role:         "主视觉",
		Operation:    "image.generate",
		CapabilityID: "design-ctrl-test:image",
		Model:        "design-ctrl-image",
		PlanRevision: 3,
		Status:       designStepPending,
	}}))
	path := "/api/design/projects/" + strconv.FormatInt(project.ID, 10) + "/confirm"

	// A PAT must not be able to release the billing gate.
	patResponse := designAgentRequest(t, router, userID, http.MethodPost, path, `{}`, true, "")
	assert.Equal(t, http.StatusForbidden, patResponse.Code)
	assert.Equal(t, "AUTH_SESSION_REQUIRED", designAgentDecode(t, patResponse)["code"])
	stored, err := model.GetDesignProjectByID(project.ID, userID)
	require.NoError(t, err)
	assert.Equal(t, designProjectAwaitingConfirmation, stored.Status, "a rejected confirm must not change state")

	// A session confirming a stale quote is refused, and still changes nothing.
	stalePath := path
	stale := designAgentSessionRequest(t, router, userID, http.MethodPost, stalePath, `{"plan_revision":2}`, "sess-stale")
	assert.Equal(t, http.StatusOK, stale.Code)
	assert.Equal(t, false, designAgentDecode(t, stale)["success"])
	stored, err = model.GetDesignProjectByID(project.ID, userID)
	require.NoError(t, err)
	assert.Equal(t, designProjectAwaitingConfirmation, stored.Status)

	// A session confirming the quote it was shown succeeds.
	recorder := designAgentSessionRequest(t, router, userID, http.MethodPost, path, `{"plan_revision":3}`, "sess-confirm")
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, true, designAgentDecode(t, recorder)["success"])
	stored, err = model.GetDesignProjectByID(project.ID, userID)
	require.NoError(t, err)
	assert.Equal(t, designProjectReady, stored.Status)
}

// Without plan_revision the call must still work: the shipped confirm button
// does not send the field, and turning it mandatory would break the live page.
func TestDesignConfirmWithoutPlanRevisionStillSucceeds(t *testing.T) {
	userID, tokenID := setupDesignControllerTestEnv(t)
	router := designAgentRouter()
	project := designAgentSeedProject(t, userID, tokenID, designProjectAwaitingConfirmation)
	require.NoError(t, model.ReplaceDesignSteps(project, []*model.DesignStep{{
		ProjectID: project.ID, Role: "主视觉", Operation: "image.generate",
		CapabilityID: "design-ctrl-test:image", Model: "design-ctrl-image",
		PlanRevision: 3, Status: designStepPending,
	}}))
	sessionID := "sess-norev"
	recorder := designAgentSessionRequest(t, router, userID, http.MethodPost,
		"/api/design/projects/"+strconv.FormatInt(project.ID, 10)+"/confirm", `{}`, sessionID)
	assert.Equal(t, true, designAgentDecode(t, recorder)["success"])
	stored, err := model.GetDesignProjectByID(project.ID, userID)
	require.NoError(t, err)
	assert.Equal(t, designProjectReady, stored.Status)
}

func TestDesignDeleteRequiresSessionAndOtherRoutesStayPATCallable(t *testing.T) {
	userID, tokenID := setupDesignControllerTestEnv(t)
	require.NoError(t, model.UpdateUserAccessToken(userID, "design-agent-pat-delete"))
	router := designAgentRouter()

	project := designAgentSeedProject(t, userID, tokenID, designProjectDraft)
	path := "/api/design/projects/" + strconv.FormatInt(project.ID, 10)

	patDelete := designAgentRequest(t, router, userID, http.MethodDelete, path, "", true, "")
	assert.Equal(t, http.StatusForbidden, patDelete.Code)
	assert.Equal(t, "AUTH_SESSION_REQUIRED", designAgentDecode(t, patDelete)["code"])
	_, err := model.GetDesignProjectByID(project.ID, userID)
	assert.NoError(t, err, "a refused delete must not remove the project")

	// The guard must stay off the rest of the group: an agent needs to plan,
	// run and retry through the same PAT, or the whole agent path is dead.
	patPlan := designAgentRequest(t, router, userID, http.MethodPost, path+"/plan", `{}`, true, "")
	require.Equal(t, http.StatusOK, patPlan.Code, "plan must remain PAT-callable: %s", patPlan.Body.String())
	assert.Equal(t, true, designAgentDecode(t, patPlan)["success"], "plan body: %s", patPlan.Body.String())

	sessionDelete := designAgentSessionRequest(t, router, userID, http.MethodDelete, path, "", "sess-delete")
	assert.Equal(t, true, designAgentDecode(t, sessionDelete)["success"])
	_, err = model.GetDesignProjectByID(project.ID, userID)
	assert.Error(t, err, "a session delete must remove the project")
}

// --- P-2: acceptance and finalization ----------------------------------------

func designAgentSeedAssets(t *testing.T, projectID int64, role string, count int) []*model.DesignAsset {
	t.Helper()
	assets := make([]*model.DesignAsset, 0, count)
	for i := 1; i <= count; i++ {
		asset := &model.DesignAsset{
			ProjectID:      projectID,
			SemanticRole:   role,
			CandidateIndex: i,
			TaskID:         fmt.Sprintf("task_%s_%d", role, i),
			ArtifactKey:    fmt.Sprintf("%s-%d.png", role, i),
			MimeType:       "image/png",
		}
		require.NoError(t, model.InsertDesignAsset(asset))
		assets = append(assets, asset)
	}
	return assets
}

// designAgentPatchAsset issues one session-authenticated asset decision. The
// session id is unique per call because a fixture may decide on the same asset
// more than once.
var designAgentPatchCounter atomic.Int64

func designAgentPatchAsset(t *testing.T, router http.Handler, userID int, projectID, assetID int64, body string) map[string]any {
	t.Helper()
	path := "/api/design/projects/" + strconv.FormatInt(projectID, 10) + "/assets/" + strconv.FormatInt(assetID, 10)
	sessionID := "sess-asset-" + strconv.FormatInt(designAgentPatchCounter.Add(1), 10)
	return designAgentDecode(t, designAgentSessionRequest(t, router, userID, http.MethodPatch, path, body, sessionID))
}

func TestDesignAssetSelectionIsExclusivePerRoleOnly(t *testing.T) {
	userID, tokenID := setupDesignControllerTestEnv(t)
	router := designAgentRouter()
	project := designAgentSeedProject(t, userID, tokenID, designProjectDraft)

	hero := designAgentSeedAssets(t, project.ID, "主视觉", 2)
	scene := designAgentSeedAssets(t, project.ID, "场景一", 2)

	// Selecting the second hero candidate must clear the first: one role
	// resolves to exactly one chosen candidate.
	require.Equal(t, true, designAgentPatchAsset(t, router, userID, project.ID, hero[0].ID, `{"selected":true}`)["success"])
	require.Equal(t, true, designAgentPatchAsset(t, router, userID, project.ID, hero[1].ID, `{"selected":true}`)["success"])
	reloaded, err := model.GetDesignAssetByID(project.ID, hero[0].ID)
	require.NoError(t, err)
	assert.False(t, reloaded.Selected, "the earlier candidate of the same role must be cleared")
	reloaded, err = model.GetDesignAssetByID(project.ID, hero[1].ID)
	require.NoError(t, err)
	assert.True(t, reloaded.Selected)

	// A different role is unaffected by that exclusivity.
	require.Equal(t, true, designAgentPatchAsset(t, router, userID, project.ID, scene[0].ID, `{"selected":true}`)["success"])
	reloaded, err = model.GetDesignAssetByID(project.ID, scene[0].ID)
	require.NoError(t, err)
	assert.True(t, reloaded.Selected)

	// Acceptance is multi-select and never implies selection.
	require.Equal(t, true, designAgentPatchAsset(t, router, userID, project.ID, hero[0].ID, `{"accepted":true}`)["success"])
	require.Equal(t, true, designAgentPatchAsset(t, router, userID, project.ID, scene[1].ID, `{"accepted":true}`)["success"])
	for _, assetID := range []int64{hero[0].ID, scene[1].ID} {
		reloaded, err = model.GetDesignAssetByID(project.ID, assetID)
		require.NoError(t, err)
		assert.True(t, reloaded.Accepted)
		assert.False(t, reloaded.Selected, "accepting a candidate must not make it the deliverable")
	}
}

func TestDesignAssetUpdateRejectsForeignAssetAndPAT(t *testing.T) {
	userID, tokenID := setupDesignControllerTestEnv(t)
	require.NoError(t, model.UpdateUserAccessToken(userID, "design-agent-pat-asset"))
	router := designAgentRouter()

	project := designAgentSeedProject(t, userID, tokenID, designProjectDraft)
	assets := designAgentSeedAssets(t, project.ID, "主视觉", 1)

	other := &model.DesignProject{UserID: userID, Name: "另一个项目", Kind: "image", Status: designProjectDraft}
	require.NoError(t, model.InsertDesignProject(other))
	designAgentSeedAssets(t, other.ID, "主视觉", 1)

	// An asset of another project reads as missing, not as forbidden: that is
	// the same shape loadOwnDesignProject uses for a foreign project.
	path := "/api/design/projects/" + strconv.FormatInt(other.ID, 10) + "/assets/" + strconv.FormatInt(assets[0].ID, 10)
	recorder := designAgentSessionRequest(t, router, userID, http.MethodPatch, path, `{"selected":true}`, "sess-foreign-asset")
	assert.Equal(t, http.StatusNotFound, recorder.Code)
	touched, err := model.GetDesignAssetByID(assets[0].ProjectID, assets[0].ID)
	require.NoError(t, err)
	assert.False(t, touched.Selected, "a rejected update must not mutate the asset")

	// The session guard covers the asset decision too: it is a human choice.
	patPath := "/api/design/projects/" + strconv.FormatInt(project.ID, 10) + "/assets/" + strconv.FormatInt(assets[0].ID, 10)
	patResponse := designAgentRequest(t, router, userID, http.MethodPatch, patPath, `{"selected":true}`, true, "")
	assert.Equal(t, http.StatusForbidden, patResponse.Code)
	assert.Equal(t, "AUTH_SESSION_REQUIRED", designAgentDecode(t, patResponse)["code"])
}

// --- P-4: origin is stamped, never claimed ------------------------------------

func TestDesignProjectOriginIsStampedFromCredential(t *testing.T) {
	userID, tokenID := setupDesignControllerTestEnv(t)
	require.NoError(t, model.UpdateUserAccessToken(userID, "design-agent-pat-origin"))
	router := designAgentRouter()

	// A PAT call claiming to be a web request is still recorded as an agent.
	patCreate := designAgentRequest(t, router, userID, http.MethodPost, "/api/design/projects", `{"name":"来自 Agent","kind":"image","token_id":`+strconv.Itoa(tokenID)+`,"created_via":"web"}`, true, "")
	require.Equal(t, http.StatusOK, patCreate.Code)
	patData := designAgentDecode(t, patCreate)["data"].(map[string]any)
	assert.Equal(t, "agent", patData["created_via"], "the request body must not decide the origin")

	// A session call is recorded as the page.
	recorder := designAgentSessionRequest(t, router, userID, http.MethodPost, "/api/design/projects",
		`{"name":"来自页面","kind":"image","token_id":`+strconv.Itoa(tokenID)+`,"created_via":"agent"}`, "sess-origin")
	require.Equal(t, http.StatusOK, recorder.Code)
	sessionData := designAgentDecode(t, recorder)["data"].(map[string]any)
	assert.Equal(t, "web", sessionData["created_via"], "the request body must not decide the origin")

	// A row written before the column existed reads as a page workspace.
	legacy := &model.DesignProject{UserID: userID, Name: "旧项目", Kind: "image", Status: designProjectDraft}
	require.NoError(t, model.InsertDesignProject(legacy))
	legacyRecorder := designAgentSessionRequest(t, router, userID, http.MethodGet,
		"/api/design/projects/"+strconv.FormatInt(legacy.ID, 10), "", "sess-origin-legacy")
	require.Equal(t, http.StatusOK, legacyRecorder.Code)
	legacyData := designAgentDecode(t, legacyRecorder)["data"].(map[string]any)
	assert.Equal(t, "web", legacyData["created_via"], "an empty origin is legacy web data")
}

// --- P-3: external deliverables ----------------------------------------------

func TestDesignExternalRegistrationRejectsUnsupportedTypes(t *testing.T) {
	userID, tokenID := setupDesignControllerTestEnv(t)
	router := designAgentRouter()
	project := designAgentSeedProject(t, userID, tokenID, designProjectDraft)

	// A script-bearing or executable type must be refused before it is stored,
	// because registered content is served back from the site's own origin.
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	part, err := writer.CreateFormFile("file", "payload.html")
	require.NoError(t, err)
	_, err = part.Write([]byte("<html><script>alert(1)</script></html>"))
	require.NoError(t, err)
	require.NoError(t, writer.WriteField("semantic_role", "主视觉"))
	require.NoError(t, writer.Close())

	// The session credential is issued up front so the upload request itself
	// can only fail for the type, not for its identity.
	accessToken := designAgentSession(t, userID, "sess-upload")
	request := httptest.NewRequest(http.MethodPost,
		"/api/design/projects/"+strconv.FormatInt(project.ID, 10)+"/assets", &buf)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Authorization", "Bearer "+accessToken)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, false, designAgentDecode(t, recorder)["success"])
	objects, err := model.ListDesignExternalObjects(project.ID)
	require.NoError(t, err)
	assert.Empty(t, objects, "a refused upload must leave no ledger row")
}

func TestDesignExternalMimeAllowlistCoversDeliveredFamilies(t *testing.T) {
	// The allowlist is a positive list; anything outside it is refused. These
	// are the families the workbench promises to carry.
	for _, mime := range []string{
		"image/png", "image/jpeg", "image/webp",
		"application/pdf",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		"application/vnd.jgraph.drawio",
	} {
		assert.True(t, service.DesignExternalMimeAllowed(mime), mime)
	}
	for _, mime := range []string{
		"text/html", "image/svg+xml", "application/javascript",
		"application/x-msdownload", "application/zip", "",
	} {
		assert.False(t, service.DesignExternalMimeAllowed(mime), mime)
	}
}

// --- P-3: the gate reads bytes, and the families it promises really arrive ----

// designAgentUpload posts one multipart file part over a PAT. A PAT is allowed
// here on purpose: registering a deliverable neither spends money nor stands in
// for a human decision, so this route carries no session guard.
func designAgentUpload(t *testing.T, router http.Handler, projectID int64, userID int, fileName string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	part, err := writer.CreateFormFile("file", fileName)
	require.NoError(t, err)
	_, err = part.Write(body)
	require.NoError(t, err)
	require.NoError(t, writer.WriteField("semantic_role", "交付稿"))
	require.NoError(t, writer.Close())

	user, err := model.GetUserById(userID, true)
	require.NoError(t, err)
	require.NotNil(t, user.AccessToken)
	request := httptest.NewRequest(http.MethodPost,
		"/api/design/projects/"+strconv.FormatInt(projectID, 10)+"/assets", &buf)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Authorization", "Bearer "+*user.AccessToken)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func TestDesignExternalRegistrationAcceptsTheEditableFamilies(t *testing.T) {
	userID, tokenID := setupDesignControllerTestEnv(t)
	router := designAgentRouter()
	project := designAgentSeedProject(t, userID, tokenID, designProjectDraft)
	require.NoError(t, model.UpdateUserAccessToken(userID, "design-agent-pat-upload-ok"))
	require.True(t, service.GetExternalArtifactStore().Enabled(),
		"the registration route must be exercised against a real volume")

	// A .drawio is plain XML. The standard library's detector calls it text/xml,
	// which is not on the allowlist — so before the gate started sniffing through
	// service.DetectExternalMimeType, every editable family except PDF was
	// refused at the door while the allowlist advertised support for it.
	drawio := []byte(`<?xml version="1.0" encoding="UTF-8"?>` +
		`<mxfile host="app.diagrams.net"><diagram id="a" name="P"/></mxfile>`)
	recorder := designAgentUpload(t, router, project.ID, userID, "架构图.drawio", drawio)
	require.Equal(t, http.StatusOK, recorder.Code)
	payload := designAgentDecode(t, recorder)
	require.Equal(t, true, payload["success"], "a drawio deliverable must be registrable")
	view, ok := payload["data"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "application/vnd.jgraph.drawio", view["mime_type"])
	assert.Equal(t, "架构图.drawio", view["file_name"])

	// The ledger row is complete as inserted — name, provenance, type and size
	// all land with the object, not in a follow-up write.
	objects, err := model.ListDesignExternalObjects(project.ID)
	require.NoError(t, err)
	require.Len(t, objects, 1)
	assert.Equal(t, "application/vnd.jgraph.drawio", objects[0].MimeType)
	assert.Equal(t, service.DesignExternalSourceUpload, objects[0].Source)
	assert.Equal(t, "架构图.drawio", objects[0].FileName)
	assert.Equal(t, int64(len(drawio)), objects[0].Size)
}

func TestDesignExternalRegistrationRefusesScriptBearingBytes(t *testing.T) {
	userID, tokenID := setupDesignControllerTestEnv(t)
	router := designAgentRouter()
	project := designAgentSeedProject(t, userID, tokenID, designProjectDraft)
	require.NoError(t, model.UpdateUserAccessToken(userID, "design-agent-pat-upload-bad"))
	require.True(t, service.GetExternalArtifactStore().Enabled(),
		"without a store the route refuses on storage, and the type is never examined")

	recorder := designAgentUpload(t, router, project.ID, userID, "payload.html",
		[]byte("<html><script>alert(1)</script></html>"))
	require.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, false, designAgentDecode(t, recorder)["success"])

	objects, err := model.ListDesignExternalObjects(project.ID)
	require.NoError(t, err)
	assert.Empty(t, objects, "a refused upload must leave no ledger row")
}
