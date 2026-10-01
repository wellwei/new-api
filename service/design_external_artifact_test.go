package service

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/system_setting"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// Registered deliverables — reference images an agent's user supplies, and
// editable files it delivers back — are stored outside the task system. These
// cover the three rejections that boundary owes them (network, type, size) and
// the one promise it makes: the bytes come back exactly as they went in.

// setupExternalArtifactStore points the external store at a temp volume and an
// in-memory ledger, restoring whatever the process had before.
func setupExternalArtifactStore(t *testing.T, maxObjectBytes int64) *FilesystemArtifactStore {
	t.Helper()
	previousDB := model.DB
	previousMain := common.MainDatabaseType()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.DesignExternalObject{}))
	model.DB = db
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	t.Cleanup(func() {
		model.DB = previousDB
		common.SetDatabaseTypes(previousMain, previousMain)
	})

	store := NewFilesystemArtifactStore(system_setting.TaskArtifactStoreConfig{
		Mode:                     system_setting.TaskArtifactStoreModeFilesystem,
		FilesystemPath:           t.TempDir(),
		FilesystemMaxObjectBytes: maxObjectBytes,
	})
	t.Cleanup(RegisterExternalArtifactStore(store))
	return store
}

func TestDesignExternalRegistrationRejectsOversizedObject(t *testing.T) {
	store := setupExternalArtifactStore(t, 16)
	// One byte over the cap: the stream limit must catch it without ever
	// writing the object or a ledger row.
	oversized := strings.Repeat("x", 17)
	_, err := store.PersistExternal(context.Background(), 1, 1, ExternalAssetRegistration{SemanticRole: "主视觉"}, strings.NewReader(oversized))
	require.ErrorIs(t, err, ErrExternalArtifactTooLarge)

	objects, listErr := model.ListDesignExternalObjects(1)
	require.NoError(t, listErr)
	assert.Empty(t, objects, "an over-cap upload must leave no ledger row")
}

func TestDesignExternalRegistrationStoresExactBytes(t *testing.T) {
	store := setupExternalArtifactStore(t, 1<<20)
	payload := "\x89PNG\r\n\x1a\n registered reference image bytes"

	object, err := store.PersistExternal(context.Background(), 7, 3, ExternalAssetRegistration{SemanticRole: "参考图"}, strings.NewReader(payload))
	require.NoError(t, err)
	assert.Equal(t, int64(7), object.ProjectID)
	assert.Equal(t, 3, object.UserID)
	assert.Equal(t, "参考图", object.SemanticRole)
	assert.Equal(t, DesignExternalSourceUpload, object.Source)
	assert.Equal(t, int64(len(payload)), object.Size)
	assert.True(t, strings.HasPrefix(object.ObjectKey, "ext_"), "the storage key is server generated")

	// The recorded digest must match the bytes, and the file on disk must be
	// those same bytes — that is the whole promise of the ledger.
	sum := sha256.Sum256([]byte(payload))
	assert.Equal(t, hex.EncodeToString(sum[:]), object.SHA256)
	abs := filepath.Join(store.storageDir(), object.RelativePath)
	stored, readErr := os.ReadFile(abs)
	require.NoError(t, readErr)
	assert.Equal(t, payload, string(stored))
	assert.NotContains(t, object.RelativePath, "..", "the storage path is derived from validated identity fields")
}

func TestDesignExternalRegistrationRejectsEmptyObject(t *testing.T) {
	store := setupExternalArtifactStore(t, 1<<20)
	_, err := store.PersistExternal(context.Background(), 1, 1, ExternalAssetRegistration{SemanticRole: "主视觉"}, strings.NewReader(""))
	require.Error(t, err)
}

