package backend

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// DuplicateCacheEntry represents cached metadata for a single audio file used
// by the duplicate scanner to avoid re-parsing metadata repeatedly.
type DuplicateCacheEntry struct {
	Path        string         `json:"path"`
	Size        int64          `json:"size"`
	ModTimeUnix int64          `json:"mod_time_unix"`
	Metadata    *AudioMetadata `json:"metadata,omitempty"`
	FileHash    string         `json:"file_hash,omitempty"`
	// Chromaprint raw fingerprint (fpcalc -raw); used when UseFingerprint to detect same audio across formats.
	Fingerprint []uint32 `json:"fingerprint,omitempty"`
	// When the entry was last saved into cache (helpful for debugging/inspection)
	SavedAt string `json:"saved_at,omitempty"`
}

// LoadDuplicateCache loads the cache for a given library root path. If the cache
// file does not exist, it returns an empty map and a nil error.
func LoadDuplicateCache(rootPath string) (map[string]DuplicateCacheEntry, error) {
	cachePath, err := duplicateCachePathForRoot(rootPath)
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(cachePath)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]DuplicateCacheEntry{}, nil
		}
		return nil, fmt.Errorf("failed to read duplicate cache: %w", err)
	}

	var out map[string]DuplicateCacheEntry
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("failed to unmarshal duplicate cache: %w", err)
	}

	return out, nil
}

// SaveDuplicateCache saves the provided cache map for a given library root path.
// The file is written atomically by writing to a temp file and renaming it.
func SaveDuplicateCache(rootPath string, cache map[string]DuplicateCacheEntry) error {
	cachePath, err := duplicateCachePathForRoot(rootPath)
	if err != nil {
		return err
	}

	dir := filepath.Dir(cachePath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("failed to create cache directory: %w", err)
	}

	// Attach saved timestamp to entries for easier inspection
	for k, v := range cache {
		v.SavedAt = time.Now().UTC().Format(time.RFC3339)
		cache[k] = v
	}

	data, err := json.MarshalIndent(cache, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal duplicate cache: %w", err)
	}

	tmpFile := cachePath + ".tmp"
	if err := os.WriteFile(tmpFile, data, 0o644); err != nil {
		return fmt.Errorf("failed to write temp duplicate cache: %w", err)
	}

	if err := os.Rename(tmpFile, cachePath); err != nil {
		// Attempt to remove temp file on error
		_ = os.Remove(tmpFile)
		return fmt.Errorf("failed to atomically save duplicate cache: %w", err)
	}

	return nil
}

// ClearDuplicateCache removes the cache file associated with the given root path.
// If the cache file does not exist, this is a no-op.
func ClearDuplicateCache(rootPath string) error {
	cachePath, err := duplicateCachePathForRoot(rootPath)
	if err != nil {
		return err
	}
	if err := os.Remove(cachePath); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("failed to remove duplicate cache file: %w", err)
	}
	return nil
}

// PruneDuplicateCache removes cache entries for files that no longer exist.
// This prevents cache bloat from deleted files.
func PruneDuplicateCache(rootPath string) error {
	cacheMap, err := LoadDuplicateCache(rootPath)
	if err != nil {
		return err
	}

	pruned := false
	for path := range cacheMap {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			delete(cacheMap, path)
			pruned = true
		}
	}

	if pruned {
		return SaveDuplicateCache(rootPath, cacheMap)
	}
	return nil
}

// InvalidateCacheEntry removes a specific file path from the cache.
func InvalidateCacheEntry(rootPath string, filePath string) error {
	cacheMap, err := LoadDuplicateCache(rootPath)
	if err != nil {
		return err
	}

	if _, exists := cacheMap[filePath]; exists {
		delete(cacheMap, filePath)
		return SaveDuplicateCache(rootPath, cacheMap)
	}
	return nil
}

// InvalidateCacheEntries removes multiple file paths from the cache.
func InvalidateCacheEntries(rootPath string, filePaths []string) error {
	if len(filePaths) == 0 {
		return nil
	}

	cacheMap, err := LoadDuplicateCache(rootPath)
	if err != nil {
		return err
	}

	pruned := false
	for _, filePath := range filePaths {
		if _, exists := cacheMap[filePath]; exists {
			delete(cacheMap, filePath)
			pruned = true
		}
	}

	if pruned {
		return SaveDuplicateCache(rootPath, cacheMap)
	}
	return nil
}

// duplicateCachePathForRoot computes a stable cache file path for the given root
// path using a hash so that different library roots have different cache files.
func duplicateCachePathForRoot(rootPath string) (string, error) {
	if rootPath == "" {
		return "", fmt.Errorf("root path is required")
	}
	userCacheDir, err := os.UserCacheDir()
	if err != nil {
		// Fallback to temp dir when UserCacheDir is unavailable
		userCacheDir = os.TempDir()
	}

	sum := sha1.Sum([]byte(rootPath))
	hash := hex.EncodeToString(sum[:])
	dir := filepath.Join(userCacheDir, "spotiflac")
	fileName := fmt.Sprintf("duplicates_%s.json", hash)
	return filepath.Join(dir, fileName), nil
}
