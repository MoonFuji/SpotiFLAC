package backend

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"unicode"

	"github.com/hbollon/go-edlib"
)

// DuplicateScanOptions controls behavior of the advanced duplicate scanner.
type DuplicateScanOptions struct {
	// UseHash will compute a SHA1 hash of each file and will allow exact
	// binary duplicate detection in addition to metadata-based grouping.
	UseHash bool `json:"use_hash"`

	// DurationToleranceMs controls how coarse duration bucketing is when
	// grouping files by duration. Defaults to 3000 (3s) if 0. Ignored when IgnoreDuration is true.
	DurationToleranceMs int `json:"duration_tolerance_ms"`

	// UseFilenameFallback will try to parse "Artist - Title" style filenames
	// when metadata is missing.
	UseFilenameFallback bool `json:"use_filename_fallback"`

	// IgnoreDuration, when true, matches duplicates by title/artist only (no duration bucketing or check).
	// Use when you have the same song in different sources (e.g. old YouTube MP3 + new FLAC from quality upgrade).
	IgnoreDuration bool `json:"ignore_duration"`

	// UseFingerprint, when true, runs fpcalc (chromaprint-tools) to compute acoustic fingerprints and
	// groups files by fingerprint match (same audio across formats, e.g. YouTube MP3 vs Bandcamp FLAC).
	// Requires fpcalc on PATH (e.g. install libchromaprint-tools). Slower than metadata-only scan.
	UseFingerprint bool `json:"use_fingerprint"`

	// WorkerCount controls concurrent metadata reads. If 0 a default is chosen.
	WorkerCount int `json:"worker_count"`
}

// fileScanResult is the result of scanning a single file.
type fileScanResult struct {
	Path        string
	Size        int64
	Metadata    *AudioMetadata
	Hash        string
	Fingerprint []uint32 // Chromaprint raw fingerprint when UseFingerprint
	Error       error
}

// computeSHA1 computes the SHA1 hash of a file streaming it from disk.
// It returns a hex-encoded string.
func computeSHA1(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open: %w", err)
	}
	defer f.Close()

	h := sha1.New()
	buf := make([]byte, 32*1024)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			if _, werr := h.Write(buf[:n]); werr != nil {
				return "", fmt.Errorf("hash write: %w", werr)
			}
		}
		if err != nil {
			if err == io.EOF {
				break
			}
			return "", fmt.Errorf("read: %w", err)
		}
	}

	return hex.EncodeToString(h.Sum(nil)), nil
}

// normalizePath normalizes file paths for consistent comparison across platforms.
// Converts paths to a canonical form (clean, forward slashes, absolute if possible).
func normalizePath(path string) string {
	// Clean the path (removes . and .., normalizes separators)
	cleaned := filepath.Clean(path)
	// Convert to forward slashes for consistency (works on all platforms)
	normalized := filepath.ToSlash(cleaned)
	return normalized
}

// foldDiacritics maps common accented characters to ASCII so "Tiësto" and "Tiesto" match.
func foldDiacritics(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch r {
		case 'ë', 'ê', 'è', 'é', 'ē', 'ė':
			b.WriteRune('e')
		case 'ï', 'î', 'ì', 'í', 'ī':
			b.WriteRune('i')
		case 'ö', 'ô', 'ò', 'ó', 'ō', 'ø':
			b.WriteRune('o')
		case 'ü', 'û', 'ù', 'ú', 'ū':
			b.WriteRune('u')
		case 'ä', 'â', 'à', 'á', 'ā', 'å':
			b.WriteRune('a')
		case 'ñ':
			b.WriteRune('n')
		case 'ß':
			b.WriteString("ss")
		case 'œ':
			b.WriteString("oe")
		case 'æ':
			b.WriteString("ae")
		default:
			if unicode.Is(unicode.Mn, r) {
				continue // skip combining characters (e.g. after NFD)
			}
			b.WriteRune(r)
		}
	}
	return b.String()
}

// normalizeForGrouping normalizes strings (title/artist) into a consistent key form.
func normalizeForGrouping(s string) string {
	s = strings.ToLower(s)
	s = foldDiacritics(s)
	s = strings.TrimSpace(s)
	featPatterns := []string{"feat.", "feat ", "ft.", "ft ", "featuring "}
	for _, pattern := range featPatterns {
		s = strings.ReplaceAll(s, pattern, " ")
	}
	s = strings.ReplaceAll(s, "&", " and ")
	s = strings.ReplaceAll(s, " - ", " ")
	s = strings.ReplaceAll(s, "_", " ")
	s = strings.ReplaceAll(s, " . ", " ")
	s = strings.ReplaceAll(s, " , ", " ")
	s = strings.ReplaceAll(s, "..", " ")
	s = strings.Join(strings.Fields(s), " ")
	return s
}