func TestDesignExternalMimeAllowlistRefusesScriptBearingTypes(t *testing.T) {
	// Content registered here is served back from the site's own origin, so
	// anything that can carry script has to be refused at the door. The store
	// clamps sniffed types too; this locks the entry list itself.
	for _, mime := range []string{
		"text/html", "image/svg+xml", "application/javascript",
		"text/html; charset=utf-8", "application/x-sh", "",
	} {
		assert.False(t, DesignExternalMimeAllowed(mime), mime)
	}
	for _, mime := range []string{
		"image/png", "image/jpeg", "image/webp", "application/pdf",
		"application/vnd.jgraph.drawio",
	} {
		assert.True(t, DesignExternalMimeAllowed(mime), mime)
	}
}

func TestDesignExternalObjectKeysAreUniquePerRegistration(t *testing.T) {
	store := setupExternalArtifactStore(t, 1<<20)
	first, err := store.PersistExternal(context.Background(), 1, 1, ExternalAssetRegistration{SemanticRole: "主视觉"}, strings.NewReader("a"))
	require.NoError(t, err)
	second, err := store.PersistExternal(context.Background(), 1, 1, ExternalAssetRegistration{SemanticRole: "主视觉"}, strings.NewReader("b"))
	require.NoError(t, err)
	assert.NotEqual(t, first.ObjectKey, second.ObjectKey,
		"two registrations must never share a key, or one would overwrite the other")
	assert.NotEqual(t, first.RelativePath, second.RelativePath)
}

func TestDesignExternalAccessStaysInsideTheOwningProject(t *testing.T) {
	store := setupExternalArtifactStore(t, 1<<20)
	object, err := store.PersistExternal(context.Background(), 11, 1, ExternalAssetRegistration{SemanticRole: "交付稿"}, strings.NewReader("drawio bytes"))
	require.NoError(t, err)

	found, err := model.DesignExternalObjectByKey(11, object.ObjectKey)
	require.NoError(t, err)
	assert.Equal(t, object.ID, found.ID)

	// The project id is part of the lookup, so another workspace cannot reach
	// the object even holding its key.
	_, err = model.DesignExternalObjectByKey(12, object.ObjectKey)
	assert.Error(t, err, "an object of another project must read as missing")
}

// A user-supplied URL is fetched by the server, so the entry validation and
// the dial-time check have to agree. These lock the rejections that make that
// safe: loopback and link-local targets, the cloud metadata address, and a
// host that only resolves into private space (DNS rebinding).
func TestDesignExternalFetchRejectsPrivateNetworkTargets(t *testing.T) {
	configureSSRFTestFetchSetting(t)

	for _, rawURL := range []string{
		"http://127.0.0.1:8080/secret.png",
		"http://localhost:8080/secret.png",
		"http://10.0.0.5/secret.png",
		"http://192.168.1.1/secret.png",
		"http://169.254.169.254/latest/meta-data/",
		"http://[::1]/secret.png",
	} {
		assert.Error(t, ValidateSSRFProtectedFetchURL(rawURL), rawURL)
	}
}

func TestDesignExternalFetchRejectsHostResolvingToPrivateSpace(t *testing.T) {
	configureSSRFTestFetchSetting(t)
	protection, _, err := currentFetchProtection()
	require.NoError(t, err)

	// A public-looking name that resolves into the private range is exactly the
	// rebinding case, and it is caught at dial time, not at the entry check.
	require.Error(t, protection.ValidateResolvedIP("assets.example.com", net.ParseIP("127.0.0.1")))
	require.Error(t, protection.ValidateResolvedIP("assets.example.com", net.ParseIP("169.254.169.254")))
	require.NoError(t, protection.ValidateResolvedIP("assets.example.com", net.ParseIP("93.184.216.34")))
}

func TestDesignExternalFetchRejectsPrivatePortEvenOnPublicHost(t *testing.T) {
	configureSSRFTestFetchSetting(t)
	// AllowedPorts is 80/443 in the test fixture; a smuggling port is refused
	// whatever the host resolves to.
	assert.Error(t, ValidateSSRFProtectedFetchURL("http://93.184.216.34:22/x.png"))
}

