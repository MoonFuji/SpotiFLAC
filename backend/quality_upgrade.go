package backend

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/hbollon/go-edlib"
)

const qualityUpgradeLogPrefix = "[QualityUpgrade]"

// fixEncodingIssues repairs common UTF-8 mojibake from misinterpreted Latin-1/Windows-1252.
func fixEncodingIssues(s string) string {
	if s == "" {
		return s
	}
	replacements := []struct{ bad, good string }{
		{"Ã\u0098", "Ø"}, {"Ã˜", "Ø"},
		{"Ã©", "é"}, {"Ã¨", "è"}, {"Ã ", "à"}, {"Ã¢", "â"},
		{"Ã¤", "ä"}, {"Ã¶", "ö"}, {"Ã¼", "ü"}, {"ÃŸ", "ß"},
		{"Ã±", "ñ"}, {"Ã­", "í"}, {"Ã³", "ó"}, {"Ãº", "ú"},
		{"Â ", ""},
	}
	for _, r := range replacements {
		s = strings.ReplaceAll(s, r.bad, r.good)
	}
	return strings.TrimSpace(s)
}

// Simple in-memory cache for search results
var (
	spotifySearchCache = make(map[string][]SearchResult)
	searchCacheMutex   sync.RWMutex
)

type QualityUpgradeSuggestion struct {
	FilePath        string             `json:"file_path"`
	FileName        string             `json:"file_name"`
	FileSize        int64              `json:"file_size"`
	CurrentFormat   string             `json:"current_format"`
	Metadata        *AudioMetadata     `json:"metadata"`
	SpotifyID       string             `json:"spotify_id,omitempty"`
	SpotifyTrack    *SpotifyTrackInfo  `json:"spotify_track,omitempty"`
	Availability    *TrackAvailability `json:"availability,omitempty"`
	Error           string             `json:"error,omitempty"`
	SearchQuery     string             `json:"search_query,omitempty"`
	MatchConfidence string             `json:"match_confidence,omitempty"`
}

type SpotifyTrackInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Artists     string `json:"artists"`
	AlbumName   string `json:"album_name"`
	Images      string `json:"images"`
	ExternalURL string `json:"external_url"`
	Duration    int    `json:"duration_ms"`
}

const qualityUpgradeConcurrency = 4

// processOneFileForQualityUpgrade runs the full scan logic for a single file. Safe for concurrent use.
func processOneFileForQualityUpgrade(ctx context.Context, file FileInfo, songLinkClient *SongLinkClient, fileIndex, totalFiles int) QualityUpgradeSuggestion {
	log.Printf("%s --- file %d/%d: %s", qualityUpgradeLogPrefix, fileIndex+1, totalFiles, file.Name)

	suggestion := QualityUpgradeSuggestion{
		FilePath:      file.Path,
		FileName:      file.Name,
		FileSize:      file.Size,
		CurrentFormat: strings.ToUpper(strings.TrimPrefix(filepath.Ext(file.Path), ".")),
	}

	metadata, err := ReadAudioMetadata(file.Path)
	if err != nil {
		log.Printf("%s   metadata read error: %v", qualityUpgradeLogPrefix, err)
		suggestion.Error = fmt.Sprintf("Failed to read metadata: %v", err)
		return suggestion
	}
	metadata.Title = fixEncodingIssues(metadata.Title)
	metadata.Artist = fixEncodingIssues(metadata.Artist)

	suggestion.Metadata = metadata
	log.Printf("%s   metadata: title=%q artist=%q duration_ms=%d", qualityUpgradeLogPrefix,
		metadata.Title, metadata.Artist, metadata.DurationMillis)

	if metadata.Title == "" || metadata.Artist == "" {
		parsedMetadata := parseFilenameForMetadata(file.Name)
		if parsedMetadata != nil {
			if metadata.Title == "" {
				metadata.Title = fixEncodingIssues(parsedMetadata.Title)
			}
			if metadata.Artist == "" {
				metadata.Artist = fixEncodingIssues(parsedMetadata.Artist)
			}
			log.Printf("%s   filename fallback: title=%q artist=%q", qualityUpgradeLogPrefix, metadata.Title, metadata.Artist)
		}
	}
	validateMetadataNotSwapped(metadata)
	if metadata.Title == "" && metadata.Artist == "" {
		log.Printf("%s   skip: missing title and artist", qualityUpgradeLogPrefix)
		suggestion.Error = "Missing title or artist metadata"
		return suggestion
	}

	variants := buildSearchQueryVariants(metadata, file.Name)
	log.Printf("%s   search variants (%d): %v", qualityUpgradeLogPrefix, len(variants), variants)
	if len(variants) == 0 {
		suggestion.SearchQuery = cleanSearchString(metadata.Title)
		if metadata.Artist != "" {
			suggestion.SearchQuery = fmt.Sprintf("%s %s", cleanSearchString(metadata.Artist), suggestion.SearchQuery)
		}
		suggestion.Error = "Could not build search query"
		return suggestion
	}
	suggestion.SearchQuery = variants[0]

	var bestMatch *SearchResult
	var lastErr error
	for vi, searchQuery := range variants {
		searchCacheMutex.RLock()
		searchResults, cached := spotifySearchCache[searchQuery]
		searchCacheMutex.RUnlock()
		if cached && len(searchResults) == 0 {
			log.Printf("%s   variant %d query=%q: cache had empty, treating as miss", qualityUpgradeLogPrefix, vi+1, searchQuery)
			cached = false
		}

		if !cached {
			log.Printf("%s   variant %d query=%q: calling Spotify API", qualityUpgradeLogPrefix, vi+1, searchQuery)
			searchCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
			var err error
			searchResults, err = SearchSpotifyByType(searchCtx, searchQuery, "track", 8, 0)
			cancel()
			if err != nil {
				log.Printf("%s   variant %d API error: %v", qualityUpgradeLogPrefix, vi+1, err)
				lastErr = err
				continue
			}
			log.Printf("%s   variant %d API returned %d results", qualityUpgradeLogPrefix, vi+1, len(searchResults))
		} else {
			log.Printf("%s   variant %d query=%q: cache HIT, %d results", qualityUpgradeLogPrefix, vi+1, searchQuery, len(searchResults))
		}

		if len(searchResults) == 0 {
			continue
		}
		bestMatch = findBestMatch(metadata, searchResults, qualityUpgradeLogPrefix, fmt.Sprintf("variant %d", vi+1))
		if bestMatch != nil {
			log.Printf("%s   variant %d MATCH: using %q - %q (score above threshold)", qualityUpgradeLogPrefix, vi+1, bestMatch.Name, bestMatch.Artists)
			suggestion.SearchQuery = searchQuery
			if !cached {
				searchCacheMutex.Lock()
				spotifySearchCache[searchQuery] = searchResults
				searchCacheMutex.Unlock()
				log.Printf("%s   variant %d: cached %d results for query", qualityUpgradeLogPrefix, vi+1, len(searchResults))
			}
			break
		}
		log.Printf("%s   variant %d: no match above threshold (scores logged above)", qualityUpgradeLogPrefix, vi+1)
		if cached {
			searchCacheMutex.Lock()
			delete(spotifySearchCache, searchQuery)
			searchCacheMutex.Unlock()
			log.Printf("%s   variant %d: invalidated cache for query", qualityUpgradeLogPrefix, vi+1)
		}
	}

	if bestMatch == nil {
		if lastErr != nil {
			log.Printf("%s   outcome: FAIL search error: %v", qualityUpgradeLogPrefix, lastErr)
			suggestion.Error = fmt.Sprintf("Search failed: %v", lastErr)
		} else {
			log.Printf("%s   outcome: FAIL no suitable match (all variants tried)", qualityUpgradeLogPrefix)
			suggestion.Error = "No matching tracks found on Spotify"
		}
		return suggestion
	}

	suggestion.SpotifyID = bestMatch.ID
	suggestion.SpotifyTrack = &SpotifyTrackInfo{
		ID:          bestMatch.ID,
		Name:        bestMatch.Name,
		Artists:     bestMatch.Artists,
		AlbumName:   bestMatch.AlbumName,
		Images:      bestMatch.Images,
		ExternalURL: bestMatch.ExternalURL,
		Duration:    bestMatch.Duration,
	}

	suggestion.MatchConfidence = calculateMatchConfidence(metadata, bestMatch)
	log.Printf("%s   outcome: OK matched %q - %q confidence=%s", qualityUpgradeLogPrefix, bestMatch.Name, bestMatch.Artists, suggestion.MatchConfidence)

	availabilityCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	availability, err := songLinkClient.CheckTrackAvailability(bestMatch.ID, "")
	cancel()
	_ = availabilityCtx

	if err != nil {
		suggestion.Error = fmt.Sprintf("Failed to check availability: %v", err)
	} else {
		suggestion.Availability = availability
	}

	return suggestion
}