// coreTitleForGrouping reduces a title to a "core" form so that different versions
// of the same track group together, e.g. "Heading Up High (feat. Kensington)" and
// "Heading Up High - First State Extended Remix" both become "heading up high".
func coreTitleForGrouping(title string) string {
	s := strings.ToLower(strings.TrimSpace(title))
	if s == "" {
		return s
	}
	// If title has " : " (e.g. "Heading Up High : Heading Up High - First State Extended Remix"), use first part as core
	if idx := strings.Index(s, " : "); idx > 0 {
		s = strings.TrimSpace(s[:idx])
	}
	// Strip parenthetical content: (feat. X), (Remix), [Something], etc.
	s = regexp.MustCompile(`\s*\([^)]*\)\s*`).ReplaceAllString(s, " ")
	s = regexp.MustCompile(`\s*\[[^]]*\]\s*`).ReplaceAllString(s, " ")
	s = regexp.MustCompile(`\s*\{[^}]*\}\s*`).ReplaceAllString(s, " ")
	// Strip common version/remix suffixes that come after " - " (dash with spaces)
	remixSuffixes := []string{
		" - first state extended remix", " - extended remix", " - remix",
		" - radio edit", " - original mix", " - club mix", " - edit",
		" - instrumental", " - acoustic", " - live",
	}
	for _, suffix := range remixSuffixes {
		s = strings.TrimSuffix(strings.TrimSpace(s), suffix)
	}
	// Also strip " - Something Extended Remix" style (generic pattern)
	if idx := strings.Index(s, " - "); idx > 0 {
		after := strings.ToLower(s[idx+3:])
		if strings.Contains(after, "remix") || strings.Contains(after, "edit") || strings.Contains(after, "mix") {
			s = strings.TrimSpace(s[:idx])
		}
	}
	// Strip possessives so "Tiësto's" / "Tiesto's" don't leave stray 's in core title
	s = regexp.MustCompile(`'s\b`).ReplaceAllString(s, "")
	s = regexp.MustCompile(`\x{2019}s\b`).ReplaceAllString(s, "") // curly apostrophe (')
	return normalizeForGrouping(s)
}

// primaryArtistForGrouping uses the first/primary artist for grouping so that
// "Armin van Buuren" and "Armin van Buuren, Kensington, First State" match,
// and "Delerium feat. Sarah McLachlan" matches "Delerium, Sarah McLachlan, Tiësto".
func primaryArtistForGrouping(artist string) string {
	s := strings.TrimSpace(artist)
	// First part before comma (artist list)
	if idx := strings.Index(s, ","); idx > 0 {
		s = strings.TrimSpace(s[:idx])
	}
	// First part before feat./ft./featuring so "Delerium feat. Sarah" -> "Delerium"
	featPatterns := []string{" feat. ", " feat ", " ft. ", " ft ", " featuring "}
	for _, pattern := range featPatterns {
		if idx := strings.Index(strings.ToLower(s), strings.ToLower(pattern)); idx > 0 {
			s = strings.TrimSpace(s[:idx])
			break
		}
	}
	return normalizeForGrouping(s)
}

// duplicatePairNormalize normalizes title/artist for scoring (same style as quality upgrade).
func duplicatePairNormalize(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, "'", "")
	s = strings.ReplaceAll(s, "&", "and")
	return s
}

// scoreDuplicatePairPair scores title-vs-title and artist-vs-artist (or swapped) for duplicate merge.
// Mirrors quality upgrade scoreMatchPair: exact, word overlap, substring, fuzzy Jaro-Winkler tiers.
func scoreDuplicatePairPair(titleA, artistA, titleB, artistB string) int {
	score := 0
	// Title
	if titleA == titleB {
		score += 100
	} else {
		wordsA := strings.Fields(titleA)
		wordsB := strings.Fields(titleB)
		matched := 0
		for _, w := range wordsA {
			if len(w) < 2 {
				continue
			}
			for _, r := range wordsB {
				if w == r {
					matched++
					break
				}
			}
		}
		if len(wordsA) > 0 {
			score += int(float64(matched) / float64(len(wordsA)) * 60)
		}
		if strings.Contains(titleB, titleA) {
			score += 30
		} else if strings.Contains(titleA, titleB) {
			score += 20
		}
		if titleA != "" && titleB != "" {
			if sim, err := edlib.StringsSimilarity(titleA, titleB, edlib.JaroWinkler); err == nil {
				if sim >= 0.90 {
					score += 55
				} else if sim >= 0.85 {
					score += 45
				} else if sim >= 0.75 {
					score += 30
				} else if sim >= 0.65 {
					score += 15
				}
			}
		}
	}
	// Artist
	if artistA == artistB {
		score += 50
	} else {
		if strings.Contains(artistB, artistA) {
			score += 30
		} else if strings.Contains(artistA, artistB) {
			score += 20
		} else {
			for _, w := range strings.Fields(artistA) {
				if len(w) < 2 {
					continue
				}
				for _, r := range strings.Fields(artistB) {
					if w == r {
						score += 10
						break
					}
				}
			}
		}
		if artistA != "" && artistB != "" {
			if sim, err := edlib.StringsSimilarity(artistA, artistB, edlib.JaroWinkler); err == nil {
				if sim >= 0.90 {
					score += 40
				} else if sim >= 0.80 {
					score += 25
				} else if sim >= 0.70 {
					score += 10
				}
			}
		}
	}
	return score
}

