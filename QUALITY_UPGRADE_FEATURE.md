# Quality Upgrade Feature Documentation

## Table of Contents
1. [Overview](#overview)
2. [Codebase Discovery](#codebase-discovery)
3. [Feature Requirements](#feature-requirements)
4. [Implementation Decisions](#implementation-decisions)
5. [Technical Implementation](#technical-implementation)
6. [Architecture](#architecture)
7. [Usage Guide](#usage-guide)
8. [Troubleshooting](#troubleshooting)

---

## Overview

This document describes the implementation of the **Quality Upgrade Suggestion** feature for SpotiFLAC. This feature allows users to scan their existing music library, automatically detect song information from files (even without metadata), find matching tracks on Spotify, and get suggestions for downloading higher-quality versions from Tidal, Qobuz, or Amazon Music.

---

## Codebase Discovery

### Initial Investigation

When first exploring the codebase, I discovered:

1. **Technology Stack:**
   - **Backend:** Go (using Wails v2 framework)
   - **Frontend:** React + TypeScript + Vite
   - **UI Framework:** Radix UI components with Tailwind CSS
   - **Build System:** Wails CLI for cross-platform compilation

2. **Project Structure:**
   ```
   SpotiFLAC/
   ├── backend/          # Go backend code
   │   ├── metadata.go   # Audio metadata reading (FLAC, MP3, M4A)
   │   ├── filemanager.go # File operations and listing
   │   ├── spotify_metadata.go # Spotify API integration
   │   ├── songlink.go   # Song.link API for availability checking
   │   ├── tidal.go      # Tidal downloader
   │   ├── qobuz.go      # Qobuz downloader
   │   └── amazon.go     # Amazon Music downloader
   ├── frontend/         # React frontend
   │   └── src/
   │       ├── components/ # UI components
   │       ├── hooks/      # React hooks (useDownload, useMetadata, etc.)
   │       └── lib/        # Utilities and API clients
   └── app.go            # Main Wails app with API endpoints
   ```

3. **Key Discoveries:**

   **Metadata Reading:**
   - The app already had robust metadata reading via `ReadAudioMetadata()` in `filemanager.go`
   - Supports FLAC, MP3, and M4A formats
   - Uses `id3v2` library for MP3, `go-flac` for FLAC, and `ffprobe` for M4A

   **Spotify Integration:**
   - `SearchSpotifyByType()` function exists for searching tracks
   - Uses Spotify's GraphQL API (via `spotfetch.go`)
   - Can search by query string (e.g., "Title Artist")

   **Availability Checking:**
   - `CheckTrackAvailability()` in `songlink.go` checks if tracks are available on Tidal/Qobuz/Amazon
   - Uses Song.link API which provides cross-platform links
   - Returns availability status and URLs for each service

   **Download System:**
   - `DownloadTrack()` in `app.go` handles downloads
   - Uses `useDownload` hook in frontend
   - Supports auto-fallback between services (Tidal → Amazon → Qobuz)
   - Requires ISRC or Spotify ID for downloads

   **File Management:**
   - `ListAudioFiles()` recursively finds all audio files in a directory
   - `FileManagerPage` component already exists with tabs for tracks/lyrics/covers
   - Uses tree structure for nested folders

---

## Feature Requirements

### Original Request
1. **Automatic folder input:** Scan a folder with existing music files
2. **Song name detection:** Extract song information from files
3. **Quality upgrade suggestions:** Find and suggest higher-quality versions available for download

### Refined Requirements (After User Feedback)
1. **Show all files immediately** - Don't wait for batch processing
2. **Individual file scanning** - Button next to each file to search manually
3. **Filename parsing** - Handle files without metadata (common with old YouTube downloads)
4. **Working download button** - Actually trigger downloads, not just open Spotify

---

## Implementation Decisions

### Decision 1: Individual File Scanning vs Batch Processing

**Initial Approach:** Batch scan entire folder, show results when complete.

**Problem:** User wanted to see files immediately and scan selectively.

**Decision:** 
- Show all audio files immediately when tab is opened
- Add "Find Upgrade" button next to each file
- Scan files individually on-demand
- Store results in a Map (file path → suggestion) for instant updates

**Rationale:**
- Better UX: Users can see their library immediately
- More efficient: Only scan files user is interested in
- Progressive: Results appear as they're found
- Non-blocking: User can continue browsing while scans happen

### Decision 2: Filename Parsing Strategy

**Problem:** Many files (especially from old YouTube downloads) have no metadata tags.

**Discovery:** Filenames often follow patterns like:
- `"Artist - Title.mp3"`
- `"Title - Artist.mp3"`
- `"01. Title - Artist.mp3"`
- `"Artist feat. Other - Title.mp3"`

**Decision:** Implement multi-pattern filename parser with fallback hierarchy:
1. Try to read metadata from file tags
2. If missing, parse filename using regex patterns
3. Patterns tried in order of specificity (numbered tracks → dash-separated → "by"/"feat" patterns)
4. If all fail, use filename as title with "Unknown Artist"

**Rationale:**
- Handles most common filename formats
- Case-insensitive matching
- Removes common artifacts (brackets, extra spaces)
- Always provides some metadata for searching

### Decision 3: Download Integration

**Problem:** Download button only opened Spotify URL instead of downloading.

**Discovery:**
- `useDownload` hook exists with `handleDownloadTrack()` function
- Requires ISRC or Spotify ID
- For Tidal/Amazon: Spotify ID can be used directly
- For Qobuz: Needs ISRC (fetched from Deezer via Song.link)

**Decision:**
- Use Spotify ID as ISRC parameter (works for Tidal/Amazon)
- Pass track metadata from suggestion to download function
- Let the download system handle ISRC fetching for Qobuz if needed
- Use existing download queue and progress system

**Rationale:**
- Reuses existing, tested download infrastructure
- Maintains consistency with rest of app
- Handles service fallback automatically
- Shows download progress in existing UI

### Decision 4: UI/UX Design

**Decision:** Add new tab to existing File Manager instead of separate page.

**Rationale:**
- File Manager already has folder selection and file listing
- Consistent with existing UI patterns
- Users already familiar with File Manager interface
- Reuses existing file tree structure

---

## Technical Implementation

### Backend Implementation

#### 1. New File: `backend/quality_upgrade.go`

**Key Functions:**

**`parseFilenameForMetadata(fileName string) *AudioMetadata`**
- Parses filename using regex patterns
- Handles common formats: "Artist - Title", "Title - Artist", numbered tracks, etc.
- Returns AudioMetadata with title and artist extracted

**`ScanSingleFileForQualityUpgrade(ctx, filePath) (*QualityUpgradeSuggestion, error)`**
- Main function for scanning a single file
- Flow:
  1. Read file metadata (if available)
  2. If missing, parse filename
  3. Search Spotify using "Title Artist" query
  4. Find best match from search results
  5. Check availability on Tidal/Qobuz/Amazon
  6. Return suggestion with all information

**`findBestMatch(metadata, searchResults) *SearchResult`**
- Matches local file metadata with Spotify search results
- Prioritizes exact title + artist matches
- Falls back to title-only matches
- Returns best match or first result

**`calculateMatchConfidence(metadata, track) string`**
- Calculates match quality: "high", "medium", or "low"
- Based on exact vs. partial matches for title and artist

#### 2. API Endpoint: `app.go`

**`ScanSingleFileForQualityUpgrade(req ScanSingleFileRequest) (string, error)`**
- Wails API endpoint exposing backend function
- Takes file path, returns JSON string with suggestion
- 30-second timeout for individual file scans

### Frontend Implementation

#### 1. File Manager Page Updates

**State Management:**
```typescript
const [qualityUpgradeSuggestions, setQualityUpgradeSuggestions] = useState<Map<string, QualityUpgradeSuggestion>>(new Map());
const [scanningFiles, setScanningFiles] = useState<Set<string>>(new Set());
const download = useDownload();
```

**Key Functions:**

**`handleScanSingleFile(filePath: string)`**
- Calls backend API to scan single file
- Updates suggestions Map with result
- Shows toast notifications for success/errors
- Manages loading state per file

**`renderQualityUpgradeFiles(files: FileNode[])`**
- Renders list of all audio files
- Shows "Find Upgrade" button for unscanned files
- Displays suggestions inline when available
- Shows download button when upgrade is available

#### 2. UI Components

**File Display:**
- File name with format badge
- Metadata (title, artist, album) when available
- Spotify match information
- Availability badges (Tidal, Amazon, Qobuz)
- Match confidence badge (high/medium/low)

**Buttons:**
- "Find Upgrade" - Triggers search for unscanned files
- "Download" - Triggers actual download via download system
- "Refresh" - Re-scans file if no upgrade found

---

## Architecture

### Data Flow

```
User clicks "Find Upgrade"
    ↓
Frontend: handleScanSingleFile(filePath)
    ↓
Backend API: ScanSingleFileForQualityUpgrade(filePath)
    ↓
Backend: ReadAudioMetadata(filePath)
    ↓ (if missing)
Backend: parseFilenameForMetadata(fileName)
    ↓
Backend: SearchSpotifyByType(query, "track")
    ↓
Backend: findBestMatch(metadata, results)
    ↓
Backend: CheckTrackAvailability(spotifyID)
    ↓
Backend: Return QualityUpgradeSuggestion
    ↓
Frontend: Update suggestions Map
    ↓
UI: Display suggestion inline
```

### Download Flow

```
User clicks "Download"
    ↓
Frontend: download.handleDownloadTrack(spotifyID, ...)
    ↓
Frontend: downloadWithAutoFallback()
    ↓
Backend: DownloadTrack(DownloadRequest)
    ↓
Backend: Service-specific downloader (Tidal/Qobuz/Amazon)
    ↓
Backend: Download file with metadata embedding
    ↓
Frontend: Show success/error toast
```

### File Structure

```
backend/
  └── quality_upgrade.go          # New: Quality upgrade scanning logic

app.go
  └── ScanSingleFileForQualityUpgrade()  # New: API endpoint

frontend/src/components/
  └── FileManagerPage.tsx         # Modified: Added quality upgrade tab

frontend/src/hooks/
  └── useDownload.ts              # Existing: Used for downloads
```

---

## Usage Guide

### Basic Usage

1. **Open File Manager:**
   - Click "File Manager" in the sidebar
   - Navigate to the "Quality Upgrade" tab

2. **Select Folder:**
   - Click "Browse" and select a folder with music files
   - All audio files (FLAC, MP3, M4A) will be listed immediately

3. **Find Upgrades:**
   - Click "Find Upgrade" button next to any file
   - The system will:
     - Extract metadata or parse filename
     - Search Spotify for matching tracks
     - Check availability on high-quality services
     - Display results inline

4. **Download:**
   - If an upgrade is available, click "Download"
   - The track will be downloaded in FLAC quality
   - Progress shown in download queue

### Filename Parsing

The system automatically parses filenames when metadata is missing. Supported patterns:

- `"Artist - Title.mp3"` → Artist: "Artist", Title: "Title"
- `"Title - Artist.mp3"` → Artist: "Artist", Title: "Title"
- `"01. Title - Artist.mp3"` → Artist: "Artist", Title: "Title"
- `"Artist feat. Other - Title.mp3"` → Artist: "Artist feat. Other", Title: "Title"
- `"Title by Artist.mp3"` → Artist: "Artist", Title: "Title"

### Match Confidence

- **High:** Exact title match + artist match (exact or contains)
- **Medium:** Partial title match + artist match
- **Low:** Only partial matches or first search result

---

## Troubleshooting

### Issue: "Missing title or artist metadata"

**Cause:** File has no metadata tags and filename doesn't match known patterns.

**Solution:**
- Rename file to follow pattern: `"Artist - Title.ext"`
- Or manually add metadata using a tag editor

### Issue: "No matching tracks found on Spotify"

**Possible Causes:**
1. Track not available on Spotify
2. Filename/metadata doesn't match Spotify's database
3. Search query too specific or misspelled

**Solution:**
- Verify the track exists on Spotify manually
- Check if filename has typos
- Try renaming to match Spotify's format

### Issue: Download button does nothing

**Possible Causes:**
1. No availability on any service
2. Download system error
3. Missing ISRC for Qobuz

**Solution:**
- Check availability badges - at least one should be green
- Check download queue for error messages
- For Qobuz, the system will try to fetch ISRC automatically

### Issue: Filename parsing incorrect

**Cause:** Filename doesn't match expected patterns.

**Solution:**
- Rename file to: `"Artist - Title.ext"` format
- Or add proper metadata tags to the file

---

## Technical Details

### Filename Parsing Patterns

The parser tries these patterns in order:

1. **Numbered tracks:** `^\d+[.\s-]+(.+?)\s*-\s*(.+)$`
   - Matches: "01. Title - Artist" or "1 - Title - Artist"

2. **Dash-separated:** `^(.+?)\s*-\s*(.+)$`
   - Matches: "Artist - Title" or "Title - Artist"

3. **"by" keyword:** `^(.+?)\s+by\s+(.+)$`
   - Matches: "Title by Artist"

4. **"feat" variations:** `^(.+?)\s+(feat|ft|featuring)\.?\s+(.+)$`
   - Matches: "Artist feat. Other - Title"

5. **"vs" or "x":** `^(.+?)\s+(vs|x)\.?\s+(.+)$`
   - Matches: "Artist vs Other" or "Artist x Other"

All patterns are case-insensitive and trim whitespace/brackets.

### Spotify Search Strategy

1. **Query Construction:** `"{Title} {Artist}"`
2. **Search Limit:** 5 results (enough for matching)
3. **Matching Logic:**
   - First: Exact title + artist match
   - Second: Title match only
   - Fallback: First search result

### Availability Checking

Uses Song.link API which:
- Takes Spotify URL
- Returns links to other platforms
- Rate-limited (9 requests/minute, 7 seconds between requests)
- Automatically fetches ISRC from Deezer for Qobuz

### Download System Integration

The download system:
- Uses Spotify ID as ISRC for Tidal/Amazon
- Fetches ISRC from Deezer for Qobuz (if needed)
- Supports auto-fallback: Tidal → Amazon → Qobuz
- Embeds metadata and cover art
- Shows progress in download queue

---

## Future Improvements

Potential enhancements:

1. **Batch Scanning:** Option to scan all files at once (with progress bar)
2. **Smart Matching:** Use audio fingerprinting for better matches
3. **Quality Comparison:** Show current vs. available quality
4. **Bulk Download:** Select multiple files and download all upgrades
5. **Filename Pattern Learning:** Learn from user corrections
6. **Cache Results:** Store suggestions to avoid re-scanning
7. **Export List:** Export suggestions to CSV/JSON

---

## Code References

### Backend Files
- `backend/quality_upgrade.go` - Main quality upgrade logic
- `backend/filemanager.go` - File operations and metadata reading
- `backend/spotify_metadata.go` - Spotify search integration
- `backend/songlink.go` - Availability checking
- `app.go` - API endpoints

### Frontend Files
- `frontend/src/components/FileManagerPage.tsx` - UI implementation
- `frontend/src/hooks/useDownload.ts` - Download functionality
- `frontend/src/lib/api.ts` - API client functions

---

## Conclusion

The Quality Upgrade feature successfully:
- ✅ Scans folders for existing music files
- ✅ Extracts song information from metadata or filenames
- ✅ Finds matching tracks on Spotify
- ✅ Checks availability on high-quality services
- ✅ Provides one-click downloads
- ✅ Handles files without metadata gracefully

The implementation follows existing codebase patterns, reuses existing infrastructure, and provides a smooth user experience for upgrading music library quality.

