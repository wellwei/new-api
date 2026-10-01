package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/model"
	"github.com/gabriel-vasile/mimetype"
	"github.com/gin-gonic/gin"
)

// Persistence for workbench deliverables that no task produced: a reference
// image the user dropped in, or an editable file an agent built with an outside
// tool. The bytes land in the same filesystem store as generated artifacts and
// land in a different table, because the existing ledger is keyed by
// (task_id, artifact_key) and its storage path embeds the task id — neither
// exists here. What is shared with the task path on purpose: the atomic
// temp-file + rename publish, the per-object byte cap, the SHA-256 ledger
// value, the mime sniffing and clamping, and the rule that content is only
// ever served through an authenticated route.

// ErrExternalArtifactTooLarge reports a rejected object over the configured
// per-object cap. The message is user-facing (the dashboard shows it), so it
// states the actual cap instead of naming an internal constant.
var ErrExternalArtifactTooLarge = errors.New("artifact exceeds max object bytes")

// Provenance of a registered deliverable, recorded so triage can tell a
// pasted link from a dropped file.
const (
	DesignExternalSourceUpload = "upload"
	DesignExternalSourceURL    = "url"
)

// DesignExternalMimeAllowlist is the set of types the workbench will register.
//
// It is a positive list, not a block list: the content is later served from
// the site's own origin, so anything that can carry script (HTML, SVG) must be
// excluded at the door rather than relied on to be neutralized downstream.
// Reference images are the common case; the editable families are what the
// design agent delivers back.
var DesignExternalMimeAllowlist = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/webp": true,

	// Editable deliverables.
	"application/vnd.jgraph.drawio":                                             true, // .drawio (uncompressed)
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": true, // .pptx
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":   true, // .docx
	"application/pdf": true,
}

// DesignExternalMimeAllowed reports whether a sniffed mime type may be
// registered. Callers must pass a type produced by DetectExternalMimeType,
// never a client-declared one.
func DesignExternalMimeAllowed(mime string) bool {
	mime = strings.ToLower(strings.TrimSpace(mime))
	if idx := strings.IndexByte(mime, ';'); idx >= 0 {
		mime = strings.TrimSpace(mime[:idx])
	}
	return DesignExternalMimeAllowlist[mime]
}

// DetectExternalMimeType is the single sniffer for registered deliverables: the
// registration gate and the ledger row both read their type from here, so they
// cannot disagree. A gate that sniffs differently from the store rejects exactly
// the formats the allowlist promises — the standard library's detector reports a
// .docx as application/zip and a .drawio as text/xml, neither of which is on the
// list.
//
// The answer comes from the bytes alone. A client-declared Content-Type is never
// consulted, because registered content is served back from this site's own
// origin and the declaration is chosen by whoever uploads.
func DetectExternalMimeType(head []byte) string {
	mime := ""
	if len(head) > 0 {
		if detected, err := mimetype.DetectReader(bytes.NewReader(head)); err == nil && detected != nil {
			mime = detected.String()
		}
	}
	if mime == "" {
		mime = "application/octet-stream"
	}
	// drawio is plain XML with no registered magic, so the root element is the
	// only honest signal that distinguishes a diagram from an arbitrary document.
	if strings.HasPrefix(mime, "text/xml") || strings.HasPrefix(mime, "application/xml") {
		if isDrawioDocument(head) {
			return "application/vnd.jgraph.drawio"
		}
	}
	if strings.Contains(mime, "html") || strings.Contains(mime, "svg") || strings.Contains(mime, "javascript") {
		return "application/octet-stream"
	}
	return mime
}

// isDrawioDocument reports whether the leading bytes open with drawio's root
// element. Only the first start element counts, so a document that merely
// mentions the name deeper down is not mistaken for a diagram.
func isDrawioDocument(head []byte) bool {
	decoder := xml.NewDecoder(bytes.NewReader(head))
	for {
		token, err := decoder.Token()
		if err != nil {
			return false
		}
		if start, ok := token.(xml.StartElement); ok {
			return start.Name.Local == "mxfile"
		}
	}
}

// SanitizeExternalFileName keeps a display name from carrying path separators or
// control characters into storage metadata or a Content-Disposition header. It
// runs at the write boundary so no caller can record an unsanitized name.
func SanitizeExternalFileName(name string) string {
	name = strings.TrimSpace(name)
	name = strings.ReplaceAll(name, "/", "_")
	name = strings.ReplaceAll(name, "\\", "_")
	if !utf8.ValidString(name) {
		return ""
	}
	if idx := strings.IndexAny(name, "\r\n"); idx >= 0 {
		name = name[:idx]
	}
	if len(name) > 191 {
		name = name[:191]
	}
	return name
}

// DesignExternalMaxUploadBytes bounds a single multipart registration before
// the body is buffered, so an oversized request is rejected without being
// staged in memory or on disk.
const DesignExternalMaxUploadBytes = int64(32 << 20)

