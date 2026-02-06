package backend

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// OrganizePreviewRequest contains the parameters for previewing file organization
type OrganizePreviewRequest struct {
	SourcePath         string   `json:"source_path"`
	FolderStructure    string   `json:"folder_structure"`    // e.g., "{artist}/{album}" or "{album_artist}/{album} ({year})"
	FileNameFormat     string   `json:"file_name_format"`    // Optional: rename files too, e.g., "{track}. {title}"
	ConflictResolution string   `json:"conflict_resolution"` // "skip", "overwrite", "rename"
	IncludeSubfolders  bool     `json:"include_subfolders"`
	FilesFilter        []string `json:"files_filter"` // Optional: specific files to organize
	FileExtensionFilter string  `json:"file_extension_filter"` // Optional: filter by extension (e.g., ".flac")
}

// OrganizePreviewItem represents a single file's organization preview
type OrganizePreviewItem struct {
	SourcePath      string         `json:"source_path"`
	DestinationPath string         `json:"destination_path"`
	FileName        string         `json:"file_name"`
	NewFileName     string         `json:"new_file_name,omitempty"`
	Metadata        *AudioMetadata `json:"metadata,omitempty"`
	Status          string         `json:"status"` // "will_move", "conflict", "missing_metadata", "unchanged", "error"
	ConflictWith    string         `json:"conflict_with,omitempty"`
	Error           string         `json:"error,omitempty"`
	FolderPath      string         `json:"folder_path"` // Just the folder portion of destination
}

// OrganizePreviewResponse contains the complete preview of the organization operation
type OrganizePreviewResponse struct {
	Items           []OrganizePreviewItem `json:"items"`
	TotalFiles      int                   `json:"total_files"`
	WillMove        int                   `json:"will_move"`
	Conflicts       int                   `json:"conflicts"`
	Unchanged       int                   `json:"unchanged"`
	Errors          int                   `json:"errors"`
	FoldersToCreate []string              `json:"folders_to_create"`
}

// OrganizeExecuteRequest contains the parameters for executing file organization
type OrganizeExecuteRequest struct {
	SourcePath         string                `json:"source_path"`
	Items              []OrganizePreviewItem `json:"items"`
	CreateFolders      bool                  `json:"create_folders"`
	MoveFiles          bool                  `json:"move_files"` // true = move, false = copy
	DeleteEmptyFolders bool                  `json:"delete_empty_folders"`
	ConflictResolution string                `json:"conflict_resolution"` // "skip", "overwrite", "rename"
}

// OrganizeExecuteResult represents the result of organizing a single file
type OrganizeExecuteResult struct {
	SourcePath      string `json:"source_path"`
	DestinationPath string `json:"destination_path"`
	Success         bool   `json:"success"`
	Error           string `json:"error,omitempty"`
	Skipped         bool   `json:"skipped,omitempty"`
	Action          string `json:"action,omitempty"` // "moved", "copied", "renamed", "skipped"
}

// OrganizeExecuteResponse contains the complete result of the organization operation
type OrganizeExecuteResponse struct {
	Results        []OrganizeExecuteResult `json:"results"`
	TotalProcessed int                     `json:"total_processed"`
	Succeeded      int                     `json:"succeeded"`
	Failed         int                     `json:"failed"`
	Skipped        int                     `json:"skipped"`
	FoldersCreated int                     `json:"folders_created"`
	FoldersDeleted int                     `json:"folders_deleted"`
	EmptyFolders   []string                `json:"empty_folders,omitempty"`
}

// FolderStructurePreset represents a preset folder structure template
type FolderStructurePreset struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Template    string `json:"template"`
	Description string `json:"description"`
}