// ScoreDuplicatePair scores how likely two track identity pairs (title, artist) are the same track.
// Used by mergeSimilarGroups (quality_upgrade.go) to decide whether to merge two duplicate groups.
// Uses the same logic as quality upgrade: exact, word overlap, substring, fuzzy Jaro-Winkler tiers.
// Tries both normal (title vs title, artist vs artist) and swapped (title vs artist) to handle
// reversed metadata. durationOK is true when both durations are 0 or diff <= 15% or 20s.
func ScoreDuplicatePair(title1, artist1 string, duration1 int, title2, artist2 string, duration2 int) (score int, durationOK bool) {
	norm := duplicatePairNormalize
	// Use normalized + core-style so "Silence (Remix)" and "Silence (feat. X)" compare well
	t1 := norm(normalizeForGrouping(coreTitleForGrouping(title1)))
	if t1 == "" {
		t1 = norm(normalizeForGrouping(title1))
	}
	a1 := norm(primaryArtistForGrouping(artist1))
	t2 := norm(normalizeForGrouping(coreTitleForGrouping(title2)))
	if t2 == "" {
		t2 = norm(normalizeForGrouping(title2))
	}
	a2 := norm(primaryArtistForGrouping(artist2))

	normalScore := scoreDuplicatePairPair(t1, a1, t2, a2)
	score = normalScore
	swappedScore := scoreDuplicatePairPair(t1, a1, a2, t2)
	if swappedScore > score {
		score = swappedScore
	}
	// Duration: 15% or 20s (slightly looser than quality upgrade so more dupes surface)
	durationOK = true
	if duration1 > 0 && duration2 > 0 {
		diff := duration1 - duration2
		if diff < 0 {
			diff = -diff
		}
		maxAllowed := int(float64(duration1) * 0.15)
		if duration2 > duration1 {
			maxAllowed = int(float64(duration2) * 0.15)
		}
		if maxAllowed < 20000 {
			maxAllowed = 20000
		}
		durationOK = diff <= maxAllowed
	}
	return score, durationOK
}

// parseFromFilename attempts to extract title/artist from various filename formats:
// - "Artist - Title"
// - "Title - Artist" (less common but exists)
// - "01. Artist - Title" or "01 Artist - Title"
// - "Artist_Title" or "Artist.Title"
// - "Artist feat. Other - Title"
func parseFromFilename(path string) (title string, artist string) {
	name := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	
	// Normalize separators: replace underscores and dots with spaces
	name = strings.ReplaceAll(name, "_", " ")
	name = strings.ReplaceAll(name, ".", " ")
	name = strings.TrimSpace(name)
	
	if name == "" {
		return "", ""
	}
	
	// Remove common prefixes: track numbers, disc numbers, etc.
	// Pattern: "01 ", "01. ", "1. ", "1-", etc.
	reTrackPrefix := regexp.MustCompile(`^\d+[\s\.\-]+`)
	name = reTrackPrefix.ReplaceAllString(name, "")
	name = strings.TrimSpace(name)
	
	// Try multiple separator patterns in order of likelihood

	// Pattern 0: "Title (feat. X) - RemixName - Artist, Artist, Artist" (title-first with artist list at end)
	if strings.Contains(name, " - ") {
		segments := strings.Split(name, " - ")
		if len(segments) >= 3 {
			first := strings.TrimSpace(segments[0])
			last := strings.TrimSpace(segments[len(segments)-1])
			firstLower := strings.ToLower(first)
			// First part looks like title (has parens e.g. "(feat. X)" or "(ft. X)"); case-insensitive
			looksLikeTitle := strings.Contains(firstLower, "(feat.") || strings.Contains(firstLower, "(ft.") ||
				strings.Contains(firstLower, "(featuring ") || (strings.Contains(first, "(") && strings.Contains(first, ")"))
			// Last part looks like artist list (comma-separated)
			looksLikeArtistList := strings.Contains(last, ",") && len(last) > 2
			if looksLikeTitle && looksLikeArtistList && first != "" && last != "" {
				return first, last
			}
		}
	}

	// Pattern 1: "Artist - Title" (most common, space-dash-space)
	if strings.Contains(name, " - ") {
		parts := strings.SplitN(name, " - ", 2)
		if len(parts) == 2 {
			artistPart := strings.TrimSpace(parts[0])
			titlePart := strings.TrimSpace(parts[1])
			// Heuristic: if title part is shorter, it might be reversed
			// But usually artist comes first, so trust the order
			if artistPart != "" && titlePart != "" {
				return titlePart, artistPart
			}
		}
	}
	
	// Pattern 2: "Artist -Title" or "Artist- Title" (dash without spaces)
	if strings.Contains(name, "-") {
		parts := strings.SplitN(name, "-", 2)
		if len(parts) == 2 {
			artistPart := strings.TrimSpace(parts[0])
			titlePart := strings.TrimSpace(parts[1])
			if artistPart != "" && titlePart != "" {
				return titlePart, artistPart
			}
		}
	}
	
	// Pattern 3: "Artist feat. Other - Title" or "Artist ft. Other - Title"
	// Try to find "feat." or "ft." as a marker
	featPatterns := []string{" feat. ", " feat ", " ft. ", " ft ", " featuring "}
	for _, pattern := range featPatterns {
		if idx := strings.Index(name, pattern); idx > 0 {
			// Everything before feat is artist, everything after might have title
			artistPart := strings.TrimSpace(name[:idx])
			rest := strings.TrimSpace(name[idx+len(pattern):])
			// If rest contains " - ", split again
			if strings.Contains(rest, " - ") {
				titleParts := strings.SplitN(rest, " - ", 2)
				if len(titleParts) == 2 {
					titlePart := strings.TrimSpace(titleParts[1])
					if artistPart != "" && titlePart != "" {
						return titlePart, artistPart
					}
				}
			} else if artistPart != "" && rest != "" {
				// No second separator, treat rest as title
				return rest, artistPart
			}
		}
	}
	
	// Pattern 4: Try splitting on common separators if no dash found
	// Look for patterns like "Artist Title" where we might guess
	// But this is risky, so only if name is short and has clear structure
	words := strings.Fields(name)
	if len(words) >= 3 {
		// Try first word as artist, rest as title (common pattern)
		// But only if it looks reasonable (not too many words)
		if len(words) <= 6 {
			potentialArtist := words[0]
			potentialTitle := strings.Join(words[1:], " ")
			// Basic validation: artist shouldn't be too long, title shouldn't be too short
			if len(potentialArtist) <= 30 && len(potentialTitle) >= 3 {
				return potentialTitle, potentialArtist
			}
		}
	}
	
	// If we can't parse, return filename as title with empty artist
	// This is better than returning empty title, as it allows hash-based grouping
	return name, ""
}

