package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"spotiflac/backend"
	"strings"
	"time"
)

type App struct {
	ctx context.Context
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

type SpotifyMetadataRequest struct {
	URL     string  `json:"url"`
	Batch   bool    `json:"batch"`
	Delay   float64 `json:"delay"`
	Timeout float64 `json:"timeout"`
}

type DownloadRequest struct {
	ISRC                 string `json:"isrc"`
	Service              string `json:"service"`
	Query                string `json:"query,omitempty"`
	TrackName            string `json:"track_name,omitempty"`
	ArtistName           string `json:"artist_name,omitempty"`
	AlbumName            string `json:"album_name,omitempty"`
	AlbumArtist          string `json:"album_artist,omitempty"`
	ReleaseDate          string `json:"release_date,omitempty"`
	CoverURL             string `json:"cover_url,omitempty"`
	ApiURL               string `json:"api_url,omitempty"`
	OutputDir            string `json:"output_dir,omitempty"`
	AudioFormat          string `json:"audio_format,omitempty"`
	FilenameFormat       string `json:"filename_format,omitempty"`
	TrackNumber          bool   `json:"track_number,omitempty"`
	Position             int    `json:"position,omitempty"`
	UseAlbumTrackNumber  bool   `json:"use_album_track_number,omitempty"`
	SpotifyID            string `json:"spotify_id,omitempty"`
	EmbedLyrics          bool   `json:"embed_lyrics,omitempty"`
	EmbedMaxQualityCover bool   `json:"embed_max_quality_cover,omitempty"`
	ServiceURL           string `json:"service_url,omitempty"`
	Duration             int    `json:"duration,omitempty"`
	ItemID               string `json:"item_id,omitempty"`
	SpotifyTrackNumber   int    `json:"spotify_track_number,omitempty"`
	SpotifyDiscNumber    int    `json:"spotify_disc_number,omitempty"`
	SpotifyTotalTracks   int    `json:"spotify_total_tracks,omitempty"`
	SpotifyTotalDiscs    int    `json:"spotify_total_discs,omitempty"`
	Copyright            string `json:"copyright,omitempty"`
	Publisher            string `json:"publisher,omitempty"`
}

type DownloadResponse struct {
	Success       bool   `json:"success"`
	Message       string `json:"message"`
	File          string `json:"file,omitempty"`
	Error         string `json:"error,omitempty"`
	AlreadyExists bool   `json:"already_exists,omitempty"`
	ItemID        string `json:"item_id,omitempty"`
}

func isValidISRC(isrc string) bool {
	if len(isrc) != 12 {
		return false
	}
	for _, ch := range isrc {
		if (ch < 'A' || ch > 'Z') && (ch < '0' || ch > '9') {
			return false
		}
	}
	return true
}

func (a *App) GetStreamingURLs(spotifyTrackID string) (result string, err error) {
	// Recover from any panics to prevent app crash
	defer func() {
		if r := recover(); r != nil {
			fmt.Printf("PANIC in GetStreamingURLs: %v\n", r)
			result = ""
			err = fmt.Errorf("streaming URLs lookup crashed: %v", r)
		}
	}()

	if spotifyTrackID == "" {
		return "", fmt.Errorf("spotify track ID is required")
	}

	fmt.Printf("[GetStreamingURLs] Called for track ID: %s\n", spotifyTrackID)
	client := backend.NewSongLinkClient()
	urls, err := client.GetAllURLsFromSpotify(spotifyTrackID)
	if err != nil {
		return "", err
	}

	jsonData, err := json.Marshal(urls)
	if err != nil {
		return "", fmt.Errorf("failed to encode response: %v", err)
	}

	return string(jsonData), nil
}

// GetAlternativeSpotifyTrackIDs searches Spotify for other releases/versions of the same track
// (e.g. different album, reissue) and returns their track IDs, excluding the given ID.
// Used when the primary track fails on all services so we can try another version.
func (a *App) GetAlternativeSpotifyTrackIDs(trackName, artistName, excludeSpotifyID string, limit int) (string, error) {
	fmt.Printf("[GetAlternativeSpotifyTrackIDs] Called (track=%q artist=%q exclude=%s)\n", trackName, artistName, excludeSpotifyID)
	if trackName == "" && artistName == "" {
		return "[]", nil
	}
	if limit <= 0 || limit > 20 {
		limit = 10
	}
	fmt.Printf("[GetAlternativeSpotifyTrackIDs] Searching other Spotify versions...\n")

	query := strings.TrimSpace(artistName + " " + trackName)
	if query == "" {
		query = trackName
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	results, err := backend.SearchSpotifyByType(ctx, query, "track", limit*2, 0)
	if err != nil {
		return "", fmt.Errorf("search failed: %w", err)
	}

	excludeLower := strings.ToLower(strings.TrimSpace(excludeSpotifyID))
	ids := make([]string, 0, limit)
	for _, r := range results {
		id := strings.TrimSpace(r.ID)
		if id == "" {
			continue
		}
		if excludeLower != "" && strings.ToLower(id) == excludeLower {
			continue
		}
		ids = append(ids, id)
		if len(ids) >= limit {
			break
		}
	}

	jsonData, err := json.Marshal(ids)
	if err != nil {
		return "[]", nil
	}
	fmt.Printf("[GetAlternativeSpotifyTrackIDs] Found %d other version(s), trying each...\n", len(ids))
	return string(jsonData), nil
}

func (a *App) GetSpotifyMetadata(req SpotifyMetadataRequest) (string, error) {
	if req.URL == "" {
		return "", fmt.Errorf("URL parameter is required")
	}

	if req.Delay == 0 {
		req.Delay = 1.0
	}
	if req.Timeout == 0 {
		req.Timeout = 300.0
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(req.Timeout*float64(time.Second)))
	defer cancel()

	data, err := backend.GetFilteredSpotifyData(ctx, req.URL, req.Batch, time.Duration(req.Delay*float64(time.Second)))
	if err != nil {
		return "", fmt.Errorf("failed to fetch metadata: %v", err)
	}

	jsonData, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return "", fmt.Errorf("failed to encode response: %v", err)
	}

	return string(jsonData), nil
}

type SpotifySearchRequest struct {
	Query string `json:"query"`
	Limit int    `json:"limit"`
}

func (a *App) SearchSpotify(req SpotifySearchRequest) (*backend.SearchResponse, error) {
	if req.Query == "" {
		return nil, fmt.Errorf("search query is required")
	}

	if req.Limit <= 0 {
		req.Limit = 10
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	return backend.SearchSpotify(ctx, req.Query, req.Limit)
}

type SpotifySearchByTypeRequest struct {
	Query      string `json:"query"`
	SearchType string `json:"search_type"`
	Limit      int    `json:"limit"`
	Offset     int    `json:"offset"`
}

func (a *App) SearchSpotifyByType(req SpotifySearchByTypeRequest) ([]backend.SearchResult, error) {
	if req.Query == "" {
		return nil, fmt.Errorf("search query is required")
	}

	if req.SearchType == "" {
		return nil, fmt.Errorf("search type is required")
	}

	if req.Limit <= 0 {
		req.Limit = 50
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	return backend.SearchSpotifyByType(ctx, req.Query, req.SearchType, req.Limit, req.Offset)
}

func (a *App) DownloadTrack(req DownloadRequest) (response DownloadResponse, err error) {
	// Recover from any panics to prevent app crash
	defer func() {
		if r := recover(); r != nil {
			fmt.Printf("PANIC in DownloadTrack: %v\n", r)
			response = DownloadResponse{
				Success: false,
				Error:   fmt.Sprintf("Download crashed: %v", r),
			}
			err = fmt.Errorf("download panic: %v", r)
		}
	}()

	if req.Service == "qobuz" {
		if req.ISRC != "" && !isValidISRC(strings.ToUpper(req.ISRC)) {
			fmt.Printf("Invalid ISRC provided for Qobuz, falling back to Deezer lookup: %s\n", req.ISRC)
			req.ISRC = ""
		} else if req.ISRC != "" {
			req.ISRC = strings.ToUpper(req.ISRC)
		}

		if req.ISRC == "" && req.SpotifyID == "" {
			return DownloadResponse{
				Success: false,
				Error:   "Spotify ID is required for Qobuz",
			}, fmt.Errorf("spotify ID is required for Qobuz")
		}
	}

	if req.Service == "" {
		req.Service = "tidal"
	}

	if req.OutputDir == "" {
		req.OutputDir = "."
	} else {

		req.OutputDir = backend.NormalizePath(req.OutputDir)
	}

	if req.AudioFormat == "" {
		req.AudioFormat = "LOSSLESS"
	}

	var filename string

	if req.FilenameFormat == "" {
		req.FilenameFormat = "title-artist"
	}

	itemID := req.ItemID
	if itemID == "" {

		if req.SpotifyID != "" {
			itemID = fmt.Sprintf("%s-%d", req.SpotifyID, time.Now().UnixNano())
		} else {
			itemID = fmt.Sprintf("%s-%s-%d", req.TrackName, req.ArtistName, time.Now().UnixNano())
		}

		backend.AddToQueue(itemID, req.TrackName, req.ArtistName, req.AlbumName, req.SpotifyID)
	}

	backend.SetDownloading(true)
	backend.StartDownloadItem(itemID)
	defer backend.SetDownloading(false)

	spotifyURL := ""
	if req.SpotifyID != "" {
		spotifyURL = fmt.Sprintf("https://open.spotify.com/track/%s", req.SpotifyID)
	}

	if req.SpotifyID != "" && (req.Copyright == "" || req.Publisher == "" || req.SpotifyTotalDiscs == 0 || req.ReleaseDate == "" || req.SpotifyTotalTracks == 0 || req.SpotifyTrackNumber == 0) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		trackURL := fmt.Sprintf("https://open.spotify.com/track/%s", req.SpotifyID)
		trackData, err := backend.GetFilteredSpotifyData(ctx, trackURL, false, 0)
		if err == nil {

			var trackResp struct {
				Track struct {
					Copyright   string `json:"copyright"`
					Publisher   string `json:"publisher"`
					TotalDiscs  int    `json:"total_discs"`
					TotalTracks int    `json:"total_tracks"`
					TrackNumber int    `json:"track_number"`
					ReleaseDate string `json:"release_date"`
				} `json:"track"`
			}
			if jsonData, jsonErr := json.Marshal(trackData); jsonErr == nil {
				if json.Unmarshal(jsonData, &trackResp) == nil {

					if req.Copyright == "" && trackResp.Track.Copyright != "" {
						req.Copyright = trackResp.Track.Copyright
					}
					if req.Publisher == "" && trackResp.Track.Publisher != "" {
						req.Publisher = trackResp.Track.Publisher
					}
					if req.SpotifyTotalDiscs == 0 && trackResp.Track.TotalDiscs > 0 {
						req.SpotifyTotalDiscs = trackResp.Track.TotalDiscs
					}
					if req.SpotifyTotalTracks == 0 && trackResp.Track.TotalTracks > 0 {
						req.SpotifyTotalTracks = trackResp.Track.TotalTracks
					}
					if req.SpotifyTrackNumber == 0 && trackResp.Track.TrackNumber > 0 {
						req.SpotifyTrackNumber = trackResp.Track.TrackNumber
					}
					if req.ReleaseDate == "" && trackResp.Track.ReleaseDate != "" {
						req.ReleaseDate = trackResp.Track.ReleaseDate
					}
				}
			}
		}
	}

	if req.TrackName != "" && req.ArtistName != "" {
		expectedFilename := backend.BuildExpectedFilename(req.TrackName, req.ArtistName, req.AlbumName, req.AlbumArtist, req.ReleaseDate, req.FilenameFormat, req.TrackNumber, req.Position, req.SpotifyDiscNumber, req.UseAlbumTrackNumber)
		expectedPath := filepath.Join(req.OutputDir, expectedFilename)

		if fileInfo, err := os.Stat(expectedPath); err == nil && fileInfo.Size() > 100*1024 {

			backend.SkipDownloadItem(itemID, expectedPath)
			return DownloadResponse{
				Success:       true,
				Message:       "File already exists",
				File:          expectedPath,
				AlreadyExists: true,
				ItemID:        itemID,
			}, nil
		}
	}

	switch req.Service {
	case "amazon":
		downloader := backend.NewAmazonDownloader()
		if req.ServiceURL != "" {

			filename, err = downloader.DownloadByURL(req.ServiceURL, req.OutputDir, req.FilenameFormat, req.TrackNumber, req.Position, req.TrackName, req.ArtistName, req.AlbumName, req.AlbumArtist, req.ReleaseDate, req.CoverURL, req.SpotifyTrackNumber, req.SpotifyDiscNumber, req.SpotifyTotalTracks, req.EmbedMaxQualityCover, req.SpotifyTotalDiscs, req.Copyright, req.Publisher, spotifyURL)
		} else {
			if req.SpotifyID == "" {
				return DownloadResponse{
					Success: false,
					Error:   "Spotify ID is required for Amazon Music",
				}, fmt.Errorf("spotify ID is required for Amazon Music")
			}
			filename, err = downloader.DownloadBySpotifyID(req.SpotifyID, req.OutputDir, req.FilenameFormat, req.TrackNumber, req.Position, req.TrackName, req.ArtistName, req.AlbumName, req.AlbumArtist, req.ReleaseDate, req.CoverURL, req.SpotifyTrackNumber, req.SpotifyDiscNumber, req.SpotifyTotalTracks, req.EmbedMaxQualityCover, req.SpotifyTotalDiscs, req.Copyright, req.Publisher, spotifyURL)
		}

	case "tidal":
		if req.ApiURL == "" || req.ApiURL == "auto" {
			downloader := backend.NewTidalDownloader("")
			if req.ServiceURL != "" {

				filename, err = downloader.DownloadByURLWithFallback(req.ServiceURL, req.OutputDir, req.AudioFormat, req.FilenameFormat, req.TrackNumber, req.Position, req.TrackName, req.ArtistName, req.AlbumName, req.AlbumArtist, req.ReleaseDate, req.UseAlbumTrackNumber, req.CoverURL, req.EmbedMaxQualityCover, req.SpotifyTrackNumber, req.SpotifyDiscNumber, req.SpotifyTotalTracks, req.SpotifyTotalDiscs, req.Copyright, req.Publisher, spotifyURL)
			} else {
				if req.SpotifyID == "" {
					return DownloadResponse{
						Success: false,
						Error:   "Spotify ID is required for Tidal",
					}, fmt.Errorf("spotify ID is required for Tidal")
				}

				filename, err = downloader.Download(req.SpotifyID, req.OutputDir, req.AudioFormat, req.FilenameFormat, req.TrackNumber, req.Position, req.TrackName, req.ArtistName, req.AlbumName, req.AlbumArtist, req.ReleaseDate, req.UseAlbumTrackNumber, req.CoverURL, req.EmbedMaxQualityCover, req.SpotifyTrackNumber, req.SpotifyDiscNumber, req.SpotifyTotalTracks, req.SpotifyTotalDiscs, req.Copyright, req.Publisher, spotifyURL)
			}
		} else {
			downloader := backend.NewTidalDownloader(req.ApiURL)
			if req.ServiceURL != "" {

				filename, err = downloader.DownloadByURL(req.ServiceURL, req.OutputDir, req.AudioFormat, req.FilenameFormat, req.TrackNumber, req.Position, req.TrackName, req.ArtistName, req.AlbumName, req.AlbumArtist, req.ReleaseDate, req.UseAlbumTrackNumber, req.CoverURL, req.EmbedMaxQualityCover, req.SpotifyTrackNumber, req.SpotifyDiscNumber, req.SpotifyTotalTracks, req.SpotifyTotalDiscs, req.Copyright, req.Publisher, spotifyURL)
			} else {
				if req.SpotifyID == "" {
					return DownloadResponse{
						Success: false,
						Error:   "Spotify ID is required for Tidal",
					}, fmt.Errorf("spotify ID is required for Tidal")
				}

				filename, err = downloader.Download(req.SpotifyID, req.OutputDir, req.AudioFormat, req.FilenameFormat, req.TrackNumber, req.Position, req.TrackName, req.ArtistName, req.AlbumName, req.AlbumArtist, req.ReleaseDate, req.UseAlbumTrackNumber, req.CoverURL, req.EmbedMaxQualityCover, req.SpotifyTrackNumber, req.SpotifyDiscNumber, req.SpotifyTotalTracks, req.SpotifyTotalDiscs, req.Copyright, req.Publisher, spotifyURL)
			}
		}

	case "qobuz":
		downloader := backend.NewQobuzDownloader()

		quality := req.AudioFormat
		if quality == "" {
			quality = "6"
		}

		deezerISRC := req.ISRC
		if deezerISRC == "" && req.SpotifyID != "" {

			songlinkClient := backend.NewSongLinkClient()
			deezerURL, err := songlinkClient.GetDeezerURLFromSpotify(req.SpotifyID)
			if err != nil {
				return DownloadResponse{
					Success: false,
					Error:   fmt.Sprintf("Failed to get Deezer URL: %v", err),
				}, err
			}
			deezerISRC, err = backend.GetDeezerISRC(deezerURL)
			if err != nil {
				return DownloadResponse{
					Success: false,
					Error:   fmt.Sprintf("Failed to get ISRC from Deezer: %v", err),
				}, err
			}
		}
		if deezerISRC == "" {
			return DownloadResponse{
				Success: false,
				Error:   "ISRC is required for Qobuz (could not fetch from Deezer)",
			}, fmt.Errorf("ISRC is required for Qobuz")
		}
		filename, err = downloader.DownloadByISRC(deezerISRC, req.OutputDir, quality, req.FilenameFormat, req.TrackNumber, req.Position, req.TrackName, req.ArtistName, req.AlbumName, req.AlbumArtist, req.ReleaseDate, req.UseAlbumTrackNumber, req.CoverURL, req.EmbedMaxQualityCover, req.SpotifyTrackNumber, req.SpotifyDiscNumber, req.SpotifyTotalTracks, req.SpotifyTotalDiscs, req.Copyright, req.Publisher, spotifyURL)

	default:
		return DownloadResponse{
			Success: false,
			Error:   fmt.Sprintf("Unknown service: %s", req.Service),
		}, fmt.Errorf("unknown service: %s", req.Service)
	}

	if err != nil {
		errMsg := fmt.Sprintf("Download failed: %v", err)
		fmt.Printf("DownloadTrack error: %v\n", err)

		if filename != "" && !strings.HasPrefix(filename, "EXISTS:") {

			if _, statErr := os.Stat(filename); statErr == nil {
				fmt.Printf("Removing corrupted/partial file after failed download: %s\n", filename)
				if removeErr := os.Remove(filename); removeErr != nil {
					fmt.Printf("Warning: Failed to remove corrupted file %s: %v\n", filename, removeErr)
				}
			}
		}

		return DownloadResponse{
			Success: false,
			Error:   errMsg,
			ItemID:  itemID,
		}, err
	}

	alreadyExists := false
	if strings.HasPrefix(filename, "EXISTS:") {
		alreadyExists = true
		filename = strings.TrimPrefix(filename, "EXISTS:")
	}

	if !alreadyExists && req.SpotifyID != "" && req.EmbedLyrics && strings.HasSuffix(filename, ".flac") {
		go func(filePath, spotifyID, trackName, artistName string) {
			defer func() {
				if r := recover(); r != nil {
					fmt.Printf("PANIC in lyrics embed: %v\n", r)
				}
			}()

			start := time.Now()
			timeout := 25 * time.Second
			done := make(chan struct{})

			go func() {
				defer func() {
					if r := recover(); r != nil {
						fmt.Printf("PANIC in lyrics embed worker: %v\n", r)
					}
				}()
				defer close(done)

				fmt.Printf("\n========== LYRICS FETCH START ==========\n")
				fmt.Printf("Spotify ID: %s\n", spotifyID)
				fmt.Printf("Track: %s\n", trackName)
				fmt.Printf("Artist: %s\n", artistName)
				fmt.Println("Searching all sources...")

				lyricsClient := backend.NewLyricsClient()

				lyricsResp, source, err := lyricsClient.FetchLyricsAllSources(spotifyID, trackName, artistName, 0)
				if err != nil {
					fmt.Printf("All sources failed: %v\n", err)
					fmt.Printf("========== LYRICS FETCH END (FAILED) ==========\n\n")
					return
				}

				if lyricsResp == nil || len(lyricsResp.Lines) == 0 {
					fmt.Println("No lyrics content found")
					fmt.Printf("========== LYRICS FETCH END (FAILED) ==========\n\n")
					return
				}

				fmt.Printf("Lyrics found from: %s\n", source)
				fmt.Printf("Sync type: %s\n", lyricsResp.SyncType)
				fmt.Printf("Total lines: %d\n", len(lyricsResp.Lines))

				lyrics := lyricsClient.ConvertToLRC(lyricsResp, trackName, artistName)
				if lyrics == "" {
					fmt.Println("No lyrics content to embed")
					fmt.Printf("========== LYRICS FETCH END (FAILED) ==========\n\n")
					return
				}

				fmt.Printf("Embedding into: %s\n", filePath)
				if err := backend.EmbedLyricsOnly(filePath, lyrics); err != nil {
					fmt.Printf("Failed to embed lyrics: %v\n", err)
					fmt.Printf("========== LYRICS FETCH END (FAILED) ==========\n\n")
				} else {
					fmt.Printf("Lyrics embedded successfully!\n")
					fmt.Printf("========== LYRICS FETCH END (SUCCESS) ==========\n\n")
				}
			}()

			select {
			case <-done:
				fmt.Printf("Lyrics embedding finished in %s\n", time.Since(start))
			case <-time.After(timeout):
				fmt.Printf("Lyrics embedding timed out after %s\n", timeout)
			}
		}(filename, req.SpotifyID, req.TrackName, req.ArtistName)
	}

	message := "Download completed successfully"
	if alreadyExists {
		message = "File already exists"
		backend.SkipDownloadItem(itemID, filename)
	} else {

		if fileInfo, statErr := os.Stat(filename); statErr == nil {
			finalSize := float64(fileInfo.Size()) / (1024 * 1024)
			backend.CompleteDownloadItem(itemID, filename, finalSize)
		} else {

			backend.CompleteDownloadItem(itemID, filename, 0)
		}
	}

	return DownloadResponse{
		Success:       true,
		Message:       message,
		File:          filename,
		AlreadyExists: alreadyExists,
		ItemID:        itemID,
	}, nil
}

func (a *App) OpenFolder(path string) error {
	if path == "" {
		return fmt.Errorf("path is required")
	}

	err := backend.OpenFolderInExplorer(path)
	if err != nil {
		return fmt.Errorf("failed to open folder: %v", err)
	}

	return nil
}

func (a *App) SelectFolder(defaultPath string) (string, error) {
	return backend.SelectFolderDialog(a.ctx, defaultPath)
}

func (a *App) SelectFile() (string, error) {
	return backend.SelectFileDialog(a.ctx)
}

func (a *App) GetDefaults() map[string]string {
	return map[string]string{
		"downloadPath": backend.GetDefaultMusicPath(),
	}
}

func (a *App) GetDownloadProgress() backend.ProgressInfo {
	return backend.GetDownloadProgress()
}

func (a *App) GetDownloadQueue() backend.DownloadQueueInfo {
	return backend.GetDownloadQueue()
}

func (a *App) ClearCompletedDownloads() {
	backend.ClearDownloadQueue()
}

func (a *App) ClearAllDownloads() {
	backend.ClearAllDownloads()
}

func (a *App) AddToDownloadQueue(isrc, trackName, artistName, albumName string) string {
	itemID := fmt.Sprintf("%s-%d", isrc, time.Now().UnixNano())
	backend.AddToQueue(itemID, trackName, artistName, albumName, isrc)
	return itemID
}

func (a *App) MarkDownloadItemFailed(itemID, errorMsg string) {
	backend.FailDownloadItem(itemID, errorMsg)
}

func (a *App) CancelAllQueuedItems() {
	backend.CancelAllQueuedItems()
}

func (a *App) Quit() {

	panic("quit")
}

func (a *App) AnalyzeTrack(filePath string) (string, error) {
	if filePath == "" {
		return "", fmt.Errorf("file path is required")
	}

	result, err := backend.AnalyzeTrack(filePath)
	if err != nil {
		return "", fmt.Errorf("failed to analyze track: %v", err)
	}

	jsonData, err := json.Marshal(result)
	if err != nil {
		return "", fmt.Errorf("failed to encode response: %v", err)
	}

	return string(jsonData), nil
}

func (a *App) AnalyzeMultipleTracks(filePaths []string) (string, error) {
	if len(filePaths) == 0 {
		return "", fmt.Errorf("at least one file path is required")
	}

	results := make([]*backend.AnalysisResult, 0, len(filePaths))

	for _, filePath := range filePaths {
		result, err := backend.AnalyzeTrack(filePath)
		if err != nil {

			continue
		}
		results = append(results, result)
	}

	jsonData, err := json.Marshal(results)
	if err != nil {
		return "", fmt.Errorf("failed to encode response: %v", err)
	}

	return string(jsonData), nil
}

type LyricsDownloadRequest struct {
	SpotifyID           string `json:"spotify_id"`
	TrackName           string `json:"track_name"`
	ArtistName          string `json:"artist_name"`
	AlbumName           string `json:"album_name"`
	AlbumArtist         string `json:"album_artist"`
	ReleaseDate         string `json:"release_date"`
	OutputDir           string `json:"output_dir"`
	FilenameFormat      string `json:"filename_format"`
	TrackNumber         bool   `json:"track_number"`
	Position            int    `json:"position"`
	UseAlbumTrackNumber bool   `json:"use_album_track_number"`
	DiscNumber          int    `json:"disc_number"`
}

func (a *App) DownloadLyrics(req LyricsDownloadRequest) (backend.LyricsDownloadResponse, error) {
	if req.SpotifyID == "" {
		return backend.LyricsDownloadResponse{
			Success: false,
			Error:   "Spotify ID is required",
		}, fmt.Errorf("spotify ID is required")
	}

	client := backend.NewLyricsClient()
	backendReq := backend.LyricsDownloadRequest{
		SpotifyID:           req.SpotifyID,
		TrackName:           req.TrackName,
		ArtistName:          req.ArtistName,
		AlbumName:           req.AlbumName,
		AlbumArtist:         req.AlbumArtist,
		ReleaseDate:         req.ReleaseDate,
		OutputDir:           req.OutputDir,
		FilenameFormat:      req.FilenameFormat,
		TrackNumber:         req.TrackNumber,
		Position:            req.Position,
		UseAlbumTrackNumber: req.UseAlbumTrackNumber,
		DiscNumber:          req.DiscNumber,
	}

	resp, err := client.DownloadLyrics(backendReq)
	if err != nil {
		return backend.LyricsDownloadResponse{
			Success: false,
			Error:   err.Error(),
		}, err
	}

	return *resp, nil
}

type CoverDownloadRequest struct {
	CoverURL       string `json:"cover_url"`
	TrackName      string `json:"track_name"`
	ArtistName     string `json:"artist_name"`
	AlbumName      string `json:"album_name"`
	AlbumArtist    string `json:"album_artist"`
	ReleaseDate    string `json:"release_date"`
	OutputDir      string `json:"output_dir"`
	FilenameFormat string `json:"filename_format"`
	TrackNumber    bool   `json:"track_number"`
	Position       int    `json:"position"`
	DiscNumber     int    `json:"disc_number"`
}

func (a *App) DownloadCover(req CoverDownloadRequest) (backend.CoverDownloadResponse, error) {
	if req.CoverURL == "" {
		return backend.CoverDownloadResponse{
			Success: false,
			Error:   "Cover URL is required",
		}, fmt.Errorf("cover URL is required")
	}

	client := backend.NewCoverClient()
	backendReq := backend.CoverDownloadRequest{
		CoverURL:       req.CoverURL,
		TrackName:      req.TrackName,
		ArtistName:     req.ArtistName,
		AlbumName:      req.AlbumName,
		AlbumArtist:    req.AlbumArtist,
		ReleaseDate:    req.ReleaseDate,
		OutputDir:      req.OutputDir,
		FilenameFormat: req.FilenameFormat,
		TrackNumber:    req.TrackNumber,
		Position:       req.Position,
		DiscNumber:     req.DiscNumber,
	}

	resp, err := client.DownloadCover(backendReq)
	if err != nil {
		return backend.CoverDownloadResponse{
			Success: false,
			Error:   err.Error(),
		}, err
	}

	return *resp, nil
}

type HeaderDownloadRequest struct {
	HeaderURL  string `json:"header_url"`
	ArtistName string `json:"artist_name"`
	OutputDir  string `json:"output_dir"`
}

func (a *App) DownloadHeader(req HeaderDownloadRequest) (backend.HeaderDownloadResponse, error) {
	if req.HeaderURL == "" {
		return backend.HeaderDownloadResponse{
			Success: false,
			Error:   "Header URL is required",
		}, fmt.Errorf("header URL is required")
	}

	if req.ArtistName == "" {
		return backend.HeaderDownloadResponse{
			Success: false,
			Error:   "Artist name is required",
		}, fmt.Errorf("artist name is required")
	}

	client := backend.NewCoverClient()
	backendReq := backend.HeaderDownloadRequest{
		HeaderURL:  req.HeaderURL,
		ArtistName: req.ArtistName,
		OutputDir:  req.OutputDir,
	}

	resp, err := client.DownloadHeader(backendReq)
	if err != nil {
		return backend.HeaderDownloadResponse{
			Success: false,
			Error:   err.Error(),
		}, err
	}

	return *resp, nil
}

type GalleryImageDownloadRequest struct {
	ImageURL   string `json:"image_url"`
	ArtistName string `json:"artist_name"`
	ImageIndex int    `json:"image_index"`
	OutputDir  string `json:"output_dir"`
}

func (a *App) DownloadGalleryImage(req GalleryImageDownloadRequest) (backend.GalleryImageDownloadResponse, error) {
	if req.ImageURL == "" {
		return backend.GalleryImageDownloadResponse{
			Success: false,
			Error:   "Image URL is required",
		}, fmt.Errorf("image URL is required")
	}

	if req.ArtistName == "" {
		return backend.GalleryImageDownloadResponse{
			Success: false,
			Error:   "Artist name is required",
		}, fmt.Errorf("artist name is required")
	}

	client := backend.NewCoverClient()
	backendReq := backend.GalleryImageDownloadRequest{
		ImageURL:   req.ImageURL,
		ArtistName: req.ArtistName,
		ImageIndex: req.ImageIndex,
		OutputDir:  req.OutputDir,
	}

	resp, err := client.DownloadGalleryImage(backendReq)
	if err != nil {
		return backend.GalleryImageDownloadResponse{
			Success: false,
			Error:   err.Error(),
		}, err
	}

	return *resp, nil
}

type AvatarDownloadRequest struct {
	AvatarURL  string `json:"avatar_url"`
	ArtistName string `json:"artist_name"`
	OutputDir  string `json:"output_dir"`
}

func (a *App) DownloadAvatar(req AvatarDownloadRequest) (backend.AvatarDownloadResponse, error) {
	if req.AvatarURL == "" {
		return backend.AvatarDownloadResponse{
			Success: false,
			Error:   "Avatar URL is required",
		}, fmt.Errorf("avatar URL is required")
	}

	if req.ArtistName == "" {
		return backend.AvatarDownloadResponse{
			Success: false,
			Error:   "Artist name is required",
		}, fmt.Errorf("artist name is required")
	}

	client := backend.NewCoverClient()
	backendReq := backend.AvatarDownloadRequest{
		AvatarURL:  req.AvatarURL,
		ArtistName: req.ArtistName,
		OutputDir:  req.OutputDir,
	}

	resp, err := client.DownloadAvatar(backendReq)
	if err != nil {
		return backend.AvatarDownloadResponse{
			Success: false,
			Error:   err.Error(),
		}, err
	}

	return *resp, nil
}

func (a *App) CheckTrackAvailability(spotifyTrackID string, isrc string) (string, error) {
	if spotifyTrackID == "" {
		return "", fmt.Errorf("spotify track ID is required")
	}

	client := backend.NewSongLinkClient()
	availability, err := client.CheckTrackAvailability(spotifyTrackID, isrc)
	if err != nil {
		return "", err
	}

	jsonData, err := json.Marshal(availability)
	if err != nil {
		return "", fmt.Errorf("failed to encode response: %v", err)
	}

	return string(jsonData), nil
}

func (a *App) IsFFmpegInstalled() (bool, error) {
	return backend.IsFFmpegInstalled()
}

func (a *App) IsFFprobeInstalled() (bool, error) {
	return backend.IsFFprobeInstalled()
}

func (a *App) GetFFmpegPath() (string, error) {
	return backend.GetFFmpegPath()
}

type DownloadFFmpegRequest struct{}

type DownloadFFmpegResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Error   string `json:"error,omitempty"`
}

func (a *App) DownloadFFmpeg() DownloadFFmpegResponse {
	err := backend.DownloadFFmpeg(func(progress int) {
		fmt.Printf("[FFmpeg] Download progress: %d%%\n", progress)
	})
	if err != nil {
		return DownloadFFmpegResponse{
			Success: false,
			Error:   err.Error(),
		}
	}

	return DownloadFFmpegResponse{
		Success: true,
		Message: "FFmpeg installed successfully",
	}
}

type ConvertAudioRequest struct {
	InputFiles   []string `json:"input_files"`
	OutputFormat string   `json:"output_format"`
	Bitrate      string   `json:"bitrate"`
	Codec        string   `json:"codec"`
}

func (a *App) ConvertAudio(req ConvertAudioRequest) ([]backend.ConvertAudioResult, error) {
	backendReq := backend.ConvertAudioRequest{
		InputFiles:   req.InputFiles,
		OutputFormat: req.OutputFormat,
		Bitrate:      req.Bitrate,
		Codec:        req.Codec,
	}
	return backend.ConvertAudio(backendReq)
}

func (a *App) SelectAudioFiles() ([]string, error) {
	files, err := backend.SelectMultipleFiles(a.ctx)
	if err != nil {
		return nil, err
	}
	return files, nil
}

func (a *App) GetFileSizes(files []string) map[string]int64 {
	return backend.GetFileSizes(files)
}

func (a *App) ListDirectoryFiles(dirPath string) ([]backend.FileInfo, error) {
	if dirPath == "" {
		return nil, fmt.Errorf("directory path is required")
	}
	return backend.ListDirectory(dirPath)
}

func (a *App) ListAudioFilesInDir(dirPath string) ([]backend.FileInfo, error) {
	if dirPath == "" {
		return nil, fmt.Errorf("directory path is required")
	}
	return backend.ListAudioFiles(dirPath)
}

func (a *App) ReadFileMetadata(filePath string) (*backend.AudioMetadata, error) {
	if filePath == "" {
		return nil, fmt.Errorf("file path is required")
	}
	return backend.ReadAudioMetadata(filePath)
}

func (a *App) PreviewRenameFiles(files []string, format string) []backend.RenamePreview {
	return backend.PreviewRename(files, format)
}

// PreviewRenameMismatched returns preview only for files not already matching the format (files that would be renamed).
func (a *App) PreviewRenameMismatched(files []string, format string) []backend.RenamePreview {
	return backend.PreviewRenameMismatched(files, format)
}

func (a *App) RenameFilesByMetadata(files []string, format string) []backend.RenameResult {
	return backend.RenameFiles(files, format)
}

// RenameFilesFromPreview renames using existing preview data (no metadata read). Use after PreviewRename for efficient apply.
func (a *App) RenameFilesFromPreview(previews []backend.RenamePreview) []backend.RenameResult {
	return backend.RenameFilesFromPreview(previews)
}

func (a *App) ReadTextFile(filePath string) (string, error) {
	content, err := os.ReadFile(filePath)
	if err != nil {
		return "", err
	}
	return string(content), nil
}

func (a *App) RenameFileTo(oldPath, newName string) error {
	dir := filepath.Dir(oldPath)
	ext := filepath.Ext(oldPath)
	newPath := filepath.Join(dir, newName+ext)
	return os.Rename(oldPath, newPath)
}

func (a *App) ReadImageAsBase64(filePath string) (string, error) {
	content, err := os.ReadFile(filePath)
	if err != nil {
		return "", err
	}

	ext := strings.ToLower(filepath.Ext(filePath))
	var mimeType string
	switch ext {
	case ".jpg", ".jpeg":
		mimeType = "image/jpeg"
	case ".png":
		mimeType = "image/png"
	case ".gif":
		mimeType = "image/gif"
	case ".webp":
		mimeType = "image/webp"
	default:
		mimeType = "image/jpeg"
	}

	encoded := base64.StdEncoding.EncodeToString(content)
	return fmt.Sprintf("data:%s;base64,%s", mimeType, encoded), nil
}

type CheckFileExistenceRequest struct {
	SpotifyID           string `json:"spotify_id"`
	TrackName           string `json:"track_name"`
	ArtistName          string `json:"artist_name"`
	AlbumName           string `json:"album_name,omitempty"`
	AlbumArtist         string `json:"album_artist,omitempty"`
	ReleaseDate         string `json:"release_date,omitempty"`
	TrackNumber         int    `json:"track_number,omitempty"`
	DiscNumber          int    `json:"disc_number,omitempty"`
	Position            int    `json:"position,omitempty"`
	UseAlbumTrackNumber bool   `json:"use_album_track_number,omitempty"`
	FilenameFormat      string `json:"filename_format,omitempty"`
	IncludeTrackNumber  bool   `json:"include_track_number,omitempty"`
	AudioFormat         string `json:"audio_format,omitempty"`
}

type CheckFileExistenceResult struct {
	SpotifyID  string `json:"spotify_id"`
	Exists     bool   `json:"exists"`
	FilePath   string `json:"file_path,omitempty"`
	TrackName  string `json:"track_name,omitempty"`
	ArtistName string `json:"artist_name,omitempty"`
}

func (a *App) CheckFilesExistence(outputDir string, tracks []CheckFileExistenceRequest) []CheckFileExistenceResult {
	if len(tracks) == 0 {
		return []CheckFileExistenceResult{}
	}

	outputDir = backend.NormalizePath(outputDir)

	defaultFilenameFormat := "title-artist"

	type result struct {
		index  int
		result CheckFileExistenceResult
	}

	resultsChan := make(chan result, len(tracks))

	for i, track := range tracks {
		go func(idx int, t CheckFileExistenceRequest) {
			res := CheckFileExistenceResult{
				SpotifyID:  t.SpotifyID,
				TrackName:  t.TrackName,
				ArtistName: t.ArtistName,
				Exists:     false,
			}

			if t.TrackName == "" || t.ArtistName == "" {
				resultsChan <- result{index: idx, result: res}
				return
			}

			filenameFormat := t.FilenameFormat
			if filenameFormat == "" {
				filenameFormat = defaultFilenameFormat
			}

			trackNumber := t.Position
			if t.UseAlbumTrackNumber && t.TrackNumber > 0 {
				trackNumber = t.TrackNumber
			}

			fileExt := ".flac"
			if t.AudioFormat == "mp3" {
				fileExt = ".mp3"
			}

			expectedFilenameBase := backend.BuildExpectedFilename(
				t.TrackName,
				t.ArtistName,
				t.AlbumName,
				t.AlbumArtist,
				t.ReleaseDate,
				filenameFormat,
				t.IncludeTrackNumber,
				trackNumber,
				t.DiscNumber,
				t.UseAlbumTrackNumber,
			)

			expectedFilename := strings.TrimSuffix(expectedFilenameBase, ".flac") + fileExt

			expectedPath := filepath.Join(outputDir, expectedFilename)

			if fileInfo, err := os.Stat(expectedPath); err == nil && fileInfo.Size() > 100*1024 {
				complete, checkErr := backend.HasCompleteMetadataAndCover(expectedPath)
				if checkErr == nil && complete {
					res.Exists = true
					res.FilePath = expectedPath
				} else if checkErr == nil && !complete {
					_ = os.Remove(expectedPath)
				}
			}

			resultsChan <- result{index: idx, result: res}
		}(i, track)
	}

	results := make([]CheckFileExistenceResult, len(tracks))
	for i := 0; i < len(tracks); i++ {
		r := <-resultsChan
		results[r.index] = r.result
	}

	return results
}

// CheckFilesExistenceInMusicDir checks if tracks already exist anywhere under rootDir (recursive).
// Use this for playlist downloads so we skip tracks that exist in the whole music directory.
func (a *App) CheckFilesExistenceInMusicDir(rootDir string, tracks []CheckFileExistenceRequest) []CheckFileExistenceResult {
	if len(tracks) == 0 {
		return []CheckFileExistenceResult{}
	}
	rootDir = backend.NormalizePath(rootDir)
	defaultFilenameFormat := "title-artist"

	// Build a map: base filename -> full path (first occurrence with size > 100KB)
	type pathSize struct {
		path string
		size int64
	}
	fileMap := make(map[string]pathSize)
	walkFn := func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		base := filepath.Base(path)
		ext := strings.ToLower(filepath.Ext(base))
		if ext != ".flac" && ext != ".mp3" {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Size() <= 100*1024 {
			return nil
		}
		if _, exists := fileMap[base]; !exists {
			fileMap[base] = pathSize{path: path, size: info.Size()}
		}
		return nil
	}
	_ = filepath.WalkDir(rootDir, walkFn)

	// For each track, compute expected filename and look up in fileMap
	results := make([]CheckFileExistenceResult, len(tracks))
	for i, t := range tracks {
		res := CheckFileExistenceResult{
			SpotifyID:  t.SpotifyID,
			TrackName:  t.TrackName,
			ArtistName: t.ArtistName,
			Exists:     false,
		}
		if t.TrackName == "" || t.ArtistName == "" {
			results[i] = res
			continue
		}
		filenameFormat := t.FilenameFormat
		if filenameFormat == "" {
			filenameFormat = defaultFilenameFormat
		}
		trackNumber := t.Position
		if t.UseAlbumTrackNumber && t.TrackNumber > 0 {
			trackNumber = t.TrackNumber
		}
		fileExt := ".flac"
		if t.AudioFormat == "mp3" {
			fileExt = ".mp3"
		}
		expectedFilenameBase := backend.BuildExpectedFilename(
			t.TrackName,
			t.ArtistName,
			t.AlbumName,
			t.AlbumArtist,
			t.ReleaseDate,
			filenameFormat,
			t.IncludeTrackNumber,
			trackNumber,
			t.DiscNumber,
			t.UseAlbumTrackNumber,
		)
		expectedFilename := strings.TrimSuffix(expectedFilenameBase, ".flac") + fileExt
		if ps, ok := fileMap[expectedFilename]; ok {
			complete, checkErr := backend.HasCompleteMetadataAndCover(ps.path)
			if checkErr == nil && complete {
				res.Exists = true
				res.FilePath = ps.path
			} else if checkErr == nil && !complete {
				_ = os.Remove(ps.path)
			}
		}
		// Also check the other extension (e.g. user has .flac, we look for .mp3 too)
		if !res.Exists {
			otherExt := ".mp3"
			if fileExt == ".mp3" {
				otherExt = ".flac"
			}
			altFilename := strings.TrimSuffix(expectedFilenameBase, ".flac") + otherExt
			if ps, ok := fileMap[altFilename]; ok {
				complete, checkErr := backend.HasCompleteMetadataAndCover(ps.path)
				if checkErr == nil && complete {
					res.Exists = true
					res.FilePath = ps.path
				} else if checkErr == nil && !complete {
					_ = os.Remove(ps.path)
				}
			}
		}
		results[i] = res
	}
	return results
}

func (a *App) SkipDownloadItem(itemID, filePath string) {
	backend.SkipDownloadItem(itemID, filePath)
}

type ScanFolderRequest struct {
	FolderPath string `json:"folder_path"`
}

func (a *App) ScanFolderForQualityUpgrades(req ScanFolderRequest) (string, error) {
	if req.FolderPath == "" {
		return "", fmt.Errorf("folder path is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	suggestions, err := backend.ScanFolderForQualityUpgrades(ctx, req.FolderPath)
	if err != nil {
		return "", fmt.Errorf("failed to scan folder: %v", err)
	}

	jsonData, err := json.Marshal(suggestions)
	if err != nil {
		return "", fmt.Errorf("failed to encode response: %v", err)
	}

	return string(jsonData), nil
}

type ScanSingleFileRequest struct {
	FilePath string `json:"file_path"`
}

func (a *App) ScanSingleFileForQualityUpgrade(req ScanSingleFileRequest) (result string, err error) {
	// Recover from any panics to prevent app crash
	defer func() {
		if r := recover(); r != nil {
			fmt.Printf("PANIC in ScanSingleFileForQualityUpgrade: %v\n", r)
			result = ""
			err = fmt.Errorf("scan crashed: %v", r)
		}
	}()

	if req.FilePath == "" {
		return "", fmt.Errorf("file path is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	suggestion, err := backend.ScanSingleFileForQualityUpgrade(ctx, req.FilePath)
	if err != nil {
		return "", fmt.Errorf("failed to scan file: %v", err)
	}

	jsonData, err := json.Marshal(suggestion)
	if err != nil {
		return "", fmt.Errorf("failed to encode response: %v", err)
	}

	return string(jsonData), nil
}

func (a *App) ReadAudioFileAsBase64(filePath string) (string, error) {
	if filePath == "" {
		return "", fmt.Errorf("file path is required")
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		return "", fmt.Errorf("failed to read audio file: %v", err)
	}

	// Determine MIME type based on extension
	ext := strings.ToLower(filepath.Ext(filePath))
	mimeType := "audio/mpeg"
	switch ext {
	case ".mp3":
		mimeType = "audio/mpeg"
	case ".flac":
		mimeType = "audio/flac"
	case ".m4a", ".aac":
		mimeType = "audio/mp4"
	case ".ogg":
		mimeType = "audio/ogg"
	case ".wav":
		mimeType = "audio/wav"
	case ".opus":
		mimeType = "audio/opus"
	}

	encoded := base64.StdEncoding.EncodeToString(data)
	return fmt.Sprintf("data:%s;base64,%s", mimeType, encoded), nil
}

func (a *App) FindDuplicateTracks(folderPath string) (string, error) {
	if folderPath == "" {
		return "", fmt.Errorf("folder path is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	duplicates, err := backend.FindDuplicateTracks(ctx, folderPath)
	if err != nil {
		return "", fmt.Errorf("failed to find duplicates: %v", err)
	}

	jsonData, err := json.Marshal(duplicates)
	if err != nil {
		return "", fmt.Errorf("failed to encode response: %v", err)
	}

	return string(jsonData), nil
}

// FindDuplicateTracksWithOptions performs an advanced duplicate scan using JSON-encoded options.
// optsJson should be a JSON object matching backend.DuplicateScanOptions fields, for example:
// {"use_hash":true,"duration_tolerance_ms":2000,"use_filename_fallback":true,"ignore_duration":false,"use_fingerprint":false,"worker_count":0}
func (a *App) FindDuplicateTracksWithOptions(folderPath string, optsJson string) (string, error) {
	if folderPath == "" {
		return "", fmt.Errorf("folder path is required")
	}

	// Parse options (best-effort). If parsing fails, return a clear error to the caller.
	var opts backend.DuplicateScanOptions
	if optsJson != "" {
		if err := json.Unmarshal([]byte(optsJson), &opts); err != nil {
			return "", fmt.Errorf("invalid options: %v", err)
		}
	} else {
		// sensible defaults
		opts = backend.DuplicateScanOptions{
			UseHash:             true,
			DurationToleranceMs: 2000,
			UseFilenameFallback: true,
			WorkerCount:         0,
		}
	}

	// Adjust timeout when hashing or fingerprinting is requested (both can be slow for large libraries)
	timeout := 2 * time.Minute
	if opts.UseHash {
		timeout = 10 * time.Minute
	}
	if opts.UseFingerprint {
		if timeout < 15*time.Minute {
			timeout = 15 * time.Minute
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	duplicates, err := backend.FindDuplicateTracksAdvanced(ctx, folderPath, opts)
	if err != nil {
		return "", fmt.Errorf("failed to find duplicates: %v", err)
	}

	jsonData, err := json.Marshal(duplicates)
	if err != nil {
		return "", fmt.Errorf("failed to encode response: %v", err)
	}

	return string(jsonData), nil
}

func (a *App) OpenFileLocation(filePath string) error {
	if filePath == "" {
		return fmt.Errorf("file path is required")
	}

	log.Printf("[OpenFileLocation] Opening file location for: %s", filePath)

	// Verify file exists
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		log.Printf("[OpenFileLocation] ERROR: File does not exist: %s", filePath)
		return fmt.Errorf("file does not exist: %s", filePath)
	}

	// Get the directory containing the file
	dir := filepath.Dir(filePath)
	fileName := filepath.Base(filePath)

	log.Printf("[OpenFileLocation] Directory: %s, File: %s", dir, fileName)

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "linux":
		// Try to detect and use the appropriate file manager with file selection
		desktop := os.Getenv("XDG_CURRENT_DESKTOP")
		desktopSession := os.Getenv("DESKTOP_SESSION")
		log.Printf("[OpenFileLocation] XDG_CURRENT_DESKTOP: %s", desktop)
		log.Printf("[OpenFileLocation] DESKTOP_SESSION: %s", desktopSession)

		// Try file manager-specific commands that support file selection
		// Different file managers have different syntax for selecting files
		fileManagers := []struct {
			name    string
			command string
			args    []string
		}{
			// Nautilus (GNOME Files) - uses --select with full file path
			{"nautilus", "nautilus", []string{"--select", filePath}},
			// Dolphin (KDE) - uses --select with full file path
			{"dolphin", "dolphin", []string{"--select", filePath}},
			// Thunar (XFCE) - uses --select with full file path
			{"thunar", "thunar", []string{"--select", filePath}},
			// PCManFM (LXDE) - uses --select with full file path
			{"pcmanfm", "pcmanfm", []string{"--select", filePath}},
			// Caja (MATE) - uses --select with full file path
			{"caja", "caja", []string{"--select", filePath}},
			// Nemo (Cinnamon) - uses --select with full file path
			{"nemo", "nemo", []string{"--select", filePath}},
			// Some file managers might need directory + file separately
			// Try with directory first, then file selection
			{"nautilus-alt", "nautilus", []string{dir, "--select", fileName}},
		}

		// Try file manager-specific commands first
		for _, fm := range fileManagers {
			if path, err := exec.LookPath(fm.command); err == nil {
				log.Printf("[OpenFileLocation] Found file manager: %s at %s", fm.name, path)
				log.Printf("[OpenFileLocation] Trying command: %s %v", fm.command, fm.args)
				testCmd := exec.Command(fm.command, fm.args...)
				if err := testCmd.Start(); err == nil {
					log.Printf("[OpenFileLocation] Successfully opened with %s", fm.name)
					// Don't wait for the command to finish, just start it
					go func() {
						_ = testCmd.Wait()
					}()
					return nil
				}
				log.Printf("[OpenFileLocation] Failed to start %s: %v", fm.name, err)
			} else {
				log.Printf("[OpenFileLocation] File manager %s not found: %v", fm.name, err)
			}
		}

		// Fallback: Try using dbus-send for some desktop environments
		// This can work with GNOME/KDE file managers
		log.Printf("[OpenFileLocation] Trying dbus-send method")
		if _, err := exec.LookPath("dbus-send"); err == nil {
			dbusCmd := exec.Command("dbus-send", "--session", "--type=method_call",
				"--dest=org.freedesktop.FileManager1",
				"/org/freedesktop/FileManager1",
				"org.freedesktop.FileManager1.ShowItems",
				fmt.Sprintf("array:string:file://%s", filePath),
				"string:")
			if err := dbusCmd.Start(); err == nil {
				log.Printf("[OpenFileLocation] Successfully opened with dbus-send")
				go func() {
					_ = dbusCmd.Wait()
				}()
				return nil
			}
			log.Printf("[OpenFileLocation] dbus-send failed: %v", err)
		} else {
			log.Printf("[OpenFileLocation] dbus-send not found")
		}

		// Last resort: open directory (at least gets user to the right place)
		log.Printf("[OpenFileLocation] Fallback: opening directory with xdg-open")
		log.Printf("[OpenFileLocation] WARNING: File selection may not work, opening directory instead")
		cmd = exec.Command("xdg-open", dir)
	case "darwin":
		log.Printf("[OpenFileLocation] Using macOS 'open -R' command")
		cmd = exec.Command("open", "-R", filePath)
	case "windows":
		log.Printf("[OpenFileLocation] Using Windows explorer /select command")
		cmd = exec.Command("explorer", "/select,", filePath)
	default:
		log.Printf("[OpenFileLocation] ERROR: Unsupported OS: %s", runtime.GOOS)
		return fmt.Errorf("unsupported operating system: %s", runtime.GOOS)
	}

	if cmd == nil {
		return fmt.Errorf("failed to create command")
	}

	log.Printf("[OpenFileLocation] Executing command: %s %v", cmd.Path, cmd.Args)
	err := cmd.Start()
	if err != nil {
		log.Printf("[OpenFileLocation] ERROR: Failed to start command: %v", err)
		return fmt.Errorf("failed to open file location: %v", err)
	}

	log.Printf("[OpenFileLocation] Command started successfully")
	return nil
}

// DeleteFile deletes a file from the filesystem
func (a *App) DeleteFile(filePath string) error {
	if filePath == "" {
		return fmt.Errorf("file path is required")
	}

	// Verify file exists
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		return fmt.Errorf("file does not exist: %s", filePath)
	}

	// Delete the file
	if err := os.Remove(filePath); err != nil {
		return fmt.Errorf("failed to delete file: %v", err)
	}

	// Invalidate cache entry for deleted file
	if rootPath := filepath.Dir(filePath); rootPath != "" {
		_ = backend.InvalidateCacheEntry(rootPath, filePath)
	}

	log.Printf("[DeleteFile] Successfully deleted: %s", filePath)
	return nil
}

// DeleteFiles deletes multiple files from the filesystem
func (a *App) DeleteFiles(filePaths []string) (map[string]string, error) {
	if len(filePaths) == 0 {
		return nil, fmt.Errorf("no file paths provided")
	}

	results := make(map[string]string)
	deletedPaths := make([]string, 0)
	rootPathMap := make(map[string][]string) // Group by root path for efficient cache invalidation

	for _, filePath := range filePaths {
		if filePath == "" {
			continue
		}

		if _, err := os.Stat(filePath); os.IsNotExist(err) {
			results[filePath] = "file does not exist"
			continue
		}

		if err := os.Remove(filePath); err != nil {
			results[filePath] = fmt.Sprintf("failed to delete: %v", err)
		} else {
			results[filePath] = "deleted"
			deletedPaths = append(deletedPaths, filePath)
			rootPath := filepath.Dir(filePath)
			rootPathMap[rootPath] = append(rootPathMap[rootPath], filePath)
			log.Printf("[DeleteFiles] Successfully deleted: %s", filePath)
		}
	}

	// Invalidate cache entries for all deleted files (grouped by root path)
	for rootPath, paths := range rootPathMap {
		_ = backend.InvalidateCacheEntries(rootPath, paths)
	}

	return results, nil
}

// MoveFilesToQuarantine moves a list of files into a quarantine folder inside the given rootPath.
// It returns a map of filePath -> status ("moved", "missing", "outside_root", or an error message)
func (a *App) MoveFilesToQuarantine(filePaths []string, rootPath string) (map[string]string, error) {
	if len(filePaths) == 0 {
		return nil, fmt.Errorf("no file paths provided")
	}
	if rootPath == "" {
		return nil, fmt.Errorf("root path is required")
	}

	quarantineDir := filepath.Join(rootPath, ".spotiflac_quarantine")
	results := make(map[string]string)
	movedPaths := make([]string, 0) // Track successfully moved files for cache invalidation

	for _, filePath := range filePaths {
		if filePath == "" {
			continue
		}
		if _, err := os.Stat(filePath); os.IsNotExist(err) {
			results[filePath] = "missing"
			continue
		}

		// Ensure the file is inside the provided rootPath to avoid moving files outside the library
		rel, err := filepath.Rel(rootPath, filePath)
		if err != nil || strings.HasPrefix(rel, "..") {
			results[filePath] = "outside_root"
			continue
		}

		dest := filepath.Join(quarantineDir, rel)
		if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
			results[filePath] = fmt.Sprintf("mkdir failed: %v", err)
			continue
		}

		// Try to rename first (fast and atomic on same filesystem). Fall back to copy+remove.
		if err := os.Rename(filePath, dest); err != nil {
			// fallback to copy then remove
			data, rerr := os.ReadFile(filePath)
			if rerr != nil {
				results[filePath] = fmt.Sprintf("move failed: %v", rerr)
				continue
			}
			if werr := os.WriteFile(dest, data, 0644); werr != nil {
				results[filePath] = fmt.Sprintf("move failed: %v", werr)
				continue
			}
			if rerr := os.Remove(filePath); rerr != nil {
				results[filePath] = fmt.Sprintf("moved but failed to remove original: %v", rerr)
				continue
			}
		}

		results[filePath] = "moved"
		movedPaths = append(movedPaths, filePath)
		log.Printf("[MoveFilesToQuarantine] Moved %s -> %s", filePath, dest)
	}

	// Invalidate cache entries for moved files (they're now at new locations)
	if len(movedPaths) > 0 {
		_ = backend.InvalidateCacheEntries(rootPath, movedPaths)
	}

	return results, nil
}

// RestoreFilesFromQuarantine moves files from quarantine back to their original location under rootPath.
// If the destination path already exists, a timestamped "restored" suffix is appended.
func (a *App) RestoreFilesFromQuarantine(quarantinePaths []string, rootPath string) (map[string]string, error) {
	if len(quarantinePaths) == 0 {
		return nil, fmt.Errorf("no file paths provided")
	}
	if rootPath == "" {
		return nil, fmt.Errorf("root path is required")
	}

	quarantineDir := filepath.Join(rootPath, ".spotiflac_quarantine")
	results := make(map[string]string)

	for _, qpath := range quarantinePaths {
		if qpath == "" {
			continue
		}

		rel, err := filepath.Rel(quarantineDir, qpath)
		if err != nil || strings.HasPrefix(rel, "..") {
			results[qpath] = "not_in_quarantine"
			continue
		}

		dest := filepath.Join(rootPath, rel)
		if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
			results[qpath] = fmt.Sprintf("mkdir failed: %v", err)
			continue
		}

		// If destination exists, pick a new name with a timestamp to avoid overwriting
		if _, err := os.Stat(dest); err == nil {
			ext := filepath.Ext(dest)
			base := strings.TrimSuffix(dest, ext)
			dest = fmt.Sprintf("%s.restored.%d%s", base, time.Now().Unix(), ext)
		}

		if err := os.Rename(qpath, dest); err != nil {
			// fallback to copy+remove
			data, rerr := os.ReadFile(qpath)
			if rerr != nil {
				results[qpath] = fmt.Sprintf("restore failed: %v", rerr)
				continue
			}
			if werr := os.WriteFile(dest, data, 0644); werr != nil {
				results[qpath] = fmt.Sprintf("restore failed: %v", werr)
				continue
			}
			if rerr := os.Remove(qpath); rerr != nil {
				results[qpath] = fmt.Sprintf("restored but failed to remove quarantine file: %v", rerr)
				continue
			}
		}

		results[qpath] = "restored"
		log.Printf("[RestoreFilesFromQuarantine] Restored %s -> %s", qpath, dest)
	}

	return results, nil
}

// ListQuarantine lists all files currently in the quarantine for the given root path.
func (a *App) ListQuarantine(rootPath string) ([]string, error) {
	if rootPath == "" {
		return nil, fmt.Errorf("root path is required")
	}

	quarantineDir := filepath.Join(rootPath, ".spotiflac_quarantine")
	var files []string
	err := filepath.Walk(quarantineDir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if !info.IsDir() {
			files = append(files, p)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to walk quarantine: %v", err)
	}

	return files, nil
}

/*
EmptyQuarantine deletes all files in the quarantine and returns number of deleted items.
This cleaned implementation ensures the function is properly closed and removes
the duplicated / dangling code that was accidentally appended to the file end.
*/
func (a *App) EmptyQuarantine(rootPath string) (int, error) {
	if rootPath == "" {
		return 0, fmt.Errorf("root path is required")
	}

	quarantineDir := filepath.Join(rootPath, ".spotiflac_quarantine")
	count := 0
	err := filepath.Walk(quarantineDir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			return nil
		}
		if rmErr := os.Remove(p); rmErr == nil {
			count++
		}
		return nil
	})
	if err != nil {
		return count, fmt.Errorf("failed to empty quarantine: %v", err)
	}

	return count, nil
}

// FetchLyricsForFileRequest is the request type for fetching lyrics for an existing file
type FetchLyricsForFileRequest struct {
	FilePath     string `json:"file_path"`
	SpotifyID    string `json:"spotify_id,omitempty"`
	TrackName    string `json:"track_name,omitempty"`
	ArtistName   string `json:"artist_name,omitempty"`
	EmbedInFile  bool   `json:"embed_in_file"`
	SaveAsLRC    bool   `json:"save_as_lrc"`
	SkipIfExists bool   `json:"skip_if_exists"` // Skip fetching if lyrics already exist
}

// FetchLyricsForFile fetches lyrics for an existing audio file
func (a *App) FetchLyricsForFile(req FetchLyricsForFileRequest) (string, error) {
	if req.FilePath == "" {
		return "", fmt.Errorf("file path is required")
	}

	client := backend.NewLyricsClient()
	backendReq := backend.FetchLyricsForFileRequest{
		FilePath:     req.FilePath,
		SpotifyID:    req.SpotifyID,
		TrackName:    req.TrackName,
		ArtistName:   req.ArtistName,
		EmbedInFile:  req.EmbedInFile,
		SaveAsLRC:    req.SaveAsLRC,
		SkipIfExists: req.SkipIfExists,
	}

	resp, err := client.FetchLyricsForFile(backendReq)
	if err != nil {
		return "", fmt.Errorf("failed to fetch lyrics: %v", err)
	}

	jsonData, err := json.Marshal(resp)
	if err != nil {
		return "", fmt.Errorf("failed to encode response: %v", err)
	}

	return string(jsonData), nil
}

// CheckDuplicateGroup validates if a set of files still contains duplicates
// Returns the duplicate group if duplicates still exist, or null if resolved
func (a *App) CheckDuplicateGroup(filePaths []string) (string, error) {
	if len(filePaths) == 0 {
		return "", fmt.Errorf("no file paths provided")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	group, err := backend.CheckDuplicateGroup(ctx, filePaths)
	if err != nil {
		return "", fmt.Errorf("failed to check duplicate group: %v", err)
	}

	if group == nil {
		return "null", nil
	}

	jsonData, err := json.Marshal(group)
	if err != nil {
		return "", fmt.Errorf("failed to encode response: %v", err)
	}

	return string(jsonData), nil
}

// ============================================
// Smart File Organization API
// ============================================

// OrganizePreviewRequest is the request type for previewing file organization
type OrganizePreviewRequest struct {
	SourcePath          string   `json:"source_path"`
	FolderStructure     string   `json:"folder_structure"`
	FileNameFormat      string   `json:"file_name_format"`
	ConflictResolution  string   `json:"conflict_resolution"`
	IncludeSubfolders   bool     `json:"include_subfolders"`
	FilesFilter         []string `json:"files_filter"`
	FileExtensionFilter string   `json:"file_extension_filter"`
}

// OrganizeExecuteRequest is the request type for executing file organization
type OrganizeExecuteRequest struct {
	SourcePath         string                        `json:"source_path"`
	Items              []backend.OrganizePreviewItem `json:"items"`
	CreateFolders      bool                          `json:"create_folders"`
	MoveFiles          bool                          `json:"move_files"`
	DeleteEmptyFolders bool                          `json:"delete_empty_folders"`
	ConflictResolution string                        `json:"conflict_resolution"`
}

// GetFolderStructurePresets returns the available folder structure presets
func (a *App) GetFolderStructurePresets() (string, error) {
	presets := backend.GetFolderStructurePresets()
	jsonData, err := json.Marshal(presets)
	if err != nil {
		return "", fmt.Errorf("failed to encode presets: %v", err)
	}
	return string(jsonData), nil
}

// PreviewOrganization generates a preview of how files would be organized
func (a *App) PreviewOrganization(req OrganizePreviewRequest) (string, error) {
	if req.SourcePath == "" {
		return "", fmt.Errorf("source path is required")
	}

	backendReq := backend.OrganizePreviewRequest{
		SourcePath:          req.SourcePath,
		FolderStructure:     req.FolderStructure,
		FileNameFormat:      req.FileNameFormat,
		ConflictResolution:  req.ConflictResolution,
		IncludeSubfolders:   req.IncludeSubfolders,
		FilesFilter:         req.FilesFilter,
		FileExtensionFilter: req.FileExtensionFilter,
	}

	response, err := backend.PreviewOrganization(backendReq)
	if err != nil {
		return "", fmt.Errorf("failed to preview organization: %v", err)
	}

	jsonData, err := json.Marshal(response)
	if err != nil {
		return "", fmt.Errorf("failed to encode response: %v", err)
	}

	return string(jsonData), nil
}

// ExecuteOrganization performs the actual file organization
func (a *App) ExecuteOrganization(req OrganizeExecuteRequest) (string, error) {
	if req.SourcePath == "" {
		return "", fmt.Errorf("source path is required")
	}

	backendReq := backend.OrganizeExecuteRequest{
		SourcePath:         req.SourcePath,
		Items:              req.Items,
		CreateFolders:      req.CreateFolders,
		MoveFiles:          req.MoveFiles,
		DeleteEmptyFolders: req.DeleteEmptyFolders,
		ConflictResolution: req.ConflictResolution,
	}

	response, err := backend.ExecuteOrganization(backendReq)
	if err != nil {
		return "", fmt.Errorf("failed to execute organization: %v", err)
	}

	jsonData, err := json.Marshal(response)
	if err != nil {
		return "", fmt.Errorf("failed to encode response: %v", err)
	}

	return string(jsonData), nil
}

// AnalyzeOrganization provides statistics about how files are currently organized
func (a *App) AnalyzeOrganization(rootPath string) (string, error) {
	if rootPath == "" {
		return "", fmt.Errorf("root path is required")
	}

	analysis, err := backend.AnalyzeOrganization(rootPath)
	if err != nil {
		return "", fmt.Errorf("failed to analyze organization: %v", err)
	}

	jsonData, err := json.Marshal(analysis)
	if err != nil {
		return "", fmt.Errorf("failed to encode response: %v", err)
	}

	return string(jsonData), nil
}

// ValidateOrganizationTemplate checks if a folder structure template is valid
func (a *App) ValidateOrganizationTemplate(template string) (string, error) {
	valid, message := backend.ValidateOrganizationTemplate(template)
	result := map[string]interface{}{
		"valid":   valid,
		"message": message,
	}

	jsonData, err := json.Marshal(result)
	if err != nil {
		return "", fmt.Errorf("failed to encode response: %v", err)
	}

	return string(jsonData), nil
}