// GetFolderStructurePresets returns the available folder structure presets
func GetFolderStructurePresets() []FolderStructurePreset {
	return []FolderStructurePreset{
		{
			ID:          "artist-album",
			Label:       "Artist / Album",
			Template:    "{artist}/{album}",
			Description: "Organizes as: Pink Floyd/The Dark Side of the Moon/",
		},
		{
			ID:          "album_artist-album",
			Label:       "Album Artist / Album",
			Template:    "{album_artist}/{album}",
			Description: "Uses album artist (better for compilations)",
		},
		{
			ID:          "artist-album-year",
			Label:       "Artist / Album (Year)",
			Template:    "{artist}/{album} ({year})",
			Description: "Organizes as: Pink Floyd/The Dark Side of the Moon (1973)/",
		},
		{
			ID:          "album_artist-album-year",
			Label:       "Album Artist / Album (Year)",
			Template:    "{album_artist}/{album} ({year})",
			Description: "Uses album artist with year",
		},
		{
			ID:          "artist-year-album",
			Label:       "Artist / Year - Album",
			Template:    "{artist}/{year} - {album}",
			Description: "Organizes as: Pink Floyd/1973 - The Dark Side of the Moon/",
		},
		{
			ID:          "artist-only",
			Label:       "Artist Only",
			Template:    "{artist}",
			Description: "Flat structure by artist only",
		},
		{
			ID:          "album-only",
			Label:       "Album Only",
			Template:    "{album}",
			Description: "Flat structure by album only",
		},
		{
			ID:          "year-artist-album",
			Label:       "Year / Artist / Album",
			Template:    "{year}/{artist}/{album}",
			Description: "Organizes by year first",
		},
		{
			ID:          "genre-artist-album",
			Label:       "Genre / Artist / Album",
			Template:    "{genre}/{artist}/{album}",
			Description: "Organizes by genre (requires genre metadata)",
		},
	}
}

