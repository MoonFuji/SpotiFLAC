import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { InputWithContext } from "@/components/ui/input-with-context";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FolderOpen,
  RefreshCw,
  FileMusic,
  ChevronRight,
  ChevronDown,
  Pencil,
  Eye,
  Folder,
  Info,
  RotateCcw,
  FileText,
  Image,
  Copy,
  Check,
  StopCircle,
  ListFilter,
  X,
  FolderTree,
  ArrowRight,
  FolderInput,
  Play,
} from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import {
  SelectFolder,
  ListDirectoryFiles,
  PreviewRenameFiles,
  PreviewRenameMismatched,
  RenameFilesByMetadata,
  RenameFilesFromPreview,
  ReadFileMetadata,
  IsFFprobeInstalled,
  DownloadFFmpeg,
  ReadTextFile,
  RenameFileTo,
  ReadImageAsBase64,
  ReadAudioFileAsBase64,
} from "../../wailsjs/go/main/App";
import { backend } from "../../wailsjs/go/models";
import { toastWithSound as toast } from "@/lib/toast-with-sound";
import { getSettings } from "@/lib/settings";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Temporary until bindings regenerate
// const FindDuplicateTracks = (folderPath: string): Promise<string> =>
//   (
//     window as unknown as {
//       go: {
//         main: { App: { FindDuplicateTracks: (p: string) => Promise<string> } };
//       };
//     }
//   ).go.main.App.FindDuplicateTracks(folderPath);

// Advanced scan with options (uses JSON options parameter)
const FindDuplicateTracksWithOptions = (
  folderPath: string,
  optsJson: string,
): Promise<string> =>
  (
    window as unknown as {
      go: {
        main: { App: { FindDuplicateTracksWithOptions: (p: string, o: string) => Promise<string> } };
      };
    }
  ).go.main.App.FindDuplicateTracksWithOptions(folderPath, optsJson);

// Batch file operations
const DeleteFiles = (filePaths: string[]): Promise<Record<string, string>> =>
  (
    window as unknown as {
      go: { main: { App: { DeleteFiles: (p: string[]) => Promise<Record<string, string>> } } };
    }
  ).go.main.App.DeleteFiles(filePaths);

const MoveFilesToQuarantine = (filePaths: string[], rootPath: string): Promise<Record<string, string>> =>
  (
    window as unknown as {
      go: { main: { App: { MoveFilesToQuarantine: (p: string[], r: string) => Promise<Record<string, string>> } } };
    }
  ).go.main.App.MoveFilesToQuarantine(filePaths, rootPath);
const OpenFileLocation = (filePath: string): Promise<void> =>
  (
    window as unknown as {
      go: { main: { App: { OpenFileLocation: (p: string) => Promise<void> } } };
    }
  ).go.main.App.OpenFileLocation(filePath);
const DeleteFile = (filePath: string): Promise<void> =>
  (
    window as unknown as {
      go: { main: { App: { DeleteFile: (p: string) => Promise<void> } } };
    }
  ).go.main.App.DeleteFile(filePath);
const CheckDuplicateGroup = (filePaths: string[]): Promise<string> =>
  (
    window as unknown as {
      go: {
        main: {
          App: { CheckDuplicateGroup: (p: string[]) => Promise<string> };
        };
      };
    }
  ).go.main.App.CheckDuplicateGroup(filePaths);

// Smart File Organization API wrappers
const PreviewOrganization = (req: OrganizePreviewRequest): Promise<string> =>
  (
    window as unknown as {
      go: {
        main: {
          App: {
            PreviewOrganization: (
              req: OrganizePreviewRequest,
            ) => Promise<string>;
          };
        };
      };
    }
  ).go.main.App.PreviewOrganization(req);

const ExecuteOrganization = (req: OrganizeExecuteRequest): Promise<string> =>
  (
    window as unknown as {
      go: {
        main: {
          App: {
            ExecuteOrganization: (
              req: OrganizeExecuteRequest,
            ) => Promise<string>;
          };
        };
      };
    }
  ).go.main.App.ExecuteOrganization(req);

const AnalyzeOrganization = (rootPath: string): Promise<string> =>
  (
    window as unknown as {
      go: {
        main: { App: { AnalyzeOrganization: (p: string) => Promise<string> } };
      };
    }
  ).go.main.App.AnalyzeOrganization(rootPath);

// Organization interfaces
interface OrganizePreviewRequest {
  source_path: string;
  folder_structure: string;
  file_name_format: string;
  conflict_resolution: string;
  include_subfolders: boolean;
  files_filter: string[];
  file_extension_filter: string;
}

interface OrganizeExecuteRequest {
  source_path: string;
  items: OrganizePreviewItem[];
  create_folders: boolean;
  move_files: boolean;
  delete_empty_folders: boolean;
  conflict_resolution: string;
}

interface OrganizePreviewItem {
  source_path: string;
  destination_path: string;
  file_name: string;
  new_file_name?: string;
  metadata?: FileMetadata;
  status: string; // "will_move", "conflict", "missing_metadata", "unchanged", "error"
  conflict_with?: string;
  error?: string;
  folder_path: string;
}

interface OrganizePreviewResponse {
  items: OrganizePreviewItem[];
  total_files: number;
  will_move: number;
  conflicts: number;
  unchanged: number;
  errors: number;
  folders_to_create: string[];
}

interface OrganizeExecuteResponse {
  results: OrganizeExecuteResult[];
  total_processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  folders_created: number;
  folders_deleted: number;
  empty_folders?: string[];
}

interface OrganizeExecuteResult {
  source_path: string;
  destination_path: string;
  success: boolean;
  error?: string;
  skipped?: boolean;
  action?: string;
}

interface OrganizationAnalysis {
  total_files: number;
  unique_artists: number;
  unique_albums: number;
  orphaned_files: string[];
  missing_metadata: string[];
  inconsistent_path: string[];
  artist_folders: Record<string, number>;
  album_folders: Record<string, number>;
}

interface FetchLyricsForFileResponse {
  success: boolean;
  message: string;
  lrc_file?: string;
  embedded: boolean;
  lyrics_type?: string;
  source?: string;
  error?: string;
  lines_count?: number;
  already_has_lyrics?: boolean;
  already_has_lrc?: boolean;
  skipped?: boolean;
}

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

interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  children?: FileNode[];
  expanded?: boolean;
}
interface FileMetadata {
  title: string;
  artist: string;
  album: string;
  album_artist: string;
  track_number: number;
  disc_number: number;
  year: string;
}
interface DuplicateGroup {
  files: string[];
  title: string;
  artist: string;
  total_size: number;
  formats: string[];
  best_quality_file: string;
  best_quality_reason?: string;
  lossless_count?: number;
  lossy_count?: number;
  avg_bitrate?: number;
  representative_duration?: number;
  file_details?: Array<{
    path: string;
    size: number;
    format: string;
    duration: number;
    bitrate?: number;
    sample_rate?: number;
    bit_depth?: number;
    channels?: number;
    codec?: string;
    lossless?: boolean;
  }>;
}

type TabType =
  | "track"
  | "lyric"
  | "cover"
  | "duplicates"
  | "organize";
const FORMAT_PRESETS: Record<
  string,
  {
    label: string;
    template: string;
  }
> = {
  title: { label: "Title", template: "{title}" },
  "title-artist": { label: "Title - Artist", template: "{title} - {artist}" },
  "artist-title": { label: "Artist - Title", template: "{artist} - {title}" },
  "track-title": { label: "Track. Title", template: "{track}. {title}" },
  "track-title-artist": {
    label: "Track. Title - Artist",
    template: "{track}. {title} - {artist}",
  },
  "track-artist-title": {
    label: "Track. Artist - Title",
    template: "{track}. {artist} - {title}",
  },
  "title-album-artist": {
    label: "Title - Album Artist",
    template: "{title} - {album_artist}",
  },
  "track-title-album-artist": {
    label: "Track. Title - Album Artist",
    template: "{track}. {title} - {album_artist}",
  },
  "artist-album-title": {
    label: "Artist - Album - Title",
    template: "{artist} - {album} - {title}",
  },
  "track-dash-title": { label: "Track - Title", template: "{track} - {title}" },
  "disc-track-title": {
    label: "Disc-Track. Title",
    template: "{disc}-{track}. {title}",
  },
  "disc-track-title-artist": {
    label: "Disc-Track. Title - Artist",
    template: "{disc}-{track}. {title} - {artist}",
  },
  custom: { label: "Custom...", template: "{title} - {artist}" },
};
const STORAGE_KEY = "spotiflac_file_manager_state";
const DUPLICATES_STORAGE_KEY = "spotiflac_duplicates";
const DEFAULT_PRESET = "title-artist";
const DEFAULT_CUSTOM_FORMAT = "{title} - {artist}";

// Folder structure presets for organization
const FOLDER_STRUCTURE_PRESETS: Record<
  string,
  { label: string; template: string; description: string }
