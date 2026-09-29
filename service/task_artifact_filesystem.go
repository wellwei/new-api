package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/QuantumNous/new-api/types"
	"github.com/gabriel-vasile/mimetype"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
)

// Filesystem backend for TaskArtifactStore (design doc §8.2, Phase 1).
//
// Artifact bytes are copied once from the upstream provider URL after a task
// succeeds, written to disk atomically (temp file + rename), and recorded in
// the task_artifact_objects ledger. Content is only ever served through the
// existing authenticated artifact endpoint — never the raw disk path and never
// the expiring upstream signed URL.

const filesystemArtifactBackend = "filesystem"

// FilesystemArtifactStore persists artifact bytes on a local volume.
type FilesystemArtifactStore struct {
	cfg    system_setting.TaskArtifactStoreConfig
	client *http.Client
}

// NewFilesystemArtifactStore builds a filesystem store from validated config.
func NewFilesystemArtifactStore(cfg system_setting.TaskArtifactStoreConfig) *FilesystemArtifactStore {
	return &FilesystemArtifactStore{
		cfg:    cfg,
		client: GetHttpClient(),
	}
}

func (s *FilesystemArtifactStore) Enabled() bool { return true }

// storageDir returns the validated base directory for artifact objects.
func (s *FilesystemArtifactStore) storageDir() string { return s.cfg.FilesystemPath }

// objectRelativePath builds the ledger path for one object. The path is
// derived only from validated identity fields, never from client input, so it
// cannot traverse outside the storage root.
func (s *FilesystemArtifactStore) objectRelativePath(taskID, artifactKey, sha string) string {
	// Shard by a short prefix of the content hash to bound directory sizes.
	prefix := "0"
	if len(sha) >= 2 {
		prefix = sha[:2]
	}
	safeKey := strings.ReplaceAll(artifactKey, "/", "_")
	return filepath.Join(prefix, taskID+"_"+safeKey)
}

// Resolve returns the stored object reference for an artifact, or nil when the
// artifact has not been persisted (or is still pending) — the caller then
// falls back to live upstream proxying.
func (s *FilesystemArtifactStore) Resolve(task *model.Task, artifactKey string) (*StoredArtifactRef, error) {
	if task == nil || strings.TrimSpace(artifactKey) == "" {
		return nil, nil
	}
	var obj model.TaskArtifactObject
	err := model.DB.Where("task_id = ? AND artifact_key = ?", task.TaskID, artifactKey).
		Order("id DESC").Take(&obj).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if obj.Pending || obj.RelativePath == "" {
		return nil, nil
	}
	return &StoredArtifactRef{
		Backend:   obj.Backend,
		ObjectKey: obj.RelativePath,
		MimeType:  obj.MimeType,
		Size:      obj.Size,
	}, nil
}

// Serve streams a persisted object through the authenticated artifact endpoint
// with safe caching and content headers. It never exposes the disk path.
func (s *FilesystemArtifactStore) Serve(c *gin.Context, task *model.Task, ref *StoredArtifactRef) error {
	if ref == nil || ref.ObjectKey == "" {
		return ErrTaskArtifactStoreDisabled
	}
	abs, err := s.resolveDiskPath(ref.ObjectKey)
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
	mime := ref.MimeType
	if mime == "" {
		mime = "application/octet-stream"
	}
	// Inline-render only raster images; everything else is forced to download
	// so SVG/HTML can never execute in the origin context.
	disposition := "inline"
	if !strings.HasPrefix(mime, "image/") || strings.Contains(mime, "svg") {
		disposition = "attachment"
	}
	base := filepath.Base(ref.ObjectKey)
	c.Header("Content-Type", mime)
	c.Header("Content-Disposition", fmt.Sprintf("%s; filename=%q", disposition, base))
	c.Header("Cache-Control", "private, max-age=3600")
	c.Header("X-Content-Type-Options", "nosniff")
	c.DataFromReader(http.StatusOK, stat.Size(), mime, f, nil)
	return nil
}

// resolveDiskPath joins a ledger relative path onto the storage root and
// refuses anything that would escape it.
func (s *FilesystemArtifactStore) resolveDiskPath(rel string) (string, error) {
	root, err := filepath.Abs(s.storageDir())
	if err != nil {
		return "", err
	}
	abs, err := filepath.Abs(filepath.Join(root, rel))
	if err != nil {
		return "", err
	}
	if abs != root && !strings.HasPrefix(abs, root+string(os.PathSeparator)) {
		return "", errors.New("artifact path escapes storage root")
	}
	return abs, nil
}