// PreviewOrganization generates a preview of how files would be organized
func PreviewOrganization(req OrganizePreviewRequest) (*OrganizePreviewResponse, error) {
	if req.SourcePath == "" {
		return nil, fmt.Errorf("source path is required")
	}

	if req.FolderStructure == "" {
		return nil, fmt.Errorf("folder structure template is required")
	}

	// Verify source path exists
	info, err := os.Stat(req.SourcePath)
	if err != nil {
		return nil, fmt.Errorf("source path does not exist: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("source path is not a directory")
	}

	// Collect audio files
	var audioFiles []string
	if len(req.FilesFilter) > 0 {
		// Use provided file list
		audioFiles = req.FilesFilter
	} else {
		// Scan directory for audio files
		audioFiles, err = collectAudioFiles(req.SourcePath, req.IncludeSubfolders)
		if err != nil {
			return nil, fmt.Errorf("failed to scan directory: %w", err)
		}
	}

	// Filter by extension if specified
	if req.FileExtensionFilter != "" {
		filteredFiles := make([]string, 0, len(audioFiles))
		extFilter := strings.ToLower(req.FileExtensionFilter)
		if !strings.HasPrefix(extFilter, ".") {
			extFilter = "." + extFilter
		}
		for _, filePath := range audioFiles {
			if strings.ToLower(filepath.Ext(filePath)) == extFilter {
				filteredFiles = append(filteredFiles, filePath)
			}
		}
		audioFiles = filteredFiles
	}

	response := &OrganizePreviewResponse{
		Items:           make([]OrganizePreviewItem, 0, len(audioFiles)),
		FoldersToCreate: make([]string, 0),
	}

	// Track destination paths to detect conflicts
	destinationMap := make(map[string]string) // destination -> source
	foldersToCreate := make(map[string]bool)

	for _, filePath := range audioFiles {
		item := OrganizePreviewItem{
			SourcePath: filePath,
			FileName:   filepath.Base(filePath),
		}

		// Read metadata
		metadata, err := ReadAudioMetadata(filePath)
		if err != nil {
			item.Status = "error"
			item.Error = fmt.Sprintf("Failed to read metadata: %v", err)
			response.Items = append(response.Items, item)
			response.Errors++
			continue
		}
		item.Metadata = metadata

		// Check if we have enough metadata
		if !hasRequiredMetadata(metadata, req.FolderStructure) {
			item.Status = "missing_metadata"
			item.Error = "Missing required metadata for folder structure"
			response.Items = append(response.Items, item)
			response.Errors++
			continue
		}

		// Generate folder path from template
		folderPath := generateFolderPath(metadata, req.FolderStructure)
		item.FolderPath = folderPath

		// Generate new filename if format specified
		ext := filepath.Ext(filePath)
		newFileName := item.FileName
		if req.FileNameFormat != "" {
			generatedName := GenerateFilename(metadata, req.FileNameFormat, ext)
			if generatedName != "" {
				newFileName = generatedName
				item.NewFileName = newFileName
			}
		}

		// Calculate full destination path
		destPath := filepath.Join(req.SourcePath, folderPath, newFileName)
		item.DestinationPath = destPath

		// Check if destination is same as source (unchanged)
		if destPath == filePath {
			item.Status = "unchanged"
			response.Items = append(response.Items, item)
			response.Unchanged++
			continue
		}

		// Check for conflicts with existing files
		if existingFile, exists := destinationMap[destPath]; exists {
			item.Status = "conflict"
			item.ConflictWith = existingFile
			response.Items = append(response.Items, item)
			response.Conflicts++
			continue
		}

		// Check if destination file already exists on disk
		if _, err := os.Stat(destPath); err == nil {
			item.Status = "conflict"
			item.ConflictWith = destPath + " (existing file)"
			response.Items = append(response.Items, item)
			response.Conflicts++
			continue
		}

		// File will be moved
		item.Status = "will_move"
		destinationMap[destPath] = filePath
		response.Items = append(response.Items, item)
		response.WillMove++

		// Track folders to create
		fullFolderPath := filepath.Join(req.SourcePath, folderPath)
		foldersToCreate[fullFolderPath] = true
	}

	response.TotalFiles = len(audioFiles)

	// Convert folders map to slice
	for folder := range foldersToCreate {
		if _, err := os.Stat(folder); os.IsNotExist(err) {
			response.FoldersToCreate = append(response.FoldersToCreate, folder)
		}
	}

	return response, nil
}

// ExecuteOrganization performs the actual file organization
func ExecuteOrganization(req OrganizeExecuteRequest) (*OrganizeExecuteResponse, error) {
	if req.SourcePath == "" {
		return nil, fmt.Errorf("source path is required")
	}

	response := &OrganizeExecuteResponse{
		Results: make([]OrganizeExecuteResult, 0, len(req.Items)),
	}

	// Track created folders for potential cleanup
	createdFolders := make(map[string]bool)
	sourceFolders := make(map[string]bool)

	for _, item := range req.Items {
		result := OrganizeExecuteResult{
			SourcePath:      item.SourcePath,
			DestinationPath: item.DestinationPath,
		}

		// Skip items that are unchanged or have errors
		if item.Status == "unchanged" || item.Status == "error" || item.Status == "missing_metadata" {
			result.Skipped = true
			result.Action = "skipped"
			result.Success = true
			response.Results = append(response.Results, result)
			response.Skipped++
			continue
		}

		// Handle conflicts based on resolution strategy
		if item.Status == "conflict" {
			switch req.ConflictResolution {
			case "skip":
				result.Skipped = true
				result.Action = "skipped"
				result.Success = true
				response.Results = append(response.Results, result)
				response.Skipped++
				continue
			case "rename":
				// Find a unique filename
				newDest := findUniqueFilename(item.DestinationPath)
				result.DestinationPath = newDest
				item.DestinationPath = newDest
			case "overwrite":
				// Will overwrite, continue with normal processing
			default:
				// Default to skip
				result.Skipped = true
				result.Action = "skipped"
				result.Success = true
				response.Results = append(response.Results, result)
				response.Skipped++
				continue
			}
		}

		// Track source folder for potential cleanup
		sourceFolders[filepath.Dir(item.SourcePath)] = true

		// Create destination folder if needed
		destFolder := filepath.Dir(item.DestinationPath)
		if req.CreateFolders {
			if err := os.MkdirAll(destFolder, 0755); err != nil {
				result.Success = false
				result.Error = fmt.Sprintf("Failed to create folder: %v", err)
				response.Results = append(response.Results, result)
				response.Failed++
				continue
			}
			if _, existed := createdFolders[destFolder]; !existed {
				// Check if folder was newly created
				createdFolders[destFolder] = true
				response.FoldersCreated++
			}
		}

		// Move or copy the file
		var err error
		if req.MoveFiles {
			err = moveFile(item.SourcePath, item.DestinationPath)
			result.Action = "moved"
		} else {
			err = copyFile(item.SourcePath, item.DestinationPath)
			result.Action = "copied"
		}

		if err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("Failed to %s file: %v", result.Action, err)
			response.Results = append(response.Results, result)
			response.Failed++
			continue
		}

		result.Success = true
		response.Results = append(response.Results, result)
		response.Succeeded++
	}

	response.TotalProcessed = len(req.Items)

	// Delete empty source folders if requested and files were moved
	if req.DeleteEmptyFolders && req.MoveFiles {
		emptyFolders := findEmptyFolders(req.SourcePath, sourceFolders)
		response.EmptyFolders = emptyFolders

		for _, folder := range emptyFolders {
			// Don't delete the source root
			if folder == req.SourcePath {
				continue
			}
			if err := os.Remove(folder); err == nil {
				response.FoldersDeleted++
			}
		}
	}

	return response, nil
}

