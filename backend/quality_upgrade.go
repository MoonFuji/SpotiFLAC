package backend

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

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

	suggestions := make([]QualityUpgradeSuggestion, 0, len(audioFiles))
	songLinkClient := NewSongLinkClient()

	for i, file := range audioFiles {
		select {
		case <-ctx.Done():
			return suggestions, ctx.Err()
		default:
		}

		suggestion := QualityUpgradeSuggestion{
			FilePath:      file.Path,
			FileName:      file.Name,
			FileSize:      file.Size,
			CurrentFormat: strings.ToUpper(strings.TrimPrefix(filepath.Ext(file.Path), ".")),
		}

		metadata, err := ReadAudioMetadata(file.Path)
		if err != nil {
			suggestion.Error = fmt.Sprintf("Failed to read metadata: %v", err)
			suggestions = append(suggestions, suggestion)
			continue
		}

		suggestion.Metadata = metadata

		if metadata.Title == "" || metadata.Artist == "" {
			suggestion.Error = "Missing title or artist metadata"
			suggestions = append(suggestions, suggestion)
			continue
		}

		// Clean title and artist for better search
		cleanTitle := cleanSearchString(metadata.Title)
		cleanArtist := cleanSearchString(metadata.Artist)
		
		// Build search query: prefer "artist title" format for better Spotify results
		// But if artist is unknown, try title-only search
		var searchQuery string
		if strings.EqualFold(cleanArtist, "Unknown Artist") || cleanArtist == "" {
			searchQuery = cleanTitle
		} else {
			searchQuery = fmt.Sprintf("%s %s", cleanArtist, cleanTitle)
		}
		suggestion.SearchQuery = searchQuery

		// Check cache first
		searchCacheMutex.RLock()
		searchResults, cached := spotifySearchCache[searchQuery]
		searchCacheMutex.RUnlock()

		if !cached {
			searchCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
			var err error
			searchResults, err = SearchSpotifyByType(searchCtx, searchQuery, "track", 5, 0)
			cancel()

			if err != nil {
				suggestion.Error = fmt.Sprintf("Search failed: %v", err)
				suggestions = append(suggestions, suggestion)
				continue
			}

			// Cache results
			searchCacheMutex.Lock()
			spotifySearchCache[searchQuery] = searchResults
			searchCacheMutex.Unlock()
		}

		if len(searchResults) == 0 {
			suggestion.Error = "No matching tracks found on Spotify"
			suggestions = append(suggestions, suggestion)
			continue
		}

		bestMatch := findBestMatch(metadata, searchResults)
		if bestMatch == nil {
			suggestion.Error = "No suitable match found"
			suggestions = append(suggestions, suggestion)
			continue
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

		availabilityCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		availability, err := songLinkClient.CheckTrackAvailability(bestMatch.ID, "")
		cancel()
		_ = availabilityCtx

		if err != nil {
			suggestion.Error = fmt.Sprintf("Failed to check availability: %v", err)
		} else {
			suggestion.Availability = availability
		}

		suggestions = append(suggestions, suggestion)

		if i < len(audioFiles)-1 {
			time.Sleep(300 * time.Millisecond)
		}
	}

	return suggestions, nil
}

// cleanSearchString removes junk from search strings
func cleanSearchString(s string) string {
	s = strings.TrimSpace(s)
	// Remove quality indicators and common junk
	reJunk := regexp.MustCompile(`(?i)\s*\([^)]*(?:320k?|128k?|256k?|flac|mp3|m4a|aac|ogg|opus|wav|hd|hq|official|video|lyrics?|audio|explicit|clean|version|remix|live|instrumental|prod\.?|feat\.?|ft\.?)[^)]*\)`)
	s = reJunk.ReplaceAllString(s, "")
	s = strings.TrimSpace(s)
	return s
}