// workerCountForOptions returns a reasonable default worker count.
func workerCountForOptions(opts DuplicateScanOptions) int {
	if opts.WorkerCount > 0 {
		return opts.WorkerCount
	}
	n := runtime.NumCPU()
	if n < 2 {
		return 2
	}
	// allow a small multiplier for I/O
	return n * 2
}

// FindDuplicateTracksAdvanced performs an advanced duplicate scan which:
//   - reads metadata concurrently
//   - uses caching to avoid re-reading unchanged files
//   - can optionally compute file hashes for exact duplicate detection
//   - groups files by normalized title/artist with optional duration bucketing
//
// The function returns DuplicateGroup objects (same model as existing API) and
// does not modify on-disk files.
func FindDuplicateTracksAdvanced(ctx context.Context, folderPath string, opts DuplicateScanOptions) ([]DuplicateGroup, error) {
	if folderPath == "" {
		return nil, fmt.Errorf("folder path is required")
	}

	// sensible defaults
	if opts.DurationToleranceMs <= 0 {
		opts.DurationToleranceMs = 3000 // 3s buckets: coarser so same track in different formats groups together more often
	}

	audioFiles, err := ListAudioFiles(folderPath)
	if err != nil {
		return nil, fmt.Errorf("failed to list audio files: %w", err)
	}

	// Load cache (non-fatal; empty cache is fine)
	cacheMap, _ := LoadDuplicateCache(folderPath)
	
	// Normalize cache keys and prune stale entries
	normalizedCacheMap := make(map[string]DuplicateCacheEntry)
	for path, entry := range cacheMap {
		normalizedPath := normalizePath(path)
		// Update entry path to normalized form
		entry.Path = normalizedPath
		normalizedCacheMap[normalizedPath] = entry
		// Prune stale entries: remove cache entries for files that no longer exist
		if _, err := os.Stat(path); os.IsNotExist(err) {
			delete(normalizedCacheMap, normalizedPath)
		}
	}
	cacheMap = normalizedCacheMap
	
	cacheLock := &sync.Mutex{}

	workers := workerCountForOptions(opts)
	filesCh := make(chan FileInfo)
	resultsCh := make(chan *fileScanResult)
	var wg sync.WaitGroup
	
	// Collect errors encountered during scan (non-fatal, but should be reported)
	scanErrors := make([]error, 0)
	scanErrorsLock := &sync.Mutex{}

	// Worker routine
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			for file := range filesCh {
				select {
				case <-ctx.Done():
					return
				default:
				}

				// Stat to get current size and mod time
				info, statErr := os.Stat(file.Path)
				if statErr != nil {
					// emit an error result but continue scanning others
					resultsCh <- &fileScanResult{Path: file.Path, Error: statErr}
					continue
				}
				size := info.Size()
				modUnix := info.ModTime().Unix()

				// Normalize path for cache lookup
				normalizedPath := normalizePath(file.Path)

				// Check cache
				var cachedEntry DuplicateCacheEntry
				cacheLock.Lock()
				entry, inCache := cacheMap[normalizedPath]
				if inCache {
					cachedEntry = entry
				}
				cacheLock.Unlock()

				// If cache is valid, return quickly
				// File existence already verified by stat() above, so no need to stat again
				if inCache && cachedEntry.Size == size && cachedEntry.ModTimeUnix == modUnix {
					// Stat already succeeded above, so file exists - use cache
					resultsCh <- &fileScanResult{
						Path:        file.Path,
						Size:        size,
						Metadata:    cachedEntry.Metadata,
						Hash:        cachedEntry.FileHash,
						Fingerprint: cachedEntry.Fingerprint,
						Error:       nil,
					}
					continue
				}

				// Otherwise, read metadata
				meta, metaErr := ReadAudioMetadata(file.Path)
				if metaErr != nil {
					// record a nil metadata result but continue
					meta = nil
				}

				var fileHash string
				if opts.UseHash {
					hv, he := computeSHA1(file.Path)
					if he != nil {
						// don't fail the whole scan for single hash failure
						// but record an error for this file
						fileHash = ""
					} else {
						fileHash = hv
					}
				}

				var fingerprint []uint32
				if opts.UseFingerprint {
					cp, err := calculateChromaprintWithTimeout(ctx, file.Path)
					if err == nil && cp != nil && len(cp.Fingerprint) > 0 {
						fingerprint = cp.Fingerprint
					}
				}

				// Update cache (best-effort) using normalized path
				cacheLock.Lock()
				cacheMap[normalizedPath] = DuplicateCacheEntry{
					Path:        normalizedPath,
					Size:        size,
					ModTimeUnix: modUnix,
					Metadata:    meta,
					FileHash:    fileHash,
					Fingerprint: fingerprint,
				}
				cacheLock.Unlock()

				resultsCh <- &fileScanResult{
					Path:        file.Path,
					Size:        size,
					Metadata:    meta,
					Hash:        fileHash,
					Fingerprint: fingerprint,
					Error:       nil,
				}
			}
		}()
	}

	// feeder goroutine
	go func() {
		defer close(filesCh)
		for _, f := range audioFiles {
			select {
			case <-ctx.Done():
				return
			default:
			}
			filesCh <- f
		}
	}()

	// collector goroutine
	go func() {
		wg.Wait()
		close(resultsCh)
	}()

	// Build groups as results arrive
	groups := make(map[string]*duplicateGroupBuilder)
	groupsLock := &sync.Mutex{}

	// For hash-based grouping (post-process)
	hashGroups := make(map[string][]string)
	hashGroupsLock := &sync.Mutex{}

	// For fingerprint-based grouping (when UseFingerprint): collect path, fp, durationMs
	type fpCandidate struct {
		path       string
		fp         []uint32
		durationMs int
	}
	var fingerprintCandidates []fpCandidate

	// Process results
	for res := range resultsCh {
		if res.Error != nil {
			// Don't fail entire scan for single-file errors; keep going
			// But collect errors so they can be reported/logged
			scanErrorsLock.Lock()
			// Only keep first 10 errors to avoid memory bloat
			if len(scanErrors) < 10 {
				scanErrors = append(scanErrors, fmt.Errorf("file %s: %w", res.Path, res.Error))
			}
			scanErrorsLock.Unlock()
			continue
		}

		select {
		case <-ctx.Done():
			return buildDuplicateGroups(groups), ctx.Err()
		default:
		}

		title := ""
		artist := ""
		duration := 0
		bitrate := 0
		sampleRate := 0
		bitDepth := 0
		channels := 0
		codec := ""
		lossless := false

		if res.Metadata != nil {
			title = res.Metadata.Title
			artist = res.Metadata.Artist
			duration = res.Metadata.DurationMillis
			bitrate = res.Metadata.Bitrate
			sampleRate = res.Metadata.SampleRate
			bitDepth = res.Metadata.BitDepth
			channels = res.Metadata.Channels
			codec = res.Metadata.Codec
			lossless = res.Metadata.Lossless
		}

		// fallback to filename parsing if requested
		if (title == "" || artist == "") && opts.UseFilenameFallback {
			ftitle, fartist := parseFromFilename(res.Path)
			if title == "" {
				title = ftitle
			}
			if artist == "" {
				artist = fartist
			}
		}

		if title == "" || artist == "" {
			// If we don't have basic identifying metadata, skip grouping by metadata.
			// Hash-only mode will still be considered later.
			// Continue to next item.
			// But we will still add the file to hashGroups if we have a hash.
			if opts.UseHash && res.Hash != "" {
				hashGroupsLock.Lock()
				hashGroups[res.Hash] = append(hashGroups[res.Hash], res.Path)
				hashGroupsLock.Unlock()
			}
			continue
		}

		// compute duration bucket key with proper rounding (skip when IgnoreDuration)
		// This ensures files near bucket boundaries are grouped correctly
		durationBucket := 0
		if !opts.IgnoreDuration && duration > 0 && opts.DurationToleranceMs > 0 {
			// Use rounding: (duration + tolerance/2) / tolerance
			// This centers buckets around multiples of tolerance
			durationBucket = (duration + opts.DurationToleranceMs/2) / opts.DurationToleranceMs
		}

		key := coreTitleForGrouping(title) + "|" + primaryArtistForGrouping(artist)
		if !opts.IgnoreDuration && durationBucket > 0 {
			key = fmt.Sprintf("%s|d%d", key, durationBucket)
		}

		// ensure the builder exists
		groupsLock.Lock()
		builder, ok := groups[key]
		if !ok {
			builder = &duplicateGroupBuilder{
				title:  title,
				artist: artist,
				files:  []FileDetail{},
			}
			groups[key] = builder
		}
		// append the file detail
		builder.files = append(builder.files, FileDetail{
			Path:       res.Path,
			Size:       res.Size,
			Format:     strings.ToUpper(strings.TrimPrefix(filepath.Ext(res.Path), ".")),
			Duration:   duration,
			Bitrate:    bitrate,
			SampleRate: sampleRate,
			BitDepth:   bitDepth,
			Channels:   channels,
			Codec:      codec,
			Lossless:   lossless,
		})
		groupsLock.Unlock()

		// also record hash grouping (for later dedupe)
		if opts.UseHash && res.Hash != "" {
			hashGroupsLock.Lock()
			hashGroups[res.Hash] = append(hashGroups[res.Hash], res.Path)
			hashGroupsLock.Unlock()
		}

		// collect fingerprint candidates for acoustic grouping
		if opts.UseFingerprint && len(res.Fingerprint) > 0 {
			dur := 0
			if res.Metadata != nil {
				dur = res.Metadata.DurationMillis
			}
			fingerprintCandidates = append(fingerprintCandidates, fpCandidate{
				path:       res.Path,
				fp:         res.Fingerprint,
				durationMs: dur,
			})
		}
	}

	// Save updated cache (best-effort)
	_ = SaveDuplicateCache(folderPath, cacheMap)

	// start with metadata-based groups
	duplicates := buildDuplicateGroups(groups)
	
	// Merge similar groups using fuzzy matching (catches variations like "feat." vs ", ")
	duplicates = mergeSimilarGroups(duplicates, 0.78, opts.IgnoreDuration)

	// Now process hash groups: create groups for any hash that has >1 files
	// and that aren't already fully represented in duplicates.
	if opts.UseHash {
		included := make(map[string]bool)
		for _, g := range duplicates {
			for _, p := range g.Files {
				included[p] = true
			}
		}

		func() {
			hashGroupsLock.Lock()
			defer hashGroupsLock.Unlock()
			for _, paths := range hashGroups {
				if len(paths) < 2 {
					continue
				}
				// Filter out files that are already in metadata-based groups
				// Only create hash groups for files not already grouped
				filteredPaths := make([]string, 0, len(paths))
				for _, p := range paths {
					if !included[p] {
						filteredPaths = append(filteredPaths, p)
					}
				}
				// Only create group if we have at least 2 files not already in metadata groups
				if len(filteredPaths) < 2 {
					continue
				}
				// Use filtered paths instead of original paths
				paths = filteredPaths
				// attempt to pick metadata/title/artist from cache if possible
				title := ""
				artist := ""
				var fileDetails []FileDetail
				for _, p := range paths {
					// get cached entry for extra info
					normalizedP := normalizePath(p)
					cacheLock.Lock()
					ce, ok := cacheMap[normalizedP]
					cacheLock.Unlock()
					var size int64
					if fi, err := os.Stat(p); err == nil {
						size = fi.Size()
					}
					if ok && ce.Metadata != nil {
						if title == "" {
							title = ce.Metadata.Title
						}
						if artist == "" {
							artist = ce.Metadata.Artist
						}
						fileDetails = append(fileDetails, FileDetail{
							Path:       p,
							Size:       size,
							Format:     strings.ToUpper(strings.TrimPrefix(filepath.Ext(p), ".")),
							Duration:   ce.Metadata.DurationMillis,
							Bitrate:    ce.Metadata.Bitrate,
							SampleRate: ce.Metadata.SampleRate,
							BitDepth:   ce.Metadata.BitDepth,
							Channels:   ce.Metadata.Channels,
							Codec:      ce.Metadata.Codec,
							Lossless:   ce.Metadata.Lossless,
						})
					} else {
						// best-effort fallback
						fileDetails = append(fileDetails, FileDetail{
							Path:   p,
							Size:   size,
							Format: strings.ToUpper(strings.TrimPrefix(filepath.Ext(p), ".")),
						})
					}
				}
				// build a temporary builder and reuse buildDuplicateGroups
				tmpKey := fmt.Sprintf("hash|%s", paths[0])
				tmpGroups := map[string]*duplicateGroupBuilder{
					tmpKey: {
						title:  title,
						artist: artist,
						files:  fileDetails,
					},
				}
				extra := buildDuplicateGroups(tmpGroups)
				// add all groups from the extra set
				for _, eg := range extra {
					duplicates = append(duplicates, eg)
				}
			}
		}()
	}

	// Acoustic fingerprint groups: same audio across formats (e.g. YouTube MP3 vs Bandcamp FLAC)
	if opts.UseFingerprint && len(fingerprintCandidates) >= 2 {
		// Cluster by fingerprint match (Hamming < 15%) + duration pre-filter (±5s or ±2%)
		const fingerprintThreshold = 0.15
		type fpGroup struct {
			paths     []string
			fp        []uint32
			durationMs int
		}
		var fpGroups []fpGroup
		for _, c := range fingerprintCandidates {
			matched := false
			for i := range fpGroups {
				g := &fpGroups[i]
				if !FingerprintDurationOK(c.durationMs, g.durationMs) {
					continue
				}
				if FingerprintsMatch(c.fp, g.fp, fingerprintThreshold) {
					g.paths = append(g.paths, c.path)
					matched = true
					break
				}
			}
			if !matched {
				fpGroups = append(fpGroups, fpGroup{
					paths:      []string{c.path},
					fp:         c.fp,
					durationMs: c.durationMs,
				})
			}
		}
		included := make(map[string]bool)
		for _, g := range duplicates {
			for _, p := range g.Files {
				included[p] = true
			}
		}
		for _, g := range fpGroups {
			if len(g.paths) < 2 {
				continue
			}
			filtered := make([]string, 0, len(g.paths))
			for _, p := range g.paths {
				if !included[p] {
					filtered = append(filtered, p)
				}
			}
			for _, p := range g.paths {
				included[p] = true
			}
			if len(filtered) < 2 {
				continue
			}
			paths := filtered
			title := ""
			artist := ""
			var fileDetails []FileDetail
			for _, p := range paths {
				normalizedP := normalizePath(p)
				cacheLock.Lock()
				ce, ok := cacheMap[normalizedP]
				cacheLock.Unlock()
				var size int64
				if fi, err := os.Stat(p); err == nil {
					size = fi.Size()
				}
				if ok && ce.Metadata != nil {
					if title == "" {
						title = ce.Metadata.Title
					}
					if artist == "" {
						artist = ce.Metadata.Artist
					}
					fileDetails = append(fileDetails, FileDetail{
						Path:       p,
						Size:       size,
						Format:     strings.ToUpper(strings.TrimPrefix(filepath.Ext(p), ".")),
						Duration:   ce.Metadata.DurationMillis,
						Bitrate:    ce.Metadata.Bitrate,
						SampleRate: ce.Metadata.SampleRate,
						BitDepth:   ce.Metadata.BitDepth,
						Channels:   ce.Metadata.Channels,
						Codec:      ce.Metadata.Codec,
						Lossless:   ce.Metadata.Lossless,
					})
				} else {
					fileDetails = append(fileDetails, FileDetail{
						Path:   p,
						Size:   size,
						Format: strings.ToUpper(strings.TrimPrefix(filepath.Ext(p), ".")),
					})
				}
			}
			tmpKey := fmt.Sprintf("fp|%s", paths[0])
			tmpGroups := map[string]*duplicateGroupBuilder{
				tmpKey: {
					title:  title,
					artist: artist,
					files:  fileDetails,
				},
			}
			extra := buildDuplicateGroups(tmpGroups)
			for _, eg := range extra {
				duplicates = append(duplicates, eg)
			}
		}
	}

	// Note: Errors are collected but don't fail the scan
	// In production, these should be logged. For now, we silently continue
	// but errors are available in scanErrors if needed for debugging
	_ = scanErrors // Suppress unused warning - errors collected for future logging

	return duplicates, nil
	}

