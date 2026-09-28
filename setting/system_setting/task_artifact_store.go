package system_setting

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
	"unicode"

	"github.com/QuantumNous/new-api/common"
)

const (
	TaskArtifactStoreModeUpstream   = "upstream"
	TaskArtifactStoreModeS3         = "s3"
	TaskArtifactStoreModeFilesystem = "filesystem"

	DefaultTaskArtifactStorePresignTTLSeconds = 900
	MaxTaskArtifactStorePresignTTLSeconds     = 7 * 24 * 60 * 60

	// Filesystem backend defaults. Retention matches the design doc (30d).
	DefaultTaskArtifactRetentionDays  = 30
	DefaultTaskArtifactMaxObjectBytes = 64 << 20 // 64 MiB per object
	DefaultTaskArtifactMaxUserBytes   = 2 << 30  // 2 GiB per user
)

const (
	TaskArtifactStoreModeEnv         = "TASK_ARTIFACT_STORE_MODE"
	TaskArtifactStoreS3EndpointEnv   = "TASK_ARTIFACT_STORE_S3_ENDPOINT"
	TaskArtifactStoreS3BucketEnv     = "TASK_ARTIFACT_STORE_S3_BUCKET"
	TaskArtifactStoreS3RegionEnv     = "TASK_ARTIFACT_STORE_S3_REGION"
	TaskArtifactStoreS3AccessKeyEnv  = "TASK_ARTIFACT_STORE_S3_ACCESS_KEY"
	TaskArtifactStoreS3SecretKeyEnv  = "TASK_ARTIFACT_STORE_S3_SECRET_KEY"
	TaskArtifactStoreS3PrefixEnv     = "TASK_ARTIFACT_STORE_S3_PREFIX"
	TaskArtifactStoreS3PresignTTLEnv = "TASK_ARTIFACT_STORE_S3_PRESIGN_TTL"

	TaskArtifactStoreFilesystemPathEnv      = "TASK_ARTIFACT_STORE_PATH"
	TaskArtifactStoreFilesystemRetentionEnv = "TASK_ARTIFACT_STORE_RETENTION_DAYS"
	TaskArtifactStoreFilesystemMaxObjectEnv = "TASK_ARTIFACT_STORE_MAX_OBJECT_BYTES"
	TaskArtifactStoreFilesystemMaxUserEnv   = "TASK_ARTIFACT_STORE_MAX_USER_BYTES"
)

var (
	taskArtifactStoreBucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	taskArtifactStoreRegionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
)

// TaskArtifactStoreConfig reserves the configuration contract for a future S3
// implementation. The current release always falls back to upstream proxying.
type TaskArtifactStoreConfig struct {
	Mode                string
	S3Endpoint          string
	S3Bucket            string
	S3Region            string
	S3AccessKey         string
	S3SecretKey         string
	S3Prefix            string
	S3PresignTTLSeconds int

	FilesystemPath           string
	FilesystemRetentionDays  int
	FilesystemMaxObjectBytes int64
	FilesystemMaxUserBytes   int64
}

// LoadTaskArtifactStoreConfig reads and validates startup-only configuration.
// S3 mode is deliberately disabled until a storage implementation is shipped.
func LoadTaskArtifactStoreConfig() TaskArtifactStoreConfig {
	config := TaskArtifactStoreConfig{
		Mode:                common.GetEnvOrDefaultString(TaskArtifactStoreModeEnv, TaskArtifactStoreModeUpstream),
		S3Endpoint:          common.GetEnvOrDefaultString(TaskArtifactStoreS3EndpointEnv, ""),
		S3Bucket:            common.GetEnvOrDefaultString(TaskArtifactStoreS3BucketEnv, ""),
		S3Region:            common.GetEnvOrDefaultString(TaskArtifactStoreS3RegionEnv, ""),
		S3AccessKey:         common.GetEnvOrDefaultString(TaskArtifactStoreS3AccessKeyEnv, ""),
		S3SecretKey:         common.GetEnvOrDefaultString(TaskArtifactStoreS3SecretKeyEnv, ""),
		S3Prefix:            common.GetEnvOrDefaultString(TaskArtifactStoreS3PrefixEnv, ""),
		S3PresignTTLSeconds: common.GetEnvOrDefault(TaskArtifactStoreS3PresignTTLEnv, DefaultTaskArtifactStorePresignTTLSeconds),

		FilesystemPath:          common.GetEnvOrDefaultString(TaskArtifactStoreFilesystemPathEnv, ""),
		FilesystemRetentionDays: common.GetEnvOrDefault(TaskArtifactStoreFilesystemRetentionEnv, DefaultTaskArtifactRetentionDays),
		FilesystemMaxObjectBytes: common.GetEnvOrDefaultInt64(
			TaskArtifactStoreFilesystemMaxObjectEnv, DefaultTaskArtifactMaxObjectBytes),
		FilesystemMaxUserBytes: common.GetEnvOrDefaultInt64(
			TaskArtifactStoreFilesystemMaxUserEnv, DefaultTaskArtifactMaxUserBytes),
	}
	if err := ValidateTaskArtifactStoreConfig(config); err != nil {
		common.SysError("invalid task artifact store configuration: " + err.Error() + "; using upstream mode")
		config.Mode = TaskArtifactStoreModeUpstream
		return config
	}
	if config.Mode == TaskArtifactStoreModeS3 {
		common.SysError("task artifact S3 storage is not implemented; using upstream mode")
		config.Mode = TaskArtifactStoreModeUpstream
	}
	return config
}