> = {
  "artist-album": {
    label: "Artist / Album",
    template: "{artist}/{album}",
    description: "Organizes as: Pink Floyd/The Dark Side of the Moon/",
  },
  "album_artist-album": {
    label: "Album Artist / Album",
    template: "{album_artist}/{album}",
    description: "Uses album artist (better for compilations)",
  },
  "artist-album-year": {
    label: "Artist / Album (Year)",
    template: "{artist}/{album} ({year})",
    description: "Organizes as: Pink Floyd/The Dark Side of the Moon (1973)/",
  },
  "album_artist-album-year": {
    label: "Album Artist / Album (Year)",
    template: "{album_artist}/{album} ({year})",
    description: "Uses album artist with year",
  },
  "artist-year-album": {
    label: "Artist / Year - Album",
    template: "{artist}/{year} - {album}",
    description: "Organizes as: Pink Floyd/1973 - The Dark Side of the Moon/",
  },
  "artist-only": {
    label: "Artist Only",
    template: "{artist}",
    description: "Flat structure by artist only",
  },
  "album-only": {
    label: "Album Only",
    template: "{album}",
    description: "Flat structure by album only",
  },
  "year-artist-album": {
    label: "Year / Artist / Album",
    template: "{year}/{artist}/{album}",
    description: "Organizes by year first",
  },
  custom: {
    label: "Custom...",
    template: "{artist}/{album}",
    description: "Define your own folder structure",
  },
};
function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
export function FileManagerPage() {
  const [rootPath, setRootPath] = useState(() => {
    const settings = getSettings();
    return settings.downloadPath || "";
  });
  const [allFiles, setAllFiles] = useState<FileNode[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>("track");
  const [formatPreset, setFormatPreset] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.formatPreset && FORMAT_PRESETS[parsed.formatPreset]) {
          return parsed.formatPreset;
        }
      }
    } catch {
      // Ignore localStorage errors
    }
    return DEFAULT_PRESET;
  });
  const [customFormat, setCustomFormat] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.customFormat) return parsed.customFormat;
      }
    } catch {
      // Ignore localStorage errors
    }
    return DEFAULT_CUSTOM_FORMAT;
  });
  const renameFormat =
    formatPreset === "custom"
      ? customFormat || FORMAT_PRESETS["custom"].template
      : FORMAT_PRESETS[formatPreset].template;
  const [showPreview, setShowPreview] = useState(false);
  const [previewData, setPreviewData] = useState<backend.RenamePreview[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [previewOnly, setPreviewOnly] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showMetadata, setShowMetadata] = useState(false);
  const [metadataFile, setMetadataFile] = useState<string>("");
  const [metadataInfo, setMetadataInfo] = useState<FileMetadata | null>(null);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [showFFprobeDialog, setShowFFprobeDialog] = useState(false);
  const [installingFFprobe, setInstallingFFprobe] = useState(false);
  const [showLyricsPreview, setShowLyricsPreview] = useState(false);
  const [lyricsContent, setLyricsContent] = useState("");
  const [lyricsFile, setLyricsFile] = useState("");
  const [lyricsTab, setLyricsTab] = useState<"synced" | "plain">("synced");
  const [copySuccess, setCopySuccess] = useState(false);
  const [showCoverPreview, setShowCoverPreview] = useState(false);
  const [coverFile, setCoverFile] = useState("");
  const [coverData, setCoverData] = useState("");
  const [showManualRename, setShowManualRename] = useState(false);
  const [manualRenameFile, setManualRenameFile] = useState("");
  const [manualRenameName, setManualRenameName] = useState("");
  const [manualRenaming, setManualRenaming] = useState(false);
  const [previewingAudio, setPreviewingAudio] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);
  const [scanningDuplicates, setScanningDuplicates] = useState(false);
  const [deletingDuplicateFile, setDeletingDuplicateFile] = useState<
    string | null
  >(null);
  const [validatingDuplicateGroup, setValidatingDuplicateGroup] = useState<
    number | null
  >(null);

  // Duplicate scan options & selection state
  const [duplicateUseHash, setDuplicateUseHash] = useState(false);
  const [duplicateDurationTolerance, setDuplicateDurationTolerance] =
    useState<number>(3000); // milliseconds
  const [duplicateIgnoreDuration, setDuplicateIgnoreDuration] = useState(false);
  const [duplicateUseFingerprint, setDuplicateUseFingerprint] = useState(false);
  const [duplicateUseFilenameFallback] = useState<boolean>(true);

  // Selection state for batch operations (stores group indices)
  const [selectedDuplicateGroups, setSelectedDuplicateGroups] = useState<
    Set<number>
  >(new Set());
  const [processingDuplicateAction, setProcessingDuplicateAction] =
    useState(false);
  const [fetchingLyricsFor, setFetchingLyricsFor] = useState<string | null>(
    null,
  );
  const [lyricsEmbedMode, setLyricsEmbedMode] = useState<
    "embed" | "lrc" | "both"
  >("embed");
  const [batchFetchingLyrics, setBatchFetchingLyrics] = useState(false);
  const [batchLyricsAbort, setBatchLyricsAbort] =
    useState<AbortController | null>(null);
  const [batchLyricsProgress, setBatchLyricsProgress] = useState({
    current: 0,
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0,
  });

  // Smart File Organization states
  const [organizeFolderPreset, setOrganizeFolderPreset] =
    useState("artist-album");
  const [organizeCustomFolder, setOrganizeCustomFolder] =
    useState("{artist}/{album}");
  const [organizeFileFormatPreset, setOrganizeFileFormatPreset] =
    useState<string>("none");
  const [organizeFileFormatCustom, setOrganizeFileFormatCustom] =
    useState<string>("");
  const [organizeFLACOnly, setOrganizeFLACOnly] = useState(false);
  const [organizeEmbedLyrics, setOrganizeEmbedLyrics] = useState(false);
  const [organizeConflictResolution, setOrganizeConflictResolution] = useState<
    "skip" | "rename" | "overwrite"
  >("skip");
  const [organizeIncludeSubfolders, setOrganizeIncludeSubfolders] =
    useState(true);
  const [organizeMoveFiles, setOrganizeMoveFiles] = useState(true);
  const [organizeDeleteEmptyFolders, setOrganizeDeleteEmptyFolders] =
    useState(true);
  const [organizePreview, setOrganizePreview] =
    useState<OrganizePreviewResponse | null>(null);
  const [organizeSelectedItems, setOrganizeSelectedItems] = useState<
    Set<string>
  >(new Set());
  const [organizePreviewing, setOrganizePreviewing] = useState(false);
  const [organizeExecuting, setOrganizeExecuting] = useState(false);
  const [, setOrganizeExecuteProgress] = useState({
    current: 0,
    total: 0,
    success: 0,
    failed: 0,
  });
  const [organizeStatusFilter, setOrganizeStatusFilter] = useState<
    "all" | "will_move" | "conflict" | "error" | "unchanged"
  >("all");
  const [organizeAnalysis, setOrganizeAnalysis] =
    useState<OrganizationAnalysis | null>(null);
  const [organizeAnalyzing, setOrganizeAnalyzing] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ formatPreset, customFormat }),
      );
    } catch {
      // Ignore localStorage errors
    }
  }, [formatPreset, customFormat]);

  // Load persisted duplicates
  useEffect(() => {
    if (!rootPath) return;
    try {
      const key = `${DUPLICATES_STORAGE_KEY}_${rootPath}`;
      const saved = localStorage.getItem(key);
      if (saved) {
        const data: DuplicateGroup[] = JSON.parse(saved);
        setDuplicates(data);
      }
    } catch {
      // Ignore localStorage errors
    }
  }, [rootPath]);

  // Save duplicates to localStorage
  useEffect(() => {
    if (!rootPath || duplicates.length === 0) return;
    try {
      const key = `${DUPLICATES_STORAGE_KEY}_${rootPath}`;
      localStorage.setItem(key, JSON.stringify(duplicates));
    } catch {
      // Ignore localStorage errors
    }
  }, [duplicates, rootPath]);

  useEffect(() => {
    const checkFullscreen = () => {
      const isMaximized = window.innerHeight >= window.screen.height * 0.9;
      setIsFullscreen(isMaximized);
    };
    checkFullscreen();
    window.addEventListener("resize", checkFullscreen);
    window.addEventListener("focus", checkFullscreen);
    return () => {
      window.removeEventListener("resize", checkFullscreen);
      window.removeEventListener("focus", checkFullscreen);
    };
  }, []);
  const filterFilesByType = (nodes: FileNode[], type: TabType): FileNode[] => {
    return nodes
      .map((node) => {
        if (node.is_dir && node.children) {
          const filteredChildren = filterFilesByType(node.children, type);
          if (filteredChildren.length > 0) {
            return { ...node, children: filteredChildren };
          }
          return null;
        }
        const ext = node.name.toLowerCase();
        if (
          type === "track" &&
          (ext.endsWith(".flac") ||
            ext.endsWith(".mp3") ||
            ext.endsWith(".m4a"))
        )
          return node;
        if (type === "lyric" && ext.endsWith(".lrc")) return node;
        if (
          type === "cover" &&
          (ext.endsWith(".jpg") ||
            ext.endsWith(".jpeg") ||
            ext.endsWith(".png"))
        )
          return node;
        return null;
      })
      .filter((node): node is FileNode => node !== null);
  };
  const loadFiles = useCallback(async () => {
    if (!rootPath) return;
    setLoading(true);
    try {
      const result = await ListDirectoryFiles(rootPath);
      if (!result || !Array.isArray(result)) {
        setAllFiles([]);
        setSelectedFiles(new Set());
        return;
      }
      setAllFiles(result as FileNode[]);
      setSelectedFiles(new Set());
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err || "");
      if (
        !errorMsg.toLowerCase().includes("empty") &&
        !errorMsg.toLowerCase().includes("no file")
      ) {
        toast.error("Failed to load files", {
          description: errorMsg || "Unknown error",
        });
      }
      setAllFiles([]);
      setSelectedFiles(new Set());
    } finally {
      setLoading(false);
    }
  }, [rootPath]);
  useEffect(() => {
    if (rootPath) loadFiles();
  }, [rootPath, loadFiles]);
  const filteredFiles = filterFilesByType(allFiles, activeTab);
  const getAllFilesFlat = (nodes: FileNode[]): FileNode[] => {
    const result: FileNode[] = [];
    for (const node of nodes) {
      if (!node.is_dir) result.push(node);
      if (node.children) result.push(...getAllFilesFlat(node.children));
    }
    return result;
  };
  const allAudioFiles = getAllFilesFlat(filterFilesByType(allFiles, "track"));
  const allLyricFiles = getAllFilesFlat(filterFilesByType(allFiles, "lyric"));
  const allCoverFiles = getAllFilesFlat(filterFilesByType(allFiles, "cover"));
  const handleSelectFolder = async () => {
    try {
      const path = await SelectFolder(rootPath);
      if (path) setRootPath(path);
    } catch (err) {
      toast.error("Failed to select folder", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };
  const toggleExpand = (path: string) => {
    setAllFiles((prev) => toggleNodeExpand(prev, path));
  };
  const toggleNodeExpand = (nodes: FileNode[], path: string): FileNode[] => {
    return nodes.map((node) => {
      if (node.path === path) return { ...node, expanded: !node.expanded };
      if (node.children)
        return { ...node, children: toggleNodeExpand(node.children, path) };
      return node;
    });
  };
  const toggleSelect = (path: string) => {
    setSelectedFiles((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(path)) newSet.delete(path);
      else newSet.add(path);
      return newSet;
    });
  };
  const toggleFolderSelect = (node: FileNode) => {
    const folderFiles = getAllFilesFlat([node]);
    const allSelected = folderFiles.every((f) => selectedFiles.has(f.path));
    setSelectedFiles((prev) => {
      const newSet = new Set(prev);
      if (allSelected) folderFiles.forEach((f) => newSet.delete(f.path));
      else folderFiles.forEach((f) => newSet.add(f.path));
      return newSet;
    });
  };
  const isFolderSelected = (node: FileNode): boolean | "indeterminate" => {
    const folderFiles = getAllFilesFlat([node]);
    if (folderFiles.length === 0) return false;
    const selectedCount = folderFiles.filter((f) =>
      selectedFiles.has(f.path),
    ).length;
    if (selectedCount === 0) return false;
    if (selectedCount === folderFiles.length) return true;
    return "indeterminate";
  };
  const selectAll = () =>
    setSelectedFiles(new Set(allAudioFiles.map((f) => f.path)));
  const deselectAll = () => setSelectedFiles(new Set());

  const handleAudioPreview = async (filePath: string) => {
    if (previewingAudio === filePath) {
      // Stop preview
      setPreviewingAudio(null);
      return;
    }

    try {
      await ReadAudioFileAsBase64(filePath);
      setPreviewingAudio(filePath);
    } catch (err) {
      toast.error("Failed to load audio", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const handleFindDuplicates = async () => {
    // Backwards-compatible quick scan (defaults)
    await handleFindDuplicatesWithOptions();
  };

  const handleFindDuplicatesWithOptions = async (extraOpts?: {
    useHash?: boolean;
    durationToleranceMs?: number;
    useFilenameFallback?: boolean;
    ignoreDuration?: boolean;
    useFingerprint?: boolean;
    workerCount?: number;
  }) => {
    if (!rootPath) {
      toast.error("Please select a folder first");
      return;
    }

    setScanningDuplicates(true);
    try {
      const opts = {
        use_hash: extraOpts?.useHash ?? duplicateUseHash,
        duration_tolerance_ms:
          extraOpts?.durationToleranceMs ?? duplicateDurationTolerance,
        use_filename_fallback:
          extraOpts?.useFilenameFallback ?? duplicateUseFilenameFallback,
        ignore_duration: extraOpts?.ignoreDuration ?? duplicateIgnoreDuration,
        use_fingerprint: extraOpts?.useFingerprint ?? duplicateUseFingerprint,
        worker_count: extraOpts?.workerCount ?? 0,
      };
      const jsonString = await FindDuplicateTracksWithOptions(
        rootPath,
        JSON.stringify(opts),
      );
      const dupes: DuplicateGroup[] = JSON.parse(jsonString);
      setDuplicates(dupes);
      toast.success(`Found ${dupes.length} duplicate groups`, {
        description: `${dupes.reduce((sum, g) => sum + g.files.length, 0)} total files`,
      });
    } catch (err) {
      toast.error("Failed to find duplicates", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setScanningDuplicates(false);
    }
  };

  const handleDeleteDuplicateFile = async (
    filePath: string,
    groupIdx: number,
  ) => {
    setDeletingDuplicateFile(filePath);
    try {
      await DeleteFile(filePath);
      toast.success("File deleted");

      // Update the duplicates state to remove the deleted file
      setDuplicates((prev) => {
        const updated = [...prev];
        const group = { ...updated[groupIdx] };

        // Remove the file from the group
        const fileIdx = group.files.indexOf(filePath);
        if (fileIdx !== -1) {
          group.files = group.files.filter((f) => f !== filePath);
          group.file_details = group.file_details?.filter(
            (_, i) => i !== fileIdx,
          );

          // Recalculate total size
          group.total_size =
            group.file_details?.reduce((sum, d) => sum + d.size, 0) || 0;

          // Update best quality file if needed
          if (group.best_quality_file === filePath && group.file_details) {
            let bestSize = 0;
            group.best_quality_file = "";
            for (const detail of group.file_details) {
              if (detail.size > bestSize) {
                bestSize = detail.size;
                group.best_quality_file = detail.path;
              }
            }
          }
        }

        // If only 1 or 0 files left, remove the group entirely
        if (group.files.length < 2) {
          return updated.filter((_, i) => i !== groupIdx);
        }

        updated[groupIdx] = group;
        return updated;
      });

      // Don't call loadFiles() here — it refreshes the whole file list and resets
      // scroll to top, which is annoying when deleting many duplicates in a row.
    } catch (err) {
      toast.error("Failed to delete file", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setDeletingDuplicateFile(null);
    }
  };

  const handleValidateDuplicateGroup = async (groupIdx: number) => {
    const group = duplicates[groupIdx];
    if (!group) return;

    setValidatingDuplicateGroup(groupIdx);
    try {
      const jsonString = await CheckDuplicateGroup(group.files);
      const result = jsonString === "null" ? null : JSON.parse(jsonString);

      if (result === null) {
        // No more duplicates in this group, remove it
        setDuplicates((prev) => prev.filter((_, i) => i !== groupIdx));
        toast.success("Duplicates resolved!", {
          description: "This group no longer contains duplicates",
        });
      } else {
        // Update the group with fresh data
        setDuplicates((prev) => {
          const updated = [...prev];
          updated[groupIdx] = result as DuplicateGroup;
          return updated;
        });
        toast.info("Group updated", {
          description: `${result.files.length} files still in this group`,
        });
      }
    } catch (err) {
      toast.error("Failed to validate group", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setValidatingDuplicateGroup(null);
    }
  };

  const handleClearDuplicates = () => {
    setDuplicates([]);
    setSelectedDuplicateGroups(new Set());
    if (rootPath) {
      try {
        localStorage.removeItem(`${DUPLICATES_STORAGE_KEY}_${rootPath}`);
      } catch {
        // Ignore localStorage errors
      }
    }
    toast.success("Cleared duplicate results");
  };

  // Selection helpers
  const toggleGroupSelection = (idx: number) => {
    setSelectedDuplicateGroups((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  const selectAllDuplicateGroups = () => {
    setSelectedDuplicateGroups(new Set(duplicates.map((_, i) => i)));
  };

  const clearSelectedDuplicateGroups = () => {
    setSelectedDuplicateGroups(new Set());
  };

  const getSelectedFilePaths = () => {
    const files: string[] = [];
    selectedDuplicateGroups.forEach((idx) => {
      const g = duplicates[idx];
      if (g) {
        files.push(...g.files);
      }
    });
    return files;
  };

  const handleKeepBestAndDeleteRestSelected = async () => {
    const groupsToProcess = Array.from(selectedDuplicateGroups);
    if (groupsToProcess.length === 0) {
      toast.info("No groups selected");
      return;
    }
    if (!rootPath) {
      toast.error("Please select a folder first");
      return;
    }

    setProcessingDuplicateAction(true);
    try {
      const toDelete: string[] = [];
      for (const idx of groupsToProcess) {
        const g = duplicates[idx];
        if (!g) continue;
        const keep = g.best_quality_file;
        for (const f of g.files) {
          if (f !== keep) toDelete.push(f);
        }
      }
      if (toDelete.length === 0) {
        toast.info("Nothing to delete");
      } else {
        await DeleteFiles(toDelete);
        // refresh the groups after deletion
        await handleFindDuplicatesWithOptions();
        toast.success(`Deleted ${toDelete.length} files`);
      }
      clearSelectedDuplicateGroups();
    } catch (err) {
      toast.error("Failed to delete files", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setProcessingDuplicateAction(false);
    }
  };

  const handleExportDuplicatesCsv = () => {
    if (duplicates.length === 0) {
      toast.info("No duplicates to export");
      return;
    }

    const rows: string[][] = [
      ["Title", "Artist", "Files", "Best", "Formats", "TotalSizeMB", "LosslessCount", "AvgBitrate"],
    ];

    duplicates.forEach((g) => {
      const files = g.files.join(";");
      rows.push([
        g.title || "",
        g.artist || "",
        files,
        g.best_quality_file || "",
        (g.formats || []).join(";"),
        ((g.total_size || 0) / 1024 / 1024).toFixed(2),
        String(g.lossless_count || 0),
        String(g.avg_bitrate || 0),
      ]);
    });

    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `duplicates_${(new Date()).toISOString().slice(0, 19).replace(/:/g, "")}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    toast.success("Exported duplicates CSV");
  };

  const handleDeleteSelectedFiles = async () => {
    const files = getSelectedFilePaths();
    if (files.length === 0) {
      toast.info("No files selected");
      return;
    }
    if (!rootPath) {
      toast.error("Please select a folder first");
      return;
    }
    setProcessingDuplicateAction(true);
    try {
      await DeleteFiles(files);
      await handleFindDuplicatesWithOptions();
      toast.success(`Deleted ${files.length} files`);
      clearSelectedDuplicateGroups();
    } catch (err) {
      toast.error("Failed to delete files", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setProcessingDuplicateAction(false);
    }
  };

  const handleMoveSelectedToQuarantine = async () => {
    const files = getSelectedFilePaths();
    if (files.length === 0) {
      toast.info("No files selected");
      return;
    }
    if (!rootPath) {
      toast.error("Please select a folder first");
      return;
    }
    setProcessingDuplicateAction(true);
    try {
      const results = await MoveFilesToQuarantine(files, rootPath);
      const moved = Object.values(results).filter((v) => v === "moved").length;
      await handleFindDuplicatesWithOptions();
      toast.success(`Moved ${moved} files to quarantine`, {
        description: `${Object.keys(results).length} attempted`,
      });
      clearSelectedDuplicateGroups();
    } catch (err) {
      toast.error("Failed to move to quarantine", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setProcessingDuplicateAction(false);
    }
  };

  const handleMoveDuplicateFileToQuarantine = async (
    filePath: string,
    groupIdx?: number,
  ) => {
    if (!rootPath) {
      toast.error("Please select a folder first");
      return;
    }
    void groupIdx; // currently unused, kept for future use
    setProcessingDuplicateAction(true);
    try {
      const results = await MoveFilesToQuarantine([filePath], rootPath);
      if (results[filePath] === "moved") {
        toast.success("Moved to quarantine");
        // Refresh
        await handleFindDuplicatesWithOptions();
      } else {
        toast.error("Failed to move to quarantine", { description: results[filePath] });
      }
    } catch (err) {
      toast.error("Failed to move to quarantine", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setProcessingDuplicateAction(false);
    }
  };

  const handleFetchLyricsForFile = async (
    filePath: string,
    spotifyId?: string,
    trackName?: string,
    artistName?: string,
    silent = false,
    skipIfExists = false,
  ): Promise<{ success: boolean; skipped?: boolean }> => {
    if (fetchingLyricsFor && !silent) return { success: false };

    if (!silent) setFetchingLyricsFor(filePath);
    try {
      const jsonString = await FetchLyricsForFile({
        file_path: filePath,
        spotify_id: spotifyId,
        track_name: trackName,
        artist_name: artistName,
        embed_in_file:
          lyricsEmbedMode === "embed" || lyricsEmbedMode === "both",
        save_as_lrc: lyricsEmbedMode === "lrc" || lyricsEmbedMode === "both",
        skip_if_exists: skipIfExists,
      });

      const response: FetchLyricsForFileResponse = JSON.parse(jsonString);

      if (response.success) {
        if (response.skipped) {
          if (!silent) {
            toast.info("Lyrics already exist", {
              description: response.message,
            });
          }
          return { success: true, skipped: true };
        }
        if (!silent) {
          toast.success("Lyrics fetched!", {
            description: `${response.lines_count} lines from ${response.source}${response.embedded ? " (embedded)" : ""}${response.lrc_file ? " (.lrc saved)" : ""}`,
          });
          // Refresh file list if .lrc was saved
          if (response.lrc_file) {
            loadFiles();
          }
        }
        return { success: true, skipped: false };
      } else {
        if (!silent) {
          toast.error("Failed to fetch lyrics", {
            description: response.error || "Unknown error",
          });
        }
        return { success: false };
      }
    } catch (err) {
      if (!silent) {
        toast.error("Failed to fetch lyrics", {
          description: err instanceof Error ? err.message : "Unknown error",
        });
      }
      return { success: false };
    } finally {
      if (!silent) setFetchingLyricsFor(null);
    }
  };

  const handleBatchFetchLyrics = async () => {
    if (batchFetchingLyrics) return;

    // Get selected files or all audio files if none selected
    const filesToProcess =
      selectedFiles.size > 0
        ? allAudioFiles.filter((f) => selectedFiles.has(f.path))
        : allAudioFiles;

    if (filesToProcess.length === 0) {
      toast.info("No files to process");
      return;
    }

    const abort = new AbortController();
    setBatchLyricsAbort(abort);
    setBatchFetchingLyrics(true);
    setBatchLyricsProgress({
      current: 0,
      total: filesToProcess.length,
      success: 0,
      failed: 0,
      skipped: 0,
    });

    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < filesToProcess.length; i++) {
      if (abort.signal.aborted) break;

      const file = filesToProcess[i];
      setFetchingLyricsFor(file.path);

      try {
        const result = await handleFetchLyricsForFile(
          file.path,
          undefined,
          undefined,
          undefined,
          true,
          true, // skipIfExists = true for batch operations
        );
        if (result.success) {
          if (result.skipped) {
            skippedCount++;
          } else {
            successCount++;
          }
        } else {
          failedCount++;
        }
      } catch {
        failedCount++;
      }

      setBatchLyricsProgress({
        current: i + 1,
        total: filesToProcess.length,
        success: successCount,
        failed: failedCount,
        skipped: skippedCount,
      });

      // Small delay between requests
      if (i < filesToProcess.length - 1 && !abort.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    setFetchingLyricsFor(null);
    setBatchFetchingLyrics(false);
    setBatchLyricsAbort(null);

    if (!abort.signal.aborted) {
      toast.success("Batch lyrics fetch complete", {
        description: `${successCount} fetched, ${skippedCount} skipped (already have lyrics), ${failedCount} failed`,
      });
      if (lyricsEmbedMode === "lrc" || lyricsEmbedMode === "both") {
        loadFiles();
      }
    } else {
      toast.info("Batch lyrics fetch stopped", {
        description: `${successCount} fetched, ${skippedCount} skipped, ${failedCount} failed`,
      });
    }
  };

  const handleStopBatchLyrics = () => {
    if (batchLyricsAbort) {
      batchLyricsAbort.abort();
      setBatchLyricsAbort(null);
    }
  };

  const resetToDefault = () => {
    setFormatPreset(DEFAULT_PRESET);
    setCustomFormat(DEFAULT_CUSTOM_FORMAT);
    setShowResetConfirm(false);
  };
  const handlePreview = async (isPreviewOnly: boolean) => {
    if (selectedFiles.size === 0) {
      toast.error("No files selected");
      return;
    }
    const hasM4A = Array.from(selectedFiles).some((f) =>
      f.toLowerCase().endsWith(".m4a"),
    );
    if (hasM4A) {
      const installed = await IsFFprobeInstalled();
      if (!installed) {
        setShowFFprobeDialog(true);
        return;
      }
    }
    setPreviewLoading(true);
    try {
      const result = await PreviewRenameFiles(
        Array.from(selectedFiles),
        renameFormat,
      );
      setPreviewData(result);
      setPreviewOnly(isPreviewOnly);
      setShowPreview(true);
    } catch (err) {
      toast.error("Failed to generate preview", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleSelectNotMatchingFormat = async () => {
    if (allAudioFiles.length === 0) {
      toast.error("No audio files in this folder");
      return;
    }
    const hasM4A = allAudioFiles.some((f) =>
      f.path.toLowerCase().endsWith(".m4a"),
    );
    if (hasM4A) {
      const installed = await IsFFprobeInstalled();
      if (!installed) {
        setShowFFprobeDialog(true);
        return;
      }
    }
    setPreviewLoading(true);
    try {
      const paths = allAudioFiles.map((f) => f.path);
      const mismatched = await PreviewRenameMismatched(paths, renameFormat);
      setPreviewData(mismatched);
      setSelectedFiles(new Set(mismatched.map((p) => p.old_path)));
      setPreviewOnly(false);
      setShowPreview(true);
      if (mismatched.length === 0) {
        toast.success("All files already match the format", {
          description: "No files need renaming.",
        });
      } else {
        toast.success(`${mismatched.length} file(s) not matching format`, {
          description: "Selected and preview ready. Review and rename if desired.",
        });
      }
    } catch (err) {
      toast.error("Failed to find files not matching format", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleShowMetadata = async (filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (filePath.toLowerCase().endsWith(".m4a")) {
      const installed = await IsFFprobeInstalled();
      if (!installed) {
        setShowFFprobeDialog(true);
        return;
      }
    }
    setMetadataFile(filePath);
    setLoadingMetadata(true);
    try {
      const metadata = await ReadFileMetadata(filePath);
      setMetadataInfo(metadata as FileMetadata);
      setShowMetadata(true);
    } catch (err) {
      toast.error("Failed to read metadata", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
      setMetadataInfo(null);
    } finally {
      setLoadingMetadata(false);
    }
  };
  const handleInstallFFprobe = async () => {
    setInstallingFFprobe(true);
    try {
      const result = await DownloadFFmpeg();
      if (result.success) {
        toast.success("FFprobe installed successfully");
        setShowFFprobeDialog(false);
      } else
        toast.error("Failed to install FFprobe", {
          description: result.error || result.message,
        });
    } catch (err) {
      toast.error("Failed to install FFprobe", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setInstallingFFprobe(false);
    }
  };
  const handleShowLyrics = async (filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setLyricsFile(filePath);
    setLyricsTab("synced");
    try {
      const content = await ReadTextFile(filePath);
      setLyricsContent(content);
      setShowLyricsPreview(true);
    } catch (err) {
      toast.error("Failed to read lyrics file", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };
  const handleShowCover = async (filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCoverFile(filePath);
    try {
      const data = await ReadImageAsBase64(filePath);
      setCoverData(data);
      setShowCoverPreview(true);
    } catch (err) {
      toast.error("Failed to load image", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };
  const getPlainLyrics = (content: string) => {
    return content
      .split("\n")
      .map((line) => line.replace(/^\[[\d:.]+\]\s*/, ""))
      .filter((line) => !line.startsWith("[") || line.includes("]"))
      .map((line) => (line.startsWith("[") ? "" : line))
      .join("\n")
      .trim();
  };
  const formatTimestamp = (timestamp: string): string => {
    const match = timestamp.match(/\[(\d+):(\d+)(?:\.(\d+))?\]/);
    if (!match) return timestamp;
    const minutes = parseInt(match[1], 10);
    const seconds = match[2];
    return `${minutes}:${seconds}`;
  };
  const renderSyncedLyrics = (content: string) => {
    if (!content)
      return (
        <div className="text-sm text-muted-foreground">No lyrics content</div>
      );
    const lines = content.split("\n");
    return lines
      .map((line, index) => {
        if (line.match(/^\[(ti|ar|al|by|length|offset):/i)) return null;
        const match = line.match(/^(\[[\d:.]+\])(.*)$/);
        if (match) {
          const timestamp = match[1];
          const text = match[2].trim();
          if (!text) return null;
          return (
            <div key={index} className="flex items-center gap-2 py-1">
              <Badge variant="secondary" className="font-mono text-xs shrink-0">
                {formatTimestamp(timestamp)}
              </Badge>
              <span className="text-sm">{text}</span>
            </div>
          );
        }
        if (!line.trim()) return null;
        return (
          <div key={index} className="py-1">
            <span className="text-sm">{line}</span>
          </div>
        );
      })
      .filter((item) => item !== null);
  };
  const handleCopyLyrics = async () => {
    try {
      const textToCopy =
        lyricsTab === "synced" ? lyricsContent : getPlainLyrics(lyricsContent);
      await navigator.clipboard.writeText(textToCopy);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 500);
    } catch {
      toast.error("Failed to copy lyrics");
    }
  };
  const handleManualRename = (filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const fileName = filePath.split(/[/\\]/).pop() || "";
    const nameWithoutExt = fileName.replace(/\.[^.]+$/, "");
    setManualRenameFile(filePath);
    setManualRenameName(nameWithoutExt);
    setShowManualRename(true);
  };
  const handleConfirmManualRename = async () => {
    if (!manualRenameFile || !manualRenameName.trim()) return;
    setManualRenaming(true);
    try {
      await RenameFileTo(manualRenameFile, manualRenameName.trim());
      toast.success("File renamed successfully");
      setShowManualRename(false);
      loadFiles();
    } catch (err) {
      toast.error("Failed to rename file", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setManualRenaming(false);
    }
  };
  const handleRename = async () => {
    if (selectedFiles.size === 0) return;
    setRenaming(true);
    try {
      // Use preview data when available (no metadata re-read); otherwise fall back to full rename
      const result =
        previewData.length > 0
          ? await RenameFilesFromPreview(previewData)
          : await RenameFilesByMetadata(
            Array.from(selectedFiles),
            renameFormat,
          );
      const successCount = result.filter(
        (r: backend.RenameResult) => r.success,
      ).length;
      const failCount = result.filter(
        (r: backend.RenameResult) => !r.success,
      ).length;
      if (successCount > 0)
        toast.success("Rename Complete", {
          description: `${successCount} file(s) renamed${failCount > 0 ? `, ${failCount} failed` : ""}`,
        });
      else
        toast.error("Rename Failed", {
          description: `All ${failCount} file(s) failed to rename`,
        });
      setShowPreview(false);
      setSelectedFiles(new Set());
      loadFiles();
    } catch (err) {
      toast.error("Rename Failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setRenaming(false);
    }
  };

  // ============================================
  // Smart File Organization Handlers
  // ============================================

  const getOrganizeFolderTemplate = () => {
    return organizeFolderPreset === "custom"
      ? organizeCustomFolder
      : FOLDER_STRUCTURE_PRESETS[organizeFolderPreset]?.template ||
      "{artist}/{album}";
  };

  const getOrganizeFileFormatTemplate = () => {
    // "none" = keep original names (Radix Select disallows value="")
    if (organizeFileFormatPreset === "none" || organizeFileFormatPreset === "") {
      return "";
    }
    if (organizeFileFormatPreset === "custom") {
      return organizeFileFormatCustom || "";
    }
    return FORMAT_PRESETS[organizeFileFormatPreset]?.template || "";
  };

  const handleAnalyzeOrganization = async () => {
    if (!rootPath) {
      toast.error("No folder selected");
      return;
    }

    setOrganizeAnalyzing(true);
    try {
      const jsonString = await AnalyzeOrganization(rootPath);
      const analysis: OrganizationAnalysis = JSON.parse(jsonString);
      setOrganizeAnalysis(analysis);
    } catch (err) {
      toast.error("Failed to analyze organization", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setOrganizeAnalyzing(false);
    }
  };

  const handlePreviewOrganization = async () => {
    if (!rootPath) {
      toast.error("No folder selected");
      return;
    }

    setOrganizePreviewing(true);
    setOrganizePreview(null);
    setOrganizeSelectedItems(new Set());

    try {
      // Filter files if FLAC-only is enabled
      let filesFilter = selectedFiles.size > 0 ? Array.from(selectedFiles) : [];
      if (organizeFLACOnly && filesFilter.length > 0) {
        // Filter selected files to only FLAC
        filesFilter = filesFilter.filter((path) =>
          path.toLowerCase().endsWith(".flac"),
        );
      }

      const req: OrganizePreviewRequest = {
        source_path: rootPath,
        folder_structure: getOrganizeFolderTemplate(),
        file_name_format: getOrganizeFileFormatTemplate(),
        conflict_resolution: organizeConflictResolution,
        include_subfolders: organizeIncludeSubfolders,
        files_filter: filesFilter,
        file_extension_filter: organizeFLACOnly ? ".flac" : "",
      };

      const jsonString = await PreviewOrganization(req);
      const response: OrganizePreviewResponse = JSON.parse(jsonString);

      setOrganizePreview(response);

      // Pre-select all "will_move" items
      const selectedSet = new Set<string>();
      response.items.forEach((item) => {
        if (item.status === "will_move") {
          selectedSet.add(item.source_path);
        }
      });
      setOrganizeSelectedItems(selectedSet);

      if (response.will_move === 0 && response.errors === 0) {
        toast.info("No files need to be moved", {
          description: "All files are already in the correct location",
        });
      }
    } catch (err) {
      toast.error("Failed to preview organization", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setOrganizePreviewing(false);
    }
  };

  const handleExecuteOrganization = async () => {
    if (!rootPath || !organizePreview) {
      toast.error("No preview available");
      return;
    }

    // Get only selected items that will be moved
    const itemsToProcess = organizePreview.items.filter(
      (item) =>
        organizeSelectedItems.has(item.source_path) &&
        (item.status === "will_move" || item.status === "conflict"),
    );

    if (itemsToProcess.length === 0) {
      toast.info("No files selected for organization");
      return;
    }

    setOrganizeExecuting(true);
    setOrganizeExecuteProgress({
      current: 0,
      total: itemsToProcess.length,
      success: 0,
      failed: 0,
    });

    try {
      const req: OrganizeExecuteRequest = {
        source_path: rootPath,
        items: itemsToProcess,
        create_folders: true,
        move_files: organizeMoveFiles,
        delete_empty_folders: organizeDeleteEmptyFolders,
        conflict_resolution: organizeConflictResolution,
      };

      const jsonString = await ExecuteOrganization(req);
      const response: OrganizeExecuteResponse = JSON.parse(jsonString);

      setOrganizeExecuteProgress({
        current: response.total_processed,
        total: response.total_processed,
        success: response.succeeded,
        failed: response.failed,
      });

      // Embed lyrics if requested (FLAC files only)
      let lyricsEmbedded = 0;
      let lyricsFailed = 0;
      if (organizeEmbedLyrics) {
        // Filter to FLAC files only (lyrics embedding only works for FLAC)
        const filesToEmbed = response.results
          .filter(
            (r) =>
              r.success &&
              r.destination_path.toLowerCase().endsWith(".flac"),
          )
          .map((r) => r.destination_path);

        // Embed lyrics for each successfully organized file
        for (const filePath of filesToEmbed) {
          try {
            // Get metadata to extract track info
            const metadata = await ReadFileMetadata(filePath);
            if (metadata && metadata.title && metadata.artist) {
              const jsonString = await FetchLyricsForFile({
                file_path: filePath,
                // `ReadFileMetadata` doesn't guarantee a Spotify ID; the backend can search by track+artist.
                spotify_id: "",
                track_name: metadata.title,
                artist_name: metadata.artist,
                embed_in_file: true,
                save_as_lrc: false,
                skip_if_exists: true,
              });
              const lyricsResponse: FetchLyricsForFileResponse =
                JSON.parse(jsonString);
              if (lyricsResponse.success && lyricsResponse.embedded) {
                lyricsEmbedded++;
              } else {
                lyricsFailed++;
              }
            } else {
              lyricsFailed++;
            }
          } catch (err) {
            console.error(`Failed to embed lyrics for ${filePath}:`, err);
            lyricsFailed++;
          }
        }
      }

      if (response.succeeded > 0) {
        let description = `${response.succeeded} files ${organizeMoveFiles ? "moved" : "copied"}`;
        if (response.folders_created > 0) {
          description += `, ${response.folders_created} folders created`;
        }
        if (response.folders_deleted > 0) {
          description += `, ${response.folders_deleted} empty folders deleted`;
        }
        if (organizeEmbedLyrics && lyricsEmbedded > 0) {
          description += `, ${lyricsEmbedded} lyrics embedded`;
        }
        if (response.failed > 0) {
          description += `, ${response.failed} failed`;
        }
        if (organizeEmbedLyrics && lyricsFailed > 0) {
          description += `, ${lyricsFailed} lyrics failed`;
        }
        toast.success("Organization complete!", { description });
      } else {
        toast.error("Organization failed", {
          description: `All ${response.failed} files failed to process`,
        });
      }

      // Clear preview and refresh
      setOrganizePreview(null);
      setOrganizeSelectedItems(new Set());
      loadFiles();
    } catch (err) {
      toast.error("Failed to execute organization", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setOrganizeExecuting(false);
    }
  };

  const handleToggleOrganizeItem = (sourcePath: string) => {
    setOrganizeSelectedItems((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(sourcePath)) {
        newSet.delete(sourcePath);
      } else {
        newSet.add(sourcePath);
      }
      return newSet;
    });
  };

  const handleSelectAllOrganizeItems = (selectAll: boolean) => {
    if (!organizePreview) return;

    if (selectAll) {
      const allMovable = new Set<string>();
      organizePreview.items.forEach((item) => {
        if (item.status === "will_move" || item.status === "conflict") {
          allMovable.add(item.source_path);
        }
      });
      setOrganizeSelectedItems(allMovable);
    } else {
      setOrganizeSelectedItems(new Set());
    }
  };

  const getFilteredOrganizeItems = () => {
    if (!organizePreview) return [];

    if (organizeStatusFilter === "all") {
      return organizePreview.items;
    }

    return organizePreview.items.filter(
      (item) => item.status === organizeStatusFilter,
    );
  };

  const getOrganizeStatusBadge = (status: string) => {
    switch (status) {
      case "will_move":
        return (
          <Badge className="text-xs bg-green-500/10 text-green-600 border-green-500/20">
            Will Move
          </Badge>
        );
      case "conflict":
        return (
          <Badge className="text-xs bg-yellow-500/10 text-yellow-600 border-yellow-500/20">
            Conflict
          </Badge>
        );
      case "unchanged":
        return (
          <Badge className="text-xs bg-blue-500/10 text-blue-600 border-blue-500/20">
            Unchanged
          </Badge>
        );
      case "missing_metadata":
        return (
          <Badge className="text-xs bg-orange-500/10 text-orange-600 border-orange-500/20">
            Missing Metadata
          </Badge>
        );
      case "error":
        return (
          <Badge className="text-xs bg-red-500/10 text-red-600 border-red-500/20">
            Error
          </Badge>
        );
      default:
        return <Badge className="text-xs">{status}</Badge>;
    }
  };

  const renderTrackTree = (nodes: FileNode[], depth = 0) => {
    return nodes.map((node) => (
      <div key={node.path}>
        <div
          className={`flex items-center gap-2 py-1.5 px-2 rounded hover:bg-muted/50 cursor-pointer ${selectedFiles.has(node.path) ? "bg-primary/10" : ""}`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() =>
            node.is_dir ? toggleExpand(node.path) : toggleSelect(node.path)
          }
        >
          {node.is_dir ? (
            <>
              <Checkbox
                checked={isFolderSelected(node) === true}
                ref={(el) => {
                  if (el)
                    (el as HTMLButtonElement).dataset.state =
                      isFolderSelected(node) === "indeterminate"
                        ? "indeterminate"
                        : isFolderSelected(node)
                          ? "checked"
                          : "unchecked";
                }}
                onCheckedChange={() => toggleFolderSelect(node)}
                onClick={(e) => e.stopPropagation()}
                className="shrink-0 data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground"
              />
              {node.expanded ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              )}
              <Folder className="h-4 w-4 text-yellow-500 shrink-0" />
            </>
          ) : (
            <>
              <Checkbox
                checked={selectedFiles.has(node.path)}
                onCheckedChange={() => toggleSelect(node.path)}
                onClick={(e) => e.stopPropagation()}
                className="shrink-0"
              />
              <FileMusic className="h-4 w-4 text-primary shrink-0" />
            </>
          )}
          <span className="truncate text-sm flex-1">
            {node.name}
            {node.is_dir && (
              <span className="text-muted-foreground ml-1">
                ({getAllFilesFlat([node]).length})
              </span>
            )}
          </span>
          {!node.is_dir && (
            <>
              <span className="text-xs text-muted-foreground shrink-0">
                {formatFileSize(node.size)}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="p-1 rounded hover:bg-muted shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleFetchLyricsForFile(node.path);
                    }}
                    disabled={fetchingLyricsFor === node.path}
                  >
                    {fetchingLyricsFor === node.path ? (
                      <Spinner className="h-3.5 w-3.5" />
                    ) : (
                      <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>Fetch Lyrics</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="p-1 rounded hover:bg-muted shrink-0"
                    onClick={(e) => handleShowMetadata(node.path, e)}
                  >
                    <Info className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>View Metadata</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
        {node.is_dir && node.expanded && node.children && (
          <div>{renderTrackTree(node.children, depth + 1)}</div>
        )}
      </div>
    ));
  };
  const renderLyricTree = (nodes: FileNode[], depth = 0) => {
    return nodes.map((node) => (
      <div key={node.path}>
        <div
          className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-muted/50 cursor-pointer"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={(e) =>
            node.is_dir
              ? toggleExpand(node.path)
              : handleShowLyrics(node.path, e)
          }
        >
          {node.is_dir ? (
            <>
              {node.expanded ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              )}
              <Folder className="h-4 w-4 text-yellow-500 shrink-0" />
            </>
          ) : (
            <FileText className="h-4 w-4 text-blue-500 shrink-0" />
          )}
          <span className="truncate text-sm flex-1">
            {node.name}
            {node.is_dir && (
              <span className="text-muted-foreground ml-1">
                ({getAllFilesFlat([node]).length})
              </span>
            )}
          </span>
          {!node.is_dir && (
            <>
              <span className="text-xs text-muted-foreground shrink-0">
                {formatFileSize(node.size)}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="p-1 rounded hover:bg-muted shrink-0"
                    onClick={(e) => handleManualRename(node.path, e)}
                  >
                    <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Rename</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
        {node.is_dir && node.expanded && node.children && (
          <div>{renderLyricTree(node.children, depth + 1)}</div>
        )}
      </div>
    ));
  };
  const renderCoverTree = (nodes: FileNode[], depth = 0) => {
    return nodes.map((node) => (
      <div key={node.path}>
        <div
          className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-muted/50 cursor-pointer"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={(e) =>
            node.is_dir
              ? toggleExpand(node.path)
              : handleShowCover(node.path, e)
          }
        >
          {node.is_dir ? (
            <>
              {node.expanded ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              )}
              <Folder className="h-4 w-4 text-yellow-500 shrink-0" />
            </>
          ) : (
            <Image className="h-4 w-4 text-green-500 shrink-0" />
          )}
          <span className="truncate text-sm flex-1">
            {node.name}
            {node.is_dir && (
              <span className="text-muted-foreground ml-1">
                ({getAllFilesFlat([node]).length})
              </span>
            )}
          </span>
          {!node.is_dir && (
            <>
              <span className="text-xs text-muted-foreground shrink-0">
                {formatFileSize(node.size)}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="p-1 rounded hover:bg-muted shrink-0"
                    onClick={(e) => handleManualRename(node.path, e)}
                  >
                    <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Rename</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
        {node.is_dir && node.expanded && node.children && (
          <div>{renderCoverTree(node.children, depth + 1)}</div>
        )}
      </div>
    ));
  };
  const allSelected =
    allAudioFiles.length > 0 && selectedFiles.size === allAudioFiles.length;
  return (
    <div className={`space-y-6 ${isFullscreen ? "h-full flex flex-col" : ""}`}>
      <div className="flex items-center justify-between shrink-0">
        <h1 className="text-2xl font-bold">File Manager</h1>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <InputWithContext
          value={rootPath}
          onChange={(e) => setRootPath(e.target.value)}
          placeholder="Select a folder..."
          className="flex-1"
        />
        <Button onClick={handleSelectFolder}>
          <FolderOpen className="h-4 w-4" />
          Browse
        </Button>
        <Button
          variant="outline"
          onClick={loadFiles}
          disabled={loading || !rootPath}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="flex gap-2 border-b shrink-0">
        <Button
          variant={activeTab === "track" ? "default" : "ghost"}
          size="sm"
          onClick={() => setActiveTab("track")}
          className="rounded-b-none"
        >
          <FileMusic className="h-4 w-4" />
          Track ({allAudioFiles.length})
        </Button>
        <Button
          variant={activeTab === "lyric" ? "default" : "ghost"}
          size="sm"
          onClick={() => setActiveTab("lyric")}
          className="rounded-b-none"
        >
          <FileText className="h-4 w-4" />
          Lyric ({allLyricFiles.length})
        </Button>
        <Button
          variant={activeTab === "cover" ? "default" : "ghost"}
          size="sm"
          onClick={() => setActiveTab("cover")}
          className="rounded-b-none"
        >
          <Image className="h-4 w-4" />
          Cover ({allCoverFiles.length})
        </Button>
        <Button
          variant={activeTab === "duplicates" ? "default" : "ghost"}
          size="sm"
          onClick={() => setActiveTab("duplicates")}
          className="rounded-b-none"
        >
          <Copy className="h-4 w-4" />
          Duplicates {duplicates.length > 0 && `(${duplicates.length})`}
        </Button>
        <Button
          variant={activeTab === "organize" ? "default" : "ghost"}
          size="sm"
          onClick={() => setActiveTab("organize")}
          className="rounded-b-none"
        >
          <FolderTree className="h-4 w-4" />
          Organize
        </Button>
      </div>

      {activeTab === "track" && (
        <div className="space-y-2 shrink-0">
          <div className="flex items-center gap-2">
            <Label className="text-sm">Rename Format</Label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right">
                <p className="text-xs whitespace-nowrap">
                  Variables: {"{title}"}, {"{artist}"}, {"{album}"},{" "}
                  {"{album_artist}"}, {"{track}"}, {"{disc}"}, {"{year}"}
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="flex items-center gap-2">
            <Select value={formatPreset} onValueChange={setFormatPreset}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(FORMAT_PRESETS).map(([key, { label }]) => (
                  <SelectItem key={key} value={key}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {formatPreset === "custom" && (
              <InputWithContext
                value={customFormat}
                onChange={(e) => setCustomFormat(e.target.value)}
                placeholder="{artist} - {title}"
                className="flex-1"
              />
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowResetConfirm(true)}
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reset to Default</TooltipContent>
            </Tooltip>
          </div>
          <p className="text-xs text-muted-foreground">
            Preview:{" "}
            <span className="font-mono">
              {renameFormat
                .replace(/\{title\}/g, "All The Stars")
                .replace(/\{artist\}/g, "Kendrick Lamar, SZA")
                .replace(/\{album\}/g, "Black Panther")
                .replace(/\{album_artist\}/g, "Kendrick Lamar")
                .replace(/\{track\}/g, "01")
                .replace(/\{disc\}/g, "1")
                .replace(/\{year\}/g, "2018")}
              .flac
            </span>
          </p>
        </div>
      )}

      <div
        className={`border rounded-lg ${isFullscreen ? "flex-1 flex flex-col min-h-0" : ""}`}
      >
        {activeTab === "track" && (
          <div className="space-y-2 p-3 border-b bg-muted/30 shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={allSelected ? deselectAll : selectAll}
                >
                  {allSelected ? "Deselect All" : "Select All"}
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleSelectNotMatchingFormat}
                      disabled={
                        allAudioFiles.length === 0 || loading || previewLoading
                      }
                    >
                      {previewLoading ? (
                        <Spinner className="h-4 w-4" />
                      ) : (
                        <ListFilter className="h-4 w-4" />
                      )}
                      Not matching format
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Select only files whose names don’t match the current
                    format, with preview
                  </TooltipContent>
                </Tooltip>
                <span className="text-sm text-muted-foreground">
                  {selectedFiles.size} of {allAudioFiles.length} file(s)
                  selected
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePreview(true)}
                  disabled={selectedFiles.size === 0 || loading || previewLoading}
                >
                  {previewLoading ? (
                    <Spinner className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                  Preview
                </Button>
                <Button
                  size="sm"
                  onClick={() => handlePreview(false)}
                  disabled={selectedFiles.size === 0 || loading || previewLoading}
                >
                  {previewLoading ? (
                    <Spinner className="h-4 w-4" />
                  ) : (
                    <Pencil className="h-4 w-4" />
                  )}
                  Rename
                </Button>
              </div>
            </div>

            {/* Batch Lyrics Section */}
            <div className="flex items-center gap-2 flex-wrap p-2 bg-muted/50 rounded-lg border">
              <span className="text-xs font-medium text-muted-foreground">
                Lyrics:
              </span>
              <Select
                value={lyricsEmbedMode}
                onValueChange={(v: string) =>
                  setLyricsEmbedMode(v as typeof lyricsEmbedMode)
                }
              >
                <SelectTrigger className="h-7 w-[130px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="embed">Embed in File</SelectItem>
                  <SelectItem value="lrc">Save as .lrc</SelectItem>
                  <SelectItem value="both">Both</SelectItem>
                </SelectContent>
              </Select>
              {batchFetchingLyrics ? (
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={handleStopBatchLyrics}
                >
                  <StopCircle className="h-3.5 w-3.5" />
                  Stop
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={handleBatchFetchLyrics}
                  disabled={allAudioFiles.length === 0}
                >
                  <FileText className="h-3.5 w-3.5" />
                  Fetch Lyrics{" "}
                  {selectedFiles.size > 0
                    ? `(${selectedFiles.size})`
                    : `(All ${allAudioFiles.length})`}
                </Button>
              )}
              {batchFetchingLyrics && (
                <span className="text-xs text-muted-foreground">
                  {batchLyricsProgress.current}/{batchLyricsProgress.total} • ✓
                  {batchLyricsProgress.success} ⏭{batchLyricsProgress.skipped}{" "}
                  ✗{batchLyricsProgress.failed}
                </span>
              )}
            </div>
          </div>
        )}

        <div
          className={`overflow-y-auto p-2 ${isFullscreen ? "flex-1 min-h-0" : "max-h-[400px]"}`}
        >
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner className="h-6 w-6" />
            </div>
          ) : activeTab === "duplicates" ? (
            scanningDuplicates ? (
              <div className="flex items-center justify-center py-8">
                <Spinner className="h-6 w-6 mr-2" />
                Scanning for duplicates...
              </div>
            ) : duplicates.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p>No duplicates found</p>
                <Button
                  size="sm"
                  className="mt-2"
                  onClick={handleFindDuplicates}
                >
                  <RefreshCw className="h-4 w-4 mr-1" />
                  Scan Again
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Duplicates header with actions */}
                <div className="flex items-center justify-between p-2 bg-muted/30 rounded-lg">
                  <div className="flex items-center gap-4">
                    <div className="text-sm text-muted-foreground">
                      {duplicates.length} duplicate group(s) •{" "}
                      {duplicates.reduce((sum, g) => sum + g.files.length, 0)}{" "}
                      total files
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={selectedDuplicateGroups.size === duplicates.length && duplicates.length > 0}
                        onCheckedChange={(v) => {
                          if (v) selectAllDuplicateGroups();
                          else clearSelectedDuplicateGroups();
                        }}
                        aria-label="Select all duplicate groups"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => selectAllDuplicateGroups()}
                      >
                        Select All
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => clearSelectedDuplicateGroups()}
                      >
                        Deselect
                      </Button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-2 mr-2">
                      <label className="text-xs text-muted-foreground mr-2">Exact hash</label>
                      <Checkbox
                        checked={duplicateUseHash}
                        onCheckedChange={(v) => setDuplicateUseHash(!!v)}
                        aria-label="Use exact hash"
                      />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="flex items-center gap-1">
                            <label className="text-xs text-muted-foreground ml-3 mr-1">Ignore duration</label>
                            <Checkbox
                              checked={duplicateIgnoreDuration}
                              onCheckedChange={(v) => setDuplicateIgnoreDuration(!!v)}
                              aria-label="Ignore duration (match by title/artist only)"
                            />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-xs">
                          Match by title/artist only; ignore track length. Use when you have the same song from
                          different sources (e.g. old YouTube MP3 + new FLAC from quality upgrade).
                        </TooltipContent>
                      </Tooltip>
                      {!duplicateIgnoreDuration && (
                        <>
                          <label className="text-xs text-muted-foreground ml-3 mr-1">Duration tolerance (s)</label>
                          <InputWithContext
                            value={(duplicateDurationTolerance / 1000).toString()}
                            onChange={(e) =>
                              setDuplicateDurationTolerance(Math.max(0, Math.round(Number(e.target.value) * 1000) || 0))
                            }
                            placeholder="3"
                            className="w-[64px] text-xs"
                          />
                        </>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="flex items-center gap-1">
                            <label className="text-xs text-muted-foreground ml-3 mr-1">Acoustic fingerprint</label>
                            <Checkbox
                              checked={duplicateUseFingerprint}
                              onCheckedChange={(v) => setDuplicateUseFingerprint(!!v)}
                              aria-label="Use acoustic fingerprint (fpcalc)"
                            />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-xs">
                          Same audio across formats (e.g. YouTube MP3 vs Bandcamp FLAC). Requires fpcalc on PATH
                          (chromaprint-tools). Slower scan.
                        </TooltipContent>
                      </Tooltip>
                    </div>

                    <div className="flex items-center gap-2">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={handleDeleteSelectedFiles}
                            disabled={processingDuplicateAction || selectedDuplicateGroups.size === 0}
                            className="h-8"
                          >
                            <X className="h-4 w-4 mr-1" />
                            Delete Selected
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Delete selected files (permanent)</TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={handleMoveSelectedToQuarantine}
                            disabled={processingDuplicateAction || selectedDuplicateGroups.size === 0}
                            className="h-8"
                          >
                            <FolderOpen className="h-4 w-4 mr-1" />
                            Move to Quarantine
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Move selected files to quarantine (safe)</TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={handleKeepBestAndDeleteRestSelected}
                            disabled={processingDuplicateAction || selectedDuplicateGroups.size === 0}
                            className="h-8"
                          >
                            <Check className="h-4 w-4 mr-1" />
                            Keep Best & Delete Rest
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Keep the best file in each group and delete the others</TooltipContent>
                      </Tooltip>

                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleClearDuplicates}
                      >
                        <X className="h-4 w-4" />
                        Clear
                      </Button>

                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            handleFindDuplicatesWithOptions({
                              useHash: duplicateUseHash,
                              durationToleranceMs: duplicateDurationTolerance,
                              ignoreDuration: duplicateIgnoreDuration,
                              useFingerprint: duplicateUseFingerprint,
                              useFilenameFallback: duplicateUseFilenameFallback,
                            })
                          }
                          disabled={scanningDuplicates}
                        >
                          <RefreshCw className="h-4 w-4" />
                          Rescan All
                        </Button>

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleExportDuplicatesCsv}
                        >
                          <FileText className="h-4 w-4 mr-1" />
                          Export CSV
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>

                {duplicates.map((group, idx) => (
                  <div key={idx} className="p-3 rounded-lg border bg-card">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1">
                        <div className="font-medium">{group.title}</div>
                        <div className="text-sm text-muted-foreground">
                          {group.artist}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex items-center mr-2">
                          <Checkbox
                            checked={selectedDuplicateGroups.has(idx)}
                            onCheckedChange={() => toggleGroupSelection(idx)}
                            aria-label={`Select group ${idx}`}
                          />
                        </div>

                        <div className="text-xs text-muted-foreground text-right">
                          <div>{group.files.length} files</div>
                          <div>
                            {(group.total_size / 1024 / 1024).toFixed(1)} MB
                            total
                          </div>
                        </div>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={() => handleValidateDuplicateGroup(idx)}
                              disabled={validatingDuplicateGroup === idx}
                            >
                              {validatingDuplicateGroup === idx ? (
                                <Spinner className="h-3.5 w-3.5" />
                              ) : (
                                <RefreshCw className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Validate Group</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                    <div className="flex gap-1 mb-2 flex-wrap">
                      {group.formats.map((fmt) => (
                        <Badge key={fmt} variant="outline" className="text-xs">
                          {fmt}
                        </Badge>
                      ))}
                    </div>
                    <div className="space-y-1">
                      {group.files.map((file, fileIdx) => {
                        const fileName = file.split("/").pop() || file;
                        const ext = fileName.split(".").pop()?.toUpperCase();
                        const isBest = file === group.best_quality_file;
                        const details = group.file_details?.[fileIdx];
                        const isDeleting = deletingDuplicateFile === file;
                        return (
                          <div
                            key={file}
                            className={`flex items-center justify-between p-2 rounded gap-2 ${isBest ? "bg-green-500/10 border border-green-500/20" : "bg-muted/30"}`}
                          >
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <FileMusic className="h-3.5 w-3.5 shrink-0" />
                              <div className="flex-1 min-w-0 truncate">
                                <div className="text-xs truncate">
                                  {fileName}
                                </div>
                                {details && (
                                  <div className="text-[10px] text-muted-foreground">
                                    {(details.size / 1024 / 1024).toFixed(1)} MB
                                    {details.duration > 0 &&
                                      ` • ${Math.floor(details.duration / 60000)}:${String(Math.floor((details.duration % 60000) / 1000)).padStart(2, "0")}`}
                                    {details.bitrate && ` • ${Math.round(details.bitrate / 1000)} kbps`}
                                    {details.sample_rate && ` • ${details.sample_rate}Hz`}
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {isBest && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] px-1 bg-green-500/10 text-green-600 border-green-500/20"
                                >
                                  Keep
                                </Badge>
                              )}
                              <Badge variant="outline" className="text-xs">
                                {ext}
                              </Badge>
                              {/* Preview / Open / Delete actions */}
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 w-6 p-0"
                                    onClick={async () => {
                                      try {
                                        await OpenFileLocation(file);
                                      } catch (err) {
                                        toast.error(
                                          "Failed to open file location",
                                          {
                                            description:
                                              err instanceof Error
                                                ? err.message
                                                : "Unknown error",
                                          },
                                        );
                                      }
                                    }}
                                  >
                                    <FolderOpen className="h-3.5 w-3.5" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  Open in File Manager
                                </TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 w-6 p-0"
                                    onClick={() => handleAudioPreview(file)}
                                  >
                                    <Play className="h-3.5 w-3.5" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Preview</TooltipContent>
                              </Tooltip>
                              {!isBest && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-6 w-6 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                                      onClick={() =>
                                        handleDeleteDuplicateFile(file, idx)
                                      }
                                      disabled={isDeleting}
                                    >
                                      {isDeleting ? (
                                        <Spinner className="h-3.5 w-3.5" />
                                      ) : (
                                        <X className="h-3.5 w-3.5" />
                                      )}
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>Delete File</TooltipContent>
                                </Tooltip>
                              )}
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 w-6 p-0"
                                    onClick={() => handleMoveDuplicateFileToQuarantine(file)}
                                    disabled={processingDuplicateAction}
                                  >
                                    <FolderOpen className="h-3.5 w-3.5" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Move to Quarantine</TooltipContent>
                              </Tooltip>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : activeTab === "organize" ? (
            <div className="space-y-4">
              {/* Organization Options Panel */}
              <div className="p-4 border rounded-lg bg-card space-y-4">
                <div className="flex items-center gap-2 mb-2">
                  <FolderTree className="h-5 w-5 text-primary" />
                  <h3 className="font-medium">Smart File Organization</h3>
                </div>

                {/* Folder Structure */}
                <div className="grid grid-cols-[140px_1fr] gap-4 items-start">
                  <Label className="text-sm pt-2">Folder Structure</Label>
                  <div className="space-y-2">
                    <Select
                      value={organizeFolderPreset}
                      onValueChange={setOrganizeFolderPreset}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(FOLDER_STRUCTURE_PRESETS).map(
                          ([key, { label }]) => (
                            <SelectItem key={key} value={key}>
                              {label}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                    {organizeFolderPreset === "custom" && (
                      <InputWithContext
                        value={organizeCustomFolder}
                        onChange={(e) =>
                          setOrganizeCustomFolder(e.target.value)
                        }
                        placeholder="{artist}/{album}"
                        className="text-sm"
                      />
                    )}
                    <p className="text-xs text-muted-foreground">
                      {FOLDER_STRUCTURE_PRESETS[organizeFolderPreset]
                        ?.description ||
                        "Define your own folder structure using placeholders"}
                    </p>
                  </div>
                </div>

                {/* File Rename Format (Optional) */}
                <div className="grid grid-cols-[140px_1fr] gap-4 items-start">
                  <Label className="text-sm pt-2">
                    Rename Files (Optional)
                  </Label>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Select
                        value={organizeFileFormatPreset}
                        onValueChange={setOrganizeFileFormatPreset}
                      >
                        <SelectTrigger className="flex-1">
                          <SelectValue placeholder="Keep original names" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Keep original names</SelectItem>
                          {Object.entries(FORMAT_PRESETS).map(([key, { label }]) => (
                            <SelectItem key={key} value={key}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {organizeFileFormatPreset === "custom" && (
                        <InputWithContext
                          value={organizeFileFormatCustom}
                          onChange={(e) =>
                            setOrganizeFileFormatCustom(e.target.value)
                          }
                          placeholder="{title} - {artist}"
                          className="flex-1 text-sm"
                        />
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Use placeholders: {"{track}"}, {"{title}"}, {"{artist}"},{" "}
                      {"{album}"}, {"{album_artist}"}, {"{disc}"}, {"{year}"}
                    </p>
                  </div>
                </div>

                {/* Options Row */}
                <div className="grid grid-cols-[140px_1fr] gap-4 items-center">
                  <Label className="text-sm">Options</Label>
                  <div className="flex flex-wrap gap-4">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="include-subfolders"
                        checked={organizeIncludeSubfolders}
                        onCheckedChange={(checked) =>
                          setOrganizeIncludeSubfolders(checked === true)
                        }
                      />
                      <Label
                        htmlFor="include-subfolders"
                        className="text-sm cursor-pointer"
                      >
                        Include subfolders
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="move-files"
                        checked={organizeMoveFiles}
                        onCheckedChange={(checked) =>
                          setOrganizeMoveFiles(checked === true)
                        }
                      />
                      <Label
                        htmlFor="move-files"
                        className="text-sm cursor-pointer"
                      >
                        Move files (uncheck to copy)
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="delete-empty-folders"
                        checked={organizeDeleteEmptyFolders}
                        onCheckedChange={(checked) =>
                          setOrganizeDeleteEmptyFolders(checked === true)
                        }
                      />
                      <Label
                        htmlFor="delete-empty-folders"
                        className="text-sm cursor-pointer"
                      >
                        Delete empty folders
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="flac-only"
                        checked={organizeFLACOnly}
                        onCheckedChange={(checked) =>
                          setOrganizeFLACOnly(checked === true)
                        }
                      />
                      <Label
                        htmlFor="flac-only"
                        className="text-sm cursor-pointer"
                      >
                        FLAC files only
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="embed-lyrics"
                        checked={organizeEmbedLyrics}
                        onCheckedChange={(checked) =>
                          setOrganizeEmbedLyrics(checked === true)
                        }
                      />
                      <Label
                        htmlFor="embed-lyrics"
                        className="text-sm cursor-pointer"
                      >
                        Embed lyrics (FLAC only)
                      </Label>
                    </div>
                  </div>
                </div>

                {/* Conflict Resolution */}
                <div className="grid grid-cols-[140px_1fr] gap-4 items-center">
                  <Label className="text-sm">On Conflict</Label>
                  <Select
                    value={organizeConflictResolution}
                    onValueChange={(v) =>
                      setOrganizeConflictResolution(
                        v as typeof organizeConflictResolution,
                      )
                    }
                  >
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="skip">Skip file</SelectItem>
                      <SelectItem value="rename">
                        Rename (add number)
                      </SelectItem>
                      <SelectItem value="overwrite">Overwrite</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Action Buttons */}
                <div className="flex items-center gap-2 pt-2 border-t">
                  <Button
                    onClick={handlePreviewOrganization}
                    disabled={organizePreviewing || !rootPath}
                  >
                    {organizePreviewing ? (
                      <>
                        <Spinner className="h-4 w-4" />
                        Analyzing...
                      </>
                    ) : (
                      <>
                        <Eye className="h-4 w-4" />
                        Preview Changes
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleAnalyzeOrganization}
                    disabled={organizeAnalyzing || !rootPath}
                  >
                    {organizeAnalyzing ? (
                      <>
                        <Spinner className="h-4 w-4" />
                        Analyzing...
                      </>
                    ) : (
                      <>
                        <Info className="h-4 w-4" />
                        Analyze Current
                      </>
                    )}
                  </Button>
                  {organizePreview && (
                    <Button
                      variant="default"
                      onClick={handleExecuteOrganization}
                      disabled={
                        organizeExecuting || organizeSelectedItems.size === 0
                      }
                      className="ml-auto"
                    >
                      {organizeExecuting ? (
                        <>
                          <Spinner className="h-4 w-4" />
                          Organizing...
                        </>
                      ) : (
                        <>
                          <FolderInput className="h-4 w-4" />
                          Organize {organizeSelectedItems.size} Files
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>

              {/* Analysis Results */}
              {organizeAnalysis && (
                <div className="p-4 border rounded-lg bg-muted/30 space-y-2">
                  <h4 className="font-medium text-sm">
                    Current Organization Analysis
                  </h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">
                        Total Files:
                      </span>{" "}
                      <span className="font-medium">
                        {organizeAnalysis.total_files}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Artists:</span>{" "}
                      <span className="font-medium">
                        {organizeAnalysis.unique_artists}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Albums:</span>{" "}
                      <span className="font-medium">
                        {organizeAnalysis.unique_albums}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Issues:</span>{" "}
                      <span className="font-medium text-yellow-600">
                        {organizeAnalysis.orphaned_files.length +
                          organizeAnalysis.missing_metadata.length +
                          organizeAnalysis.inconsistent_path.length}
                      </span>
                    </div>
                  </div>
                  {(organizeAnalysis.orphaned_files.length > 0 ||
                    organizeAnalysis.missing_metadata.length > 0 ||
                    organizeAnalysis.inconsistent_path.length > 0) && (
                      <div className="text-xs text-muted-foreground mt-2">
                        {organizeAnalysis.orphaned_files.length > 0 && (
                          <span className="mr-3">
                            {organizeAnalysis.orphaned_files.length} orphaned
                            files
                          </span>
                        )}
                        {organizeAnalysis.missing_metadata.length > 0 && (
                          <span className="mr-3">
                            {organizeAnalysis.missing_metadata.length} missing
                            metadata
                          </span>
                        )}
                        {organizeAnalysis.inconsistent_path.length > 0 && (
                          <span>
                            {organizeAnalysis.inconsistent_path.length}{" "}
                            inconsistent paths
                          </span>
                        )}
                      </div>
                    )}
                </div>
              )}

              {/* Preview Results */}
              {organizePreview && (
                <div className="space-y-3">
                  {/* Preview Header */}
                  <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg border">
                    <div className="flex items-center gap-4 text-sm">
                      <span>
                        <span className="text-muted-foreground">Total:</span>{" "}
                        <span className="font-medium">
                          {organizePreview.total_files}
                        </span>
                      </span>
                      <span className="text-green-600">
                        <span className="text-muted-foreground">
                          Will Move:
                        </span>{" "}
                        <span className="font-medium">
                          {organizePreview.will_move}
                        </span>
                      </span>
                      <span className="text-yellow-600">
                        <span className="text-muted-foreground">
                          Conflicts:
                        </span>{" "}
                        <span className="font-medium">
                          {organizePreview.conflicts}
                        </span>
                      </span>
                      <span className="text-blue-600">
                        <span className="text-muted-foreground">
                          Unchanged:
                        </span>{" "}
                        <span className="font-medium">
                          {organizePreview.unchanged}
                        </span>
                      </span>
                      <span className="text-red-600">
                        <span className="text-muted-foreground">Errors:</span>{" "}
                        <span className="font-medium">
                          {organizePreview.errors}
                        </span>
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={organizeStatusFilter}
                        onValueChange={(v) =>
                          setOrganizeStatusFilter(
                            v as typeof organizeStatusFilter,
                          )
                        }
                      >
                        <SelectTrigger className="h-8 w-32 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All</SelectItem>
                          <SelectItem value="will_move">Will Move</SelectItem>
                          <SelectItem value="conflict">Conflicts</SelectItem>
                          <SelectItem value="unchanged">Unchanged</SelectItem>
                          <SelectItem value="error">Errors</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleSelectAllOrganizeItems(true)}
                      >
                        Select All
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleSelectAllOrganizeItems(false)}
                      >
                        Deselect All
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setOrganizePreview(null);
                          setOrganizeSelectedItems(new Set());
                        }}
                      >
                        <X className="h-4 w-4" />
                        Clear
                      </Button>
                    </div>
                  </div>

                  {/* Preview Items */}
                  <div className="space-y-1 max-h-96 overflow-y-auto">
                    {getFilteredOrganizeItems().map((item) => {
                      const isSelected = organizeSelectedItems.has(
                        item.source_path,
                      );
                      const canSelect =
                        item.status === "will_move" ||
                        item.status === "conflict";
                      const fileName =
                        item.source_path.split(/[/\\]/).pop() || "";
                      const destFolder = item.folder_path || "";

                      return (
                        <div
                          key={item.source_path}
                          className={`p-3 rounded-lg border transition-colors ${isSelected
                            ? "bg-primary/5 border-primary/30"
                            : "bg-card hover:bg-muted/30"
                            }`}
                        >
                          <div className="flex items-start gap-3">
                            {canSelect && (
                              <Checkbox
                                checked={isSelected}
                                onCheckedChange={() =>
                                  handleToggleOrganizeItem(item.source_path)
                                }
                                className="mt-1"
                              />
                            )}
                            {!canSelect && <div className="w-4" />}
                            <div className="flex-1 min-w-0 space-y-1">
                              <div className="flex items-center gap-2">
                                <FileMusic className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="text-sm font-medium truncate">
                                  {fileName}
                                </span>
                                {getOrganizeStatusBadge(item.status)}
                              </div>
                              {item.status === "will_move" && (
                                <div className="flex items-center gap-2 text-xs text-muted-foreground pl-6">
                                  <span className="truncate max-w-[300px]">
                                    {item.source_path
                                      .split(/[/\\]/)
                                      .slice(-2, -1)
                                      .join("/")}
                                  </span>
                                  <ArrowRight className="h-3 w-3 shrink-0 text-green-500" />
                                  <span className="truncate max-w-[300px] text-green-600">
                                    {destFolder}
                                  </span>
                                </div>
                              )}
                              {item.new_file_name && (
                                <div className="flex items-center gap-2 text-xs text-muted-foreground pl-6">
                                  <span>Rename to:</span>
                                  <span className="text-primary">
                                    {item.new_file_name}
                                  </span>
                                </div>
                              )}
                              {item.error && (
                                <div className="text-xs text-red-500 pl-6">
                                  {item.error}
                                </div>
                              )}
                              {item.conflict_with && (
                                <div className="text-xs text-yellow-600 pl-6">
                                  Conflicts with: {item.conflict_with}
                                </div>
                              )}
                              {item.metadata && (
                                <div className="text-xs text-muted-foreground pl-6">
                                  {item.metadata.artist} - {item.metadata.album}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Folders to Create */}
                  {organizePreview.folders_to_create.length > 0 && (
                    <div className="p-3 bg-muted/30 rounded-lg border">
                      <h4 className="text-sm font-medium mb-2">
                        {organizePreview.folders_to_create.length} folders will
                        be created
                      </h4>
                      <div className="text-xs text-muted-foreground space-y-1 max-h-32 overflow-y-auto">
                        {organizePreview.folders_to_create
                          .slice(0, 10)
                          .map((folder) => (
                            <div
                              key={folder}
                              className="flex items-center gap-1"
                            >
                              <Folder className="h-3 w-3" />
                              <span className="truncate">{folder}</span>
                            </div>
                          ))}
                        {organizePreview.folders_to_create.length > 10 && (
                          <div className="text-muted-foreground">
                            ...and{" "}
                            {organizePreview.folders_to_create.length - 10} more
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Empty State */}
              {!organizePreview && !organizeAnalysis && (
                <div className="text-center py-12 text-muted-foreground">
                  <FolderTree className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p className="text-lg font-medium mb-2">
                    Organize your music library
                  </p>
                  <p className="text-sm max-w-md mx-auto">
                    Automatically organize your audio files into a clean folder
                    structure based on metadata. Select a folder structure
                    template above and click "Preview Changes" to see how files
                    will be organized.
                  </p>
                </div>
              )}
            </div>
          ) : filteredFiles.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {rootPath
                ? `No ${activeTab} files found`
                : "Select a folder to browse"}
            </div>
          ) : activeTab === "track" ? (
            renderTrackTree(filteredFiles)
          ) : activeTab === "lyric" ? (
            renderLyricTree(filteredFiles)
          ) : (
            renderCoverTree(filteredFiles)
          )}
        </div>
      </div>

      <Dialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
        <DialogContent className="max-w-md [&>button]:hidden">
          <DialogHeader>
            <DialogTitle>Reset to Default?</DialogTitle>
            <DialogDescription>
              This will reset the rename format to "Title - Artist". Your custom
              format will be lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowResetConfirm(false)}
            >
              Cancel
            </Button>
            <Button onClick={resetToDefault}>Reset</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col [&>button]:hidden">
          <DialogHeader>
            <DialogTitle>Rename Preview</DialogTitle>
            <DialogDescription>
              Review the changes before renaming. Files with errors will be
              skipped.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-2 py-4">
            {previewData.map((item, index) => (
              <div
                key={index}
                className={`p-3 rounded-lg border ${item.error ? "border-destructive/50 bg-destructive/5" : "border-border"}`}
              >
                <div className="text-sm">
                  <div className="text-muted-foreground break-all">
                    {item.old_name}
                  </div>
                  {item.error ? (
                    <div className="text-destructive text-xs mt-1">
                      {item.error}
                    </div>
                  ) : (
                    <div className="text-primary font-medium break-all mt-1">
                      → {item.new_name}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            {previewOnly ? (
              <Button onClick={() => setShowPreview(false)}>Close</Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setShowPreview(false)}>
                  Cancel
                </Button>
                <Button onClick={handleRename} disabled={renaming}>
                  {renaming ? (
                    <>
                      <Spinner className="h-4 w-4" />
                      Renaming...
                    </>
                  ) : (
                    <>
                      Rename {previewData.filter((p) => !p.error).length}{" "}
                      File(s)
                    </>
                  )}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showMetadata} onOpenChange={setShowMetadata}>
        <DialogContent className="max-w-md [&>button]:hidden">
          <DialogHeader>
            <DialogTitle>File Metadata</DialogTitle>
            <DialogDescription className="break-all">
              {metadataFile.split(/[/\\]/).pop()}
            </DialogDescription>
          </DialogHeader>
          {loadingMetadata ? (
            <div className="flex items-center justify-center py-8">
              <Spinner className="h-6 w-6" />
            </div>
          ) : metadataInfo ? (
            <div className="space-y-3 py-2">
              <div className="grid grid-cols-[100px_1fr] gap-2 text-sm">
                <span className="text-muted-foreground">Title</span>
                <span>{metadataInfo.title || "-"}</span>
              </div>
              <div className="grid grid-cols-[100px_1fr] gap-2 text-sm">
                <span className="text-muted-foreground">Artist</span>
                <span>{metadataInfo.artist || "-"}</span>
              </div>
              <div className="grid grid-cols-[100px_1fr] gap-2 text-sm">
                <span className="text-muted-foreground">Album</span>
                <span>{metadataInfo.album || "-"}</span>
              </div>
              <div className="grid grid-cols-[100px_1fr] gap-2 text-sm">
                <span className="text-muted-foreground">Album Artist</span>
                <span>{metadataInfo.album_artist || "-"}</span>
              </div>
              <div className="grid grid-cols-[100px_1fr] gap-2 text-sm">
                <span className="text-muted-foreground">Track</span>
                <span>{metadataInfo.track_number || "-"}</span>
              </div>
              <div className="grid grid-cols-[100px_1fr] gap-2 text-sm">
                <span className="text-muted-foreground">Disc</span>
                <span>{metadataInfo.disc_number || "-"}</span>
              </div>
              <div className="grid grid-cols-[100px_1fr] gap-2 text-sm">
                <span className="text-muted-foreground">Year</span>
                <span>
                  {metadataInfo.year ? metadataInfo.year.substring(0, 4) : "-"}
                </span>
              </div>
            </div>
          ) : (
            <div className="text-center py-4 text-muted-foreground">
              No metadata available
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setShowMetadata(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showFFprobeDialog} onOpenChange={setShowFFprobeDialog}>
        <DialogContent className="max-w-md [&>button]:hidden">
          <DialogHeader>
            <DialogTitle>FFprobe Required</DialogTitle>
            <DialogDescription>
              Reading M4A metadata requires FFprobe. Would you like to download
              and install it now?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowFFprobeDialog(false)}
              disabled={installingFFprobe}
            >
              Cancel
            </Button>
            <Button onClick={handleInstallFFprobe} disabled={installingFFprobe}>
              {installingFFprobe ? (
                <>
                  <Spinner className="h-4 w-4" />
                  Installing...
                </>
              ) : (
                "Install FFprobe"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showLyricsPreview} onOpenChange={setShowLyricsPreview}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-hidden flex flex-col [&>button]:hidden">
          <DialogHeader>
            <DialogTitle>Lyrics Preview</DialogTitle>
            <DialogDescription className="break-all">
              {lyricsFile.split(/[/\\]/).pop()}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 border-b pb-2">
            <Button
              variant={lyricsTab === "synced" ? "default" : "ghost"}
              size="sm"
              onClick={() => setLyricsTab("synced")}
            >
              Synced
            </Button>
            <Button
              variant={lyricsTab === "plain" ? "default" : "ghost"}
              size="sm"
              onClick={() => setLyricsTab("plain")}
            >
              Plain
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto py-4">
            {lyricsTab === "synced" ? (
              <div className="bg-muted/30 p-4 rounded-lg space-y-0">
                {renderSyncedLyrics(lyricsContent)}
              </div>
            ) : (
              <pre className="text-sm whitespace-pre-wrap font-mono bg-muted/30 p-4 rounded-lg">
                {getPlainLyrics(lyricsContent) || "No lyrics content"}
              </pre>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCopyLyrics}
              className="gap-1.5"
            >
              {copySuccess ? (
                <Check className="h-4 w-4" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              Copy
            </Button>
            <Button onClick={() => setShowLyricsPreview(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showCoverPreview} onOpenChange={setShowCoverPreview}>
        <DialogContent className="max-w-lg [&>button]:hidden">
          <DialogHeader>
            <DialogTitle>Cover Preview</DialogTitle>
            <DialogDescription className="break-all">
              {coverFile.split(/[/\\]/).pop()}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-center p-4">
            {coverData ? (
              <img
                src={coverData}
                alt="Cover"
                className="max-w-full max-h-[350px] rounded-lg object-contain"
              />
            ) : (
              <div className="text-muted-foreground">Loading...</div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setShowCoverPreview(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showManualRename} onOpenChange={setShowManualRename}>
        <DialogContent className="max-w-2xl [&>button]:hidden">
          <DialogHeader>
            <DialogTitle>Rename File</DialogTitle>
            <DialogDescription className="break-all">
              {manualRenameFile.split(/[/\\]/).pop()}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="newName" className="text-sm">
              New Name
            </Label>
            <div className="flex items-center gap-2 mt-2">
              <InputWithContext
                id="newName"
                value={manualRenameName}
                onChange={(e) => setManualRenameName(e.target.value)}
                placeholder="Enter new name"
                className="flex-1"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !manualRenaming)
                    handleConfirmManualRename();
                }}
              />
              <span className="text-sm text-muted-foreground shrink-0">
                {manualRenameFile.match(/\.[^.]+$/)?.[0] || ""}
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowManualRename(false)}
              disabled={manualRenaming}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmManualRename}
              disabled={manualRenaming || !manualRenameName.trim()}
            >
              {manualRenaming ? (
                <>
                  <Spinner className="h-4 w-4" />
                  Renaming...
                </>
              ) : (
                "Rename"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