// scoreMatch calculates a match score between metadata and a search result
// Higher score = better match
func scoreMatch(metadata *AudioMetadata, result *SearchResult) int {
	score := 0

	normalize := func(s string) string {
		s = strings.ToLower(s)
		s = strings.TrimSpace(s)
		// Remove common punctuation for better matching
		s = strings.ReplaceAll(s, "'", "")
		s = strings.ReplaceAll(s, "&", "and")
		return s
	}

	metadataTitle := normalize(cleanSearchString(metadata.Title))
	metadataArtist := normalize(cleanSearchString(metadata.Artist))
	resultTitle := normalize(result.Name)
	resultArtists := normalize(result.Artists)

	// Title matching (most important)
	if metadataTitle == resultTitle {
		score += 100 // Exact title match
	} else {
		// Check if title words match (better than substring)
		metadataTitleWords := strings.Fields(metadataTitle)
		resultTitleWords := strings.Fields(resultTitle)
		matchedWords := 0
		for _, word := range metadataTitleWords {
			if len(word) < 2 {
				continue // Skip very short words
			}
			for _, rWord := range resultTitleWords {
				if word == rWord {
					matchedWords++
					break
				}
			}
		}
		if len(metadataTitleWords) > 0 {
			wordMatchRatio := float64(matchedWords) / float64(len(metadataTitleWords))
			score += int(wordMatchRatio * 60) // Up to 60 points for word matching
		}

		// Substring matching (less reliable but still useful)
		if strings.Contains(resultTitle, metadataTitle) {
			score += 30
		} else if strings.Contains(metadataTitle, resultTitle) {
			score += 20
		}
	}

	// Artist matching
	if metadataArtist == resultArtists {
		score += 50 // Exact artist match
	} else {
		// Check if artist name appears in result artists
		if strings.Contains(resultArtists, metadataArtist) {
			score += 30
		} else if strings.Contains(metadataArtist, resultArtists) {
			score += 20
		} else {
			// Try word-by-word matching for artists
			metadataArtistWords := strings.Fields(metadataArtist)
			resultArtistWords := strings.Fields(resultArtists)
			for _, word := range metadataArtistWords {
				if len(word) < 2 {
					continue
				}
				for _, rWord := range resultArtistWords {
					if word == rWord {
						score += 10
						break
					}
				}
			}
		}
	}

	// Duration matching (bonus points)
	if metadata.DurationMillis > 0 && result.Duration > 0 {
		durationDiff := result.Duration - metadata.DurationMillis
		if durationDiff < 0 {
			durationDiff = -durationDiff
		}
		if durationDiff <= 1000 {
			score += 20 // Within 1 second
		} else if durationDiff <= 3000 {
			score += 10 // Within 3 seconds
		} else if durationDiff <= 5000 {
			score += 5 // Within 5 seconds
		} else if durationDiff > 10000 {
			score -= 20 // More than 10 seconds difference - likely wrong match
		}
	}

	return score
}

func findBestMatch(metadata *AudioMetadata, searchResults []SearchResult) *SearchResult {
	if len(searchResults) == 0 {
		return nil
	}

	// Score all results and find the best match
	bestScore := -1
	bestIndex := -1

	for i := range searchResults {
		score := scoreMatch(metadata, &searchResults[i])
		if score > bestScore {
			bestScore = score
			bestIndex = i
		}
	}

	// Only return a match if score is above threshold
	// This prevents returning completely unrelated tracks
	if bestIndex >= 0 && bestScore >= 30 {
		return &searchResults[bestIndex]
	}

	// If no good match found, return nil instead of random result
	return nil
}

func calculateMatchConfidence(metadata *AudioMetadata, track *SearchResult) string {
	score := scoreMatch(metadata, track)

	// Use score thresholds to determine confidence
	if score >= 120 {
		return "high"
	} else if score >= 70 {
		return "medium"
	} else if score >= 30 {
		return "low"
	}

	return "low"
}