// Persist writes artifact bytes to disk and records the ledger row. The caller
// supplies an io.Reader over the upstream bytes; Persist is invoked exactly
// once per (task, artifact) by the completion hook, after the task succeeds.
func (s *FilesystemArtifactStore) Persist(ctx context.Context, task *model.Task, artifact types.TaskArtifact, content io.Reader) (*StoredArtifactRef, error) {
	if task == nil || strings.TrimSpace(artifact.Key) == "" {
		return nil, errors.New("persist: task and artifact key are required")
	}
	if content == nil {
		return nil, errors.New("persist: artifact content reader is nil")
	}

	// Stream to a temp file while hashing and sizing; enforce per-object cap.
	maxObject := s.cfg.FilesystemMaxObjectBytes
	if err := os.MkdirAll(s.storageDir(), 0o755); err != nil {
		return nil, fmt.Errorf("persist: mkdir root: %w", err)
	}
	tmp, err := os.CreateTemp(s.storageDir(), ".artifact-*")
	if err != nil {
		return nil, fmt.Errorf("persist: create temp: %w", err)
	}
	tmpName := tmp.Name()
	// Best-effort cleanup if we fail before rename.
	defer func() { _ = os.Remove(tmpName) }()

	h := sha256.New()
	limited := &io.LimitedReader{R: content, N: maxObject + 1}
	written, err := io.Copy(io.MultiWriter(tmp, h), limited)
	if err != nil {
		_ = tmp.Close()
		return nil, fmt.Errorf("persist: copy: %w", err)
	}
	if written > maxObject {
		_ = tmp.Close()
		return nil, fmt.Errorf("persist: artifact exceeds max object bytes (%d)", maxObject)
	}
	if err := tmp.Close(); err != nil {
		return nil, fmt.Errorf("persist: close temp: %w", err)
	}

	sum := hex.EncodeToString(h.Sum(nil))
	rel := s.objectRelativePath(task.TaskID, artifact.Key, sum)
	abs, err := s.resolveDiskPath(rel)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, fmt.Errorf("persist: mkdir: %w", err)
	}

	mime := artifact.MimeType
	if mime == "" {
		// Sniff a bounded prefix from the temp file; fall back to octet-stream.
		head, _ := os.Open(tmpName)
		if head != nil {
			mt, mErr := mimetype.DetectReader(io.LimitReader(head, 4<<10))
			_ = head.Close()
			if mErr == nil && mt != nil {
				mime = mt.String()
			}
		}
	}
	if mime == "" {
		mime = "application/octet-stream"
	}
	// Never let an HTML/SVG mime slip through as inline-renderable.
	if strings.Contains(mime, "html") || strings.Contains(mime, "svg") || strings.Contains(mime, "javascript") {
		mime = "application/octet-stream"
	}

	width, height := probeImageDimensions(tmpName, mime)

	// Atomically publish the object (temp + rename), then record the ledger.
	if err := os.Rename(tmpName, abs); err != nil {
		// Cross-device or existing target: fall back to copy+remove.
		if cerr := copyFile(tmpName, abs); cerr != nil {
			return nil, fmt.Errorf("persist: rename: %w", err)
		}
		_ = os.Remove(tmpName)
	}

	obj := model.TaskArtifactObject{
		CreatedAt:    time.Now().Unix(),
		TaskID:       task.TaskID,
		ArtifactKey:  artifact.Key,
		UserID:       task.UserId,
		Backend:      filesystemArtifactBackend,
		RelativePath: rel,
		MimeType:     mime,
		Size:         written,
		SHA256:       sum,
		Width:        width,
		Height:       height,
		Pending:      false,
	}
	// Idempotent upsert keyed on (task_id, artifact_key).
	err = model.DB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "task_id"}, {Name: "artifact_key"}},
		DoUpdates: clause.Assignments(map[string]any{"pending": false, "relative_path": rel, "mime_type": mime, "size": written, "sha256": sum, "backend": filesystemArtifactBackend, "width": width, "height": height, "user_id": task.UserId}),
	}).Create(&obj).Error
	if err != nil {
		return nil, fmt.Errorf("persist: ledger: %w", err)
	}

	return &StoredArtifactRef{
		Backend:   filesystemArtifactBackend,
		ObjectKey: rel,
		MimeType:  mime,
		Size:      written,
	}, nil
}

// probeImageDimensions returns pixel dimensions for raster images, 0 otherwise.
func probeImageDimensions(path, mime string) (int, int) {
	if !strings.HasPrefix(mime, "image/") || strings.Contains(mime, "svg") {
		return 0, 0
	}
	f, err := os.Open(path)
	if err != nil {
		return 0, 0
	}
	defer func() { _ = f.Close() }()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return 0, 0
	}
	return cfg.Width, cfg.Height
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}