// collectAudioFiles collects all audio files from a directory
func collectAudioFiles(rootPath string, includeSubfolders bool) ([]string, error) {
	var files []string
	audioExts := map[string]bool{
		".flac": true,
		".mp3":  true,
		".m4a":  true,
		".wav":  true,
		".aac":  true,
		".ogg":  true,
		".wma":  true,
	}

	if includeSubfolders {
		err := filepath.Walk(rootPath, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return nil // Skip errors
			}
			if info.IsDir() {
				return nil
			}
			ext := strings.ToLower(filepath.Ext(path))
			if audioExts[ext] {
				files = append(files, path)
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	} else {
		entries, err := os.ReadDir(rootPath)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			ext := strings.ToLower(filepath.Ext(entry.Name()))
			if audioExts[ext] {
				files = append(files, filepath.Join(rootPath, entry.Name()))
			}
		}
	}

	return files, nil
}

// hasRequiredMetadata checks if the metadata has the fields needed for the folder structure
func hasRequiredMetadata(metadata *AudioMetadata, template string) bool {
	if metadata == nil {
		return false
	}

	// Check each placeholder in the template
	if strings.Contains(template, "{artist}") && metadata.Artist == "" {
		return false
	}
	if strings.Contains(template, "{album}") && metadata.Album == "" {
		return false
	}
	if strings.Contains(template, "{album_artist}") {
		// Fall back to artist if album_artist is missing
		if metadata.AlbumArtist == "" && metadata.Artist == "" {
			return false
		}
	}
	if strings.Contains(template, "{year}") && metadata.Year == "" {
		return false
	}
	// Genre would require extending AudioMetadata
	if strings.Contains(template, "{genre}") {
		return false // Genre not currently in AudioMetadata
	}

	return true
}

// generateFolderPath creates the folder path from metadata and template
func generateFolderPath(metadata *AudioMetadata, template string) string {
	result := template

	// Extract year (first 4 characters if longer)
	year := metadata.Year
	if len(year) >= 4 {
		year = year[:4]
	}

	// Use album artist, fallback to artist
	albumArtist := metadata.AlbumArtist
	if albumArtist == "" {
		albumArtist = metadata.Artist
	}

	// Replace placeholders
	result = strings.ReplaceAll(result, "{artist}", sanitizePathComponent(metadata.Artist))
	result = strings.ReplaceAll(result, "{album}", sanitizePathComponent(metadata.Album))
	result = strings.ReplaceAll(result, "{album_artist}", sanitizePathComponent(albumArtist))
	result = strings.ReplaceAll(result, "{year}", sanitizePathComponent(year))
	result = strings.ReplaceAll(result, "{title}", sanitizePathComponent(metadata.Title))

	// Handle track and disc numbers
	if metadata.TrackNumber > 0 {
		result = strings.ReplaceAll(result, "{track}", fmt.Sprintf("%02d", metadata.TrackNumber))
	} else {
		result = strings.ReplaceAll(result, "{track}", "")
	}
	if metadata.DiscNumber > 0 {
		result = strings.ReplaceAll(result, "{disc}", fmt.Sprintf("%d", metadata.DiscNumber))
	} else {
		result = strings.ReplaceAll(result, "{disc}", "")
	}

	// Clean up empty segments and normalize path
	parts := strings.Split(result, "/")
	var cleanParts []string
	for _, part := range parts {
		part = strings.TrimSpace(part)
		// Remove empty parts and parts that are just punctuation
		if part != "" && part != "-" && part != "()" && part != "[]" {
			cleanParts = append(cleanParts, part)
		}
	}

	return filepath.Join(cleanParts...)
}