// ValidateTaskArtifactStoreConfig performs syntax checks only. It never
// resolves hosts, contacts an endpoint, or verifies credentials.
func ValidateTaskArtifactStoreConfig(config TaskArtifactStoreConfig) error {
	if config.Mode != TaskArtifactStoreModeUpstream && config.Mode != TaskArtifactStoreModeS3 &&
		config.Mode != TaskArtifactStoreModeFilesystem {
		return fmt.Errorf("unsupported mode %q", config.Mode)
	}
	if config.Mode == TaskArtifactStoreModeFilesystem {
		if config.FilesystemPath == "" {
			return errors.New("filesystem artifact store requires " + TaskArtifactStoreFilesystemPathEnv)
		}
		if config.FilesystemPath != strings.TrimSpace(config.FilesystemPath) || len(config.FilesystemPath) > 512 ||
			strings.Contains(config.FilesystemPath, "\\") {
			return errors.New("filesystem artifact path is invalid")
		}
		if config.FilesystemRetentionDays <= 0 {
			return errors.New("filesystem artifact retention days must be positive")
		}
		if config.FilesystemMaxObjectBytes <= 0 || config.FilesystemMaxUserBytes <= 0 {
			return errors.New("filesystem artifact byte limits must be positive")
		}
	}
	if config.S3PresignTTLSeconds <= 0 || config.S3PresignTTLSeconds > MaxTaskArtifactStorePresignTTLSeconds {
		return fmt.Errorf("S3 presign TTL must be between 1 and %d seconds", MaxTaskArtifactStorePresignTTLSeconds)
	}

	requireS3Fields := config.Mode == TaskArtifactStoreModeS3
	if requireS3Fields && config.S3Endpoint == "" {
		return errors.New("S3 endpoint is required")
	}
	if config.S3Endpoint != "" {
		if config.S3Endpoint != strings.TrimSpace(config.S3Endpoint) {
			return errors.New("S3 endpoint must not contain surrounding whitespace")
		}
		endpoint, err := url.Parse(config.S3Endpoint)
		if err != nil || endpoint == nil || endpoint.Host == "" || endpoint.User != nil || endpoint.Opaque != "" {
			return errors.New("S3 endpoint must be an absolute URL without userinfo")
		}
		if endpoint.Scheme != "http" && endpoint.Scheme != "https" {
			return errors.New("S3 endpoint must use http or https")
		}
		if endpoint.RawQuery != "" || endpoint.ForceQuery || endpoint.Fragment != "" {
			return errors.New("S3 endpoint must not contain a query or fragment")
		}
	}

	if requireS3Fields && config.S3Bucket == "" {
		return errors.New("S3 bucket is required")
	}
	if config.S3Bucket != "" {
		if !taskArtifactStoreBucketPattern.MatchString(config.S3Bucket) ||
			strings.Contains(config.S3Bucket, "..") || net.ParseIP(config.S3Bucket) != nil {
			return errors.New("S3 bucket syntax is invalid")
		}
	}

	if requireS3Fields && config.S3Region == "" {
		return errors.New("S3 region is required")
	}
	if config.S3Region != "" && !taskArtifactStoreRegionPattern.MatchString(config.S3Region) {
		return errors.New("S3 region syntax is invalid")
	}
	if err := validateTaskArtifactStoreCredential("access key", config.S3AccessKey, 256, requireS3Fields); err != nil {
		return err
	}
	if err := validateTaskArtifactStoreCredential("secret key", config.S3SecretKey, 1024, requireS3Fields); err != nil {
		return err
	}

	if config.S3Prefix != "" {
		if config.S3Prefix != strings.TrimSpace(config.S3Prefix) || len(config.S3Prefix) > 512 ||
			strings.HasPrefix(config.S3Prefix, "/") || strings.Contains(config.S3Prefix, "\\") {
			return errors.New("S3 prefix syntax is invalid")
		}
		for part := range strings.SplitSeq(config.S3Prefix, "/") {
			if part == "." || part == ".." {
				return errors.New("S3 prefix must not contain dot segments")
			}
		}
		for _, character := range config.S3Prefix {
			if unicode.IsControl(character) {
				return errors.New("S3 prefix must not contain control characters")
			}
		}
	}
	return nil
}

func validateTaskArtifactStoreCredential(name, value string, maxLength int, required bool) error {
	if required && value == "" {
		return fmt.Errorf("S3 %s is required", name)
	}
	if value == "" {
		return nil
	}
	if value != strings.TrimSpace(value) || len(value) > maxLength {
		return fmt.Errorf("S3 %s syntax is invalid", name)
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return fmt.Errorf("S3 %s syntax is invalid", name)
		}
	}
	return nil
}
