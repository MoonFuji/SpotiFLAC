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

		searchQuery := fmt.Sprintf("%s %s", metadata.Title, metadata.Artist)
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

func findBestMatch(metadata *AudioMetadata, searchResults []SearchResult) *SearchResult {
	if len(searchResults) == 0 {
		return nil
	}

	normalize := func(s string) string {
		s = strings.ToLower(s)
		s = strings.TrimSpace(s)
		return s
	}

	metadataTitle := normalize(metadata.Title)
	metadataArtist := normalize(metadata.Artist)
	metadataDuration := metadata.DurationMillis

	// First pass: exact or very close matches with duration check
	for _, result := range searchResults {
		resultTitle := normalize(result.Name)
		resultArtists := normalize(result.Artists)

		titleMatch := metadataTitle == resultTitle ||
			strings.Contains(resultTitle, metadataTitle) ||
			strings.Contains(metadataTitle, resultTitle)
		artistMatch := metadataArtist == resultArtists ||
			strings.Contains(resultArtists, metadataArtist) ||
			strings.Contains(metadataArtist, resultArtists)

		// Duration check: within 3 seconds tolerance
		durationMatch := true
		if metadataDuration > 0 && result.Duration > 0 {
			durationDiff := result.Duration - metadataDuration
			if durationDiff < 0 {
				durationDiff = -durationDiff
			}
			durationMatch = durationDiff <= 3000 // 3 seconds tolerance
		}

		if titleMatch && artistMatch && durationMatch {
			return &result
		}
	}

	// Second pass: title match with duration
	for _, result := range searchResults {
		resultTitle := normalize(result.Name)

		titleMatch := metadataTitle == resultTitle ||
			strings.Contains(resultTitle, metadataTitle) ||
			strings.Contains(metadataTitle, resultTitle)

		durationMatch := true
		if metadataDuration > 0 && result.Duration > 0 {
			durationDiff := result.Duration - metadataDuration
			if durationDiff < 0 {
				durationDiff = -durationDiff
			}
			durationMatch = durationDiff <= 5000 // 5 seconds tolerance for title-only
		}

		if titleMatch && durationMatch {
			return &result
		}
	}

	// Third pass: artist + title without duration
	for _, result := range searchResults {
		resultTitle := normalize(result.Name)
		resultArtists := normalize(result.Artists)

		titleMatch := strings.Contains(resultTitle, metadataTitle) || strings.Contains(metadataTitle, resultTitle)
		artistMatch := strings.Contains(resultArtists, metadataArtist) || strings.Contains(metadataArtist, resultArtists)

		if titleMatch && artistMatch {
			return &result
		}
	}

	// Fallback: return first result
	return &searchResults[0]
}

func calculateMatchConfidence(metadata *AudioMetadata, track *SearchResult) string {
	normalize := func(s string) string {
		s = strings.ToLower(s)
		s = strings.TrimSpace(s)
		return s
	}

	metadataTitle := normalize(metadata.Title)
	metadataArtist := normalize(metadata.Artist)
	trackTitle := normalize(track.Name)
	trackArtists := normalize(track.Artists)

	titleExact := metadataTitle == trackTitle
	titleContains := strings.Contains(trackTitle, metadataTitle) || strings.Contains(metadataTitle, trackTitle)
	artistExact := metadataArtist == trackArtists
	artistContains := strings.Contains(trackArtists, metadataArtist) || strings.Contains(metadataArtist, trackArtists)

	// Check duration match
	metadataDuration := metadata.DurationMillis
	durationClose := false
	durationExact := false

	if metadataDuration > 0 && track.Duration > 0 {
		durationDiff := track.Duration - metadataDuration
		if durationDiff < 0 {
			durationDiff = -durationDiff
		}
		durationExact = durationDiff <= 1000 // Within 1 second
		durationClose = durationDiff <= 3000 // Within 3 seconds
	}

	// High confidence: exact matches with duration confirmation
	if titleExact && artistExact && (durationExact || metadataDuration == 0) {
		return "high"
	}
	if titleExact && artistContains && durationExact {
		return "high"
	}

	// Medium confidence: good matches with duration check
	if titleContains && artistExact && durationClose {
		return "medium"
	}
	if titleExact && artistContains && (durationClose || metadataDuration == 0) {
		return "medium"
	}
	if titleContains && artistContains && durationClose {
		return "medium"
	}

	// Low confidence: weak matches
	if titleContains && artistContains {
		return "low"
	}
	if (titleContains || artistContains) && durationClose {
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

	patterns := []struct {
		regex     *regexp.Regexp
		titleIdx  int
		artistIdx int
	}{
		{regexp.MustCompile(`(?i)^(\d+)[\.\s\-]+(.+?)\s*-\s*(.+)$`), 3, 2},
		{regexp.MustCompile(`(?i)^(.+?)\s*-\s*(.+)$`), 2, 1},
		{regexp.MustCompile(`(?i)^(.+?)\s+by\s+(.+)$`), 1, 2},
		{regexp.MustCompile(`(?i)^(.+?)\s+feat\.?\s+(.+)$`), 1, 2},
		{regexp.MustCompile(`(?i)^(.+?)\s+ft\.?\s+(.+)$`), 1, 2},
		{regexp.MustCompile(`(?i)^(.+?)\s+featuring\s+(.+)$`), 1, 2},
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

	searchQuery := fmt.Sprintf("%s %s", metadata.Title, metadata.Artist)
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
