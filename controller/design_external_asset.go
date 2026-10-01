package controller

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
)

// Registering workbench deliverables that no task produced: a reference image
// the user supplies before any generation exists, and the editable files an
// agent builds with outside tools (design doc §8.2, Phase C gate).
//
// Both arrival modes end in the same ledger row and the same storage write.
// Direct upload and remote-URL fetch differ only in where the bytes come from
// and in the defenses each needs — the URL path runs through the SSRF-
// protected fetch client, the upload path through the multipart limits below.

const (
	designExternalPartName   = "file"
	designExternalRoleField  = "semantic_role"
	designExternalURLField   = "url"
	designExternalNameField  = "file_name"
	designExternalFieldLimit = 4 << 10
)

// designExternalAssetView is the response shape for a registered deliverable.
// It reuses the asset card's URL field so the dashboard renders it with the
// same component as a generated candidate.
type designExternalAssetView struct {
	ID           int64  `json:"id"`
	ObjectKey    string `json:"object_key"`
	SemanticRole string `json:"semantic_role"`
	FileName     string `json:"file_name"`
	MimeType     string `json:"mime_type"`
	Size         int64  `json:"size"`
	SHA256       string `json:"sha256"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	CreatedAt    int64  `json:"created_at"`
	URL          string `json:"url"`
}

// RegisterDesignExternalAsset records a deliverable in the project's ledger.
//
// A personal access token is deliberately allowed here (the session guard is
// not installed on this route): uploading a reference image is normal agent
// work, and it neither spends money nor makes a human decision. What it does
// do is write bytes under the caller's own project, which loadOwnDesignProject
// has already scoped to the authenticated user.
func RegisterDesignExternalAsset(c *gin.Context) {
	project, ok := loadOwnDesignProject(c)
	if !ok {
		return
	}
	store := service.GetExternalArtifactStore()
	if !store.Enabled() {
		common.ApiErrorMsg(c, "产物存储未启用，无法登记外部文件")
		return
	}

	contentType, _, _ := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if strings.HasPrefix(strings.ToLower(contentType), "multipart/") {
		registerDesignExternalUpload(c, project, store)
		return
	}
	registerDesignExternalURL(c, project, store)
}

// registerDesignExternalUpload persists a multipart upload. The declared part
// content type is ignored on purpose: the store sniffs the bytes, and the
// allowlist is applied to the sniffed type, so a renamed executable cannot
// pass by claiming to be a PNG.
func registerDesignExternalUpload(c *gin.Context, project *model.DesignProject, store service.ExternalArtifactStore) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, service.DesignExternalMaxUploadBytes+(1<<20))
	form, err := c.MultipartForm()
	if err != nil {
		common.ApiErrorMsg(c, "上传内容解析失败或超出大小限制")
		return
	}
	defer form.RemoveAll()

	headers := form.File[designExternalPartName]
	if len(headers) == 0 || headers[0] == nil {
		common.ApiErrorMsg(c, "缺少上传文件")
		return
	}
	fileHeader := headers[0]
	if fileHeader.Size > service.DesignExternalMaxUploadBytes {
		common.ApiErrorMsg(c, "文件超出大小限制")
		return
	}
	file, err := fileHeader.Open()
	if err != nil {
		common.ApiErrorMsg(c, "读取上传文件失败")
		return
	}
	defer func() { _ = file.Close() }()

	// Sniff before persisting, with the same detector the store records from:
	// a gate that sniffs differently rejects the very formats the allowlist
	// promises (a .docx reads as application/zip to the standard library).
	// Deciding first keeps a rejected upload from leaving bytes and a ledger
	// row behind. The declared part Content-Type is ignored — a renamed
	// executable would pass on a lie.
	head := make([]byte, 512)
	read, err := io.ReadFull(file, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		common.ApiErrorMsg(c, "读取上传文件失败")
		return
	}
	head = head[:read]
	sniffed := service.DetectExternalMimeType(head)
	if !service.DesignExternalMimeAllowed(sniffed) {
		common.ApiErrorMsg(c, "不支持的文件类型")
		return
	}

	object, err := store.PersistExternal(c.Request.Context(), project.ID, int64(c.GetInt("id")),
		service.ExternalAssetRegistration{
			SemanticRole: formValue(form.Value, designExternalRoleField),
			FileName:     fileHeader.Filename,
			Source:       service.DesignExternalSourceUpload,
		},
		io.MultiReader(bytes.NewReader(head), file))
	if err != nil {
		common.ApiErrorMsg(c, designExternalPersistMessage(err))
		return
	}

	common.ApiSuccess(c, buildDesignExternalAssetView(c, project.ID, object))
}

// registerDesignExternalURL fetches a remote deliverable and records it.
//
// The URL is validated once at the door and then fetched through the
// SSRF-protected client, which re-checks the resolved IP at dial time and
// re-validates every redirect hop. Validating only the entry URL would not
// stop DNS rebinding or a redirect into the private ranges.
func registerDesignExternalURL(c *gin.Context, project *model.DesignProject, store service.ExternalArtifactStore) {
	var req struct {
		URL          string `json:"url"`
		SemanticRole string `json:"semantic_role"`
		FileName     string `json:"file_name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiErrorMsg(c, "请求格式错误")
		return
	}
	rawURL := strings.TrimSpace(req.URL)
	if rawURL == "" {
		common.ApiErrorMsg(c, "缺少资源地址")
		return
	}
	if err := service.ValidateSSRFProtectedFetchURL(rawURL); err != nil {
		common.ApiErrorMsg(c, "资源地址不被允许")
		return
	}
	body, sniffed, err := fetchDesignExternalBytes(c, rawURL)
	if err != nil {
		common.ApiErrorMsg(c, designExternalPersistMessage(err))
		return
	}
	// Decide on the sniffed type before persisting, so a rejected fetch never
	// leaves bytes or a ledger row behind.
	if !service.DesignExternalMimeAllowed(sniffed) {
		common.ApiErrorMsg(c, "不支持的文件类型")
		return
	}
	object, err := store.PersistExternal(c.Request.Context(), project.ID, int64(c.GetInt("id")),
		service.ExternalAssetRegistration{
			SemanticRole: req.SemanticRole,
			FileName:     req.FileName,
			Source:       service.DesignExternalSourceURL,
		},
		bytes.NewReader(body))
	if err != nil {
		common.ApiErrorMsg(c, designExternalPersistMessage(err))
		return
	}

	common.ApiSuccess(c, buildDesignExternalAssetView(c, project.ID, object))
}

