import { useState, useEffect, useCallback, useMemo, memo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  FolderOpen,
  RefreshCw,
  FileMusic,
  TrendingUp,
  Download,
  StopCircle,
  X,
  Play,
  Square,
  FileText,
  AlertCircle,
  Search,
  CheckCircle2,
  XCircle,
  Clock,
  Trash2,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Music2,
  Zap,
  BarChart3,
  Settings2,
  Library,
  Bookmark,
} from "lucide-react";
import {
  SelectFolder,
  ListDirectoryFiles,
  ScanSingleFileForQualityUpgrade,
  OpenFileLocation,
  DeleteFile,
  ReadAudioFileAsBase64,
} from "../../wailsjs/go/main/App";
import { main } from "../../wailsjs/go/models";
import { toastWithSound as toast } from "@/lib/toast-with-sound";
import { getSettings } from "@/lib/settings";
import { useDownload } from "@/hooks/useDownload";
import { runWithConcurrency, createThrottledUpdater } from "@/lib/download-helpers";
import { BrowserOpenURL } from "../../wailsjs/runtime/runtime";
import { openInSpotify } from "@/lib/utils";
import type { ForLaterItem } from "@/types/for-later";

// Check if tracks already exist anywhere in the music directory (for "already in library" / skip download)
const CheckFilesExistenceInMusicDir = (
  rootDir: string,
  tracks: {
    spotify_id: string;
    track_name: string;
    artist_name: string;
    album_name?: string;
    album_artist?: string;
    release_date?: string;
    track_number?: number;
    disc_number?: number;
    position?: number;
    use_album_track_number?: boolean;
    filename_format?: string;
    include_track_number?: boolean;
    audio_format?: string;
  }[]
): Promise<{ spotify_id: string; exists: boolean; file_path?: string }[]> =>
  Promise.resolve(
    (
      window as unknown as {
        go: {
          main: {
            App: {
              CheckFilesExistenceInMusicDir: (
                rootDir: string,
                tracks: unknown[]
              ) => { spotify_id: string; exists: boolean; file_path?: string }[];
            };
          };
        };
      }
    ).go.main.App.CheckFilesExistenceInMusicDir(rootDir, tracks)
  );

// ============================================
// Types & Interfaces
// ============================================

interface FileMetadata {
  title: string;
  artist: string;
  album: string;
  album_artist: string;
  track_number: number;
  disc_number: number;
  year: string;
}

interface SpotifyTrack {
  id: string;
  name: string;
  artists: string;
  album_name: string;
  images: string;
  external_url: string;
  duration_ms: number;
}

interface Availability {
  spotify_id: string;
  tidal: boolean;
  amazon: boolean;
  qobuz: boolean;
  tidal_url?: string;
  amazon_url?: string;
  qobuz_url?: string;
}

interface QualityUpgradeSuggestion {
  file_path: string;
  file_name: string;
  file_size: number;
  current_format: string;
  metadata?: FileMetadata;
  spotify_id?: string;
  spotify_track?: SpotifyTrack;
  availability?: Availability;
  error?: string;
  search_query?: string;
  match_confidence?: "high" | "medium" | "low";
}

interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  children?: FileNode[];
}

type UpgradeFilter =
  | "all"
  | "available"
  | "unavailable"
  | "errors"
  | "unscanned";
type ConfidenceFilter = "all" | "high" | "medium" | "low";
type FormatFilter = "all" | "lossy-only" | "flac-only";
type LibraryFilter = "all" | "in-library" | "not-in-library";
type SortOption = "name" | "size-asc" | "size-desc" | "format" | "need-upgrade-first";

// ============================================
// Constants
// ============================================

const STORAGE_KEY = "spotiflac_quality_upgrade";
const SETTINGS_STORAGE_KEY = "spotiflac_quality_upgrade_settings";
const ITEMS_PER_PAGE = 30;

const AUDIO_EXTENSIONS = new Set([
  "flac",
  "mp3",
  "m4a",
  "aac",
  "ogg",
  "wav",
  "wma",
]);
const LOSSY_EXTENSIONS = new Set(["mp3", "m4a", "aac", "ogg", "wma"]);

// ============================================
// API Wrappers
// ============================================

const FetchLyricsForFile = (req: {
  file_path: string;
  spotify_id?: string;
  track_name?: string;
  artist_name?: string;
  embed_in_file: boolean;
  save_as_lrc: boolean;
  skip_if_exists?: boolean;
}): Promise<string> =>
  (
    window as unknown as {
      go: {
        main: {
          App: {
            FetchLyricsForFile: (req: {
              file_path: string;
              spotify_id?: string;
              track_name?: string;
              artist_name?: string;
              embed_in_file: boolean;
              save_as_lrc: boolean;
              skip_if_exists?: boolean;
            }) => Promise<string>;
          };
        };
      };
    }
  ).go.main.App.FetchLyricsForFile(req);

// ============================================
// Utility Functions
// ============================================

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

const getFileExtension = (path: string): string => {
  return path.toLowerCase().split(".").pop() || "";
};

const isLossyFormat = (path: string): boolean => {
  return LOSSY_EXTENSIONS.has(getFileExtension(path));
};

const isAudioFile = (path: string): boolean => {
  return AUDIO_EXTENSIONS.has(getFileExtension(path));
};

const getConfidenceConfig = (confidence?: string) => {
  switch (confidence) {
    case "high":
      return {
        color: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
        icon: CheckCircle2,
        label: "High Match",
      };
    case "medium":
      return {
        color: "bg-amber-500/10 text-amber-600 border-amber-500/20",
        icon: Clock,
        label: "Medium Match",
      };
    case "low":
      return {
        color: "bg-red-500/10 text-red-600 border-red-500/20",
        icon: AlertCircle,
        label: "Low Match",
      };
    default:
      return null;
  }
};

const getFormatBadgeColor = (ext: string): string => {
  switch (ext.toLowerCase()) {
    case "flac":
      return "bg-blue-500/10 text-blue-600 border-blue-500/20";
    case "mp3":
      return "bg-orange-500/10 text-orange-600 border-orange-500/20";
    case "m4a":
    case "aac":
      return "bg-purple-500/10 text-purple-600 border-purple-500/20";
    case "ogg":
      return "bg-green-500/10 text-green-600 border-green-500/20";
    default:
      return "bg-gray-500/10 text-gray-600 border-gray-500/20";
  }
};

// ============================================
// Sub-components
// ============================================

interface StatCardProps {
  label: string;
  value: number;
  icon: React.ElementType;
  color?: string;
  onClick?: () => void;
  isActive?: boolean;
}