func parseFilenameForMetadata(fileName string) *AudioMetadata {
	metadata := &AudioMetadata{}

	ext := filepath.Ext(fileName)
	nameWithoutExt := strings.TrimSuffix(fileName, ext)
	nameWithoutExt = strings.TrimSpace(nameWithoutExt)

	if nameWithoutExt == "" {
		return nil
	}

	// Remove common junk patterns first (quality indicators, years, etc.)
	reJunk := regexp.MustCompile(`(?i)\s*\([^)]*(?:320k?|128k?|256k?|flac|mp3|m4a|aac|ogg|opus|wav|hd|hq|official|video|lyrics?|audio|explicit|clean|version|remix|live|instrumental|prod\.?|feat\.?|ft\.?)[^)]*\)`)
	nameWithoutExt = reJunk.ReplaceAllString(nameWithoutExt, "")
	nameWithoutExt = strings.TrimSpace(nameWithoutExt)

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

	if metadata.Title == "" || metadata.Artist == "" {
		parsedMetadata := parseFilenameForMetadata(fileName)
		if parsedMetadata != nil {
			if metadata.Title == "" {
				metadata.Title = parsedMetadata.Title
			}
			if metadata.Artist == "" {
				metadata.Artist = parsedMetadata.Artist
			}
		}
	}

	suggestion.Metadata = metadata

	if metadata.Title == "" || metadata.Artist == "" {
		suggestion.Error = "Could not extract title or artist from filename or metadata"
		return suggestion, nil
	}

	// Clean title and artist for better search
	cleanTitle := cleanSearchString(metadata.Title)
	cleanArtist := cleanSearchString(metadata.Artist)
	
	// Build search query: prefer "artist title" format for better Spotify results
	// But if artist is unknown, try title-only search
	var searchQuery string
	if strings.EqualFold(cleanArtist, "Unknown Artist") || cleanArtist == "" {
		searchQuery = cleanTitle
	} else {
		searchQuery = fmt.Sprintf("%s %s", cleanArtist, cleanTitle)
	}
	suggestion.SearchQuery = searchQuery

	// Check cache first
	searchCacheMutex.RLock()
	searchResults, cached := spotifySearchCache[searchQuery]
	searchCacheMutex.RUnlock()

	if !cached {
		searchCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		var err error
		searchResults, err = SearchSpotifyByType(searchCtx, searchQuery, "track", 5, 0)
		cancel()

		if err != nil {
			suggestion.Error = fmt.Sprintf("Search failed: %v", err)
			return suggestion, nil
		}

		// Cache results
		searchCacheMutex.Lock()
		spotifySearchCache[searchQuery] = searchResults
		searchCacheMutex.Unlock()
	}

	if len(searchResults) == 0 {
		suggestion.Error = "No matching tracks found on Spotify"
		return suggestion, nil
	}

	bestMatch := findBestMatch(metadata, searchResults)
	if bestMatch == nil {
		suggestion.Error = "No suitable match found"
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
	Files           []string     `json:"files"`
	Title           string       `json:"title"`
	Artist          string       `json:"artist"`
	TotalSize       int64        `json:"total_size"`
	Formats         []string     `json:"formats"`
	BestQualityFile string       `json:"best_quality_file"`
	FileDetails     []FileDetail `json:"file_details"`
}

type FileDetail struct {
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	Format   string `json:"format"`
	Duration int    `json:"duration"`
}

// FindDuplicateTracks finds duplicate tracks by reading metadata in batches
// Returns duplicates as they're found to avoid memory spikes
func FindDuplicateTracks(ctx context.Context, folderPath string) ([]DuplicateGroup, error) {
	if folderPath == "" {
		return nil, fmt.Errorf("folder path is required")
	}

	audioFiles, err := ListAudioFiles(folderPath)
	if err != nil {
		return nil, fmt.Errorf("failed to list audio files: %w", err)
	}

	// Process in batches to avoid overwhelming the system
	batchSize := 20
	groups := make(map[string]*duplicateGroupBuilder)

	for i := 0; i < len(audioFiles); i += batchSize {
		select {
		case <-ctx.Done():
			return buildDuplicateGroups(groups), ctx.Err()
		default:
		}

		end := i + batchSize
		if end > len(audioFiles) {
			end = len(audioFiles)
		}

		batch := audioFiles[i:end]

		// Process batch
		for _, file := range batch {
			meta, err := ReadAudioMetadata(file.Path)
			if err != nil || meta == nil || meta.Title == "" || meta.Artist == "" {
				continue
			}

			// Create normalized key
			normalize := func(s string) string {
				s = strings.ToLower(s)
				s = strings.TrimSpace(s)
				s = strings.ReplaceAll(s, " - ", " ")
				s = strings.ReplaceAll(s, "(", "")
				s = strings.ReplaceAll(s, ")", "")
				return s
			}

			key := normalize(meta.Title) + "|" + normalize(meta.Artist)

			if _, exists := groups[key]; !exists {
				groups[key] = &duplicateGroupBuilder{
					title:  meta.Title,
					artist: meta.Artist,
					files:  []FileDetail{},
				}
			}

			info, _ := os.Stat(file.Path)
			size := int64(0)
			if info != nil {
				size = info.Size()
			}

			groups[key].files = append(groups[key].files, FileDetail{
				Path:     file.Path,
				Size:     size,
				Format:   strings.ToUpper(strings.TrimPrefix(filepath.Ext(file.Path), ".")),
				Duration: meta.DurationMillis,
			})
		}

		// Small delay between batches to reduce I/O stress
		time.Sleep(50 * time.Millisecond)
	}

	return buildDuplicateGroups(groups), nil
}

type duplicateGroupBuilder struct {
	title  string
	artist string
	files  []FileDetail
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
		bestSize := int64(0)

		filePaths := make([]string, len(builder.files))
		for i, file := range builder.files {
			filePaths[i] = file.Path
			totalSize += file.Size
			formats[file.Format] = true

			if file.Size > bestSize {
				bestSize = file.Size
				bestFile = file.Path
			}
		}

		formatList := make([]string, 0, len(formats))
		for format := range formats {
			formatList = append(formatList, format)
		}

		duplicates = append(duplicates, DuplicateGroup{
			Files:           filePaths,
			Title:           builder.title,
			Artist:          builder.artist,
			TotalSize:       totalSize,
			Formats:         formatList,
			BestQualityFile: bestFile,
			FileDetails:     builder.files,
		})
	}

	return duplicates
}