func ScanFolderForQualityUpgrades(ctx context.Context, folderPath string) ([]QualityUpgradeSuggestion, error) {
	if folderPath == "" {
		return nil, fmt.Errorf("folder path is required")
	}

	audioFiles, err := ListAudioFiles(folderPath)
	if err != nil {
		return nil, fmt.Errorf("failed to list audio files: %w", err)
	}

	if len(audioFiles) == 0 {
		return []QualityUpgradeSuggestion{}, nil
	}

	n := len(audioFiles)
	results := make([]QualityUpgradeSuggestion, n)
	songLinkClient := NewSongLinkClient()

	concurrency := qualityUpgradeConcurrency
	if concurrency > n {
		concurrency = n
	}
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup

	for i, file := range audioFiles {
		wg.Add(1)
		sem <- struct{}{}
		go func(idx int, f FileInfo) {
			defer wg.Done()
			defer func() { <-sem }()
			results[idx] = processOneFileForQualityUpgrade(ctx, f, songLinkClient, idx, n)
		}(i, file)
	}

	wg.Wait()

	// Preserve order
	suggestions := make([]QualityUpgradeSuggestion, 0, n)
	for i := range results {
		suggestions = append(suggestions, results[i])
	}
	return suggestions, nil
}

// cleanSearchString aggressively removes bitrate, format, and junk from search strings.
func cleanSearchString(s string) string {
	if s == "" {
		return s
	}
	s = strings.TrimSpace(s)
	// Remove content in parentheses/brackets that contain quality indicators or junk
	reJunk := regexp.MustCompile(`(?i)[\(\[]([^)\]]*(?:\d{3,4}\s*[kK]?\s*(?:bps|MP3|FLAC|AAC|OGG|WAV|M4A)|official|video|lyrics?|audio|explicit|clean|HD|HQ|prod\.?|feat\.?|ft\.?|version|remix|edit|mix|live|instrumental)[^)\]]*)[\)\]]`)
	s = reJunk.ReplaceAllString(s, "")
	// Remove patterns like "( - 128K MP3" (opening paren + junk without closing)
	reJunkOpen := regexp.MustCompile(`(?i)\s*\(\s*[-–]?\s*\d{3,4}\s*[kK]?\s*(?:bps|MP3|FLAC|AAC|OGG|M4A|WAV)?\s*\)?`)
	s = reJunkOpen.ReplaceAllString(s, "")
	// Standalone bitrate/format at end or surrounded by spaces
	reBitrate := regexp.MustCompile(`(?i)\s+(?:\d{3,4}\s*[kK]?(?:bps|bps)?|MP3|FLAC|AAC|OGG|M4A|WAV)(?:\s|$)`)
	s = reBitrate.ReplaceAllString(s, " ")
	// File extensions if leaked
	reExt := regexp.MustCompile(`(?i)\.(mp3|flac|aac|ogg|m4a|wav|wma)(\s|$)`)
	s = reExt.ReplaceAllString(s, " ")
	// Years at end: (2020), [2019]
	reYear := regexp.MustCompile(`\s*[\(\[]\d{4}[\)\]]\s*$`)
	s = reYear.ReplaceAllString(s, "")
	s = regexp.MustCompile(`\s+`).ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

// containsTrackKeywords reports if s contains track-type keywords (mix, edit, remix, etc.).
func containsTrackKeywords(s string) bool {
	s = strings.ToLower(s)
	keywords := []string{"mix", "edit", "remix", "version", "radio", "extended", "original", "instrumental", "acoustic", "live", "feat.", "ft.", "unitedweare"}
	for _, kw := range keywords {
		if strings.Contains(s, kw) {
			return true
		}
	}
	return false
}

// isLikelyArtistName heuristically checks if s looks like an artist name (short, no track keywords).
func isLikelyArtistName(s string) bool {
	words := strings.Fields(s)
	if len(words) > 4 {
		return false
	}
	return !containsTrackKeywords(s)
}

// validateMetadataNotSwapped fixes artist/title when parser reversed them (e.g. "Hardwell" as title, "Eclipse (Extended Mix)..." as artist).
func validateMetadataNotSwapped(metadata *AudioMetadata) {
	if metadata.Title == "" || metadata.Artist == "" {
		return
	}
	titleLooksLikeArtist := isLikelyArtistName(metadata.Title)
	artistLooksLikeTrack := containsTrackKeywords(metadata.Artist) || len(strings.Fields(metadata.Artist)) > 4
	if titleLooksLikeArtist && artistLooksLikeTrack {
		log.Printf("%s   detected swapped artist/title, correcting: %q <-> %q", qualityUpgradeLogPrefix, metadata.Artist, metadata.Title)
		metadata.Title, metadata.Artist = metadata.Artist, metadata.Title
	}
}

// stripParentheticals removes (feat. X), (Remix), etc. for a simpler search query.
func stripParentheticals(s string) string {
	// Remove (...) and [...] content
	re := regexp.MustCompile(`\s*[\[\(][^\]\)]*[\]\)]`)
	return strings.TrimSpace(re.ReplaceAllString(s, ""))
}

// buildSearchQueryVariants returns multiple search query strings to try in order.
// This improves chances of finding the right track on Spotify when metadata varies.
func buildSearchQueryVariants(metadata *AudioMetadata, fileName string) []string {
	cleanTitle := cleanSearchString(metadata.Title)
	cleanArtist := cleanSearchString(metadata.Artist)
	if cleanTitle == "" && cleanArtist == "" {
		if parsed := parseFilenameForMetadata(fileName); parsed != nil {
			cleanTitle = cleanSearchString(parsed.Title)
			cleanArtist = cleanSearchString(parsed.Artist)
		}
	}
	if cleanTitle == "" {
		return nil
	}
	titleOnly := stripParentheticals(cleanTitle)
	artistUnknown := strings.EqualFold(cleanArtist, "Unknown Artist") || cleanArtist == ""

	var variants []string
	// Primary: "artist title" (best for Spotify)
	if !artistUnknown {
		variants = append(variants, fmt.Sprintf("%s %s", cleanArtist, cleanTitle))
		variants = append(variants, fmt.Sprintf("%s %s", cleanArtist, titleOnly))
	}
	// Title-only can work when artist is wrong or unknown
	variants = append(variants, cleanTitle)
	if titleOnly != cleanTitle {
		variants = append(variants, titleOnly)
	}
	// "title artist" sometimes matches different indexing
	if !artistUnknown {
		variants = append(variants, fmt.Sprintf("%s %s", cleanTitle, cleanArtist))
	}
	// Deduplicate while preserving order
	seen := make(map[string]bool)
	out := make([]string, 0, len(variants))
	for _, q := range variants {
		q = strings.TrimSpace(q)
		if q == "" || seen[q] {
			continue
		}
		seen[q] = true
		out = append(out, q)
	}
	return out
}

// scoreMatchPair scores title-vs-title and artist-vs-artists (used for both normal and swapped).
func scoreMatchPair(
	metaTitle, metaArtist string,
	resultTitle, resultArtists string,
	addFuzzyTitle, addFuzzyArtist bool,
	resultTitleHasExtraParenthetical bool,
) int {
	score := 0
	// Title
	if metaTitle == resultTitle {
		score += 100
	} else {
		metaWords := strings.Fields(metaTitle)
		resWords := strings.Fields(resultTitle)
		matched := 0
		for _, w := range metaWords {
			if len(w) < 2 {
				continue
			}
			for _, r := range resWords {
				if w == r {
					matched++
					break
				}
			}
		}
		if len(metaWords) > 0 {
			score += int(float64(matched) / float64(len(metaWords)) * 60)
		}
		if strings.Contains(resultTitle, metaTitle) {
			score += 30
		} else if strings.Contains(metaTitle, resultTitle) {
			score += 20
		}
		if addFuzzyTitle && metaTitle != "" && resultTitle != "" {
			sim, err := edlib.StringsSimilarity(metaTitle, resultTitle, edlib.JaroWinkler)
			if err == nil {
				fuzzyBonus := 0
				if sim >= 0.90 {
					fuzzyBonus = 55
				} else if sim >= 0.85 {
					fuzzyBonus = 45
				} else if sim >= 0.75 {
					fuzzyBonus = 30
				} else if sim >= 0.65 {
					fuzzyBonus = 15
				}
				if resultTitleHasExtraParenthetical {
					fuzzyBonus = fuzzyBonus / 2 // Prefer exact/short title over "Thunder (Ultra Slowed)"
				}
				score += fuzzyBonus
			}
		}
	}
	// Artist
	if metaArtist == resultArtists {
		score += 50
	} else {
		if strings.Contains(resultArtists, metaArtist) {
			score += 30
		} else if strings.Contains(metaArtist, resultArtists) {
			score += 20
		} else {
			for _, w := range strings.Fields(metaArtist) {
				if len(w) < 2 {
					continue
				}
				for _, r := range strings.Fields(resultArtists) {
					if w == r {
						score += 10
						break
					}
				}
			}
		}
		if addFuzzyArtist && metaArtist != "" && resultArtists != "" {
			if sim, err := edlib.StringsSimilarity(metaArtist, resultArtists, edlib.JaroWinkler); err == nil {
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

// resultTitleHasExtraParenthetical returns true when result title is longer and adds "(...)" not in metadata.
func resultTitleHasExtraParenthetical(metadataTitle, resultTitle string) bool {
	if len(resultTitle) <= len(metadataTitle)+2 {
		return false
	}
	// Result has "(Remix)", "(Slowed)", "(Ultra ...)" etc. that metadata doesn't
	return strings.Contains(resultTitle, "(") && !strings.Contains(metadataTitle, "(")
}

// scoreMatch calculates a match score between metadata and a search result.
// Uses exact, word, substring, and fuzzy matching. Also tries swapped title/artist when
// filename may have been "Artist - Title" but parsed as "Title - Artist".
// Rejects (returns -1000) if duration differs by >10% or 15s (whichever is larger).
func scoreMatch(metadata *AudioMetadata, result *SearchResult) int {
	// Hard duration filter: reject if duration differs by more than 10% or 15 seconds
	if metadata.DurationMillis > 0 && result.Duration > 0 {
		diff := metadata.DurationMillis - result.Duration
		if diff < 0 {
			diff = -diff
		}
		maxAllowedDiff := int(float64(metadata.DurationMillis) * 0.10)
		if maxAllowedDiff < 15000 {
			maxAllowedDiff = 15000
		}
		if diff > maxAllowedDiff {
			return -1000
		}
	}

	normalize := func(s string) string {
		s = strings.ToLower(s)
		s = strings.TrimSpace(s)
		s = strings.ReplaceAll(s, "'", "")
		s = strings.ReplaceAll(s, "&", "and")
		return s
	}
	metaTitle := normalize(cleanSearchString(metadata.Title))
	metaArtist := normalize(cleanSearchString(metadata.Artist))
	resTitle := normalize(result.Name)
	resArtists := normalize(result.Artists)
	extraParen := resultTitleHasExtraParenthetical(metaTitle, resTitle)

	// Normal: metadata title vs result name, metadata artist vs result artists
	score := scoreMatchPair(metaTitle, metaArtist, resTitle, resArtists, true, true, extraParen)

	// Swapped: metadata title vs result artists, metadata artist vs result name (filename "Artist - Title" parsed wrong)
	swapped := scoreMatchPair(metaTitle, metaArtist, resArtists, resTitle, true, true, false)
	if swapped > score {
		score = swapped
	}

	// Duration bonus (only when within tolerance; rejection already handled above)
	if metadata.DurationMillis > 0 && result.Duration > 0 {
		diff := result.Duration - metadata.DurationMillis
		if diff < 0 {
			diff = -diff
		}
		if diff <= 1000 {
			score += 20
		} else if diff <= 3000 {
			score += 10
		} else if diff <= 5000 {
			score += 5
		}
	}
	return score
}

const matchScoreThreshold = 30
const gapRuleMinimum = 25 // require this much gap between best and second for scores 30-70

func findBestMatch(metadata *AudioMetadata, searchResults []SearchResult, logPrefix, logContext string) *SearchResult {
	if len(searchResults) == 0 {
		return nil
	}

	type scoredResult struct {
		index  int
		score  int
		result *SearchResult
	}
	scored := make([]scoredResult, len(searchResults))
	for i := range searchResults {
		scored[i] = scoredResult{
			index:  i,
			score:  scoreMatch(metadata, &searchResults[i]),
			result: &searchResults[i],
		}
	}
	sort.Slice(scored, func(i, j int) bool { return scored[i].score > scored[j].score })

	best := scored[0]
	bestScore := best.score

	if logPrefix != "" && logContext != "" {
		for _, s := range scored {
			log.Printf("%s %s score[%d] %d: %q - %q", logPrefix, logContext, s.index, s.score, s.result.Name, s.result.Artists)
		}
	}

	if bestScore < matchScoreThreshold {
		if logPrefix != "" && logContext != "" {
			log.Printf("%s %s best: index=%d score=%d threshold=%d -> false (below threshold)", logPrefix, logContext, best.index, bestScore, matchScoreThreshold)
		}
		return nil
	}

	// Gap rule: for borderline scores (30-70), require significant gap to second place
	if bestScore < 70 && len(scored) > 1 {
		secondScore := scored[1].score
		gap := bestScore - secondScore
		if gap < gapRuleMinimum {
			if logPrefix != "" && logContext != "" {
				log.Printf("%s %s rejecting: best score %d too close to second %d (gap=%d, required=%d)", logPrefix, logContext, bestScore, secondScore, gap, gapRuleMinimum)
			}
			return nil
		}
	}

	// For low scores (30-50), require at least 50% of metadata title words appear in result title
	if bestScore >= 30 && bestScore < 50 {
		metaTitle := strings.ToLower(cleanSearchString(metadata.Title))
		resultTitle := strings.ToLower(best.result.Name)
		metaWords := strings.Fields(metaTitle)
		matchedWords := 0
		for _, w := range metaWords {
			if len(w) > 2 && strings.Contains(resultTitle, w) {
				matchedWords++
			}
		}
		var matchRatio float64
		if len(metaWords) > 0 {
			matchRatio = float64(matchedWords) / float64(len(metaWords))
		}
		if matchRatio < 0.5 {
			if logPrefix != "" && logContext != "" {
				log.Printf("%s %s rejecting: low score %d with poor title match ratio %.0f%%", logPrefix, logContext, bestScore, matchRatio*100)
			}
			return nil
		}
	}

	if logPrefix != "" && logContext != "" {
		log.Printf("%s %s best: index=%d score=%d threshold=%d -> true", logPrefix, logContext, best.index, bestScore, matchScoreThreshold)
	}
	return best.result
}

func calculateMatchConfidence(metadata *AudioMetadata, track *SearchResult) string {
	score := scoreMatch(metadata, track)

	durationAccurate := false
	if metadata.DurationMillis > 0 && track.Duration > 0 {
		diff := metadata.DurationMillis - track.Duration
		if diff < 0 {
			diff = -diff
		}
		if diff <= 2000 {
			durationAccurate = true
		}
	}

	if score >= 120 && durationAccurate {
		return "high"
	}
	if score >= 80 || (score >= 60 && durationAccurate) {
		return "medium"
	}
	if score >= matchScoreThreshold {
		return "low"
	}
	return "low"
}

var reInvalidArtist = regexp.MustCompile(`(?i)\d{3,4}\s*[kK]?\s*(?:bps|MP3|FLAC|AAC)`)

func parseFilenameForMetadata(fileName string) *AudioMetadata {
	metadata := &AudioMetadata{}

	ext := filepath.Ext(fileName)
	nameWithoutExt := strings.TrimSuffix(fileName, ext)
	nameWithoutExt = strings.TrimSpace(nameWithoutExt)
	// Aggressive clean before parsing so bitrate/format don't pollute artist/title
	nameWithoutExt = cleanSearchString(nameWithoutExt)

	if nameWithoutExt == "" {
		return nil
	}

	// Remove year patterns at the end: (2005), [2005], etc.
	reYear := regexp.MustCompile(`(?i)\s*[\(\[\{](\d{4})[\)\]\}]$`)
	nameWithoutExt = reYear.ReplaceAllString(nameWithoutExt, "")
	nameWithoutExt = strings.TrimSpace(nameWithoutExt)

	patterns := []struct {
		regex     *regexp.Regexp
		titleIdx  int
		artistIdx int
	}{
		// Pattern: "01. Title - Artist" or "01 Title - Artist"
		{regexp.MustCompile(`(?i)^(\d+)[\.\s\-]+(.+?)\s*-\s*(.+)$`), 2, 3},
		// Pattern: "Title - Artist"
		{regexp.MustCompile(`(?i)^(.+?)\s*-\s*(.+)$`), 1, 2},
		// Pattern: "Title by Artist"
		{regexp.MustCompile(`(?i)^(.+?)\s+by\s+(.+)$`), 1, 2},
		// Pattern: "Title feat. Artist" or "Title ft. Artist"
		{regexp.MustCompile(`(?i)^(.+?)\s+feat\.?\s+(.+)$`), 1, 2},
		{regexp.MustCompile(`(?i)^(.+?)\s+ft\.?\s+(.+)$`), 1, 2},
		{regexp.MustCompile(`(?i)^(.+?)\s+featuring\s+(.+)$`), 1, 2},
		// Pattern: "Title vs Artist" or "Title x Artist"
		{regexp.MustCompile(`(?i)^(.+?)\s+vs\.?\s+(.+)$`), 1, 2},
		{regexp.MustCompile(`(?i)^(.+?)\s+x\s+(.+)$`), 1, 2},
	}

	for _, pattern := range patterns {
		matches := pattern.regex.FindStringSubmatch(nameWithoutExt)
		if len(matches) > pattern.titleIdx && len(matches) > pattern.artistIdx {
			title := strings.TrimSpace(matches[pattern.titleIdx])
			artist := strings.TrimSpace(matches[pattern.artistIdx])

			title = strings.Trim(title, "()[]{}")
			artist = strings.Trim(artist, "()[]{}")

			if title != "" && artist != "" && len(title) > 1 && len(artist) > 1 {
				metadata.Title = title
				metadata.Artist = artist
				// Reject if parsed "artist" contains bitrate/format (pollution)
				if reInvalidArtist.MatchString(metadata.Artist) {
					log.Printf("%s   rejecting parsed artist %q (contains bitrate/format)", qualityUpgradeLogPrefix, metadata.Artist)
					metadata.Title = nameWithoutExt
					metadata.Artist = "Unknown Artist"
					return metadata
				}
				return metadata
			}
		}
	}

	// Try to detect "Title Artist" pattern (no separator)
	// This handles cases like "1 Thing Amerie" where artist name comes after title
	// We'll try to split on the last word(s) that could be an artist name
	// Common pattern: short title (1-3 words) followed by artist name
	words := strings.Fields(nameWithoutExt)
	if len(words) >= 3 {
		// Try splitting: first 1-2 words as title, rest as artist
		// This handles "1 Thing Amerie" -> "1 Thing" / "Amerie"
		for i := 1; i <= 2 && i < len(words); i++ {
			title := strings.Join(words[:i], " ")
			artist := strings.Join(words[i:], " ")

			// Basic validation: artist should be 1-3 words typically
			artistWords := strings.Fields(artist)
			if len(artistWords) <= 3 && len(title) > 1 && len(artist) > 1 {
				metadata.Title = strings.TrimSpace(title)
				metadata.Artist = strings.TrimSpace(artist)
				return metadata
			}
		}
	}

	// Fallback: treat entire filename as title
	if nameWithoutExt != "" {
		metadata.Title = nameWithoutExt
		metadata.Artist = "Unknown Artist"
		return metadata
	}

	return nil
}

func ScanSingleFileForQualityUpgrade(ctx context.Context, filePath string) (*QualityUpgradeSuggestion, error) {
	if filePath == "" {
		return nil, fmt.Errorf("file path is required")
	}

	log.Printf("%s [SingleFile] path=%s", qualityUpgradeLogPrefix, filePath)

	songLinkClient := NewSongLinkClient()
	fileInfo, err := os.Stat(filePath)
	if err != nil {
		return nil, fmt.Errorf("file does not exist: %w", err)
	}

	fileName := filepath.Base(filePath)
	suggestion := &QualityUpgradeSuggestion{
		FilePath:      filePath,
		FileName:      fileName,
		FileSize:      fileInfo.Size(),
		CurrentFormat: strings.ToUpper(strings.TrimPrefix(filepath.Ext(filePath), ".")),
	}

	metadata, err := ReadAudioMetadata(filePath)
	if err != nil || metadata == nil {
		metadata = &AudioMetadata{}
	}
	metadata.Title = fixEncodingIssues(metadata.Title)
	metadata.Artist = fixEncodingIssues(metadata.Artist)

	if metadata.Title == "" || metadata.Artist == "" {
		parsedMetadata := parseFilenameForMetadata(fileName)
		if parsedMetadata != nil {
			if metadata.Title == "" {
				metadata.Title = fixEncodingIssues(parsedMetadata.Title)
			}
			if metadata.Artist == "" {
				metadata.Artist = fixEncodingIssues(parsedMetadata.Artist)
			}
			log.Printf("%s [SingleFile] filename fallback: title=%q artist=%q", qualityUpgradeLogPrefix, metadata.Title, metadata.Artist)
		}
	}
	validateMetadataNotSwapped(metadata)

	suggestion.Metadata = metadata
	log.Printf("%s [SingleFile] metadata: title=%q artist=%q duration_ms=%d", qualityUpgradeLogPrefix,
		metadata.Title, metadata.Artist, metadata.DurationMillis)

	if metadata.Title == "" && metadata.Artist == "" {
		suggestion.Error = "Could not extract title or artist from filename or metadata"
		return suggestion, nil
	}

	variants := buildSearchQueryVariants(metadata, fileName)
	log.Printf("%s [SingleFile] search variants (%d): %v", qualityUpgradeLogPrefix, len(variants), variants)
	if len(variants) == 0 {
		suggestion.SearchQuery = cleanSearchString(metadata.Title)
		if metadata.Artist != "" {
			suggestion.SearchQuery = fmt.Sprintf("%s %s", cleanSearchString(metadata.Artist), suggestion.SearchQuery)
		}
		suggestion.Error = "Could not build search query"
		return suggestion, nil
	}
	suggestion.SearchQuery = variants[0]

	var bestMatch *SearchResult
	var lastErr error
	for vi, searchQuery := range variants {
		searchCacheMutex.RLock()
		searchResults, cached := spotifySearchCache[searchQuery]
		searchCacheMutex.RUnlock()
		if cached && len(searchResults) == 0 {
			log.Printf("%s [SingleFile] variant %d query=%q: cache had empty, treating as miss", qualityUpgradeLogPrefix, vi+1, searchQuery)
			cached = false
		}

		if !cached {
			log.Printf("%s [SingleFile] variant %d query=%q: calling Spotify API", qualityUpgradeLogPrefix, vi+1, searchQuery)
			searchCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
			var err error
			searchResults, err = SearchSpotifyByType(searchCtx, searchQuery, "track", 8, 0)
			cancel()
			if err != nil {
				log.Printf("%s [SingleFile] variant %d API error: %v", qualityUpgradeLogPrefix, vi+1, err)
				lastErr = err
				continue
			}
			log.Printf("%s [SingleFile] variant %d API returned %d results", qualityUpgradeLogPrefix, vi+1, len(searchResults))
		} else {
			log.Printf("%s [SingleFile] variant %d query=%q: cache HIT, %d results", qualityUpgradeLogPrefix, vi+1, searchQuery, len(searchResults))
		}

		if len(searchResults) == 0 {
			continue
		}
		bestMatch = findBestMatch(metadata, searchResults, qualityUpgradeLogPrefix, fmt.Sprintf("[SingleFile] variant %d", vi+1))
		if bestMatch != nil {
			log.Printf("%s [SingleFile] variant %d MATCH: %q - %q", qualityUpgradeLogPrefix, vi+1, bestMatch.Name, bestMatch.Artists)
			suggestion.SearchQuery = searchQuery
			if !cached {
				searchCacheMutex.Lock()
				spotifySearchCache[searchQuery] = searchResults
				searchCacheMutex.Unlock()
			}
			break
		}
		log.Printf("%s [SingleFile] variant %d: no match above threshold", qualityUpgradeLogPrefix, vi+1)
		if cached {
			searchCacheMutex.Lock()
			delete(spotifySearchCache, searchQuery)
			searchCacheMutex.Unlock()
		}
	}

	if bestMatch == nil {
		if lastErr != nil {
			log.Printf("%s [SingleFile] outcome: FAIL search error: %v", qualityUpgradeLogPrefix, lastErr)
			suggestion.Error = fmt.Sprintf("Search failed: %v", lastErr)
		} else {
			log.Printf("%s [SingleFile] outcome: FAIL no suitable match", qualityUpgradeLogPrefix)
			suggestion.Error = "No matching tracks found on Spotify"
		}
		return suggestion, nil
	}

	suggestion.SpotifyID = bestMatch.ID
	suggestion.SpotifyTrack = &SpotifyTrackInfo{
		ID:          bestMatch.ID,
		Name:        bestMatch.Name,
		Artists:     bestMatch.Artists,
		AlbumName:   bestMatch.AlbumName,
		Images:      bestMatch.Images,
		ExternalURL: bestMatch.ExternalURL,
		Duration:    bestMatch.Duration,
	}

	suggestion.MatchConfidence = calculateMatchConfidence(metadata, bestMatch)
	log.Printf("%s [SingleFile] outcome: OK matched %q - %q confidence=%s", qualityUpgradeLogPrefix, bestMatch.Name, bestMatch.Artists, suggestion.MatchConfidence)

	availabilityCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	availability, err := songLinkClient.CheckTrackAvailability(bestMatch.ID, "")
	cancel()
	_ = availabilityCtx

	if err != nil {
		suggestion.Error = fmt.Sprintf("Failed to check availability: %v", err)
	} else {
		suggestion.Availability = availability
	}

	return suggestion, nil
}

type DuplicateGroup struct {
	Files                  []string     `json:"files"`
	Title                  string       `json:"title"`
	Artist                 string       `json:"artist"`
	TotalSize              int64        `json:"total_size"`
	Formats                []string     `json:"formats"`
	BestQualityFile        string       `json:"best_quality_file"`
	BestQualityReason      string       `json:"best_quality_reason"`
	LosslessCount          int          `json:"lossless_count"`
	LossyCount             int          `json:"lossy_count"`
	AvgBitrate             int          `json:"avg_bitrate"`
	RepresentativeDuration int          `json:"representative_duration"`
	FileDetails            []FileDetail `json:"file_details"`
}

type FileDetail struct {
	Path       string `json:"path"`
	Size       int64  `json:"size"`
	Format     string `json:"format"`
	Duration   int    `json:"duration"`
	Bitrate    int    `json:"bitrate"`
	SampleRate int    `json:"sample_rate"`
	BitDepth   int    `json:"bit_depth"`
	Channels   int    `json:"channels"`
	Codec      string `json:"codec"`
	Lossless   bool   `json:"lossless"`
}

// FindDuplicateTracks finds duplicate tracks by reading metadata in batches
// Returns duplicates as they're found to avoid memory spikes
func FindDuplicateTracks(ctx context.Context, folderPath string) ([]DuplicateGroup, error) {
	// Use advanced scanner with sensible defaults for better accuracy and performance
	opts := DuplicateScanOptions{
		UseHash:             true,
		UseFilenameFallback: true,
		DurationToleranceMs: 2000,
		WorkerCount:         0,
	}
	return FindDuplicateTracksAdvanced(ctx, folderPath, opts)
}

type duplicateGroupBuilder struct {
	title  string
	artist string
	files  []FileDetail
}

// duplicateMatchScoreThreshold: merge groups when ScoreDuplicatePair >= this (quality-upgrade-style scoring).
// Lower = more groups merged (more potential dupes shown). 40 allows moderate fuzzy matches without being noisy.
const duplicateMatchScoreThreshold = 40

// mergeSimilarGroups merges duplicate groups that are similar but not exactly matching
// using fuzzy string matching. When ignoreDuration is true, duration is not used when
// deciding to merge (same song from different sources, e.g. old MP3 + new FLAC).
func mergeSimilarGroups(duplicates []DuplicateGroup, similarityThreshold float32, ignoreDuration bool) []DuplicateGroup {
	if len(duplicates) <= 1 {
		return duplicates
	}

	merged := make([]DuplicateGroup, 0)
	mergedIndices := make(map[int]bool)

	for i := 0; i < len(duplicates); i++ {
		if mergedIndices[i] {
			continue
		}

		currentGroup := duplicates[i]
		mergedGroup := currentGroup

		// Compare with all remaining groups
		for j := i + 1; j < len(duplicates); j++ {
			if mergedIndices[j] {
				continue
			}

			otherGroup := duplicates[j]

			// Exact match on normalized core key (title + primary artist) merges regardless of raw similarity
			currentCoreKey := coreTitleForGrouping(currentGroup.Title) + "|" + primaryArtistForGrouping(currentGroup.Artist)
			otherCoreKey := coreTitleForGrouping(otherGroup.Title) + "|" + primaryArtistForGrouping(otherGroup.Artist)
			shouldMerge := currentCoreKey != "" && otherCoreKey != "" && currentCoreKey == otherCoreKey

			if !shouldMerge {
				// Quality-upgrade-style scoring: word overlap, substring, fuzzy Jaro-Winkler tiers, swapped title/artist
				pairScore, durationOK := ScoreDuplicatePair(
					currentGroup.Title, currentGroup.Artist, currentGroup.RepresentativeDuration,
					otherGroup.Title, otherGroup.Artist, otherGroup.RepresentativeDuration,
				)
				if ignoreDuration {
					durationOK = true
				}
				if pairScore >= duplicateMatchScoreThreshold && durationOK {
					shouldMerge = true
				}
			}

			if !shouldMerge {
				// Fallback: Jaro-Winkler on combined title+artist (and per-field)
				currentKey := strings.ToLower(strings.TrimSpace(currentGroup.Title + " " + currentGroup.Artist))
				otherKey := strings.ToLower(strings.TrimSpace(otherGroup.Title + " " + otherGroup.Artist))
				similarity, err := edlib.StringsSimilarity(currentKey, otherKey, edlib.JaroWinkler)
				if err != nil {
					continue
				}
				titleSim, _ := edlib.StringsSimilarity(
					strings.ToLower(strings.TrimSpace(currentGroup.Title)),
					strings.ToLower(strings.TrimSpace(otherGroup.Title)),
					edlib.JaroWinkler,
				)
				artistSim, _ := edlib.StringsSimilarity(
					strings.ToLower(strings.TrimSpace(currentGroup.Artist)),
					strings.ToLower(strings.TrimSpace(otherGroup.Artist)),
					edlib.JaroWinkler,
				)
				combinedSim := (titleSim*0.6 + artistSim*0.4)
				if combinedSim < similarity {
					combinedSim = similarity
				}
				durationOK := true
				if !ignoreDuration {
					d1, d2 := currentGroup.RepresentativeDuration, otherGroup.RepresentativeDuration
					if d1 > 0 && d2 > 0 {
						diff := d1 - d2
						if diff < 0 {
							diff = -diff
						}
						maxAllowed := int(float64(d1) * 0.15)
						if d2 > d1 {
							maxAllowed = int(float64(d2) * 0.15)
						}
						if maxAllowed < 20000 {
							maxAllowed = 20000
						}
						durationOK = diff <= maxAllowed
					}
				}
				shouldMerge = combinedSim >= similarityThreshold && durationOK
			}

			// Merge if core key matched or similarity is above threshold
			if shouldMerge {
				// Merge the groups
				mergedGroup.Files = append(mergedGroup.Files, otherGroup.Files...)
				mergedGroup.TotalSize += otherGroup.TotalSize

				// Merge formats
				formatMap := make(map[string]bool)
				for _, f := range mergedGroup.Formats {
					formatMap[f] = true
				}
				for _, f := range otherGroup.Formats {
					formatMap[f] = true
				}
				mergedGroup.Formats = make([]string, 0, len(formatMap))
				for f := range formatMap {
					mergedGroup.Formats = append(mergedGroup.Formats, f)
				}

				// Merge file details
				mergedGroup.FileDetails = append(mergedGroup.FileDetails, otherGroup.FileDetails...)

				// Recalculate best quality file
				bestScore := -1
				bestFile := ""
				bestReason := ""
				for _, detail := range mergedGroup.FileDetails {
					score := 0
					if detail.Lossless {
						score += 1000000
					}
					score += detail.BitDepth * 10000
					score += detail.SampleRate / 10
					score += detail.Bitrate / 1000
					score += int(detail.Size / (1024 * 1024))

					if score > bestScore {
						bestScore = score
						bestFile = detail.Path
						reasonParts := []string{}
						if detail.Lossless {
							reasonParts = append(reasonParts, "lossless")
						} else if detail.Bitrate > 0 {
							reasonParts = append(reasonParts, fmt.Sprintf("%dkbps", detail.Bitrate/1000))
						}
						if detail.SampleRate > 0 {
							reasonParts = append(reasonParts, fmt.Sprintf("%dHz", detail.SampleRate))
						}
						if detail.BitDepth > 0 {
							reasonParts = append(reasonParts, fmt.Sprintf("%dbit", detail.BitDepth))
						}
						if detail.Codec != "" {
							reasonParts = append(reasonParts, strings.ToUpper(detail.Codec))
						}
						bestReason = strings.Join(reasonParts, " • ")
					}
				}
				mergedGroup.BestQualityFile = bestFile
				mergedGroup.BestQualityReason = bestReason

				// Update counts
				mergedGroup.LosslessCount += otherGroup.LosslessCount
				mergedGroup.LossyCount += otherGroup.LossyCount

				// Recalculate average bitrate
				bitrateSum := 0
				bitrateCount := 0
				for _, detail := range mergedGroup.FileDetails {
					if detail.Bitrate > 0 {
						bitrateSum += detail.Bitrate
						bitrateCount++
					}
				}
				if bitrateCount > 0 {
					mergedGroup.AvgBitrate = bitrateSum / bitrateCount
				}

				// Use the longer duration as representative
				if otherGroup.RepresentativeDuration > mergedGroup.RepresentativeDuration {
					mergedGroup.RepresentativeDuration = otherGroup.RepresentativeDuration
				}

				// Prefer the more complete title/artist (longer or more specific)
				if len(otherGroup.Title) > len(mergedGroup.Title) && otherGroup.Title != "" {
					mergedGroup.Title = otherGroup.Title
				}
				if len(otherGroup.Artist) > len(mergedGroup.Artist) && otherGroup.Artist != "" {
					mergedGroup.Artist = otherGroup.Artist
				}

				mergedIndices[j] = true
			}
		}

		merged = append(merged, mergedGroup)
		mergedIndices[i] = true
	}

	return merged
}

func buildDuplicateGroups(groups map[string]*duplicateGroupBuilder) []DuplicateGroup {
	var duplicates []DuplicateGroup

	for _, builder := range groups {
		if len(builder.files) < 2 {
			continue
		}

		var totalSize int64
		formats := make(map[string]bool)
		bestFile := ""
		bestReason := ""
		bestScore := -1
		losslessCount := 0
		lossyCount := 0
		bitrateSum := 0
		bitrateCount := 0
		representativeDuration := 0

		filePaths := make([]string, len(builder.files))
		for i, file := range builder.files {
			filePaths[i] = file.Path
			totalSize += file.Size
			formats[file.Format] = true

			if file.Lossless {
				losslessCount++
			} else {
				lossyCount++
			}

			if file.Bitrate > 0 {
				bitrateSum += file.Bitrate
				bitrateCount++
			}

			if representativeDuration == 0 && file.Duration > 0 {
				representativeDuration = file.Duration
			}

			score := 0
			if file.Lossless {
				score += 1000000
			}
			score += file.BitDepth * 10000
			score += file.SampleRate / 10
			score += file.Bitrate / 1000
			score += int(file.Size / (1024 * 1024))

			if score > bestScore {
				bestScore = score
				bestFile = file.Path

				reasonParts := []string{}
				if file.Lossless {
					reasonParts = append(reasonParts, "lossless")
				} else if file.Bitrate > 0 {
					reasonParts = append(reasonParts, fmt.Sprintf("%dkbps", file.Bitrate/1000))
				}
				if file.SampleRate > 0 {
					reasonParts = append(reasonParts, fmt.Sprintf("%dHz", file.SampleRate))
				}
				if file.BitDepth > 0 {
					reasonParts = append(reasonParts, fmt.Sprintf("%dbit", file.BitDepth))
				}
				if file.Codec != "" {
					reasonParts = append(reasonParts, strings.ToUpper(file.Codec))
				}
				bestReason = strings.Join(reasonParts, " • ")
			}
		}

		formatList := make([]string, 0, len(formats))
		for format := range formats {
			formatList = append(formatList, format)
		}

		avgBitrate := 0
		if bitrateCount > 0 {
			avgBitrate = bitrateSum / bitrateCount
		}

		duplicates = append(duplicates, DuplicateGroup{
			Files:                  filePaths,
			Title:                  builder.title,
			Artist:                 builder.artist,
			TotalSize:              totalSize,
			Formats:                formatList,
			BestQualityFile:        bestFile,
			BestQualityReason:      bestReason,
			LosslessCount:          losslessCount,
			LossyCount:             lossyCount,
			AvgBitrate:             avgBitrate,
			RepresentativeDuration: representativeDuration,
			FileDetails:            builder.files,
		})
	}

	return duplicates
}

// CheckDuplicateGroup checks if a specific set of files still contains duplicates
// This is useful for validating after a file deletion
func CheckDuplicateGroup(ctx context.Context, filePaths []string) (*DuplicateGroup, error) {
	if len(filePaths) == 0 {
		return nil, fmt.Errorf("no file paths provided")
	}

	// Delegate to the advanced check implementation with conservative defaults.
	// This keeps the public API unchanged while benefiting from caching,
	// filename fallback and optional hash-based validation.
	opts := DuplicateScanOptions{
		UseHash:             true,
		UseFilenameFallback: true,
		DurationToleranceMs: 2000,
		WorkerCount:         0,
	}

	return CheckDuplicateGroupAdvanced(ctx, filePaths, opts)
}