const StatCard = memo(function StatCard({
  label,
  value,
  icon: Icon,
  color = "text-foreground",
  onClick,
  isActive,
}: StatCardProps) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`p-3 border rounded-lg bg-card transition-all text-left w-full ${onClick ? "hover:bg-muted/50 cursor-pointer" : ""
        } ${isActive ? "ring-2 ring-primary" : ""}`}
    >
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${color}`} />
        <span className={`text-xs ${color}`}>{label}</span>
      </div>
      <div className={`text-xl font-bold mt-1 ${color}`}>{value}</div>
    </button>
  );
});

interface ServiceBadgeProps {
  service: "tidal" | "amazon" | "qobuz";
  available: boolean;
  url?: string;
}

const ServiceBadge = memo(function ServiceBadge({
  service,
  available,
  url,
}: ServiceBadgeProps) {
  if (!available) return null;

  const configs = {
    tidal: {
      label: "Tidal",
      color: "bg-sky-500/10 text-sky-600 border-sky-500/20 hover:bg-sky-500/20",
    },
    amazon: {
      label: "Amazon",
      color:
        "bg-orange-500/10 text-orange-600 border-orange-500/20 hover:bg-orange-500/20",
    },
    qobuz: {
      label: "Qobuz",
      color:
        "bg-violet-500/10 text-violet-600 border-violet-500/20 hover:bg-violet-500/20",
    },
  };

  const config = configs[service];

  return (
    <Badge
      variant="outline"
      className={`text-xs cursor-pointer transition-colors ${config.color}`}
      onClick={(e) => {
        e.stopPropagation();
        if (url) BrowserOpenURL(url);
      }}
    >
      {config.label}
      {url && <ExternalLink className="h-2.5 w-2.5 ml-1" />}
    </Badge>
  );
});

// ============================================
// File Item Component
// ============================================

interface FileItemProps {
  file: FileNode;
  suggestion?: QualityUpgradeSuggestion;
  isScanning: boolean;
  isDownloading: boolean;
  isFetchingLyrics: boolean;
  isPreviewingAudio: boolean;
  audioDataUrl: string;
  alreadyInLibrary?: boolean;
  /** Path to the file in library deemed "already existing" (click to open) */
  alreadyInLibraryPath?: string;
  onScan: (path: string) => void;
  onDownload: (file: FileNode, suggestion: QualityUpgradeSuggestion) => void;
  onFetchLyrics: (
    path: string,
    spotifyId?: string,
    trackName?: string,
    artistName?: string,
  ) => void;
  onOpenLocation: (path: string) => void;
  onPreviewAudio: (path: string) => void;
  onStopPreview: () => void;
  onDelete: (path: string) => void;
  onSearchInFetch?: (query: string) => void;
  onAddForLater?: (item: Omit<ForLaterItem, "id" | "addedAt">) => void;
}

const FileItem = memo(function FileItem({
  file,
  suggestion,
  isScanning,
  isDownloading,
  isFetchingLyrics,
  isPreviewingAudio,
  audioDataUrl,
  alreadyInLibrary,
  alreadyInLibraryPath,
  onScan,
  onDownload,
  onFetchLyrics,
  onOpenLocation,
  onPreviewAudio,
  onStopPreview,
  onDelete,
  onSearchInFetch,
  onAddForLater,
}: FileItemProps) {
  const hasAvailability =
    suggestion?.availability?.tidal ||
    suggestion?.availability?.amazon ||
    suggestion?.availability?.qobuz;

  const ext = getFileExtension(file.name).toUpperCase();
  const isLossy = isLossyFormat(file.path);
  const confidenceConfig = getConfidenceConfig(suggestion?.match_confidence);

  // Determine the status of this file
  const getStatus = () => {
    if (isScanning) return "scanning";
    if (isDownloading) return "downloading";
    if (!suggestion) return "unscanned";
    if (suggestion.error) return "error";
    if (hasAvailability) return "available";
    if (suggestion.spotify_id) return "unavailable";
    return "unscanned";
  };

  const status = getStatus();

  return (
    <div
      className={`group p-4 rounded-lg border bg-card transition-all hover:shadow-md ${status === "available"
        ? "border-l-4 border-l-emerald-500"
        : status === "error"
          ? "border-l-4 border-l-red-500"
          : status === "unavailable"
            ? "border-l-4 border-l-amber-500"
            : ""
        }`}
    >
      <div className="flex items-start gap-4">
        {/* Album Art / Icon */}
        <div className="shrink-0">
          {suggestion?.spotify_track?.images ? (
            <img
              src={suggestion.spotify_track.images}
              alt=""
              className="w-12 h-12 rounded-md object-cover shadow-sm"
            />
          ) : (
            <div
              className={`w-12 h-12 rounded-md flex items-center justify-center ${isLossy ? "bg-orange-500/10" : "bg-blue-500/10"
                }`}
            >
              <Music2
                className={`h-6 w-6 ${isLossy ? "text-orange-500" : "text-blue-500"}`}
              />
            </div>
          )}
        </div>

        {/* File Info */}
        <div className="flex-1 min-w-0 space-y-1.5">
          {/* Title Row */}
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="font-medium text-sm truncate max-w-[300px]"
              title={file.name}
            >
              {suggestion?.metadata?.title ||
                file.name.replace(/\.[^/.]+$/, "")}
            </span>
            <Badge
              variant="outline"
              className={`text-[10px] shrink-0 ${getFormatBadgeColor(ext)}`}
            >
              {ext}
            </Badge>
            <span className="text-xs text-muted-foreground shrink-0">
              {formatFileSize(file.size)}
            </span>
          </div>

          {/* Artist / Original filename */}
          <div className="text-xs text-muted-foreground truncate">
            {suggestion?.metadata?.artist ? (
              <>
                {suggestion.metadata.artist}
                {suggestion.metadata.album && ` • ${suggestion.metadata.album}`}
              </>
            ) : (
              <span className="italic">{file.name}</span>
            )}
          </div>

          {/* Match Info */}
          {suggestion?.spotify_track && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground">
                → {suggestion.spotify_track.name} by{" "}
                {suggestion.spotify_track.artists}
              </span>
              {confidenceConfig && (
                <Badge
                  variant="outline"
                  className={`text-[10px] ${confidenceConfig.color}`}
                >
                  <confidenceConfig.icon className="h-3 w-3 mr-1" />
                  {confidenceConfig.label}
                </Badge>
              )}
            </div>
          )}

          {/* Availability Badges */}
          {suggestion?.availability && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <ServiceBadge
                service="tidal"
                available={suggestion.availability.tidal}
                url={suggestion.availability.tidal_url}
              />
              <ServiceBadge
                service="amazon"
                available={suggestion.availability.amazon}
                url={suggestion.availability.amazon_url}
              />
              <ServiceBadge
                service="qobuz"
                available={suggestion.availability.qobuz}
                url={suggestion.availability.qobuz_url}
              />
              {!hasAvailability && suggestion.spotify_id && (
                <Badge
                  variant="outline"
                  className="text-[10px] bg-gray-500/10 text-gray-500 border-gray-500/20"
                >
                  <XCircle className="h-3 w-3 mr-1" />
                  No FLAC Available
                </Badge>
              )}
            </div>
          )}

          {/* Error */}
          {suggestion?.error && (
            <div className="flex items-center gap-1.5 text-xs text-red-500">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{suggestion.error}</span>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0 opacity-70 group-hover:opacity-100 transition-opacity">
          {/* Preview Audio */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0"
                onClick={() =>
                  isPreviewingAudio
                    ? onStopPreview()
                    : onPreviewAudio(file.path)
                }
              >
                {isPreviewingAudio ? (
                  <Square className="h-4 w-4 fill-current" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {isPreviewingAudio ? "Stop" : "Preview"}
            </TooltipContent>
          </Tooltip>

          {/* Open Location */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0"
                onClick={() => onOpenLocation(file.path)}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open Location</TooltipContent>
          </Tooltip>

          {/* Scan / Actions */}
          {!suggestion ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onScan(file.path)}
              disabled={isScanning}
              className="gap-1.5"
            >
              {isScanning ? (
                <>
                  <Spinner className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Scanning...</span>
                </>
              ) : (
                <>
                  <Search className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Find</span>
                </>
              )}
            </Button>
          ) : (
            <>
              {/* Search in Fetch — open Fetch page with this file's search query for manual edit */}
              {onSearchInFetch && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0"
                      onClick={() => {
                        const q =
                          suggestion.search_query?.trim() ||
                          (suggestion.metadata?.artist && suggestion.metadata?.title
                            ? `${suggestion.metadata.artist} ${suggestion.metadata.title}`
                            : suggestion.metadata?.title ||
                            suggestion.metadata?.artist ||
                            file.name);
                        onSearchInFetch(q || file.name);
                      }}
                    >
                      <Search className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Search in Fetch — open Fetch page to edit search and find
                    track
                  </TooltipContent>
                </Tooltip>
              )}

              {/* Open in Spotify */}
              {suggestion?.spotify_id && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0"
                      onClick={() => {
                        openInSpotify(
                          suggestion.spotify_id!,
                          suggestion.spotify_track?.external_url
                        );
                      }}
                    >
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Open in Spotify to verify it's the right track
                  </TooltipContent>
                </Tooltip>
              )}

              {/* Fetch Lyrics */}
              {suggestion.spotify_id && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0"
                      onClick={() =>
                        onFetchLyrics(
                          file.path,
                          suggestion.spotify_id,
                          suggestion.spotify_track?.name ||
                          suggestion.metadata?.title,
                          suggestion.spotify_track?.artists ||
                          suggestion.metadata?.artist,
                        )
                      }
                      disabled={isFetchingLyrics}
                    >
                      {isFetchingLyrics ? (
                        <Spinner className="h-4 w-4" />
                      ) : (
                        <FileText className="h-4 w-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Fetch Lyrics</TooltipContent>
                </Tooltip>
              )}

              {/* Save for later */}
              {suggestion && onAddForLater && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0"
                      onClick={() => {
                        const searchQuery =
                          suggestion.search_query?.trim() ||
                          (suggestion.metadata?.artist && suggestion.metadata?.title
                            ? `${suggestion.metadata.artist} ${suggestion.metadata.title}`
                            : suggestion.metadata?.title ||
                            suggestion.metadata?.artist ||
                            file.name);
                        const spotifyUrl = suggestion.spotify_id
                          ? `https://open.spotify.com/track/${suggestion.spotify_id}`
                          : undefined;
                        const label =
                          suggestion.spotify_track?.name ||
                          suggestion.metadata?.title ||
                          file.name;
                        const sublabel =
                          suggestion.spotify_track?.artists ||
                          suggestion.metadata?.artist ||
                          "";
                        onAddForLater({
                          label,
                          sublabel,
                          image: suggestion.spotify_track?.images,
                          spotifyUrl,
                          searchQuery: spotifyUrl ? undefined : searchQuery,
                          type: suggestion.spotify_id ? "track" : "search",
                          source: "quality-upgrade",
                          filePath: file.path,
                        });
                      }}
                    >
                      <Bookmark className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Save for later (e.g. when on mobile data)
                  </TooltipContent>
                </Tooltip>
              )}

              {/* Delete */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-red-500"
                    onClick={() => onDelete(file.path)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete File</TooltipContent>
              </Tooltip>

              {/* Download / Already in library (only FLAC counts; show Upgrade anyway so user can re-download) */}
              {hasAvailability && (
                <>
                  {alreadyInLibrary && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="secondary"
                          className="text-xs bg-muted text-muted-foreground cursor-pointer hover:bg-muted/80 shrink-0"
                          onClick={() => alreadyInLibraryPath && onOpenLocation(alreadyInLibraryPath)}
                          role={alreadyInLibraryPath ? "button" : undefined}
                        >
                          Already in library
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="max-w-[260px]">
                        {alreadyInLibraryPath
                          ? "FLAC version found. Click to open it. You can still upgrade to re-download."
                          : "A FLAC version exists in your music folder."}
                      </TooltipContent>
                    </Tooltip>
                  )}
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => suggestion && onDownload(file, suggestion)}
                    disabled={isDownloading}
                    className="gap-1.5"
                  >
                    {isDownloading ? (
                      <>
                        <Spinner className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">Downloading...</span>
                      </>
                    ) : (
                      <>
                        <Download className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">Upgrade</span>
                      </>
                    )}
                  </Button>
                </>
              )}

              {/* Rescan */}
              {!hasAvailability && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0"
                      onClick={() => onScan(file.path)}
                      disabled={isScanning}
                    >
                      {isScanning ? (
                        <Spinner className="h-4 w-4" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Rescan</TooltipContent>
                </Tooltip>
              )}
            </>
          )}
        </div>
      </div>

      {/* Audio Preview Player */}
      {isPreviewingAudio && audioDataUrl && (
        <div className="mt-3 pt-3 border-t">
          <audio
            controls
            autoPlay
            className="w-full h-8"
            src={audioDataUrl}
            onEnded={onStopPreview}
          >
            Your browser does not support audio playback.
          </audio>
        </div>
      )}
    </div>
  );
});

