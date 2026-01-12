package backend

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type QualityUpgradeSuggestion struct {
	FilePath         string            `json:"file_path"`
	FileName         string            `json:"file_name"`
	FileSize         int64             `json:"file_size"`
	CurrentFormat    string            `json:"current_format"`
	Metadata         *AudioMetadata    `json:"metadata"`
	SpotifyID        string            `json:"spotify_id,omitempty"`
	SpotifyTrack     *SpotifyTrackInfo `json:"spotify_track,omitempty"`
	Availability     *TrackAvailability `json:"availability,omitempty"`
	Error            string            `json:"error,omitempty"`
	SearchQuery      string            `json:"search_query,omitempty"`
	MatchConfidence  string            `json:"match_confidence,omitempty"`
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

		searchCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		searchResults, err := SearchSpotifyByType(searchCtx, searchQuery, "track", 5, 0)
		cancel()

		if err != nil {
			suggestion.Error = fmt.Sprintf("Failed to search Spotify: %v", err)
			suggestions = append(suggestions, suggestion)
			continue
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
		_ = availabilityCtx // Context used for timeout

		if err != nil {
			suggestion.Error = fmt.Sprintf("Failed to check availability: %v", err)
		} else {
			suggestion.Availability = availability
		}

		suggestions = append(suggestions, suggestion)

		if i < len(audioFiles)-1 {
			time.Sleep(500 * time.Millisecond)
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

	for _, result := range searchResults {
		resultTitle := normalize(result.Name)
		resultArtists := normalize(result.Artists)

		titleMatch := strings.Contains(resultTitle, metadataTitle) || strings.Contains(metadataTitle, resultTitle)
		artistMatch := strings.Contains(resultArtists, metadataArtist) || strings.Contains(metadataArtist, resultArtists)

		if titleMatch && artistMatch {
			return &result
		}
	}

	for _, result := range searchResults {
		resultTitle := normalize(result.Name)

		titleMatch := strings.Contains(resultTitle, metadataTitle) || strings.Contains(metadataTitle, resultTitle)
		if titleMatch {
			return &result
		}
	}

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

	if titleExact && artistExact {
		return "high"
	}
	if titleExact && artistContains {
		return "high"
	}
	if titleContains && artistExact {
		return "medium"
	}
	if titleContains && artistContains {
		return "medium"
	}
	if titleContains || artistContains {
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
		regex    *regexp.Regexp
		titleIdx int
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

	searchCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	searchResults, err := SearchSpotifyByType(searchCtx, searchQuery, "track", 5, 0)
	cancel()

	if err != nil {
		suggestion.Error = fmt.Sprintf("Failed to search Spotify: %v", err)
		return suggestion, nil
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