// CheckDuplicateGroupAdvanced validates a set of files and returns the
// DuplicateGroup (if duplicates still exist) according to the same advanced
// matching rules. This is useful after deletions to verify a group was resolved.
func CheckDuplicateGroupAdvanced(ctx context.Context, filePaths []string, opts DuplicateScanOptions) (*DuplicateGroup, error) {
	if len(filePaths) == 0 {
		return nil, fmt.Errorf("no file paths provided")
	}

	// We can reuse the engine but with a small scoped cache loaded from the
	// parent root. To keep things simple we will scan only the provided files
	// without listing a folder.
	if opts.DurationToleranceMs <= 0 {
		opts.DurationToleranceMs = 3000
	}

	// Load cache from an empty root (best-effort) - we try to infer a root from the first file
	root := ""
	if len(filePaths) > 0 {
		root = filepath.Dir(filePaths[0])
	}
	cacheMap, _ := LoadDuplicateCache(root)
	
	// Normalize cache keys and prune stale entries
	normalizedCacheMap := make(map[string]DuplicateCacheEntry)
	for path, entry := range cacheMap {
		normalizedPath := normalizePath(path)
		entry.Path = normalizedPath
		normalizedCacheMap[normalizedPath] = entry
	}
	cacheMap = normalizedCacheMap
	
	// Prune stale entries for the specific files we're checking
	for _, path := range filePaths {
		normalizedPath := normalizePath(path)
		if _, err := os.Stat(path); os.IsNotExist(err) {
			delete(cacheMap, normalizedPath)
		}
	}
	
	cacheLock := &sync.Mutex{}

	workers := workerCountForOptions(opts)
	filesCh := make(chan string)
	resultsCh := make(chan *fileScanResult)
	var wg sync.WaitGroup

	// Worker pool
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			for path := range filesCh {
				select {
				case <-ctx.Done():
					return
				default:
				}
				info, err := os.Stat(path)
				if err != nil {
					resultsCh <- &fileScanResult{Path: path, Error: err}
					continue
				}
				size := info.Size()
				modUnix := info.ModTime().Unix()

				normalizedPath := normalizePath(path)

				cacheLock.Lock()
				entry, inCache := cacheMap[normalizedPath]
				cacheLock.Unlock()

				if inCache && entry.Size == size && entry.ModTimeUnix == modUnix {
					// Stat already succeeded above, so file exists - use cache
					resultsCh <- &fileScanResult{
						Path:     path,
						Size:     size,
						Metadata: entry.Metadata,
						Hash:     entry.FileHash,
					}
					continue
				}

				meta, _ := ReadAudioMetadata(path)

				var h string
				if opts.UseHash {
					if hv, err := computeSHA1(path); err == nil {
						h = hv
					}
				}

				cacheLock.Lock()
				cacheMap[normalizedPath] = DuplicateCacheEntry{
					Path:        normalizedPath,
					Size:        size,
					ModTimeUnix: modUnix,
					Metadata:    meta,
					FileHash:    h,
				}
				cacheLock.Unlock()

				resultsCh <- &fileScanResult{
					Path:     path,
					Size:     size,
					Metadata: meta,
					Hash:     h,
				}
			}
		}()
	}

	go func() {
		defer close(filesCh)
		for _, p := range filePaths {
			filesCh <- p
		}
	}()

	go func() {
		wg.Wait()
		close(resultsCh)
	}()

	// Group building (same logic as FindDuplicateTracksAdvanced)
	groups := make(map[string]*duplicateGroupBuilder)
	groupsLock := &sync.Mutex{}
	hashGroups := make(map[string][]string)
	hashGroupsLock := &sync.Mutex{}

	for res := range resultsCh {
		if res.Error != nil {
			// skip problematic files
			continue
		}
		title := ""
		artist := ""
		duration := 0
		bitrate := 0
		sampleRate := 0
		bitDepth := 0
		channels := 0
		codec := ""
		lossless := false

		if res.Metadata != nil {
			title = res.Metadata.Title
			artist = res.Metadata.Artist
			duration = res.Metadata.DurationMillis
			bitrate = res.Metadata.Bitrate
			sampleRate = res.Metadata.SampleRate
			bitDepth = res.Metadata.BitDepth
			channels = res.Metadata.Channels
			codec = res.Metadata.Codec
			lossless = res.Metadata.Lossless
		}

		if (title == "" || artist == "") && opts.UseFilenameFallback {
			ft, fa := parseFromFilename(res.Path)
			if title == "" {
				title = ft
			}
			if artist == "" {
				artist = fa
			}
		}

		if title == "" || artist == "" {
			if opts.UseHash && res.Hash != "" {
				hashGroupsLock.Lock()
				hashGroups[res.Hash] = append(hashGroups[res.Hash], res.Path)
				hashGroupsLock.Unlock()
			}
			continue
		}

		durationBucket := 0
		if !opts.IgnoreDuration && duration > 0 && opts.DurationToleranceMs > 0 {
			// Use rounding: (duration + tolerance/2) / tolerance
			durationBucket = (duration + opts.DurationToleranceMs/2) / opts.DurationToleranceMs
		}

		key := coreTitleForGrouping(title) + "|" + primaryArtistForGrouping(artist)
		if !opts.IgnoreDuration && durationBucket > 0 {
			key = fmt.Sprintf("%s|d%d", key, durationBucket)
		}

		groupsLock.Lock()
		builder, ok := groups[key]
		if !ok {
			builder = &duplicateGroupBuilder{
				title:  title,
				artist: artist,
				files:  []FileDetail{},
			}
			groups[key] = builder
		}
		builder.files = append(builder.files, FileDetail{
			Path:       res.Path,
			Size:       res.Size,
			Format:     strings.ToUpper(strings.TrimPrefix(filepath.Ext(res.Path), ".")),
			Duration:   duration,
			Bitrate:    bitrate,
			SampleRate: sampleRate,
			BitDepth:   bitDepth,
			Channels:   channels,
			Codec:      codec,
			Lossless:   lossless,
		})
		groupsLock.Unlock()

		if opts.UseHash && res.Hash != "" {
			hashGroupsLock.Lock()
			hashGroups[res.Hash] = append(hashGroups[res.Hash], res.Path)
			hashGroupsLock.Unlock()
		}
	}

	_ = SaveDuplicateCache(root, cacheMap)

	duplicates := buildDuplicateGroups(groups)
	
	// Merge similar groups using fuzzy matching
	duplicates = mergeSimilarGroups(duplicates, 0.78, opts.IgnoreDuration)

	// Create a set of provided file paths for quick lookup
	providedPaths := make(map[string]bool)
	for _, p := range filePaths {
		providedPaths[p] = true
	}

	// Find the group that contains the provided files
	// Check metadata-based groups first
	for i := range duplicates {
		group := &duplicates[i]
		// Check if all provided files are in this group
		allFound := true
		for _, p := range filePaths {
			found := false
			for _, groupPath := range group.Files {
				if groupPath == p {
					found = true
					break
				}
			}
			if !found {
				allFound = false
				break
			}
		}
		if allFound && len(group.Files) >= 2 {
			// Found a group containing all provided files
			return group, nil
		}
	}

	// If no metadata-based group found, try hash-based fallback
	if opts.UseHash {
		var hashResult *DuplicateGroup
		func() {
			hashGroupsLock.Lock()
			defer hashGroupsLock.Unlock()
			for _, paths := range hashGroups {
				if len(paths) < 2 {
					continue
				}
				// Check if all provided files are in this hash group
				allFound := true
				for _, p := range filePaths {
					found := false
					for _, hashPath := range paths {
						if hashPath == p {
							found = true
							break
						}
					}
					if !found {
						allFound = false
						break
					}
				}
				if allFound {
					// Build group from hash
					tmpFiles := []FileDetail{}
					for _, p := range paths {
						var size int64
						if fi, err := os.Stat(p); err == nil {
							size = fi.Size()
						}
						tmpFiles = append(tmpFiles, FileDetail{
							Path:   p,
							Size:   size,
							Format: strings.ToUpper(strings.TrimPrefix(filepath.Ext(p), ".")),
						})
					}
					tmpBuilder := map[string]*duplicateGroupBuilder{
						"hash-fallback": {
							title:  "",
							artist: "",
							files:  tmpFiles,
						},
					}
					extra := buildDuplicateGroups(tmpBuilder)
					if len(extra) > 0 {
						hashResult = &extra[0]
						return
					}
				}
			}
		}()
		if hashResult != nil {
			return hashResult, nil
		}
	}

	// No duplicate group found containing all provided files
	return nil, nil
}