// ExternalAssetRegistration describes a deliverable being registered. The file
// name is display-only and is sanitized before it is recorded; Source is one of
// DesignExternalSourceUpload / DesignExternalSourceURL. Carrying all of it into
// PersistExternal is what lets the ledger row be written once and complete:
// patching the row afterwards leaves a window where a registered object has
// bytes on disk but no name or provenance.
type ExternalAssetRegistration struct {
	SemanticRole string
	FileName     string
	Source       string
}

// ExternalArtifactStore persists externally supplied deliverable bytes.
// Implemented by the filesystem backend; upstream and s3 keep their previous
// behavior (no external object support) until they gain a backend.
type ExternalArtifactStore interface {
	Enabled() bool
	PersistExternal(ctx context.Context, projectID, userID int64, registration ExternalAssetRegistration, content io.Reader) (*model.DesignExternalObject, error)
	ResolveExternal(projectID int64, objectKey string) (*model.DesignExternalObject, error)
	ServeExternal(c *gin.Context, object *model.DesignExternalObject) error
}

type disabledExternalArtifactStore struct{}

func (disabledExternalArtifactStore) Enabled() bool { return false }

func (disabledExternalArtifactStore) PersistExternal(context.Context, int64, int64, ExternalAssetRegistration, io.Reader) (*model.DesignExternalObject, error) {
	return nil, ErrTaskArtifactStoreDisabled
}

func (disabledExternalArtifactStore) ResolveExternal(int64, string) (*model.DesignExternalObject, error) {
	return nil, nil
}

func (disabledExternalArtifactStore) ServeExternal(*gin.Context, *model.DesignExternalObject) error {
	return ErrTaskArtifactStoreDisabled
}

var externalArtifactStore ExternalArtifactStore = &disabledExternalArtifactStore{}

// GetExternalArtifactStore returns the backend that can hold registered
// deliverables. It is the filesystem store when the artifact store runs in
// filesystem mode, otherwise the disabled store.
func GetExternalArtifactStore() ExternalArtifactStore {
	return externalArtifactStore
}

// RegisterExternalArtifactStore wires the external-object surface to a backend
// and returns a func that restores the previous one. The artifact store init
// calls it with the configured backend; a disabled or upstream store leaves
// external registration unsupported on purpose. Returning the restore is what
// lets a test drive the registration route against a real volume instead of
// bouncing off the disabled store.
func RegisterExternalArtifactStore(store TaskArtifactStore) func() {
	previous := externalArtifactStore
	if filesystem, ok := store.(*FilesystemArtifactStore); ok {
		externalArtifactStore = filesystem
	} else {
		externalArtifactStore = &disabledExternalArtifactStore{}
	}
	return func() { externalArtifactStore = previous }
}

// NewExternalObjectKey mints the storage key and HMAC signing input for a
// registered deliverable. It is always server-generated: the key is both the
// on-disk name and the signature subject, so a client-chosen name would be a
// way to overwrite or address another object's bytes. The semantic role is
// kept as a readable prefix for operators grepping the volume.
func NewExternalObjectKey(semanticRole string) (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	role := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		default:
			return '_'
		}
	}, strings.TrimSpace(semanticRole))
	if len(role) > 32 {
		role = role[:32]
	}
	if role == "" {
		role = "object"
	}
	return fmt.Sprintf("ext_%s_%s", role, hex.EncodeToString(buf)), nil
}

// externalObjectRelativePath mirrors objectRelativePath but keys the
// namespace on the project and the generated key, so external objects can
// never collide with task artifacts even when a task id happens to look like
// a project id.
func (s *FilesystemArtifactStore) externalObjectRelativePath(projectID int64, objectKey, sha string) string {
	prefix := "0"
	if len(sha) >= 2 {
		prefix = sha[:2]
	}
	return filepath.Join("external", prefix, fmt.Sprintf("p%d_%s", projectID, objectKey))
}