// sanitizePathComponent removes or replaces invalid characters for file/folder names
func sanitizePathComponent(name string) string {
	if name == "" {
		return ""
	}

	// Characters invalid in Windows file names
	invalid := []string{"<", ">", ":", "\"", "|", "?", "*"}
	result := name

	for _, char := range invalid {
		result = strings.ReplaceAll(result, char, "")
	}

	// Replace forward/backward slashes as they're path separators
	result = strings.ReplaceAll(result, "/", "-")
	result = strings.ReplaceAll(result, "\\", "-")

	// Trim spaces and dots from ends (Windows restriction)
	result = strings.Trim(result, " .")

	return result
}

// moveFile moves a file from src to dst
func moveFile(src, dst string) error {
	// First try simple rename (works if same filesystem)
	err := os.Rename(src, dst)
	if err == nil {
		return nil
	}

	// If rename fails (cross-filesystem), copy then delete
	if err := copyFile(src, dst); err != nil {
		return err
	}

	return os.Remove(src)
}

// copyFile copies a file from src to dst
func copyFile(src, dst string) error {
	sourceFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer sourceFile.Close()

	// Get source file info for permissions
	sourceInfo, err := sourceFile.Stat()
	if err != nil {
		return err
	}

	destFile, err := os.OpenFile(dst, os.O_RDWR|os.O_CREATE|os.O_TRUNC, sourceInfo.Mode())
	if err != nil {
		return err
	}
	defer destFile.Close()

	// Copy in chunks
	buf := make([]byte, 1024*1024) // 1MB buffer
	for {
		n, err := sourceFile.Read(buf)
		if n > 0 {
			if _, writeErr := destFile.Write(buf[:n]); writeErr != nil {
				return writeErr
			}
		}
		if err != nil {
			if err.Error() == "EOF" {
				break
			}
			return err
		}
	}

	return nil
}

// findUniqueFilename finds a unique filename by appending a number
func findUniqueFilename(path string) string {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return path
	}

	dir := filepath.Dir(path)
	ext := filepath.Ext(path)
	base := strings.TrimSuffix(filepath.Base(path), ext)

	for i := 1; i < 1000; i++ {
		newPath := filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, i, ext))
		if _, err := os.Stat(newPath); os.IsNotExist(err) {
			return newPath
		}
	}

	// Fallback: use timestamp
	return filepath.Join(dir, fmt.Sprintf("%s_%d%s", base, os.Getpid(), ext))
}

// findEmptyFolders finds all empty folders starting from the deepest level
func findEmptyFolders(rootPath string, sourceFolders map[string]bool) []string {
	var emptyFolders []string

	// Collect all potential folders to check
	foldersToCheck := make([]string, 0)
	for folder := range sourceFolders {
		// Walk up to root, adding each parent
		current := folder
		for current != rootPath && strings.HasPrefix(current, rootPath) {
			foldersToCheck = append(foldersToCheck, current)
			current = filepath.Dir(current)
		}
	}

	// Sort by depth (deepest first) to delete children before parents
	// Simple approach: longer paths are deeper
	for i := 0; i < len(foldersToCheck); i++ {
		for j := i + 1; j < len(foldersToCheck); j++ {
			if len(foldersToCheck[j]) > len(foldersToCheck[i]) {
				foldersToCheck[i], foldersToCheck[j] = foldersToCheck[j], foldersToCheck[i]
			}
		}
	}

	// Remove duplicates while maintaining order
	seen := make(map[string]bool)
	uniqueFolders := make([]string, 0)
	for _, folder := range foldersToCheck {
		if !seen[folder] {
			seen[folder] = true
			uniqueFolders = append(uniqueFolders, folder)
		}
	}

	// Check each folder for emptiness
	for _, folder := range uniqueFolders {
		entries, err := os.ReadDir(folder)
		if err != nil {
			continue
		}
		if len(entries) == 0 {
			emptyFolders = append(emptyFolders, folder)
		}
	}

	return emptyFolders
}

