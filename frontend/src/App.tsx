import { useState, useEffect, useCallback, useRef, Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Search, X, ArrowUp } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  getSettings,
  getSettingsWithDefaults,
  saveSettings,
  applyThemeMode,
  applyFont,
} from "@/lib/settings";
import { applyTheme } from "@/lib/themes";
import { OpenFolder } from "../wailsjs/go/main/App";
import { toastWithSound as toast } from "@/lib/toast-with-sound";
import { TitleBar } from "@/components/TitleBar";
import { Sidebar, type PageType } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { SearchBar } from "@/components/SearchBar";
import { TrackInfo } from "@/components/TrackInfo";
import { AlbumInfo } from "@/components/AlbumInfo";
import { PlaylistInfo } from "@/components/PlaylistInfo";
import { ArtistInfo } from "@/components/ArtistInfo";
import { DownloadQueue } from "@/components/DownloadQueue";
import { DownloadProgressToast } from "@/components/DownloadProgressToast";
import { AudioAnalysisPage } from "@/components/AudioAnalysisPage";
import { AudioConverterPage } from "@/components/AudioConverterPage";
import { FileManagerPage } from "@/components/FileManagerPage";
import { QualityUpgradePage } from "@/components/QualityUpgradePage";
import { SettingsPage } from "@/components/SettingsPage";
import { DebugLoggerPage } from "@/components/DebugLoggerPage";
import { Dashboard } from "@/components/Dashboard";
import { ForLaterPage } from "@/components/ForLaterPage";
import type { HistoryItem } from "@/components/FetchHistory";
import type { ForLaterItem } from "@/types/for-later";
import { useDownload } from "@/hooks/useDownload";
import { useMetadata } from "@/hooks/useMetadata";
import { useLyrics } from "@/hooks/useLyrics";
import { useCover } from "@/hooks/useCover";
import { useAvailability } from "@/hooks/useAvailability";
import { useDownloadQueueDialog } from "@/hooks/useDownloadQueueDialog";
const HISTORY_KEY = "spotiflac_fetch_history";
const MAX_HISTORY = 5;
const FOR_LATER_KEY = "spotiflac_for_later";