// ============================================
// Empty State Component
// ============================================

interface EmptyStateProps {
  icon: React.ElementType;
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
        <Icon className="h-8 w-8 text-muted-foreground" />
      </div>
      <h3 className="text-lg font-semibold mb-1">{title}</h3>
      <p className="text-sm text-muted-foreground max-w-sm mb-4">
        {description}
      </p>
      {action && (
        <Button onClick={action.onClick} variant="outline">
          {action.label}
        </Button>
      )}
    </div>
  );
}

// ============================================
// Pagination Component
// ============================================

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  onPageChange: (page: number) => void;
}

function Pagination({
  currentPage,
  totalPages,
  totalItems,
  onPageChange,
}: PaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between py-4 border-t">
      <span className="text-sm text-muted-foreground">
        Showing {currentPage * ITEMS_PER_PAGE + 1}-
        {Math.min((currentPage + 1) * ITEMS_PER_PAGE, totalItems)} of{" "}
        {totalItems}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => onPageChange(0)}
          disabled={currentPage === 0}
        >
          <ChevronsLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 0}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="px-3 text-sm">
          {currentPage + 1} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage >= totalPages - 1}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => onPageChange(totalPages - 1)}
          disabled={currentPage >= totalPages - 1}
        >
          <ChevronsRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// ============================================
// Main Component
// ============================================

interface QualityUpgradePageProps {
  /** When set, Quality Upgrade will show a "Search in Fetch" button that navigates to Fetch with the file's search query */
  onNavigateToFetchWithQuery?: (query: string) => void;
  /** When set, Quality Upgrade will show a "Save for later" button that adds the item to the for-later list */
  onAddForLater?: (item: Omit<ForLaterItem, "id" | "addedAt">) => void;
}