// GetDesignExternalAssets lists a project's registered deliverables.
func GetDesignExternalAssets(c *gin.Context) {
	project, ok := loadOwnDesignProject(c)
	if !ok {
		return
	}
	objects, err := model.ListDesignExternalObjects(project.ID)
	if err != nil {
		common.ApiErrorMsg(c, "查询外部产物失败")
		return
	}
	views := make([]designExternalAssetView, 0, len(objects))
	for i := range objects {
		views = append(views, buildDesignExternalAssetView(c, project.ID, &objects[i]))
	}
	common.ApiSuccess(c, gin.H{"items": views})
}

// GetDesignExternalAssetContent streams one registered deliverable. It sits
// under the same UserAuth group as the rest of the workbench: a same-origin
// <img> request carries the dashboard session cookie, so no second capability
// signature is needed and none is issued.
func GetDesignExternalAssetContent(c *gin.Context) {
	project, ok := loadOwnDesignProject(c)
	if !ok {
		return
	}
	object, err := model.DesignExternalObjectByKey(project.ID, strings.TrimSpace(c.Param("object_key")))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "message": "object not found"})
		return
	}
	if err := service.GetExternalArtifactStore().ServeExternal(c, object); err != nil {
		common.ApiErrorMsg(c, "读取产物失败")
	}
}

// --- Helpers ----------------------------------------------------------------

// fetchDesignExternalBytes downloads a remote deliverable under the size cap
// and returns the sniffed mime type. The cap is enforced while streaming, so
// an oversized or endless response is abandoned instead of buffered.
func fetchDesignExternalBytes(c *gin.Context, rawURL string) ([]byte, string, error) {
	request, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, "", errors.New("资源地址无效")
	}
	request.Header.Set("User-Agent", "New-Api-Design-Workbench/1.0")
	client := service.GetSSRFProtectedHTTPClient()
	if client == nil {
		return nil, "", errors.New("抓取客户端不可用")
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, "", errors.New("资源抓取失败")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("资源返回状态码 %d", response.StatusCode)
	}
	// One extra byte distinguishes "at the cap" from "over the cap".
	limited := &io.LimitedReader{R: response.Body, N: service.DesignExternalMaxUploadBytes + 1}
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, "", errors.New("资源读取失败")
	}
	if int64(len(data)) > service.DesignExternalMaxUploadBytes {
		return nil, "", fmt.Errorf("%w (%d)", service.ErrExternalArtifactTooLarge, service.DesignExternalMaxUploadBytes)
	}
	if len(data) == 0 {
		return nil, "", errors.New("资源为空")
	}
	// Sniffed, never declared. The response Content-Type is chosen by whoever
	// serves the bytes, and this value is what the ledger records and what the
	// content route later sends back from this site's own origin — trusting it
	// would let the uploader pick the recorded type, and would overwrite the
	// store's own script-bearing clamp.
	mimeType := service.DetectExternalMimeType(data)
	if service.DesignExternalMimeAllowed(mimeType) {
		return data, mimeType, nil
	}
	return nil, "", errors.New("不支持的文件类型")
}

func buildDesignExternalAssetView(c *gin.Context, projectID int64, object *model.DesignExternalObject) designExternalAssetView {
	view := designExternalAssetView{
		ID:           object.ID,
		ObjectKey:    object.ObjectKey,
		SemanticRole: object.SemanticRole,
		FileName:     object.FileName,
		MimeType:     object.MimeType,
		Size:         object.Size,
		SHA256:       object.SHA256,
		Width:        object.Width,
		Height:       object.Height,
		CreatedAt:    object.CreatedAt,
		// Relative, same-origin path: the dashboard session cookie authorizes
		// it, and no long-lived signed capability is minted for a file that is
		// only ever read inside the workspace it belongs to.
		URL: fmt.Sprintf("/api/design/projects/%d/external-assets/%s/content",
			projectID, url.PathEscape(object.ObjectKey)),
	}
	return view
}

func formValue(values map[string][]string, key string) string {
	if entries := values[key]; len(entries) > 0 {
		return entries[0]
	}
	return ""
}

// designExternalPersistMessage maps a storage rejection to something the user
// can act on. The business failures stay HTTP 200 with success:false, matching
// every other workbench error, so a client does not retry a permanent
// rejection as if it were a transport failure.
func designExternalPersistMessage(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, service.ErrExternalArtifactTooLarge) {
		return "文件超出大小限制"
	}
	if errors.Is(err, service.ErrTaskArtifactStoreDisabled) {
		return "产物存储未启用，无法登记外部文件"
	}
	return "登记外部产物失败"
}