// Error Boundary to catch and display crashes instead of crashing the entire app
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("App Error Boundary caught an error:", error, errorInfo);
    this.setState({ errorInfo });

    // Log to localStorage for debugging
    try {
      const errorLog = {
        timestamp: new Date().toISOString(),
        error: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
      };
      const existingLogs = JSON.parse(
        localStorage.getItem("spotiflac_error_logs") || "[]",
      );
      existingLogs.push(errorLog);
      // Keep only last 10 errors
      if (existingLogs.length > 10) {
        existingLogs.shift();
      }
      localStorage.setItem(
        "spotiflac_error_logs",
        JSON.stringify(existingLogs),
      );
    } catch {
      // Ignore localStorage errors
    }
  }

  handleReload = () => {
    window.location.reload();
  };

  handleCopyError = () => {
    const { error, errorInfo } = this.state;
    const errorText = `Error: ${error?.message}\n\nStack: ${error?.stack}\n\nComponent Stack: ${errorInfo?.componentStack}`;
    navigator.clipboard.writeText(errorText).then(() => {
      alert("Error details copied to clipboard");
    });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-background flex items-center justify-center p-8">
          <div className="max-w-lg w-full bg-card border border-border rounded-lg p-6 shadow-lg">
            <h1 className="text-xl font-bold text-red-500 mb-4">
              Something went wrong
            </h1>
            <p className="text-muted-foreground mb-4">
              The application encountered an unexpected error. This has been
              logged for debugging.
            </p>
            <div className="bg-muted rounded p-3 mb-4 max-h-48 overflow-auto">
              <code className="text-xs text-red-400 whitespace-pre-wrap">
                {this.state.error?.message}
              </code>
            </div>
            <div className="flex gap-3">
              <button
                onClick={this.handleReload}
                className="flex-1 bg-primary text-primary-foreground px-4 py-2 rounded hover:bg-primary/90"
              >
                Reload App
              </button>
              <button
                onClick={this.handleCopyError}
                className="px-4 py-2 border border-border rounded hover:bg-muted"
              >
                Copy Error
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function App() {
  const [currentPage, setCurrentPage] = useState<PageType>("main");
  const [spotifyUrl, setSpotifyUrl] = useState("");
  const [selectedTracks, setSelectedTracks] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<string>("default");
  const [currentListPage, setCurrentListPage] = useState(1);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [releaseDate, setReleaseDate] = useState<string | null>(null);
  const [fetchHistory, setFetchHistory] = useState<HistoryItem[]>([]);
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [hasUnsavedSettings, setHasUnsavedSettings] = useState(false);
  const [pendingPageChange, setPendingPageChange] = useState<PageType | null>(
    null,
  );
  const [showUnsavedChangesDialog, setShowUnsavedChangesDialog] =
    useState(false);
  const [resetSettingsFn, setResetSettingsFn] = useState<(() => void) | null>(
    null,
  );
  const [showDashboard, setShowDashboard] = useState(true);
  const [pendingFetchSearchQuery, setPendingFetchSearchQuery] = useState<
    string | null
  >(null);
  const [forLaterList, setForLaterList] = useState<ForLaterItem[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const ITEMS_PER_PAGE = 50;
  const CURRENT_VERSION = "7.0.4";
  const download = useDownload();
  const metadata = useMetadata();
  const lyrics = useLyrics();
  const cover = useCover();
  const availability = useAvailability();
  const downloadQueue = useDownloadQueueDialog();
  useEffect(() => {
    const initSettings = async () => {
      const settings = getSettings();
      applyThemeMode(settings.themeMode);
      applyTheme(settings.theme);
      applyFont(settings.fontFamily);
      if (!settings.downloadPath) {
        const settingsWithDefaults = await getSettingsWithDefaults();
        saveSettings(settingsWithDefaults);
      }
    };
    initSettings();
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      const currentSettings = getSettings();
      if (currentSettings.themeMode === "auto") {
        applyThemeMode("auto");
        applyTheme(currentSettings.theme);
      }
    };
    mediaQuery.addEventListener("change", handleChange);
    checkForUpdates();
    loadHistory();
    loadForLater();
    const handleScroll = () => {
      setShowScrollTop(window.scrollY > 300);
    };
    window.addEventListener("scroll", handleScroll);
    return () => {
      mediaQuery.removeEventListener("change", handleChange);
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);
  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  useEffect(() => {
    setSelectedTracks([]);
    setSearchQuery("");
    download.resetDownloadedTracks();
    lyrics.resetLyricsState();
    cover.resetCoverState();
    availability.clearAvailability();
    setSortBy("default");
    setCurrentListPage(1);
  }, [metadata.metadata]);
  const checkForUpdates = async () => {
    try {
      const response = await fetch(
        "https://api.github.com/repos/afkarxyz/SpotiFLAC/releases/latest",
      );
      const data = await response.json();
      const latestVersion = data.tag_name?.replace(/^v/, "") || "";
      if (data.published_at) {
        setReleaseDate(data.published_at);
      }
      if (latestVersion && latestVersion > CURRENT_VERSION) {
        setHasUpdate(true);
      }
    } catch (err) {
      console.error("Failed to check for updates:", err);
    }
  };
  const loadHistory = () => {
    try {
      const saved = localStorage.getItem(HISTORY_KEY);
      if (saved) {
        setFetchHistory(JSON.parse(saved));
      }
    } catch (err) {
      console.error("Failed to load history:", err);
    }
  };
  const saveHistory = (history: HistoryItem[]) => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (err) {
      console.error("Failed to save history:", err);
    }
  };
  const addToHistory = (item: Omit<HistoryItem, "id" | "timestamp">) => {
    setFetchHistory((prev) => {
      const filtered = prev.filter((h) => h.url !== item.url);
      const newItem: HistoryItem = {
        ...item,
        id: crypto.randomUUID(),
        timestamp: Date.now(),
      };
      const updated = [newItem, ...filtered].slice(0, MAX_HISTORY);
      saveHistory(updated);
      return updated;
    });
  };
  const removeFromHistory = (id: string) => {
    setFetchHistory((prev) => {
      const updated = prev.filter((h) => h.id !== id);
      saveHistory(updated);
      return updated;
    });
  };
  const loadForLater = () => {
    try {
      const saved = localStorage.getItem(FOR_LATER_KEY);
      if (saved) {
        setForLaterList(JSON.parse(saved));
      }
    } catch (err) {
      console.error("Failed to load for later list:", err);
    }
  };
  const saveForLater = (items: ForLaterItem[]) => {
    try {
      localStorage.setItem(FOR_LATER_KEY, JSON.stringify(items));
    } catch (err) {
      console.error("Failed to save for later list:", err);
    }
  };
  const addForLater = (item: Omit<ForLaterItem, "id" | "addedAt">) => {
    setForLaterList((prev) => {
      // Check for duplicates by spotifyUrl or searchQuery
      const existingIndex = prev.findIndex(
        (i) =>
          (item.spotifyUrl && i.spotifyUrl === item.spotifyUrl) ||
          (!item.spotifyUrl &&
            item.searchQuery &&
            i.searchQuery === item.searchQuery)
      );
      const newItem: ForLaterItem = {
        ...item,
        id: crypto.randomUUID(),
        addedAt: Date.now(),
      };
      let updated: ForLaterItem[];
      if (existingIndex >= 0) {
        // Replace and move to top
        updated = [...prev];
        updated.splice(existingIndex, 1);
        updated = [newItem, ...updated];
        toast.info("Updated in list");
      } else {
        updated = [newItem, ...prev];
      }
      saveForLater(updated);
      return updated;
    });
  };
  const removeForLater = (id: string) => {
    setForLaterList((prev) => {
      const updated = prev.filter((i) => i.id !== id);
      saveForLater(updated);
      return updated;
    });
  };
  const handleOpenForLater = async (item: ForLaterItem) => {
    setCurrentPage("main");
    setShowDashboard(false);
    if (item.spotifyUrl) {
      setSpotifyUrl(item.spotifyUrl);
      const updatedUrl = await metadata.handleFetchMetadata(item.spotifyUrl);
      if (updatedUrl) {
        setSpotifyUrl(updatedUrl);
      }
    } else if (item.searchQuery) {
      setPendingFetchSearchQuery(item.searchQuery);
    }
  };
  const handleHistorySelect = async (item: HistoryItem) => {
    setSpotifyUrl(item.url);
    const updatedUrl = await metadata.handleFetchMetadata(item.url);
    if (updatedUrl) {
      setSpotifyUrl(updatedUrl);
    }
  };
  const handleFetchMetadata = async () => {
    const updatedUrl = await metadata.handleFetchMetadata(spotifyUrl);
    if (updatedUrl) {
      setSpotifyUrl(updatedUrl);
    }
  };
  useEffect(() => {
    if (!metadata.metadata || !spotifyUrl) return;
    let historyItem: Omit<HistoryItem, "id" | "timestamp"> | null = null;
    if ("track" in metadata.metadata) {
      const { track } = metadata.metadata;
      historyItem = {
        url: spotifyUrl,
        type: "track",
        name: track.name,
        artist: track.artists,
        image: track.images,
      };
    } else if ("album_info" in metadata.metadata) {
      const { album_info } = metadata.metadata;
      historyItem = {
        url: spotifyUrl,
        type: "album",
        name: album_info.name,
        artist: `${album_info.total_tracks} tracks`,
        image: album_info.images,
      };
    } else if ("playlist_info" in metadata.metadata) {
      const { playlist_info } = metadata.metadata;
      historyItem = {
        url: spotifyUrl,
        type: "playlist",
        name: playlist_info.owner.name,
        artist: `${playlist_info.tracks.total} tracks`,
        image: playlist_info.cover || playlist_info.owner.images || "",
      };
    } else if ("artist_info" in metadata.metadata) {
      const { artist_info } = metadata.metadata;
      historyItem = {
        url: spotifyUrl,
        type: "artist",
        name: artist_info.name,
        artist: `${artist_info.total_albums} albums`,
        image: artist_info.images,
      };
    }
    if (historyItem) {
      addToHistory(historyItem);
    }
  }, [metadata.metadata]);
  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    setCurrentListPage(1);
  };
  const toggleTrackSelection = (isrc: string) => {
    setSelectedTracks((prev) =>
      prev.includes(isrc) ? prev.filter((id) => id !== isrc) : [...prev, isrc],
    );
  };
  const toggleSelectAll = (tracks: any[]) => {
    const tracksWithIsrc = tracks
      .filter((track) => track.isrc)
      .map((track) => track.isrc);
    if (selectedTracks.length === tracksWithIsrc.length) {
      setSelectedTracks([]);
    } else {
      setSelectedTracks(tracksWithIsrc);
    }
  };
  const handleOpenFolder = async () => {
    const settings = getSettings();
    if (!settings.downloadPath) {
      toast.error("Download path not set");
      return;
    }
    try {
      await OpenFolder(settings.downloadPath);
    } catch (error) {
      console.error("Error opening folder:", error);
      toast.error(`Error opening folder: ${error}`);
    }
  };
  const renderMetadata = () => {
    if (!metadata.metadata) return null;
    if ("track" in metadata.metadata) {
      const { track } = metadata.metadata;
      return (
        <TrackInfo
          track={track}
          isDownloading={download.isDownloading}
          downloadingTrack={download.downloadingTrack}
          isDownloaded={download.downloadedTracks.has(track.isrc)}
          isFailed={download.failedTracks.has(track.isrc)}
          isSkipped={download.skippedTracks.has(track.isrc)}
          downloadingLyricsTrack={lyrics.downloadingLyricsTrack}
          downloadedLyrics={lyrics.downloadedLyrics.has(track.spotify_id || "")}
          failedLyrics={lyrics.failedLyrics.has(track.spotify_id || "")}
          skippedLyrics={lyrics.skippedLyrics.has(track.spotify_id || "")}
          checkingAvailability={
            availability.checkingTrackId === track.spotify_id
          }
          availability={availability.getAvailability(track.spotify_id || "")}
          downloadingCover={cover.downloadingCover}
          downloadedCover={cover.downloadedCovers.has(track.spotify_id || "")}
          failedCover={cover.failedCovers.has(track.spotify_id || "")}
          skippedCover={cover.skippedCovers.has(track.spotify_id || "")}
          onDownload={download.handleDownloadTrack}
          onDownloadLyrics={(
            spotifyId,
            name,
            artists,
            albumName,
            albumArtist,
            releaseDate,
            discNumber,
          ) =>
            lyrics.handleDownloadLyrics(
              spotifyId,
              name,
              artists,
              albumName,
              undefined,
              undefined,
              albumArtist,
              releaseDate,
              discNumber,
            )
          }
          onCheckAvailability={availability.checkAvailability}
          onDownloadCover={(
            coverUrl,
            trackName,
            artistName,
            albumName,
            _playlistName,
            _position,
            trackId,
            albumArtist,
            releaseDate,
            discNumber,
          ) =>
            cover.handleDownloadCover(
              coverUrl,
              trackName,
              artistName,
              albumName,
              undefined,
              undefined,
              trackId,
              albumArtist,
              releaseDate,
              discNumber,
            )
          }
          onOpenFolder={handleOpenFolder}
          spotifyUrl={spotifyUrl}
          onSaveForLater={() => {
            if (track.spotify_id && spotifyUrl) {
              addForLater({
                label: track.name,
                sublabel: track.artists,
                image: track.images,
                spotifyUrl,
                type: "track",
                source: "fetch",
              });
            }
          }}
        />
      );
    }
    if ("album_info" in metadata.metadata) {
      const { album_info, track_list } = metadata.metadata;
      return (
        <AlbumInfo
          albumInfo={album_info}
          trackList={track_list}
          searchQuery={searchQuery}
          sortBy={sortBy}
          selectedTracks={selectedTracks}
          downloadedTracks={download.downloadedTracks}
          failedTracks={download.failedTracks}
          skippedTracks={download.skippedTracks}
          downloadingTrack={download.downloadingTrack}
          isDownloading={download.isDownloading}
          bulkDownloadType={download.bulkDownloadType}
          downloadProgress={download.downloadProgress}
          currentDownloadInfo={download.currentDownloadInfo}
          currentPage={currentListPage}
          itemsPerPage={ITEMS_PER_PAGE}
          downloadedLyrics={lyrics.downloadedLyrics}
          failedLyrics={lyrics.failedLyrics}
          skippedLyrics={lyrics.skippedLyrics}
          downloadingLyricsTrack={lyrics.downloadingLyricsTrack}
          checkingAvailabilityTrack={availability.checkingTrackId}
          availabilityMap={availability.availabilityMap}
          downloadedCovers={cover.downloadedCovers}
          failedCovers={cover.failedCovers}
          skippedCovers={cover.skippedCovers}
          downloadingCoverTrack={cover.downloadingCoverTrack}
          isBulkDownloadingCovers={cover.isBulkDownloadingCovers}
          isBulkDownloadingLyrics={lyrics.isBulkDownloadingLyrics}
          onSearchChange={handleSearchChange}
          onSortChange={setSortBy}
          onToggleTrack={toggleTrackSelection}
          onToggleSelectAll={toggleSelectAll}
          onDownloadTrack={download.handleDownloadTrack}
          onDownloadLyrics={(
            spotifyId,
            name,
            artists,
            albumName,
            _folderName,
            _isArtistDiscography,
            position,
            albumArtist,
            releaseDate,
            discNumber,
          ) =>
            lyrics.handleDownloadLyrics(
              spotifyId,
              name,
              artists,
              albumName,
              album_info.name,
              position,
              albumArtist,
              releaseDate,
              discNumber,
              true,
            )
          }
          onDownloadCover={(
            coverUrl,
            trackName,
            artistName,
            albumName,
            _folderName,
            _isArtistDiscography,
            position,
            trackId,
            albumArtist,
            releaseDate,
            discNumber,
          ) =>
            cover.handleDownloadCover(
              coverUrl,
              trackName,
              artistName,
              albumName,
              album_info.name,
              position,
              trackId,
              albumArtist,
              releaseDate,
              discNumber,
              true,
            )
          }
          onCheckAvailability={availability.checkAvailability}
          onDownloadAllLyrics={() =>
            lyrics.handleDownloadAllLyrics(
              track_list,
              album_info.name,
              undefined,
              true,
            )
          }
          onDownloadAllCovers={() =>
            cover.handleDownloadAllCovers(track_list, album_info.name, true)
          }
          onDownloadAll={() =>
            download.handleDownloadAll(track_list, undefined, true)
          }
          onDownloadSelected={() =>
            download.handleDownloadSelected(
              selectedTracks,
              track_list,
              undefined,
              true,
            )
          }
          onStopDownload={download.handleStopDownload}
          onOpenFolder={handleOpenFolder}
          onPageChange={setCurrentListPage}
          onArtistClick={async (artist) => {
            const artistUrl = await metadata.handleArtistClick(artist);
            if (artistUrl) {
              setSpotifyUrl(artistUrl);
            }
          }}
          onTrackClick={async (track) => {
            if (track.external_urls) {
              setSpotifyUrl(track.external_urls);
              await metadata.handleFetchMetadata(track.external_urls);
            }
          }}
        />
      );
    }
    if ("playlist_info" in metadata.metadata) {
      const { playlist_info, track_list } = metadata.metadata;
      return (
        <PlaylistInfo
          playlistInfo={playlist_info}
          trackList={track_list}
          searchQuery={searchQuery}
          sortBy={sortBy}
          selectedTracks={selectedTracks}
          downloadedTracks={download.downloadedTracks}
          failedTracks={download.failedTracks}
          skippedTracks={download.skippedTracks}
          downloadingTrack={download.downloadingTrack}
          isDownloading={download.isDownloading}
          bulkDownloadType={download.bulkDownloadType}
          downloadProgress={download.downloadProgress}
          currentDownloadInfo={download.currentDownloadInfo}
          currentPage={currentListPage}
          itemsPerPage={ITEMS_PER_PAGE}
          downloadedLyrics={lyrics.downloadedLyrics}
          failedLyrics={lyrics.failedLyrics}
          skippedLyrics={lyrics.skippedLyrics}
          downloadingLyricsTrack={lyrics.downloadingLyricsTrack}
          checkingAvailabilityTrack={availability.checkingTrackId}
          availabilityMap={availability.availabilityMap}
          downloadedCovers={cover.downloadedCovers}
          failedCovers={cover.failedCovers}
          skippedCovers={cover.skippedCovers}
          downloadingCoverTrack={cover.downloadingCoverTrack}
          isBulkDownloadingCovers={cover.isBulkDownloadingCovers}
          isBulkDownloadingLyrics={lyrics.isBulkDownloadingLyrics}
          onSearchChange={handleSearchChange}
          onSortChange={setSortBy}
          onToggleTrack={toggleTrackSelection}
          onToggleSelectAll={toggleSelectAll}
          onDownloadTrack={download.handleDownloadTrack}
          onDownloadLyrics={(
            spotifyId,
            name,
            artists,
            albumName,
            _folderName,
            _isArtistDiscography,
            position,
            albumArtist,
            releaseDate,
            discNumber,
          ) =>
            lyrics.handleDownloadLyrics(
              spotifyId,
              name,
              artists,
              albumName,
              playlist_info.owner.name,
              position,
              albumArtist,
              releaseDate,
              discNumber,
            )
          }
          onDownloadCover={(
            coverUrl,
            trackName,
            artistName,
            albumName,
            _folderName,
            _isArtistDiscography,
            position,
            trackId,
            albumArtist,
            releaseDate,
            discNumber,
          ) =>
            cover.handleDownloadCover(
              coverUrl,
              trackName,
              artistName,
              albumName,
              playlist_info.owner.name,
              position,
              trackId,
              albumArtist,
              releaseDate,
              discNumber,
            )
          }
          onCheckAvailability={availability.checkAvailability}
          onDownloadAllLyrics={() =>
            lyrics.handleDownloadAllLyrics(track_list, playlist_info.owner.name)
          }
          onDownloadAllCovers={() =>
            cover.handleDownloadAllCovers(track_list, playlist_info.owner.name)
          }
          onDownloadAll={() =>
            download.handleDownloadAll(track_list, playlist_info.owner.name)
          }
          onDownloadSelected={() =>
            download.handleDownloadSelected(
              selectedTracks,
              track_list,
              playlist_info.owner.name,
            )
          }
          onStopDownload={download.handleStopDownload}
          onOpenFolder={handleOpenFolder}
          onPageChange={setCurrentListPage}
          onAlbumClick={metadata.handleAlbumClick}
          onArtistClick={async (artist) => {
            const artistUrl = await metadata.handleArtistClick(artist);
            if (artistUrl) {
              setSpotifyUrl(artistUrl);
            }
          }}
          onTrackClick={async (track) => {
            if (track.external_urls) {
              setSpotifyUrl(track.external_urls);
              await metadata.handleFetchMetadata(track.external_urls);
            }
          }}
          spotifyUrl={spotifyUrl}
          onSaveForLater={() => {
            if (spotifyUrl) {
              addForLater({
                label: playlist_info.owner.name,
                sublabel: `${playlist_info.tracks.total} tracks`,
                image: playlist_info.cover || playlist_info.owner.images || "",
                spotifyUrl,
                type: "playlist",
                source: "fetch",
              });
            }
          }}
          onSaveTrackForLater={(track) => {
            if (track.spotify_id && track.external_urls) {
              addForLater({
                label: track.name,
                sublabel: track.artists,
                image: track.images,
                spotifyUrl: track.external_urls,
                type: "track",
                source: "fetch",
              });
            }
          }}
        />
      );
    }
    if ("artist_info" in metadata.metadata) {
      const { artist_info, album_list, track_list } = metadata.metadata;
      return (
        <ArtistInfo
          artistInfo={artist_info}
          albumList={album_list}
          trackList={track_list}
          searchQuery={searchQuery}
          sortBy={sortBy}
          selectedTracks={selectedTracks}
          downloadedTracks={download.downloadedTracks}
          failedTracks={download.failedTracks}
          skippedTracks={download.skippedTracks}
          downloadingTrack={download.downloadingTrack}
          isDownloading={download.isDownloading}
          bulkDownloadType={download.bulkDownloadType}
          downloadProgress={download.downloadProgress}
          currentDownloadInfo={download.currentDownloadInfo}
          currentPage={currentListPage}
          itemsPerPage={ITEMS_PER_PAGE}
          downloadedLyrics={lyrics.downloadedLyrics}
          failedLyrics={lyrics.failedLyrics}
          skippedLyrics={lyrics.skippedLyrics}
          downloadingLyricsTrack={lyrics.downloadingLyricsTrack}
          checkingAvailabilityTrack={availability.checkingTrackId}
          availabilityMap={availability.availabilityMap}
          downloadedCovers={cover.downloadedCovers}
          failedCovers={cover.failedCovers}
          skippedCovers={cover.skippedCovers}
          downloadingCoverTrack={cover.downloadingCoverTrack}
          isBulkDownloadingCovers={cover.isBulkDownloadingCovers}
          isBulkDownloadingLyrics={lyrics.isBulkDownloadingLyrics}
          onSearchChange={handleSearchChange}
          onSortChange={setSortBy}
          onToggleTrack={toggleTrackSelection}
          onToggleSelectAll={toggleSelectAll}
          onDownloadTrack={download.handleDownloadTrack}
          onDownloadLyrics={(
            spotifyId,
            name,
            artists,
            albumName,
            _folderName,
            _isArtistDiscography,
            position,
            albumArtist,
            releaseDate,
            discNumber,
          ) =>
            lyrics.handleDownloadLyrics(
              spotifyId,
              name,
              artists,
              albumName,
              artist_info.name,
              position,
              albumArtist,
              releaseDate,
              discNumber,
            )
          }
          onDownloadCover={(
            coverUrl,
            trackName,
            artistName,
            albumName,
            _folderName,
            _isArtistDiscography,
            position,
            trackId,
            albumArtist,
            releaseDate,
            discNumber,
          ) =>
            cover.handleDownloadCover(
              coverUrl,
              trackName,
              artistName,
              albumName,
              artist_info.name,
              position,
              trackId,
              albumArtist,
              releaseDate,
              discNumber,
            )
          }
          onCheckAvailability={availability.checkAvailability}
          onDownloadAllLyrics={() =>
            lyrics.handleDownloadAllLyrics(track_list, artist_info.name)
          }
          onDownloadAllCovers={() =>
            cover.handleDownloadAllCovers(track_list, artist_info.name)
          }
          onDownloadAll={() =>
            download.handleDownloadAll(track_list, artist_info.name)
          }
          onDownloadSelected={() =>
            download.handleDownloadSelected(
              selectedTracks,
              track_list,
              artist_info.name,
            )
          }
          onStopDownload={download.handleStopDownload}
          onOpenFolder={handleOpenFolder}
          onAlbumClick={metadata.handleAlbumClick}
          onArtistClick={async (artist) => {
            const artistUrl = await metadata.handleArtistClick(artist);
            if (artistUrl) {
              setSpotifyUrl(artistUrl);
            }
          }}
          onPageChange={setCurrentListPage}
          onTrackClick={async (track) => {
            if (track.external_urls) {
              setSpotifyUrl(track.external_urls);
              await metadata.handleFetchMetadata(track.external_urls);
            }
          }}
        />
      );
    }
    return null;
  };
  const handlePageChange = (page: PageType) => {
    if (
      currentPage === "settings" &&
      hasUnsavedSettings &&
      page !== "settings"
    ) {
      setPendingPageChange(page);
      setShowUnsavedChangesDialog(true);
      return;
    }
    setCurrentPage(page);
  };
  const handleDiscardChanges = () => {
    setShowUnsavedChangesDialog(false);
    if (resetSettingsFn) {
      resetSettingsFn();
    }
    const savedSettings = getSettings();
    applyThemeMode(savedSettings.themeMode);
    applyTheme(savedSettings.theme);
    applyFont(savedSettings.fontFamily);
    if (pendingPageChange) {
      setCurrentPage(pendingPageChange);
      setPendingPageChange(null);
    }
  };
  const handleCancelNavigation = () => {
    setShowUnsavedChangesDialog(false);
    setPendingPageChange(null);
  };
  const renderPage = () => {
    switch (currentPage) {
      case "settings":
        return (
          <SettingsPage
            onUnsavedChangesChange={setHasUnsavedSettings}
            onResetRequest={setResetSettingsFn}
          />
        );
      case "debug":
        return <DebugLoggerPage />;
      case "audio-analysis":
        return <AudioAnalysisPage />;
      case "audio-converter":
        return <AudioConverterPage />;
      case "file-manager":
        return <FileManagerPage />;
      case "quality-upgrade":
        return (
          <QualityUpgradePage
            onNavigateToFetchWithQuery={(query) => {
              setCurrentPage("main");
              setPendingFetchSearchQuery(query);
              setShowDashboard(false);
            }}
            onAddForLater={addForLater}
          />
        );
      case "for-later":
        return (
          <ForLaterPage
            items={forLaterList}
            onRemove={removeForLater}
            onOpen={handleOpenForLater}
          />
        );
      default: {
        // Focus search and switch from dashboard to search mode
        const focusSearch = () => {
          setShowDashboard(false);
          setTimeout(() => {
            searchInputRef.current?.focus();
          }, 100);
        };

        // Show dashboard when no metadata and showDashboard is true
        if (showDashboard && !metadata.metadata) {
          return (
            <>
              <Header
                version={CURRENT_VERSION}
                hasUpdate={hasUpdate}
                releaseDate={releaseDate}
              />
              <Dashboard
                onNavigate={(page) => {
                  if (page === "main") {
                    focusSearch();
                  } else {
                    handlePageChange(page);
                  }
                }}
                onFocusSearch={focusSearch}
              />
            </>
          );
        }

        return (
          <>
            <Header
              version={CURRENT_VERSION}
              hasUpdate={hasUpdate}
              releaseDate={releaseDate}
            />

            <Dialog
              open={metadata.showTimeoutDialog}
              onOpenChange={metadata.setShowTimeoutDialog}
            >
              <DialogContent className="sm:max-w-[425px] p-6 [&>button]:hidden">
                <div className="absolute right-4 top-4">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 opacity-70 hover:opacity-100"
                    onClick={() => metadata.setShowTimeoutDialog(false)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <DialogTitle className="text-sm font-medium">
                  Fetch Artist
                </DialogTitle>
                <DialogDescription>
                  Set timeout for fetching metadata. Longer timeout is
                  recommended for artists with large discography.
                </DialogDescription>
                {metadata.pendingArtistName && (
                  <div className="py-2">
                    <p className="font-medium bg-muted/50 rounded-md px-3 py-2">
                      {metadata.pendingArtistName}
                    </p>
                  </div>
                )}
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="timeout">Timeout (seconds)</Label>
                    <Input
                      id="timeout"
                      type="number"
                      min="10"
                      max="600"
                      value={metadata.timeoutValue}
                      onChange={(e) =>
                        metadata.setTimeoutValue(Number(e.target.value))
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      Default: 60 seconds. For large discographies, try 300-600
                      seconds (5-10 minutes).
                    </p>
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => metadata.setShowTimeoutDialog(false)}
                  >
                    Cancel
                  </Button>
                  <Button onClick={metadata.handleConfirmFetch}>
                    <Search className="h-4 w-4" />
                    Fetch
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog
              open={metadata.showAlbumDialog}
              onOpenChange={metadata.setShowAlbumDialog}
            >
              <DialogContent className="sm:max-w-[425px] p-6 [&>button]:hidden">
                <div className="absolute right-4 top-4">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 opacity-70 hover:opacity-100"
                    onClick={() => metadata.setShowAlbumDialog(false)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <DialogTitle className="text-sm font-medium">
                  Fetch Album
                </DialogTitle>
                <DialogDescription>
                  Do you want to fetch metadata for this album?
                </DialogDescription>
                {metadata.selectedAlbum && (
                  <div className="py-2">
                    <p className="font-medium bg-muted/50 rounded-md px-3 py-2">
                      {metadata.selectedAlbum.name}
                    </p>
                  </div>
                )}
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => metadata.setShowAlbumDialog(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={async () => {
                      const albumUrl = await metadata.handleConfirmAlbumFetch();
                      if (albumUrl) {
                        setSpotifyUrl(albumUrl);
                      }
                    }}
                  >
                    <Search className="h-4 w-4" />
                    Fetch Album
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <SearchBar
              ref={searchInputRef}
              url={spotifyUrl}
              loading={metadata.loading}
              initialSearchQuery={pendingFetchSearchQuery}
              onInitialQueryConsumed={() => setPendingFetchSearchQuery(null)}
              onUrlChange={(url) => {
                setSpotifyUrl(url);
                if (!url && !metadata.metadata) {
                  setShowDashboard(true);
                }
              }}
              onFetch={handleFetchMetadata}
              onFetchUrl={async (url) => {
                setSpotifyUrl(url);
                const updatedUrl = await metadata.handleFetchMetadata(url);
                if (updatedUrl) {
                  setSpotifyUrl(updatedUrl);
                  setShowDashboard(false);
                }
              }}
              history={fetchHistory}
              onHistorySelect={(item) => {
                handleHistorySelect(item);
                setShowDashboard(false);
              }}
              onHistoryRemove={removeFromHistory}
              hasResult={!!metadata.metadata}
              searchMode={isSearchMode}
              onSearchModeChange={setIsSearchMode}
              onBackToDashboard={
                !metadata.metadata ? () => setShowDashboard(true) : undefined
              }
            />

            {!isSearchMode && metadata.metadata && renderMetadata()}
          </>
        );
      }
    }
  };
  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background flex flex-col">
        <TitleBar />
        <Sidebar currentPage={currentPage} onPageChange={handlePageChange} />

        <div className="flex-1 ml-14 mt-10 p-4 md:p-8">
          <div className="max-w-4xl mx-auto space-y-6">{renderPage()}</div>
        </div>

        <DownloadProgressToast onClick={downloadQueue.openQueue} />

        <DownloadQueue
          isOpen={downloadQueue.isOpen}
          onClose={downloadQueue.closeQueue}
        />

        {showScrollTop && (
          <Button
            onClick={scrollToTop}
            className="fixed bottom-6 right-6 z-50 h-10 w-10 rounded-full shadow-lg"
            size="icon"
          >
            <ArrowUp className="h-5 w-5" />
          </Button>
        )}

        <Dialog
          open={showUnsavedChangesDialog}
          onOpenChange={setShowUnsavedChangesDialog}
        >
          <DialogContent className="sm:max-w-[425px] [&>button]:hidden">
            <DialogHeader>
              <DialogTitle>Unsaved Changes</DialogTitle>
              <DialogDescription>
                You have unsaved changes in Settings. Are you sure you want to
                leave? Your changes will be lost.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={handleCancelNavigation}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleDiscardChanges}>
                Discard Changes
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

// Wrap the app with ErrorBoundary to catch and display crashes
function AppWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

export default AppWithErrorBoundary;