export function QualityUpgradePage({
  onNavigateToFetchWithQuery,
  onAddForLater,
}: QualityUpgradePageProps = {}) {
  // ==========================================
  // State
  // ==========================================

  // Load saved settings from localStorage
  const loadSavedSettings = useCallback(() => {
    try {
      const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch {
      // Ignore
    }
    return null;
  }, []);

  const savedSettings = useMemo(() => loadSavedSettings(), [loadSavedSettings]);

  const [rootPath, setRootPath] = useState(() => {
    // First try to get from saved settings, then fall back to app settings
    if (savedSettings?.rootPath) {
      return savedSettings.rootPath;
    }
    const settings = getSettings();
    return settings.downloadPath || "";
  });
  const [files, setFiles] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<
    Map<string, QualityUpgradeSuggestion>
  >(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        // Match against the potentially saved rootPath
        const effectiveRootPath =
          savedSettings?.rootPath || getSettings().downloadPath || "";
        if (data.rootPath === effectiveRootPath && data.suggestions) {
          return new Map(Object.entries(data.suggestions));
        }
      }
    } catch {
      // Ignore
    }
    return new Map();
  });

  // Scanning states
  const [scanningFiles, setScanningFiles] = useState<Set<string>>(new Set());
  const [batchScanning, setBatchScanning] = useState(false);
  const [batchScanAbort, setBatchScanAbort] = useState<AbortController | null>(
    null,
  );
  const [batchScanProgress, setBatchScanProgress] = useState({
    current: 0,
    total: 0,
  });

  // Download states
  const [downloadingTracks, setDownloadingTracks] = useState<Set<string>>(
    new Set(),
  );
  const [batchDownloading, setBatchDownloading] = useState(false);
  const [batchDownloadAbort, setBatchDownloadAbort] =
    useState<AbortController | null>(null);
  const [batchDownloadProgress, setBatchDownloadProgress] = useState({
    current: 0,
    total: 0,
    success: 0,
    failed: 0,
  });
  const [deleteOldFilesAfterDownload, setDeleteOldFilesAfterDownload] =
    useState(() => savedSettings?.deleteOldFilesAfterDownload || false);

  // Lyrics states
  const [fetchingLyricsFor, setFetchingLyricsFor] = useState<string | null>(
    null,
  );
  const [lyricsEmbedMode, setLyricsEmbedMode] = useState<
    "embed" | "lrc" | "both"
  >(() => savedSettings?.lyricsEmbedMode || "embed");

  // Audio preview states
  const [previewingAudio, setPreviewingAudio] = useState<string | null>(null);
  const [audioDataUrl, setAudioDataUrl] = useState<string>("");

  // Filter states - restore from saved settings
  const [upgradeFilter, setUpgradeFilter] = useState<UpgradeFilter>(
    () => savedSettings?.upgradeFilter || "all",
  );
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>(
    () => savedSettings?.confidenceFilter || "all",
  );
  const [formatFilter, setFormatFilter] = useState<FormatFilter>(
    () => savedSettings?.formatFilter || "lossy-only",
  );
  const [sortBy, setSortBy] = useState<SortOption>(
    () => savedSettings?.sortBy || "size-asc",
  );
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>(
    () => savedSettings?.libraryFilter || "all",
  );
  const [skipAlreadyInLibrary, setSkipAlreadyInLibrary] = useState(
    () => savedSettings?.skipAlreadyInLibrary ?? false,
  );
  const [minimumConfidenceForBatch, setMinimumConfidenceForBatch] = useState<
    "high" | "medium" | "low" | "all"
  >(() => savedSettings?.minimumConfidenceForBatch || "high");

  // Track deleted files to exclude them from the list
  const [deletedFiles, setDeletedFiles] = useState<Set<string>>(new Set());

  // Tracks that already exist in the music directory (from CheckFilesExistenceInMusicDir)
  const [existingInLibrarySpotifyIds, setExistingInLibrarySpotifyIds] = useState<Set<string>>(new Set());
  const [existingInLibraryFilePaths, setExistingInLibraryFilePaths] = useState<Map<string, string>>(new Map());

  // Refs for abort in concurrent batch operations
  const batchScanAbortRef = useRef<AbortController | null>(null);
  const batchDownloadAbortRef = useRef<AbortController | null>(null);

  // Pagination
  const [currentPage, setCurrentPage] = useState(0);

  // Settings panel
  const [showSettings, setShowSettings] = useState(false);

  const download = useDownload();

  // ==========================================
  // Effects
  // ==========================================

  // Persist suggestions to localStorage
  useEffect(() => {
    if (rootPath && suggestions.size > 0) {
      try {
        const data = {
          rootPath,
          suggestions: Object.fromEntries(suggestions),
          timestamp: Date.now(),
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch (err) {
        console.error("Failed to save suggestions:", err);
      }
    }
  }, [suggestions, rootPath]);

  // Check which suggested tracks already exist in the music directory (whole library).
  // Uses same backend as SpotiFetch: only "complete" files count (title + artist + embedded cover).
  // Incomplete/corrupt/broken files are removed by the backend so they can be overwritten by an upgrade.
  const refreshExistingInLibrary = useCallback((): Promise<void> => {
    const musicDir = getSettings().downloadPath;
    if (!musicDir || suggestions.size === 0) {
      setExistingInLibrarySpotifyIds(new Set());
      setExistingInLibraryFilePaths(new Map());
      return Promise.resolve();
    }
    const entries = Array.from(suggestions.entries());
    const withAvailability = entries.filter(([, s]) => {
      const hasAvail =
        s.availability?.tidal || s.availability?.amazon || s.availability?.qobuz;
      const trackName = s.spotify_track?.name ?? s.metadata?.title ?? "";
      const artistName = s.spotify_track?.artists ?? s.metadata?.artist ?? "";
      return s.spotify_id && s.spotify_track && hasAvail && trackName && artistName;
    });
    if (withAvailability.length === 0) {
      setExistingInLibrarySpotifyIds(new Set());
      setExistingInLibraryFilePaths(new Map());
      return Promise.resolve();
    }
    const settings = getSettings();
    const useAlbumTrackNumber = settings.folderTemplate?.includes("{album}") ?? false;
    const requests = withAvailability.map(([, s]) => {
      const trackNum = s.metadata?.track_number ?? 0;
      return {
        spotify_id: s.spotify_id!,
        track_name: s.spotify_track?.name ?? s.metadata?.title ?? "",
        artist_name: s.spotify_track?.artists ?? s.metadata?.artist ?? "",
        album_name: s.spotify_track?.album_name ?? s.metadata?.album ?? "",
        album_artist: s.metadata?.album_artist ?? "",
        release_date: s.metadata?.year ?? "",
        track_number: trackNum,
        disc_number: s.metadata?.disc_number ?? 0,
        position: trackNum,
        use_album_track_number: useAlbumTrackNumber,
        filename_format: settings.filenameTemplate || "title-artist",
        include_track_number: settings.trackNumber ?? false,
        audio_format: "flac",
      };
    });
    return Promise.resolve(CheckFilesExistenceInMusicDir(musicDir, requests)).then(
      (results) => {
        const set = new Set<string>();
        const pathMap = new Map<string, string>();
        results.forEach((r, i) => {
          if (!r.exists || !requests[i]) return;
          const path = r.file_path?.toLowerCase() ?? "";
          if (!path.endsWith(".flac")) return;
          set.add(requests[i].spotify_id);
          if (r.file_path) pathMap.set(requests[i].spotify_id, r.file_path);
        });
        setExistingInLibrarySpotifyIds(set);
        setExistingInLibraryFilePaths(pathMap);
      },
    ).catch(() => {
      setExistingInLibrarySpotifyIds(new Set());
      setExistingInLibraryFilePaths(new Map());
    });
  }, [suggestions]);

  useEffect(() => {
    refreshExistingInLibrary();
  }, [refreshExistingInLibrary]);

  // Persist settings to localStorage
  useEffect(() => {
    try {
      const settingsData = {
        rootPath,
        upgradeFilter,
        confidenceFilter,
        formatFilter,
        sortBy,
        libraryFilter,
        skipAlreadyInLibrary,
        minimumConfidenceForBatch,
        lyricsEmbedMode,
        deleteOldFilesAfterDownload,
        timestamp: Date.now(),
      };
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settingsData));
    } catch (err) {
      console.error("Failed to save settings:", err);
    }
  }, [
    rootPath,
    upgradeFilter,
    confidenceFilter,
    formatFilter,
    sortBy,
    libraryFilter,
    skipAlreadyInLibrary,
    minimumConfidenceForBatch,
    lyricsEmbedMode,
    deleteOldFilesAfterDownload,
  ]);

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(0);
  }, [upgradeFilter, confidenceFilter, formatFilter, sortBy, libraryFilter]);

  // Load files when rootPath changes
  useEffect(() => {
    if (rootPath) {
      loadFiles();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape to stop batch operations
      if (e.key === "Escape") {
        if (batchScanning) {
          batchScanAbort?.abort();
          setBatchScanAbort(null);
          setBatchScanning(false);
        }
        if (batchDownloading) {
          batchDownloadAbort?.abort();
          setBatchDownloadAbort(null);
          setBatchDownloading(false);
        }
        if (previewingAudio) {
          setPreviewingAudio(null);
          setAudioDataUrl("");
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    batchScanning,
    batchDownloading,
    previewingAudio,
    batchScanAbort,
    batchDownloadAbort,
  ]);

  // ==========================================
  // Memoized Values
  // ==========================================

  // Collect all audio files recursively
  const audioFiles = useMemo(() => {
    const result: FileNode[] = [];
    const traverse = (nodes: FileNode[]) => {
      for (const node of nodes) {
        if (node.is_dir && node.children) {
          traverse(node.children);
        } else if (
          !node.is_dir &&
          isAudioFile(node.name) &&
          !deletedFiles.has(node.path)
        ) {
          result.push(node);
        }
      }
    };
    traverse(files);
    return result;
  }, [files, deletedFiles]);

  // Filtered and sorted files
  const filteredFiles = useMemo(() => {
    let result = [...audioFiles];

    // Format filter
    if (formatFilter === "lossy-only") {
      result = result.filter((f) => isLossyFormat(f.path));
    } else if (formatFilter === "flac-only") {
      result = result.filter((f) => getFileExtension(f.path) === "flac");
    }

    // Upgrade filter
    if (upgradeFilter !== "all") {
      result = result.filter((f) => {
        const suggestion = suggestions.get(f.path);

        switch (upgradeFilter) {
          case "unscanned":
            return !suggestion;
          case "available":
            return (
              suggestion?.availability?.tidal ||
              suggestion?.availability?.amazon ||
              suggestion?.availability?.qobuz
            );
          case "unavailable":
            return (
              suggestion?.spotify_id &&
              !suggestion?.availability?.tidal &&
              !suggestion?.availability?.amazon &&
              !suggestion?.availability?.qobuz &&
              !suggestion?.error
            );
          case "errors":
            return !!suggestion?.error;
          default:
            return true;
        }
      });
    }

    // Confidence filter
    if (confidenceFilter !== "all") {
      result = result.filter((f) => {
        const suggestion = suggestions.get(f.path);
        return suggestion?.match_confidence === confidenceFilter;
      });
    }

    // Library filter (already in library vs not)
    if (libraryFilter !== "all") {
      result = result.filter((f) => {
        const suggestion = suggestions.get(f.path);
        const spotifyId = suggestion?.spotify_id;
        const inLibrary = spotifyId ? existingInLibrarySpotifyIds.has(spotifyId) : false;
        if (libraryFilter === "in-library") return inLibrary;
        if (libraryFilter === "not-in-library") return !inLibrary;
        return true;
      });
    }

    // Sort
    switch (sortBy) {
      case "size-asc":
        result.sort((a, b) => a.size - b.size);
        break;
      case "size-desc":
        result.sort((a, b) => b.size - a.size);
        break;
      case "name":
        result.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "format":
        result.sort((a, b) =>
          getFileExtension(a.path).localeCompare(getFileExtension(b.path)),
        );
        break;
      case "need-upgrade-first":
        result.sort((a, b) => {
          const aSugg = suggestions.get(a.path);
          const bSugg = suggestions.get(b.path);
          const aInLib = aSugg?.spotify_id ? existingInLibrarySpotifyIds.has(aSugg.spotify_id) : false;
          const bInLib = bSugg?.spotify_id ? existingInLibrarySpotifyIds.has(bSugg.spotify_id) : false;
          if (aInLib === bInLib) return 0;
          return aInLib ? 1 : -1;
        });
        break;
    }

    return result;
  }, [
    audioFiles,
    formatFilter,
    upgradeFilter,
    confidenceFilter,
    libraryFilter,
    sortBy,
    suggestions,
    existingInLibrarySpotifyIds,
  ]);

  // Stats
  const stats = useMemo(() => {
    let scanned = 0;
    let available = 0;
    let unavailable = 0;
    let errors = 0;
    let inLibrary = 0;

    for (const file of audioFiles) {
      const suggestion = suggestions.get(file.path);
      if (suggestion) {
        scanned++;
        if (suggestion.spotify_id && existingInLibrarySpotifyIds.has(suggestion.spotify_id)) {
          inLibrary++;
        }
        const hasAvail =
          suggestion.availability?.tidal ||
          suggestion.availability?.amazon ||
          suggestion.availability?.qobuz;

        if (hasAvail) {
          available++;
        } else if (suggestion.error) {
          errors++;
        } else if (suggestion.spotify_id) {
          unavailable++;
        }
      }
    }

    return {
      total: audioFiles.length,
      lossy: audioFiles.filter((f) => isLossyFormat(f.path)).length,
      scanned,
      available,
      unavailable,
      errors,
      inLibrary,
      unscanned: audioFiles.length - scanned,
    };
  }, [audioFiles, suggestions, existingInLibrarySpotifyIds]);

  // Eligible files for batch download (include all available; "already in library" can still be upgraded)
  const eligibleFilesForBatchDownload = useMemo(() => {
    return filteredFiles.filter((file) => {
      const suggestion = suggestions.get(file.path);
      if (!suggestion) return false;

      const hasAvail =
        suggestion.availability?.tidal ||
        suggestion.availability?.amazon ||
        suggestion.availability?.qobuz;

      if (!hasAvail) return false;

      if (minimumConfidenceForBatch !== "all") {
        const confidenceOrder = { high: 3, medium: 2, low: 1 };
        const minLevel = confidenceOrder[minimumConfidenceForBatch];
        const fileLevel =
          confidenceOrder[suggestion.match_confidence || "low"] || 0;
        if (fileLevel < minLevel) return false;
      }

      return true;
    });
  }, [filteredFiles, suggestions, minimumConfidenceForBatch]);

  // When "Skip already in library" is on, only these will be downloaded
  const filesToDownloadForBatch = useMemo(() => {
    if (!skipAlreadyInLibrary) return eligibleFilesForBatchDownload;
    return eligibleFilesForBatchDownload.filter((file) => {
      const suggestion = suggestions.get(file.path);
      return !suggestion?.spotify_id || !existingInLibrarySpotifyIds.has(suggestion.spotify_id);
    });
  }, [eligibleFilesForBatchDownload, skipAlreadyInLibrary, suggestions, existingInLibrarySpotifyIds]);

  // Paginated files
  const paginatedFiles = useMemo(() => {
    const start = currentPage * ITEMS_PER_PAGE;
    return filteredFiles.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredFiles, currentPage]);

  const totalPages = Math.ceil(filteredFiles.length / ITEMS_PER_PAGE);

  // ==========================================
  // Handlers
  // ==========================================

  const loadFiles = useCallback(async () => {
    if (!rootPath) return;
    setLoading(true);
    try {
      const result = await ListDirectoryFiles(rootPath);
      setFiles(result || []);
    } catch (err) {
      toast.error("Failed to load files", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setLoading(false);
    }
  }, [rootPath]);

  const handleSelectFolder = useCallback(async () => {
    try {
      const path = await SelectFolder(rootPath);
      if (path) {
        setRootPath(path);
        setSuggestions(new Map());
        setCurrentPage(0);
      }
    } catch (err) {
      toast.error("Failed to select folder", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }, [rootPath]);

  const handleScanFile = useCallback(async (filePath: string) => {
    setScanningFiles((prev) => new Set(prev).add(filePath));
    try {
      const result = await ScanSingleFileForQualityUpgrade({
        file_path: filePath,
      } as main.ScanSingleFileRequest);
      const suggestion: QualityUpgradeSuggestion = JSON.parse(result);
      setSuggestions((prev) => {
        const newMap = new Map(prev);
        newMap.set(filePath, suggestion);
        return newMap;
      });
    } catch (err) {
      toast.error("Failed to scan file", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setScanningFiles((prev) => {
        const newSet = new Set(prev);
        newSet.delete(filePath);
        return newSet;
      });
    }
  }, []);

  const BATCH_SCAN_CONCURRENCY = 4;
  const PROGRESS_THROTTLE_MS = 280;

  const handleBatchScan = useCallback(async () => {
    const filesToScan = filteredFiles.filter((f) => !suggestions.has(f.path));
    if (filesToScan.length === 0) {
      toast.info("All files already scanned");
      return;
    }

    const abort = new AbortController();
    batchScanAbortRef.current = abort;
    setBatchScanAbort(abort);
    setBatchScanning(true);
    setBatchScanProgress({ current: 0, total: filesToScan.length });

    const batchScanState = { completed: 0 };
    const flushProgress = createThrottledUpdater(PROGRESS_THROTTLE_MS, () => {
      setBatchScanProgress({
        current: batchScanState.completed,
        total: filesToScan.length,
      });
    });

    const getAbort = () => batchScanAbortRef.current?.signal.aborted ?? false;

    const results = await runWithConcurrency(
      filesToScan,
      BATCH_SCAN_CONCURRENCY,
      async (file) => {
        if (getAbort()) return null;
        let suggestion: QualityUpgradeSuggestion;
        try {
          const result = await ScanSingleFileForQualityUpgrade({
            file_path: file.path,
          } as main.ScanSingleFileRequest);
          suggestion = JSON.parse(result);
        } catch {
          suggestion = { file_path: file.path, file_name: file.name, file_size: file.size ?? 0, current_format: getFileExtension(file.path).toUpperCase(), error: "Scan failed" } as QualityUpgradeSuggestion;
        }
        setSuggestions((prev) => {
          const next = new Map(prev);
          next.set(file.path, suggestion);
          return next;
        });
        batchScanState.completed++;
        flushProgress();
        return { path: file.path, suggestion };
      },
      { getAbort },
    );

    batchScanAbortRef.current = null;
    setBatchScanning(false);
    setBatchScanAbort(null);

    const validResults = results.filter((r): r is { path: string; suggestion: QualityUpgradeSuggestion } => r != null);
    if (!getAbort()) {
      toast.success("Batch scan complete", {
        description: `Scanned ${validResults.length} files`,
      });
    } else {
      toast.info(`Scan stopped after ${batchScanState.completed} files`);
    }
  }, [filteredFiles, suggestions]);

  const handleStopBatchScan = useCallback(() => {
    if (batchScanAbort) {
      batchScanAbort.abort();
      setBatchScanAbort(null);
    }
    setBatchScanning(false);
  }, [batchScanAbort]);

  const handleDownload = useCallback(
    async (file: FileNode, suggestion: QualityUpgradeSuggestion): Promise<boolean> => {
      if (!suggestion.spotify_id || !suggestion.spotify_track) {
        toast.error("Cannot download: Missing Spotify data");
        return false;
      }

      setDownloadingTracks((prev) => new Set(prev).add(file.path));

      try {
        const trackName =
          suggestion.spotify_track.name || suggestion.metadata?.title || "";
        const artistName =
          suggestion.spotify_track.artists || suggestion.metadata?.artist || "";
        const albumName =
          suggestion.spotify_track.album_name ||
          suggestion.metadata?.album ||
          "";
        const durationMs = suggestion.spotify_track.duration_ms || 0;
        const coverUrl = suggestion.spotify_track.images || "";

        if (!trackName || !artistName) {
          toast.error("Cannot download: Missing track or artist name");
          return false;
        }

        await download.handleDownloadTrack(
          suggestion.spotify_id,
          trackName,
          artistName,
          albumName,
          suggestion.spotify_id,
          undefined,
          durationMs,
          undefined,
          undefined,
          undefined,
          coverUrl,
        );

        toast.success(`Downloaded: ${trackName}`);
        return true;
      } catch (err) {
        console.error("Download error:", err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        toast.error(`Download failed: ${errorMessage}`);
        return false;
      } finally {
        setDownloadingTracks((prev) => {
          const newSet = new Set(prev);
          newSet.delete(file.path);
          return newSet;
        });
      }
    },
    [download],
  );

  const BATCH_DOWNLOAD_CONCURRENCY = 3;

  const handleBatchDownload = useCallback(async () => {
    if (filesToDownloadForBatch.length === 0) {
      toast.info(skipAlreadyInLibrary ? "No files to download (all eligible are already in library)" : "No files eligible for download");
      return;
    }

    const abort = new AbortController();
    batchDownloadAbortRef.current = abort;
    setBatchDownloadAbort(abort);
    setBatchDownloading(true);
    setBatchDownloadProgress({
      current: 0,
      total: filesToDownloadForBatch.length,
      success: 0,
      failed: 0,
    });

    const batchState = { current: 0, success: 0, failed: 0 };
    const flushProgress = createThrottledUpdater(PROGRESS_THROTTLE_MS, () => {
      setBatchDownloadProgress({
        current: batchState.current,
        total: filesToDownloadForBatch.length,
        success: batchState.success,
        failed: batchState.failed,
      });
    });

    const getAbort = () => batchDownloadAbortRef.current?.signal.aborted ?? false;

    const items = filesToDownloadForBatch
      .map((file) => ({ file, suggestion: suggestions.get(file.path) as QualityUpgradeSuggestion }))
      .filter((x) => x.suggestion);

    await runWithConcurrency(
      items,
      BATCH_DOWNLOAD_CONCURRENCY,
      async ({ file, suggestion }) => {
        if (getAbort()) return null;
        try {
          const result = await Promise.race([
            handleDownload(file, suggestion),
            new Promise<boolean>((_, reject) => {
              setTimeout(() => reject(new Error("Download timeout")), 120000);
            }),
          ]);
          const success = result;
          batchState.current++;
          if (success) {
            batchState.success++;
            if (deleteOldFilesAfterDownload) {
              try {
                await DeleteFile(file.path);
                setSuggestions((prev) => {
                  const next = new Map(prev);
                  next.delete(file.path);
                  return next;
                });
                setDeletedFiles((prev) => new Set(prev).add(file.path));
              } catch (deleteErr) {
                console.error("Failed to delete old file:", deleteErr);
              }
            }
          } else {
            batchState.failed++;
          }
          flushProgress();
          return success;
        } catch (err) {
          console.error(`Batch download error for ${file.name}:`, err);
          batchState.current++;
          batchState.failed++;
          flushProgress();
          return false;
        }
      },
      { getAbort },
    );

    batchDownloadAbortRef.current = null;
    setBatchDownloading(false);
    setBatchDownloadAbort(null);
    setBatchDownloadProgress({
      current: batchState.current,
      total: filesToDownloadForBatch.length,
      success: batchState.success,
      failed: batchState.failed,
    });

    if (!getAbort()) {
      toast.success("Batch download complete", {
        description: `${batchState.success} succeeded, ${batchState.failed} failed`,
      });
      loadFiles();
      // Re-check existence so newly downloaded tracks show as "Already in library" and eligible count updates
      await refreshExistingInLibrary();
    } else {
      toast.info(
        `Download stopped after ${batchState.success} succeeded, ${batchState.failed} failed`,
      );
    }
  }, [
    filesToDownloadForBatch,
    skipAlreadyInLibrary,
    suggestions,
    handleDownload,
    deleteOldFilesAfterDownload,
    loadFiles,
    refreshExistingInLibrary,
  ]);

  const handleStopBatchDownload = useCallback(() => {
    if (batchDownloadAbort) {
      batchDownloadAbort.abort();
      setBatchDownloadAbort(null);
    }
    setBatchDownloading(false);
  }, [batchDownloadAbort]);

  const handleFetchLyrics = useCallback(
    async (
      filePath: string,
      spotifyId?: string,
      trackName?: string,
      artistName?: string,
    ) => {
      setFetchingLyricsFor(filePath);
      try {
        const jsonString = await FetchLyricsForFile({
          file_path: filePath,
          spotify_id: spotifyId,
          track_name: trackName,
          artist_name: artistName,
          embed_in_file:
            lyricsEmbedMode === "embed" || lyricsEmbedMode === "both",
          save_as_lrc: lyricsEmbedMode === "lrc" || lyricsEmbedMode === "both",
        });

        const response = JSON.parse(jsonString);
        if (response.success) {
          toast.success("Lyrics fetched!", {
            description: `${response.lines_count} lines from ${response.source}`,
          });
        } else {
          toast.error("No lyrics found");
        }
      } catch (err) {
        toast.error("Failed to fetch lyrics", {
          description: err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        setFetchingLyricsFor(null);
      }
    },
    [lyricsEmbedMode],
  );

  const handlePreviewAudio = useCallback(async (filePath: string) => {
    setPreviewingAudio(filePath);
    try {
      const base64 = await ReadAudioFileAsBase64(filePath);
      const ext = getFileExtension(filePath);
      const mimeType =
        ext === "mp3"
          ? "audio/mpeg"
          : ext === "flac"
            ? "audio/flac"
            : ext === "m4a"
              ? "audio/mp4"
              : "audio/ogg";
      setAudioDataUrl(`data:${mimeType};base64,${base64}`);
    } catch (err) {
      toast.error("Failed to load audio", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
      setPreviewingAudio(null);
    }
  }, []);

  const handleStopPreview = useCallback(() => {
    setPreviewingAudio(null);
    setAudioDataUrl("");
  }, []);

  const handleOpenLocation = useCallback(async (filePath: string) => {
    try {
      await OpenFileLocation(filePath);
    } catch (err) {
      toast.error("Failed to open location", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }, []);

  const handleDeleteFile = useCallback(async (filePath: string) => {
    try {
      await DeleteFile(filePath);
      // Remove from suggestions and track as deleted
      setSuggestions((prev) => {
        const newMap = new Map(prev);
        newMap.delete(filePath);
        return newMap;
      });
      setDeletedFiles((prev) => new Set(prev).add(filePath));
      toast.success("File deleted");
    } catch (err) {
      console.error("Failed to delete file:", err);
      toast.error("Failed to delete file", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const handleClearResults = useCallback(() => {
    setSuggestions(new Map());
    setDeletedFiles(new Set());
    localStorage.removeItem(STORAGE_KEY);
    toast.success("Results cleared");
  }, []);

  // Reset deleted files when changing folder
  useEffect(() => {
    setDeletedFiles(new Set());
  }, [rootPath]);

  // ==========================================
  // Render
  // ==========================================

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <TrendingUp className="h-6 w-6 text-primary" />
            Quality Upgrade
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Scan your library and upgrade to high-quality FLAC versions
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setShowSettings(!showSettings)}
          className={showSettings ? "bg-muted" : ""}
        >
          <Settings2 className="h-5 w-5" />
        </Button>
      </div>

      {/* Folder Selection */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <FolderOpen className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {rootPath || "No folder selected"}
              </p>
              {rootPath && (
                <p className="text-xs text-muted-foreground">
                  {audioFiles.length} audio files found
                </p>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={handleSelectFolder}>
              Browse
            </Button>
            {rootPath && (
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9"
                onClick={loadFiles}
                disabled={loading}
              >
                <RefreshCw
                  className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
                />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Settings Panel (collapsible) */}
      {showSettings && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm font-medium">Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-0">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Lyrics Mode</Label>
                <Select
                  value={lyricsEmbedMode}
                  onValueChange={(v) =>
                    setLyricsEmbedMode(v as typeof lyricsEmbedMode)
                  }
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="embed">Embed in file</SelectItem>
                    <SelectItem value="lrc">.lrc file</SelectItem>
                    <SelectItem value="both">Both</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Min. Confidence for Batch</Label>
                <Select
                  value={minimumConfidenceForBatch}
                  onValueChange={(v) =>
                    setMinimumConfidenceForBatch(
                      v as typeof minimumConfidenceForBatch,
                    )
                  }
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="high">High only</SelectItem>
                    <SelectItem value="medium">Medium+</SelectItem>
                    <SelectItem value="low">Low+</SelectItem>
                    <SelectItem value="all">All matches</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2 flex items-end gap-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="delete-old"
                    checked={deleteOldFilesAfterDownload}
                    onCheckedChange={(c) =>
                      setDeleteOldFilesAfterDownload(c === true)
                    }
                  />
                  <Label
                    htmlFor="delete-old"
                    className="text-xs cursor-pointer"
                  >
                    Delete old files after download
                  </Label>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats Cards */}
      {audioFiles.length > 0 && (
        <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-2">
          <StatCard
            label="Total"
            value={stats.total}
            icon={FileMusic}
            onClick={() => setUpgradeFilter("all")}
            isActive={upgradeFilter === "all"}
          />
          <StatCard
            label="Lossy"
            value={stats.lossy}
            icon={Zap}
            color="text-orange-500"
          />
          <StatCard
            label="Unscanned"
            value={stats.unscanned}
            icon={Clock}
            color="text-muted-foreground"
            onClick={() => setUpgradeFilter("unscanned")}
            isActive={upgradeFilter === "unscanned"}
          />
          <StatCard
            label="Available"
            value={stats.available}
            icon={CheckCircle2}
            color="text-emerald-500"
            onClick={() => setUpgradeFilter("available")}
            isActive={upgradeFilter === "available"}
          />
          <StatCard
            label="Unavailable"
            value={stats.unavailable}
            icon={XCircle}
            color="text-amber-500"
            onClick={() => setUpgradeFilter("unavailable")}
            isActive={upgradeFilter === "unavailable"}
          />
          <StatCard
            label="Errors"
            value={stats.errors}
            icon={AlertCircle}
            color="text-red-500"
            onClick={() => setUpgradeFilter("errors")}
            isActive={upgradeFilter === "errors"}
          />
          <StatCard
            label="In library"
            value={stats.inLibrary}
            icon={Library}
            color="text-blue-500"
            onClick={() => setLibraryFilter("in-library")}
            isActive={libraryFilter === "in-library"}
          />
        </div>
      )}

      {/* Progress Bars */}
      {batchScanning && (
        <Card className="border-primary/50">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Spinner className="h-4 w-4" />
                <span className="text-sm font-medium">Scanning files...</span>
              </div>
              <Button variant="ghost" size="sm" onClick={handleStopBatchScan}>
                <StopCircle className="h-4 w-4 mr-1" />
                Stop
              </Button>
            </div>
            <Progress
              value={
                (batchScanProgress.current / batchScanProgress.total) * 100
              }
              className="h-2"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {batchScanProgress.current} of {batchScanProgress.total} files •{" "}
              {Math.round(
                (batchScanProgress.current / batchScanProgress.total) * 100,
              )}
              %
            </p>
          </CardContent>
        </Card>
      )}

      {batchDownloading && (
        <Card className="border-emerald-500/50">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Download className="h-4 w-4 animate-bounce" />
                <span className="text-sm font-medium">
                  Downloading upgrades...
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleStopBatchDownload}
              >
                <StopCircle className="h-4 w-4 mr-1" />
                Stop
              </Button>
            </div>
            <Progress
              value={
                (batchDownloadProgress.current / batchDownloadProgress.total) *
                100
              }
              className="h-2"
            />
            <div className="flex items-center justify-between mt-1">
              <p className="text-xs text-muted-foreground">
                {batchDownloadProgress.current} of {batchDownloadProgress.total}{" "}
                files
              </p>
              <p className="text-xs">
                <span className="text-emerald-500">
                  ✓ {batchDownloadProgress.success}
                </span>
                {" • "}
                <span className="text-red-500">
                  ✗ {batchDownloadProgress.failed}
                </span>
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters & Actions */}
      {audioFiles.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-4">
            {/* Filters */}
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={formatFilter}
                onValueChange={(v) => setFormatFilter(v as FormatFilter)}
              >
                <SelectTrigger className="h-8 w-[130px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Formats</SelectItem>
                  <SelectItem value="lossy-only">Lossy Only</SelectItem>
                  <SelectItem value="flac-only">FLAC Only</SelectItem>
                </SelectContent>
              </Select>

              <Select
                value={confidenceFilter}
                onValueChange={(v) =>
                  setConfidenceFilter(v as ConfidenceFilter)
                }
              >
                <SelectTrigger className="h-8 w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Confidence</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>

              <Select
                value={libraryFilter}
                onValueChange={(v) => setLibraryFilter(v as LibraryFilter)}
              >
                <SelectTrigger className="h-8 w-[130px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="in-library">In library</SelectItem>
                  <SelectItem value="not-in-library">Not in library</SelectItem>
                </SelectContent>
              </Select>

              <Select
                value={sortBy}
                onValueChange={(v) => setSortBy(v as SortOption)}
              >
                <SelectTrigger className="h-8 w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="name">Name</SelectItem>
                  <SelectItem value="size-asc">Size ↑</SelectItem>
                  <SelectItem value="size-desc">Size ↓</SelectItem>
                  <SelectItem value="format">Format</SelectItem>
                  <SelectItem value="need-upgrade-first">Need upgrade first</SelectItem>
                </SelectContent>
              </Select>

              <div className="flex-1" />

              <span className="text-xs text-muted-foreground">
                {filteredFiles.length} files
              </span>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t">
              {!batchScanning ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBatchScan}
                  disabled={loading || batchDownloading}
                >
                  <Search className="h-4 w-4 mr-1.5" />
                  Scan All
                  {stats.unscanned > 0 && (
                    <Badge variant="secondary" className="ml-1.5 text-[10px]">
                      {stats.unscanned}
                    </Badge>
                  )}
                </Button>
              ) : (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleStopBatchScan}
                >
                  <StopCircle className="h-4 w-4 mr-1.5" />
                  Stop Scan
                </Button>
              )}

              <div className="flex items-center gap-1.5">
                <Checkbox
                  id="skip-already-in-library"
                  checked={skipAlreadyInLibrary}
                  onCheckedChange={(c) => setSkipAlreadyInLibrary(!!c)}
                  disabled={batchDownloading}
                />
                <Label
                  htmlFor="skip-already-in-library"
                  className="text-xs cursor-pointer select-none text-muted-foreground"
                >
                  Skip already in library
                </Label>
              </div>

              {!batchDownloading ? (
                <Button
                  size="sm"
                  onClick={handleBatchDownload}
                  disabled={
                    filesToDownloadForBatch.length === 0 || batchScanning
                  }
                >
                  <Download className="h-4 w-4 mr-1.5" />
                  Upgrade All
                  {filesToDownloadForBatch.length > 0 && (
                    <Badge variant="secondary" className="ml-1.5 text-[10px]">
                      {filesToDownloadForBatch.length}
                    </Badge>
                  )}
                </Button>
              ) : (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleStopBatchDownload}
                >
                  <StopCircle className="h-4 w-4 mr-1.5" />
                  Stop Download
                </Button>
              )}

              <div className="flex-1" />

              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearResults}
                disabled={suggestions.size === 0}
              >
                <X className="h-4 w-4 mr-1.5" />
                Clear
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* File List */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Spinner className="h-8 w-8" />
          <span className="ml-3 text-muted-foreground">Loading files...</span>
        </div>
      ) : !rootPath ? (
        <EmptyState
          icon={FolderOpen}
          title="Select a folder"
          description="Choose a folder containing your audio files to scan for quality upgrades"
          action={{ label: "Browse", onClick: handleSelectFolder }}
        />
      ) : audioFiles.length === 0 ? (
        <EmptyState
          icon={FileMusic}
          title="No audio files found"
          description="The selected folder doesn't contain any supported audio files"
          action={{ label: "Change Folder", onClick: handleSelectFolder }}
        />
      ) : filteredFiles.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="No matching files"
          description="Try adjusting your filters to see more files"
          action={{
            label: "Reset Filters",
            onClick: () => {
              setUpgradeFilter("all");
              setConfidenceFilter("all");
              setFormatFilter("all");
            },
          }}
        />
      ) : (
        <div className="space-y-2">
          {paginatedFiles.map((file) => {
            const suggestion = suggestions.get(file.path);
            return (
              <FileItem
                key={file.path}
                file={file}
                suggestion={suggestion}
                isScanning={scanningFiles.has(file.path)}
                isDownloading={downloadingTracks.has(file.path)}
                isFetchingLyrics={fetchingLyricsFor === file.path}
                isPreviewingAudio={previewingAudio === file.path}
                audioDataUrl={previewingAudio === file.path ? audioDataUrl : ""}
                alreadyInLibrary={suggestion?.spotify_id ? existingInLibrarySpotifyIds.has(suggestion.spotify_id) : false}
                alreadyInLibraryPath={suggestion?.spotify_id ? existingInLibraryFilePaths.get(suggestion.spotify_id) : undefined}
                onScan={handleScanFile}
                onDownload={handleDownload}
                onFetchLyrics={handleFetchLyrics}
                onOpenLocation={handleOpenLocation}
                onPreviewAudio={handlePreviewAudio}
                onStopPreview={handleStopPreview}
                onDelete={handleDeleteFile}
                onSearchInFetch={onNavigateToFetchWithQuery}
                onAddForLater={onAddForLater}
              />
            );
          })}

          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            totalItems={filteredFiles.length}
            onPageChange={setCurrentPage}
          />
        </div>
      )}

      {/* Keyboard shortcuts hint */}
      {(batchScanning || batchDownloading || previewingAudio) && (
        <p className="text-xs text-center text-muted-foreground">
          Press{" "}
          <kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px]">Esc</kbd>{" "}
          to stop
        </p>
      )}
    </div>
  );
}