// PersistExternal streams caller-supplied bytes to disk and records the
// ledger row. The size cap is enforced by copying at most maxObject+1 bytes,
// so an oversized upload is rejected without ever filling the volume, and the
// ledger row is only written after the object has been published.
func (s *FilesystemArtifactStore) PersistExternal(ctx context.Context, projectID, userID int64, registration ExternalAssetRegistration, content io.Reader) (*model.DesignExternalObject, error) {
	if projectID <= 0 || userID <= 0 {
		return nil, errors.New("persist external: project and user are required")
	}
	if content == nil {
		return nil, errors.New("persist external: artifact content reader is nil")
	}
	semanticRole := strings.TrimSpace(registration.SemanticRole)
	// Anything not explicitly a fetched URL arrived as an upload.
	source := DesignExternalSourceUpload
	if registration.Source == DesignExternalSourceURL {
		source = DesignExternalSourceURL
	}
	objectKey, err := NewExternalObjectKey(semanticRole)
	if err != nil {
		return nil, fmt.Errorf("persist external: object key: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(s.storageDir(), 0o755); err != nil {
		return nil, fmt.Errorf("persist external: mkdir root: %w", err)
	}
	tmp, err := os.CreateTemp(s.storageDir(), ".external-*")
	if err != nil {
		return nil, fmt.Errorf("persist external: create temp: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()

	h := sha256.New()
	maxObject := s.cfg.FilesystemMaxObjectBytes
	written, err := io.Copy(io.MultiWriter(tmp, h), &io.LimitedReader{R: content, N: maxObject + 1})
	if err != nil {
		_ = tmp.Close()
		return nil, fmt.Errorf("persist external: copy: %w", err)
	}
	if written > maxObject {
		_ = tmp.Close()
		return nil, fmt.Errorf("%w (%d)", ErrExternalArtifactTooLarge, maxObject)
	}
	if written == 0 {
		_ = tmp.Close()
		return nil, errors.New("persist external: artifact is empty")
	}
	if err := tmp.Close(); err != nil {
		return nil, fmt.Errorf("persist external: close temp: %w", err)
	}

	sum := hex.EncodeToString(h.Sum(nil))
	rel := s.externalObjectRelativePath(projectID, objectKey, sum)
	abs, err := s.resolveDiskPath(rel)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, fmt.Errorf("persist external: mkdir: %w", err)
	}
	// Same mime handling as the task path: sniff a bounded prefix, then clamp
	// anything script-bearing to octet-stream.
	mime, width, height, err := s.probeExternalMetadata(tmpName)
	if err != nil {
		return nil, err
	}
	if err := os.Rename(tmpName, abs); err != nil {
		if copyErr := copyFile(tmpName, abs); copyErr != nil {
			return nil, fmt.Errorf("persist external: rename: %w", err)
		}
		_ = os.Remove(tmpName)
	}

	object := &model.DesignExternalObject{
		UserID:       int(userID),
		ProjectID:    projectID,
		ObjectKey:    objectKey,
		SemanticRole: semanticRole,
		FileName:     SanitizeExternalFileName(registration.FileName),
		Source:       source,
		Backend:      filesystemArtifactBackend,
		RelativePath: rel,
		MimeType:     mime,
		Size:         written,
		SHA256:       sum,
		Width:        width,
		Height:       height,
	}
	if err := model.InsertDesignExternalObject(object); err != nil {
		// The bytes are published but unrecorded: drop them rather than leave
		// an orphan that no retention pass can attribute to a project.
		_ = os.Remove(abs)
		return nil, fmt.Errorf("persist external: ledger: %w", err)
	}
	return object, nil
}

// probeExternalMetadata reads the type through the same detector the
// registration gate uses, then the pixel dimensions, from the staged temp file.
func (s *FilesystemArtifactStore) probeExternalMetadata(tmpName string) (string, int, int, error) {
	head := make([]byte, 4<<10)
	read := 0
	if f, err := os.Open(tmpName); err == nil {
		n, _ := io.ReadFull(f, head)
		_ = f.Close()
		read = n
	}
	mime := DetectExternalMimeType(head[:read])
	width, height := probeImageDimensions(tmpName, mime)
	return mime, width, height, nil
}

// ResolveExternal returns a registered object of the project, or nil when it
// is not registered.
func (s *FilesystemArtifactStore) ResolveExternal(projectID int64, objectKey string) (*model.DesignExternalObject, error) {
	object, err := model.DesignExternalObjectByKey(projectID, objectKey)
	if err != nil {
		return nil, nil
	}
	return object, nil
}

// ServeExternal streams a registered object through the authenticated route
// with the same headers as a task artifact.
func (s *FilesystemArtifactStore) ServeExternal(c *gin.Context, object *model.DesignExternalObject) error {
	if object == nil || object.RelativePath == "" {
		return ErrTaskArtifactStoreDisabled
	}
	abs, err := s.resolveDiskPath(object.RelativePath)
	if err != nil {
		return err
	}
	f, err := os.Open(abs)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	stat, err := f.Stat()
	if err != nil {
		return err
	}
	mime := object.MimeType
	if mime == "" {
		mime = "application/octet-stream"
	}
	// Raster images render inline; everything else downloads, so a
	// mis-sniffed type can never execute in the site's origin.
	disposition := "inline"
	if !strings.HasPrefix(mime, "image/") || strings.Contains(mime, "svg") {
		disposition = "attachment"
	}
	name := object.FileName
	if name == "" {
		name = filepath.Base(object.RelativePath)
	}
	c.Header("Content-Type", mime)
	c.Header("Content-Disposition", fmt.Sprintf("%s; filename=%q", disposition, name))
	c.Header("Cache-Control", "private, max-age=3600")
	c.Header("X-Content-Type-Options", "nosniff")
	c.DataFromReader(http.StatusOK, stat.Size(), mime, f, nil)
	return nil
}

// designExternalObjectRetentionSeconds is the 30-day retention window the
// workbench documents for stored objects. Registered objects record created_at
// so a cleanup pass can attribute every byte to a workspace before
// reclaiming it.
const designExternalObjectRetentionSeconds = 30 * 24 * 60 * 60

// DesignExternalObjectExpired reports whether a registered object is past the
// retention window.
func DesignExternalObjectExpired(object *model.DesignExternalObject, now int64) bool {
	if object == nil || object.CreatedAt == 0 {
		return false
	}
	return now-object.CreatedAt > designExternalObjectRetentionSeconds
}