// AnalyzeOrganization provides statistics about how files are currently organized
func AnalyzeOrganization(rootPath string) (*OrganizationAnalysis, error) {
	if rootPath == "" {
		return nil, fmt.Errorf("root path is required")
	}

	analysis := &OrganizationAnalysis{
		ArtistFolders:    make(map[string]int),
		AlbumFolders:     make(map[string]int),
		OrphanedFiles:    make([]string, 0),
		MissingMetadata:  make([]string, 0),
		InconsistentPath: make([]string, 0),
	}

	audioFiles, err := collectAudioFiles(rootPath, true)
	if err != nil {
		return nil, err
	}

	analysis.TotalFiles = len(audioFiles)

	for _, filePath := range audioFiles {
		// Check folder depth
		relPath, _ := filepath.Rel(rootPath, filePath)
		depth := len(strings.Split(relPath, string(os.PathSeparator))) - 1 // -1 for the file itself

		if depth == 0 {
			// File is directly in root, likely orphaned
			analysis.OrphanedFiles = append(analysis.OrphanedFiles, filePath)
			continue
		}

		// Read metadata
		metadata, err := ReadAudioMetadata(filePath)
		if err != nil || metadata == nil {
			analysis.MissingMetadata = append(analysis.MissingMetadata, filePath)
			continue
		}

		// Check if file path matches metadata
		parentDir := filepath.Base(filepath.Dir(filePath))

		// Simple check: does the parent folder contain the album or artist name?
		matchesArtist := metadata.Artist != "" && strings.Contains(strings.ToLower(parentDir), strings.ToLower(metadata.Artist))
		matchesAlbum := metadata.Album != "" && strings.Contains(strings.ToLower(parentDir), strings.ToLower(metadata.Album))

		if !matchesArtist && !matchesAlbum && metadata.Artist != "" && metadata.Album != "" {
			analysis.InconsistentPath = append(analysis.InconsistentPath, filePath)
		}

		// Track artists and albums
		if metadata.Artist != "" {
			analysis.ArtistFolders[metadata.Artist]++
		}
		if metadata.Album != "" {
			analysis.AlbumFolders[metadata.Album]++
		}
	}

	analysis.UniqueArtists = len(analysis.ArtistFolders)
	analysis.UniqueAlbums = len(analysis.AlbumFolders)

	return analysis, nil
}

// OrganizationAnalysis provides statistics about the current file organization
type OrganizationAnalysis struct {
	TotalFiles       int            `json:"total_files"`
	UniqueArtists    int            `json:"unique_artists"`
	UniqueAlbums     int            `json:"unique_albums"`
	OrphanedFiles    []string       `json:"orphaned_files"`    // Files in root without proper folder structure
	MissingMetadata  []string       `json:"missing_metadata"`  // Files without readable metadata
	InconsistentPath []string       `json:"inconsistent_path"` // Files where path doesn't match metadata
	ArtistFolders    map[string]int `json:"artist_folders"`    // Artist name -> file count
	AlbumFolders     map[string]int `json:"album_folders"`     // Album name -> file count
}

// ValidateOrganizationTemplate checks if a template is valid
func ValidateOrganizationTemplate(template string) (bool, string) {
	if template == "" {
		return false, "Template cannot be empty"
	}

	// Check for at least one valid placeholder
	validPlaceholders := []string{"{artist}", "{album}", "{album_artist}", "{year}", "{title}", "{track}", "{disc}"}
	hasPlaceholder := false
	for _, p := range validPlaceholders {
		if strings.Contains(template, p) {
			hasPlaceholder = true
			break
		}
	}

	if !hasPlaceholder {
		return false, "Template must contain at least one placeholder like {artist}, {album}, etc."
	}

	// Check for invalid characters
	invalidChars := []string{"<", ">", ":", "\"", "|", "?", "*"}
	for _, char := range invalidChars {
		if strings.Contains(template, char) {
			return false, fmt.Sprintf("Template contains invalid character: %s", char)
		}
	}

	return true, ""
}