func TestDesignExternalRegistrationRecordsNameAndSourceInOneWrite(t *testing.T) {
	store := setupExternalArtifactStore(t, 1<<20)
	object, err := store.PersistExternal(context.Background(), 7, 3,
		ExternalAssetRegistration{
			SemanticRole: "交付稿",
			FileName:     "../../etc/passwd\r\nX-Injected: 1",
			Source:       DesignExternalSourceURL,
		},
		strings.NewReader("drawio bytes"))
	require.NoError(t, err)

	// The row is complete as inserted, so no reader can observe a registered
	// object that has bytes on disk but no name or provenance, and a hostile
	// file name cannot reach a Content-Disposition header.
	stored, readErr := model.DesignExternalObjectByKey(7, object.ObjectKey)
	require.NoError(t, readErr)
	assert.Equal(t, DesignExternalSourceURL, stored.Source)
	assert.Equal(t, object.FileName, stored.FileName)
	assert.NotContains(t, stored.FileName, "/")
	assert.NotContains(t, stored.FileName, "\r")
	assert.NotContains(t, stored.FileName, "\n")
}

func TestDesignExternalRegistrationDefaultsSourceToUpload(t *testing.T) {
	store := setupExternalArtifactStore(t, 1<<20)
	object, err := store.PersistExternal(context.Background(), 7, 3,
		ExternalAssetRegistration{SemanticRole: "参考图"}, strings.NewReader("bytes"))
	require.NoError(t, err)
	assert.Equal(t, DesignExternalSourceUpload, object.Source)
}

// minimalDocx builds the smallest byte sequence a word processor writes: a zip
// carrying the OOXML content-type map. It is the shape the standard library's
// detector reports as application/zip.
func minimalDocx(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	writer := zip.NewWriter(&buf)
	parts := map[string]string{
		"[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
			`<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
			`</Types>`,
		"word/document.xml": `<?xml version="1.0" encoding="UTF-8"?>` +
			`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`,
	}
	for name, body := range parts {
		part, err := writer.Create(name)
		require.NoError(t, err)
		_, err = part.Write([]byte(body))
		require.NoError(t, err)
	}
	require.NoError(t, writer.Close())
	return buf.Bytes()
}

func TestDetectExternalMimeTypeRecognizesTheDeliveredFamilies(t *testing.T) {
	// A .docx is a zip and a .drawio is plain XML, so the standard library's
	// detector reports application/zip and text/xml — neither is on the
	// allowlist. That mismatch is what made the editable families unregisterable,
	// so the gate and the store both have to read through this detector.
	docx := minimalDocx(t)
	assert.Equal(t,
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		DetectExternalMimeType(docx))
	assert.True(t, DesignExternalMimeAllowed(DetectExternalMimeType(docx)))

	drawio := []byte(`<?xml version="1.0" encoding="UTF-8"?>` +
		`<mxfile host="app.diagrams.net"><diagram id="a" name="P"/></mxfile>`)
	assert.Equal(t, "application/vnd.jgraph.drawio", DetectExternalMimeType(drawio))
	assert.True(t, DesignExternalMimeAllowed(DetectExternalMimeType(drawio)))

	// XML that is not a diagram stays off the allowlist: recognizing drawio must
	// not turn into admitting arbitrary XML.
	otherXML := []byte(`<?xml version="1.0" encoding="UTF-8"?><note><body>hi</body></note>`)
	assert.False(t, DesignExternalMimeAllowed(DetectExternalMimeType(otherXML)))

	// Script-bearing content is clamped to a type nothing will render, rather
	// than merely left unrecognized.
	assert.Equal(t, "application/octet-stream",
		DetectExternalMimeType([]byte("<html><script>alert(1)</script></html>")))
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)
	assert.False(t, DesignExternalMimeAllowed(DetectExternalMimeType(svg)))
}
