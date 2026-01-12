import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { InputWithContext } from "@/components/ui/input-with-context";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { FolderOpen, RefreshCw, FileMusic, ChevronRight, ChevronDown, Pencil, Eye, Folder, Info, RotateCcw, FileText, Image, Copy, Check, TrendingUp, Download, StopCircle, Filter, X, } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { SelectFolder, ListDirectoryFiles, PreviewRenameFiles, RenameFilesByMetadata, ReadFileMetadata, IsFFprobeInstalled, DownloadFFmpeg, ReadTextFile, RenameFileTo, ReadImageAsBase64, ScanSingleFileForQualityUpgrade, ReadAudioFileAsBase64 } from "../../wailsjs/go/main/App";
import { backend, main } from "../../wailsjs/go/models";
import { toastWithSound as toast } from "@/lib/toast-with-sound";
import { getSettings } from "@/lib/settings";
import { useDownload } from "@/hooks/useDownload";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { BrowserOpenURL } from "../../wailsjs/runtime/runtime";

// Temporary until bindings regenerate
const FindDuplicateTracks = (folderPath: string): Promise<string> => (window as unknown as { go: { main: { App: { FindDuplicateTracks: (p: string) => Promise<string> } } } }).go.main.App.FindDuplicateTracks(folderPath);
const OpenFileLocation = (filePath: string): Promise<void> => (window as unknown as { go: { main: { App: { OpenFileLocation: (p: string) => Promise<void> } } } }).go.main.App.OpenFileLocation(filePath);
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
interface QualityUpgradeSuggestion {
  file_path: string;
  file_name: string;
  file_size: number;
  current_format: string;
  metadata?: FileMetadata;
  spotify_id?: string;
  spotify_track?: {
    id: string;
    name: string;
    artists: string;
    album_name: string;
    images: string;
    external_url: string;
    duration_ms: number;
  };
  availability?: {
    spotify_id: string;
    tidal: boolean;
    amazon: boolean;
    qobuz: boolean;
    tidal_url?: string;
    amazon_url?: string;
    qobuz_url?: string;
  };
  error?: string;
  search_query?: string;
  match_confidence?: string;
}

interface DuplicateGroup {
  files: string[];
  title: string;
  artist: string;
  total_size: number;
  formats: string[];
  best_quality_file: string;
  file_details?: Array<{
    path: string;
    size: number;
    format: string;
    duration: number;
  }>;
}

type TabType = "track" | "lyric" | "cover" | "quality-upgrade" | "duplicates";
const FORMAT_PRESETS: Record<string, {
  label: string;
  template: string;
}> = {
  "title": { label: "Title", template: "{title}" },
  "title-artist": { label: "Title - Artist", template: "{title} - {artist}" },
  "artist-title": { label: "Artist - Title", template: "{artist} - {title}" },
  "track-title": { label: "Track. Title", template: "{track}. {title}" },
  "track-title-artist": { label: "Track. Title - Artist", template: "{track}. {title} - {artist}" },
  "track-artist-title": { label: "Track. Artist - Title", template: "{track}. {artist} - {title}" },
  "title-album-artist": { label: "Title - Album Artist", template: "{title} - {album_artist}" },
  "track-title-album-artist": { label: "Track. Title - Album Artist", template: "{track}. {title} - {album_artist}" },
  "artist-album-title": { label: "Artist - Album - Title", template: "{artist} - {album} - {title}" },
  "track-dash-title": { label: "Track - Title", template: "{track} - {title}" },
  "disc-track-title": { label: "Disc-Track. Title", template: "{disc}-{track}. {title}" },
  "disc-track-title-artist": { label: "Disc-Track. Title - Artist", template: "{disc}-{track}. {title} - {artist}" },
  "custom": { label: "Custom...", template: "{title} - {artist}" },
};
const STORAGE_KEY = "spotiflac_file_manager_state";
const DUPLICATES_STORAGE_KEY = "spotiflac_duplicates";
const DEFAULT_PRESET = "title-artist";
const DEFAULT_CUSTOM_FORMAT = "{title} - {artist}";
function formatFileSize(bytes: number): string {
  if (bytes === 0)
    return "0 B";
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
    }
    catch {
      // Ignore localStorage errors
    }
    return DEFAULT_PRESET;
  });
  const [customFormat, setCustomFormat] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.customFormat)
          return parsed.customFormat;
      }
    }
    catch {
      // Ignore localStorage errors
    }
    return DEFAULT_CUSTOM_FORMAT;
  });
  const renameFormat = formatPreset === "custom" ? (customFormat || FORMAT_PRESETS["custom"].template) : FORMAT_PRESETS[formatPreset].template;
  const [showPreview, setShowPreview] = useState(false);
  const [previewData, setPreviewData] = useState<backend.RenamePreview[]>([]);
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
  const [qualityUpgradeSuggestions, setQualityUpgradeSuggestions] = useState<Map<string, QualityUpgradeSuggestion>>(new Map());
  const [scanningFiles, setScanningFiles] = useState<Set<string>>(new Set());
  const [batchScanning, setBatchScanning] = useState(false);
  const [batchScanAbort, setBatchScanAbort] = useState<AbortController | null>(null);
  const [batchScanProgress, setBatchScanProgress] = useState({ current: 0, total: 0 });
  const [downloadingTracks, setDownloadingTracks] = useState<Set<string>>(new Set());
  const [upgradeFilter, setUpgradeFilter] = useState<"all" | "available" | "unavailable" | "errors">("all");
  const [confidenceFilter, setConfidenceFilter] = useState<"all" | "high" | "medium" | "low">("all");
  const [formatFilter, setFormatFilter] = useState<"all" | "lossy-only">("lossy-only");
  const [sortBy, setSortBy] = useState<"name" | "size-asc" | "size-desc">("size-asc");
  const [previewingAudio, setPreviewingAudio] = useState<string | null>(null);
  const [audioDataUrl, setAudioDataUrl] = useState<string>("");
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);
  const [scanningDuplicates, setScanningDuplicates] = useState(false);
  const download = useDownload();
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ formatPreset, customFormat }));
    }
    catch {
      // Ignore localStorage errors
    }
  }, [formatPreset, customFormat]);

  // Load persisted scan results
  useEffect(() => {
    if (!rootPath) return;
    try {
      const key = `spotiflac_quality_scans_${rootPath}`;
      const saved = localStorage.getItem(key);
      if (saved) {
        const data = JSON.parse(saved);
        const map = new Map<string, QualityUpgradeSuggestion>();
        Object.entries(data).forEach(([path, suggestion]) => {
          map.set(path, suggestion as QualityUpgradeSuggestion);
        });
        setQualityUpgradeSuggestions(map);
      }
    } catch {
      // Ignore localStorage errors
    }
  }, [rootPath]);

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

  // Save scan results to localStorage
  useEffect(() => {
    if (!rootPath || qualityUpgradeSuggestions.size === 0) return;
    try {
      const key = `spotiflac_quality_scans_${rootPath}`;
      const obj: Record<string, QualityUpgradeSuggestion> = {};
      qualityUpgradeSuggestions.forEach((value, key) => {
        obj[key] = value;
      });
      localStorage.setItem(key, JSON.stringify(obj));
    } catch {
      // Ignore localStorage errors
    }
  }, [qualityUpgradeSuggestions, rootPath]);
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
        if (type === "track" && (ext.endsWith(".flac") || ext.endsWith(".mp3") || ext.endsWith(".m4a")))
          return node;
        if (type === "lyric" && ext.endsWith(".lrc"))
          return node;
        if (type === "cover" && (ext.endsWith(".jpg") || ext.endsWith(".jpeg") || ext.endsWith(".png")))
          return node;
        return null;
      })
      .filter((node): node is FileNode => node !== null);
  };
  const loadFiles = useCallback(async () => {
    if (!rootPath)
      return;
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
    }
    catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err || "");
      if (!errorMsg.toLowerCase().includes("empty") && !errorMsg.toLowerCase().includes("no file")) {
        toast.error("Failed to load files", { description: errorMsg || "Unknown error" });
      }
      setAllFiles([]);
      setSelectedFiles(new Set());
    }
    finally {
      setLoading(false);
    }
  }, [rootPath]);
  useEffect(() => {
    if (rootPath)
      loadFiles();
  }, [rootPath, loadFiles]);
  const filteredFiles = filterFilesByType(allFiles, activeTab);
  const getAllFilesFlat = (nodes: FileNode[]): FileNode[] => {
    const result: FileNode[] = [];
    for (const node of nodes) {
      if (!node.is_dir)
        result.push(node);
      if (node.children)
        result.push(...getAllFilesFlat(node.children));
    }
    return result;
  };
  const allAudioFiles = getAllFilesFlat(filterFilesByType(allFiles, "track"));
  const allLyricFiles = getAllFilesFlat(filterFilesByType(allFiles, "lyric"));
  const allCoverFiles = getAllFilesFlat(filterFilesByType(allFiles, "cover"));
  const handleSelectFolder = async () => {
    try {
      const path = await SelectFolder(rootPath);
      if (path)
        setRootPath(path);
    }
    catch (err) {
      toast.error("Failed to select folder", { description: err instanceof Error ? err.message : "Unknown error" });
    }
  };
  const toggleExpand = (path: string) => {
    setAllFiles((prev) => toggleNodeExpand(prev, path));
  };
  const toggleNodeExpand = (nodes: FileNode[], path: string): FileNode[] => {
    return nodes.map((node) => {
      if (node.path === path)
        return { ...node, expanded: !node.expanded };
      if (node.children)
        return { ...node, children: toggleNodeExpand(node.children, path) };
      return node;
    });
  };
  const toggleSelect = (path: string) => {
    setSelectedFiles((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(path))
        newSet.delete(path);
      else
        newSet.add(path);
      return newSet;
    });
  };
  const toggleFolderSelect = (node: FileNode) => {
    const folderFiles = getAllFilesFlat([node]);
    const allSelected = folderFiles.every((f) => selectedFiles.has(f.path));
    setSelectedFiles((prev) => {
      const newSet = new Set(prev);
      if (allSelected)
        folderFiles.forEach((f) => newSet.delete(f.path));
      else
        folderFiles.forEach((f) => newSet.add(f.path));
      return newSet;
    });
  };
  const isFolderSelected = (node: FileNode): boolean | "indeterminate" => {
    const folderFiles = getAllFilesFlat([node]);
    if (folderFiles.length === 0)
      return false;
    const selectedCount = folderFiles.filter((f) => selectedFiles.has(f.path)).length;
    if (selectedCount === 0)
      return false;
    if (selectedCount === folderFiles.length)
      return true;
    return "indeterminate";
  };
  const selectAll = () => setSelectedFiles(new Set(allAudioFiles.map((f) => f.path)));
  const deselectAll = () => setSelectedFiles(new Set());
  const handleScanSingleFile = async (filePath: string, silent = false) => {
    if (scanningFiles.has(filePath)) return;
    setScanningFiles((prev) => new Set(prev).add(filePath));
    try {
      const jsonString = await ScanSingleFileForQualityUpgrade({ file_path: filePath } as main.ScanSingleFileRequest);
      const suggestion: QualityUpgradeSuggestion = JSON.parse(jsonString);
      setQualityUpgradeSuggestions((prev) => {
        const newMap = new Map(prev);
        newMap.set(filePath, suggestion);
        return newMap;
      });

      if (!silent) {
        const hasAvailability = suggestion.availability && (suggestion.availability.tidal || suggestion.availability.amazon || suggestion.availability.qobuz);
        if (suggestion.error) {
          toast.error("No upgrade found", { description: suggestion.error });
        } else if (hasAvailability) {
          toast.success("Upgrade available!");
        } else if (suggestion.spotify_id) {
          toast.info("Track found", { description: "No high-quality sources available" });
        }
      }
    }
    catch (err) {
      if (!silent) {
        toast.error("Failed to scan file", { description: err instanceof Error ? err.message : "Unknown error" });
      }
    }
    finally {
      setScanningFiles((prev) => {
        const newSet = new Set(prev);
        newSet.delete(filePath);
        return newSet;
      });
    }
  };

  const handleBatchScan = async () => {
    if (batchScanning) return;
    const filesToScan = allAudioFiles.filter(f => !qualityUpgradeSuggestions.has(f.path));
    if (filesToScan.length === 0) {
      toast.info("All files already scanned");
      return;
    }

    const abort = new AbortController();
    setBatchScanAbort(abort);
    setBatchScanning(true);
    setBatchScanProgress({ current: 0, total: filesToScan.length });

    let scanned = 0;
    for (const file of filesToScan) {
      if (abort.signal.aborted) break;

      setScanningFiles((prev) => new Set(prev).add(file.path));
      try {
        const jsonString = await ScanSingleFileForQualityUpgrade({ file_path: file.path } as main.ScanSingleFileRequest);
        const suggestion: QualityUpgradeSuggestion = JSON.parse(jsonString);
        setQualityUpgradeSuggestions((prev) => {
          const newMap = new Map(prev);
          newMap.set(file.path, suggestion);
          return newMap;
        });
      } catch (err) {
        console.error(`Failed to scan ${file.path}:`, err);
      } finally {
        setScanningFiles((prev) => {
          const newSet = new Set(prev);
          newSet.delete(file.path);
          return newSet;
        });
        scanned++;
        setBatchScanProgress({ current: scanned, total: filesToScan.length });
      }

      if (scanned < filesToScan.length && !abort.signal.aborted) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    setBatchScanning(false);
    setBatchScanAbort(null);
    if (!abort.signal.aborted) {
      toast.success(`Scanned ${scanned} files`);
    } else {
      toast.info(`Scan stopped at ${scanned}/${filesToScan.length}`);
    }
  };

  const handleStopBatchScan = () => {
    if (batchScanAbort) {
      batchScanAbort.abort();
      setBatchScanAbort(null);
    }
  };

  const clearAllScans = () => {
    setQualityUpgradeSuggestions(new Map());
    if (rootPath) {
      try {
        localStorage.removeItem(`spotiflac_quality_scans_${rootPath}`);
      } catch {
        // Ignore localStorage errors
      }
    }
    toast.success("Cleared all scan results");
  };

  const handleAudioPreview = async (filePath: string) => {
    if (previewingAudio === filePath) {
      // Stop preview
      setPreviewingAudio(null);
      setAudioDataUrl("");
      return;
    }

    setLoadingAudio(true);
    try {
      const dataUrl = await ReadAudioFileAsBase64(filePath);
      setAudioDataUrl(dataUrl);
      setPreviewingAudio(filePath);
    } catch (err) {
      toast.error("Failed to load audio", {
        description: err instanceof Error ? err.message : "Unknown error"
      });
    } finally {
      setLoadingAudio(false);
    }
  };

  const handleFindDuplicates = async () => {
    if (!rootPath) {
      toast.error("Please select a folder first");
      return;
    }

    setScanningDuplicates(true);
    try {
      const jsonString = await FindDuplicateTracks(rootPath);
      const dupes: DuplicateGroup[] = JSON.parse(jsonString);
      setDuplicates(dupes);
      toast.success(`Found ${dupes.length} duplicate groups`, {
        description: `${dupes.reduce((sum, g) => sum + g.files.length, 0)} total files`
      });
    } catch (err) {
      toast.error("Failed to find duplicates", {
        description: err instanceof Error ? err.message : "Unknown error"
      });
    } finally {
      setScanningDuplicates(false);
    }
  };

  const resetToDefault = () => { setFormatPreset(DEFAULT_PRESET); setCustomFormat(DEFAULT_CUSTOM_FORMAT); setShowResetConfirm(false); };
  const handlePreview = async (isPreviewOnly: boolean) => {
    if (selectedFiles.size === 0) {
      toast.error("No files selected");
      return;
    }
    const hasM4A = Array.from(selectedFiles).some(f => f.toLowerCase().endsWith(".m4a"));
    if (hasM4A) {
      const installed = await IsFFprobeInstalled();
      if (!installed) {
        setShowFFprobeDialog(true);
        return;
      }
    }
    try {
      const result = await PreviewRenameFiles(Array.from(selectedFiles), renameFormat);
      setPreviewData(result);
      setPreviewOnly(isPreviewOnly);
      setShowPreview(true);
    }
    catch (err) {
      toast.error("Failed to generate preview", { description: err instanceof Error ? err.message : "Unknown error" });
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
    }
    catch (err) {
      toast.error("Failed to read metadata", { description: err instanceof Error ? err.message : "Unknown error" });
      setMetadataInfo(null);
    }
    finally {
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
      }
      else
        toast.error("Failed to install FFprobe", { description: result.error || result.message });
    }
    catch (err) {
      toast.error("Failed to install FFprobe", { description: err instanceof Error ? err.message : "Unknown error" });
    }
    finally {
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
    }
    catch (err) {
      toast.error("Failed to read lyrics file", { description: err instanceof Error ? err.message : "Unknown error" });
    }
  };
  const handleShowCover = async (filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCoverFile(filePath);
    try {
      const data = await ReadImageAsBase64(filePath);
      setCoverData(data);
      setShowCoverPreview(true);
    }
    catch (err) {
      toast.error("Failed to load image", { description: err instanceof Error ? err.message : "Unknown error" });
    }
  };
  const getPlainLyrics = (content: string) => {
    return content.split('\n').map(line => line.replace(/^\[[\d:.]+\]\s*/, '')).filter(line => !line.startsWith('[') || line.includes(']')).map(line => line.startsWith('[') ? '' : line).join('\n').trim();
  };
  const formatTimestamp = (timestamp: string): string => {
    const match = timestamp.match(/\[(\d+):(\d+)(?:\.(\d+))?\]/);
    if (!match)
      return timestamp;
    const minutes = parseInt(match[1], 10);
    const seconds = match[2];
    return `${minutes}:${seconds}`;
  };
  const renderSyncedLyrics = (content: string) => {
    if (!content)
      return <div className="text-sm text-muted-foreground">No lyrics content</div>;
    const lines = content.split('\n');
    return lines.map((line, index) => {
      if (line.match(/^\[(ti|ar|al|by|length|offset):/i))
        return null;
      const match = line.match(/^(\[[\d:.]+\])(.*)$/);
      if (match) {
        const timestamp = match[1];
        const text = match[2].trim();
        if (!text)
          return null;
        return (<div key={index} className="flex items-center gap-2 py-1">
          <Badge variant="secondary" className="font-mono text-xs shrink-0">
            {formatTimestamp(timestamp)}
          </Badge>
          <span className="text-sm">{text}</span>
        </div>);
      }
      if (!line.trim())
        return null;
      return (<div key={index} className="py-1">
        <span className="text-sm">{line}</span>
      </div>);
    }).filter(item => item !== null);
  };
  const handleCopyLyrics = async () => {
    try {
      const textToCopy = lyricsTab === "synced" ? lyricsContent : getPlainLyrics(lyricsContent);
      await navigator.clipboard.writeText(textToCopy);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 500);
    }
    catch {
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
    if (!manualRenameFile || !manualRenameName.trim())
      return;
    setManualRenaming(true);
    try {
      await RenameFileTo(manualRenameFile, manualRenameName.trim());
      toast.success("File renamed successfully");
      setShowManualRename(false);
      loadFiles();
    }
    catch (err) {
      toast.error("Failed to rename file", { description: err instanceof Error ? err.message : "Unknown error" });
    }
    finally {
      setManualRenaming(false);
    }
  };
  const handleRename = async () => {
    if (selectedFiles.size === 0)
      return;
    setRenaming(true);
    try {
      const result = await RenameFilesByMetadata(Array.from(selectedFiles), renameFormat);
      const successCount = result.filter((r: backend.RenameResult) => r.success).length;
      const failCount = result.filter((r: backend.RenameResult) => !r.success).length;
      if (successCount > 0)
        toast.success("Rename Complete", { description: `${successCount} file(s) renamed${failCount > 0 ? `, ${failCount} failed` : ""}` });
      else
        toast.error("Rename Failed", { description: `All ${failCount} file(s) failed to rename` });
      setShowPreview(false);
      setSelectedFiles(new Set());
      loadFiles();
    }
    catch (err) {
      toast.error("Rename Failed", { description: err instanceof Error ? err.message : "Unknown error" });
    }
    finally {
      setRenaming(false);
    }
  };
  const renderTrackTree = (nodes: FileNode[], depth = 0) => {
    return nodes.map((node) => (<div key={node.path}>
      <div className={`flex items-center gap-2 py-1.5 px-2 rounded hover:bg-muted/50 cursor-pointer ${selectedFiles.has(node.path) ? "bg-primary/10" : ""}`} style={{ paddingLeft: `${depth * 16 + 8}px` }} onClick={() => (node.is_dir ? toggleExpand(node.path) : toggleSelect(node.path))}>
        {node.is_dir ? (<>
          <Checkbox checked={isFolderSelected(node) === true} ref={(el) => {
            if (el)
              (el as HTMLButtonElement).dataset.state = isFolderSelected(node) === "indeterminate" ? "indeterminate" : isFolderSelected(node) ? "checked" : "unchecked";
          }} onCheckedChange={() => toggleFolderSelect(node)} onClick={(e) => e.stopPropagation()} className="shrink-0 data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground" />
          {node.expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
          <Folder className="h-4 w-4 text-yellow-500 shrink-0" />
        </>) : (<>
          <Checkbox checked={selectedFiles.has(node.path)} onCheckedChange={() => toggleSelect(node.path)} onClick={(e) => e.stopPropagation()} className="shrink-0" />
          <FileMusic className="h-4 w-4 text-primary shrink-0" />
        </>)}
        <span className="truncate text-sm flex-1">
          {node.name}
          {node.is_dir && <span className="text-muted-foreground ml-1">({getAllFilesFlat([node]).length})</span>}
        </span>
        {!node.is_dir && (<>
          <span className="text-xs text-muted-foreground shrink-0">{formatFileSize(node.size)}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="p-1 rounded hover:bg-muted shrink-0" onClick={(e) => handleShowMetadata(node.path, e)}>
                <Info className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </TooltipTrigger>
            <TooltipContent>View Metadata</TooltipContent>
          </Tooltip>
        </>)}
      </div>
      {node.is_dir && node.expanded && node.children && <div>{renderTrackTree(node.children, depth + 1)}</div>}
    </div>));
  };
  const renderLyricTree = (nodes: FileNode[], depth = 0) => {
    return nodes.map((node) => (<div key={node.path}>
      <div className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-muted/50 cursor-pointer" style={{ paddingLeft: `${depth * 16 + 8}px` }} onClick={(e) => node.is_dir ? toggleExpand(node.path) : handleShowLyrics(node.path, e)}>
        {node.is_dir ? (<>
          {node.expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
          <Folder className="h-4 w-4 text-yellow-500 shrink-0" />
        </>) : (<FileText className="h-4 w-4 text-blue-500 shrink-0" />)}
        <span className="truncate text-sm flex-1">
          {node.name}
          {node.is_dir && <span className="text-muted-foreground ml-1">({getAllFilesFlat([node]).length})</span>}
        </span>
        {!node.is_dir && (<>
          <span className="text-xs text-muted-foreground shrink-0">{formatFileSize(node.size)}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="p-1 rounded hover:bg-muted shrink-0" onClick={(e) => handleManualRename(node.path, e)}>
                <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Rename</TooltipContent>
          </Tooltip>
        </>)}
      </div>
      {node.is_dir && node.expanded && node.children && <div>{renderLyricTree(node.children, depth + 1)}</div>}
    </div>));
  };
  const renderQualityUpgradeFiles = (files: FileNode[]) => {
    return (<div className="space-y-2">
      {files.map((file) => {
        const suggestion = qualityUpgradeSuggestions.get(file.path);
        const isScanning = scanningFiles.has(file.path);
        const isDownloading = downloadingTracks.has(file.path);
        const hasAvailability = suggestion?.availability && (suggestion.availability.tidal || suggestion.availability.amazon || suggestion.availability.qobuz);
        const confidenceColor = suggestion?.match_confidence === "high" ? "bg-green-500/10 text-green-600 border-green-500/20" : suggestion?.match_confidence === "medium" ? "bg-yellow-500/10 text-yellow-600 border-yellow-500/20" : suggestion?.match_confidence === "low" ? "bg-orange-500/10 text-orange-600 border-orange-500/20" : "";
        return (<div key={file.path} className={`p-3 rounded-lg border ${suggestion?.error ? "border-destructive/50 bg-destructive/5" : suggestion ? "border-border" : "border-border/50"}`}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2">
                <FileMusic className="h-4 w-4 text-primary shrink-0" />
                <span className="font-medium text-sm truncate">{file.name}</span>
                <Badge variant="outline" className="text-xs shrink-0">{file.name.split('.').pop()?.toUpperCase() || "UNKNOWN"}</Badge>
                <Badge variant="outline" className="text-xs shrink-0">{(file.size / 1024 / 1024).toFixed(1)} MB</Badge>
                {suggestion?.match_confidence && (<Badge className={`text-xs shrink-0 ${confidenceColor}`}>{suggestion.match_confidence} match</Badge>)}
              </div>
              {suggestion?.metadata && (<div className="text-sm text-muted-foreground mb-2">
                <div><span className="font-medium">Title:</span> {suggestion.metadata.title || "-"}</div>
                <div><span className="font-medium">Artist:</span> {suggestion.metadata.artist || "-"}</div>
                {suggestion.metadata.album && <div><span className="font-medium">Album:</span> {suggestion.metadata.album}</div>}
              </div>)}
              {suggestion?.spotify_track && (<div className="text-sm mb-2">
                <div className="text-muted-foreground">Spotify Match:</div>
                <div className="font-medium">{suggestion.spotify_track.name}</div>
                <div className="text-muted-foreground">{suggestion.spotify_track.artists}</div>
              </div>)}
              {suggestion?.availability && hasAvailability && (<div className="space-y-1 mt-2">
                <div className="text-xs text-muted-foreground">High-quality available:</div>
                <div className="flex flex-wrap gap-1">
                  {suggestion.availability.tidal && <Badge variant="secondary" className="text-xs">Tidal FLAC</Badge>}
                  {suggestion.availability.amazon && <Badge variant="secondary" className="text-xs">Amazon HD</Badge>}
                  {suggestion.availability.qobuz && <Badge variant="secondary" className="text-xs">Qobuz Hi-Res</Badge>}
                </div>
                <div className="text-xs text-muted-foreground italic">Current: {file.name.split('.').pop()?.toUpperCase()} ({(file.size / 1024 / 1024).toFixed(1)} MB) → Upgrade to lossless FLAC</div>
              </div>)}
              {suggestion?.error && !isScanning && (<div className="text-sm text-destructive mt-2">{suggestion.error}</div>)}
            </div>
            <div className="flex flex-col gap-2 shrink-0">
              {suggestion?.spotify_id && (
                <Button size="sm" variant="ghost" onClick={async () => {
                  try {
                    // Try spotify: protocol first (opens desktop app)
                    const spotifyProtocolUrl = `spotify:track:${suggestion.spotify_id}`;
                    console.log("[FileManagerPage] Opening Spotify with protocol URL:", spotifyProtocolUrl);
                    BrowserOpenURL(spotifyProtocolUrl);
                  } catch (err) {
                    console.error("[FileManagerPage] Failed to open Spotify protocol URL, trying web URL:", err);
                    // Fallback to web URL
                    const webUrl = suggestion.spotify_track?.external_url || `https://open.spotify.com/track/${suggestion.spotify_id}`;
                    try {
                      BrowserOpenURL(webUrl);
                    } catch (fallbackErr) {
                      console.error("[FileManagerPage] Failed to open web URL:", fallbackErr);
                      toast.error("Failed to open Spotify", {
                        description: "Please make sure Spotify is installed or try opening manually"
                      });
                    }
                  }
                }} title="Listen on Spotify">
                  <svg className="h-4 w-4 mr-1" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
                  </svg>
                  Spotify
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={async () => {
                console.log("[FileManagerPage] Opening file location for:", file.path);
                try {
                  await OpenFileLocation(file.path);
                  console.log("[FileManagerPage] Successfully called OpenFileLocation");
                } catch (err) {
                  console.error("[FileManagerPage] Error opening file location:", err);
                  toast.error("Failed to open file location", {
                    description: err instanceof Error ? err.message : "Unknown error"
                  });
                }
              }} title="Open in file manager">
                <FolderOpen className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => handleAudioPreview(file.path)} disabled={loadingAudio} title="Preview local file">
                {loadingAudio && previewingAudio === file.path ? (
                  <><Spinner className="h-4 w-4 mr-1" />Loading...</>
                ) : previewingAudio === file.path ? (
                  <><StopCircle className="h-4 w-4 mr-1" />Stop</>
                ) : (
                  <><svg className="h-4 w-4 mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>Play</>
                )}
              </Button>
              {!suggestion && (<Button size="sm" variant="outline" onClick={() => handleScanSingleFile(file.path, false)} disabled={isScanning}>
                {isScanning ? <><Spinner className="h-4 w-4" />Searching...</> : <><TrendingUp className="h-4 w-4" />Find Upgrade</>}
              </Button>)}
              {suggestion?.spotify_id && hasAvailability && (<Button size="sm" variant="outline" onClick={async () => {
                if (suggestion.spotify_id && suggestion.spotify_track) {
                  setDownloadingTracks(prev => new Set(prev).add(file.path));
                  try {
                    const trackName = suggestion.spotify_track.name || suggestion.metadata?.title || "";
                    const artistName = suggestion.spotify_track.artists || suggestion.metadata?.artist || "";
                    const albumName = suggestion.spotify_track.album_name || suggestion.metadata?.album || "";
                    const durationMs = suggestion.spotify_track.duration_ms || 0;
                    const coverUrl = suggestion.spotify_track.images || "";

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
                      coverUrl
                    );
                  } finally {
                    setDownloadingTracks(prev => {
                      const newSet = new Set(prev);
                      newSet.delete(file.path);
                      return newSet;
                    });
                  }
                }
              }} disabled={isDownloading}>
                {isDownloading ? <><Spinner className="h-4 w-4" />Downloading...</> : <><Download className="h-4 w-4" />Download</>}
              </Button>)}
              {suggestion && !hasAvailability && !suggestion.error && (<Button size="sm" variant="ghost" onClick={() => handleScanSingleFile(file.path, false)} disabled={isScanning}>
                {isScanning ? <><Spinner className="h-4 w-4" />Searching...</> : <><RefreshCw className="h-4 w-4" />Refresh</>}
              </Button>)}
            </div>
          </div>
          {previewingAudio === file.path && audioDataUrl && (
            <div className="mt-2 p-2 bg-muted/30 rounded border">
              <audio controls autoPlay className="w-full h-8" src={audioDataUrl}>
                Your browser does not support audio playback.
              </audio>
            </div>
          )}
        </div>);
      })}
    </div>);
  };
  const renderCoverTree = (nodes: FileNode[], depth = 0) => {
    return nodes.map((node) => (<div key={node.path}>
      <div className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-muted/50 cursor-pointer" style={{ paddingLeft: `${depth * 16 + 8}px` }} onClick={(e) => node.is_dir ? toggleExpand(node.path) : handleShowCover(node.path, e)}>
        {node.is_dir ? (<>
          {node.expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
          <Folder className="h-4 w-4 text-yellow-500 shrink-0" />
        </>) : (<Image className="h-4 w-4 text-green-500 shrink-0" />)}
        <span className="truncate text-sm flex-1">
          {node.name}
          {node.is_dir && <span className="text-muted-foreground ml-1">({getAllFilesFlat([node]).length})</span>}
        </span>
        {!node.is_dir && (<>
          <span className="text-xs text-muted-foreground shrink-0">{formatFileSize(node.size)}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="p-1 rounded hover:bg-muted shrink-0" onClick={(e) => handleManualRename(node.path, e)}>
                <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Rename</TooltipContent>
          </Tooltip>
        </>)}
      </div>
      {node.is_dir && node.expanded && node.children && <div>{renderCoverTree(node.children, depth + 1)}</div>}
    </div>));
  };
  const allSelected = allAudioFiles.length > 0 && selectedFiles.size === allAudioFiles.length;
  return (<div className={`space-y-6 ${isFullscreen ? "h-full flex flex-col" : ""}`}>
    <div className="flex items-center justify-between shrink-0">
      <h1 className="text-2xl font-bold">File Manager</h1>
    </div>


    <div className="flex items-center gap-2 shrink-0">
      <InputWithContext value={rootPath} onChange={(e) => setRootPath(e.target.value)} placeholder="Select a folder..." className="flex-1" />
      <Button onClick={handleSelectFolder}>
        <FolderOpen className="h-4 w-4" />
        Browse
      </Button>
      <Button variant="outline" onClick={loadFiles} disabled={loading || !rootPath}>
        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        Refresh
      </Button>
    </div>


    <div className="flex gap-2 border-b shrink-0">
      <Button variant={activeTab === "track" ? "default" : "ghost"} size="sm" onClick={() => setActiveTab("track")} className="rounded-b-none">
        <FileMusic className="h-4 w-4" />
        Track ({allAudioFiles.length})
      </Button>
      <Button variant={activeTab === "lyric" ? "default" : "ghost"} size="sm" onClick={() => setActiveTab("lyric")} className="rounded-b-none">
        <FileText className="h-4 w-4" />
        Lyric ({allLyricFiles.length})
      </Button>
      <Button variant={activeTab === "cover" ? "default" : "ghost"} size="sm" onClick={() => setActiveTab("cover")} className="rounded-b-none">
        <Image className="h-4 w-4" />
        Cover ({allCoverFiles.length})
      </Button>
      <Button variant={activeTab === "quality-upgrade" ? "default" : "ghost"} size="sm" onClick={() => setActiveTab("quality-upgrade")} className="rounded-b-none">
        <TrendingUp className="h-4 w-4" />
        Quality Upgrade
      </Button>
      <Button variant={activeTab === "duplicates" ? "default" : "ghost"} size="sm" onClick={() => setActiveTab("duplicates")} className="rounded-b-none">
        <Copy className="h-4 w-4" />
        Duplicates {duplicates.length > 0 && `(${duplicates.length})`}
      </Button>
    </div>


    {activeTab === "track" && (<div className="space-y-2 shrink-0">
      <div className="flex items-center gap-2">
        <Label className="text-sm">Rename Format</Label>
        <Tooltip>
          <TooltipTrigger asChild>
            <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
          </TooltipTrigger>
          <TooltipContent side="right">
            <p className="text-xs whitespace-nowrap">Variables: {"{title}"}, {"{artist}"}, {"{album}"}, {"{album_artist}"}, {"{track}"}, {"{disc}"}, {"{year}"}</p>
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex items-center gap-2">
        <Select value={formatPreset} onValueChange={setFormatPreset}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(FORMAT_PRESETS).map(([key, { label }]) => (<SelectItem key={key} value={key}>{label}</SelectItem>))}
          </SelectContent>
        </Select>
        {formatPreset === "custom" && (<InputWithContext value={customFormat} onChange={(e) => setCustomFormat(e.target.value)} placeholder="{artist} - {title}" className="flex-1" />)}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={() => setShowResetConfirm(true)}>
              <RotateCcw className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reset to Default</TooltipContent>
        </Tooltip>
      </div>
      <p className="text-xs text-muted-foreground">
        Preview: <span className="font-mono">{renameFormat.replace(/\{title\}/g, "All The Stars").replace(/\{artist\}/g, "Kendrick Lamar, SZA").replace(/\{album\}/g, "Black Panther").replace(/\{album_artist\}/g, "Kendrick Lamar").replace(/\{track\}/g, "01").replace(/\{disc\}/g, "1").replace(/\{year\}/g, "2018")}.flac</span>
      </p>
    </div>)}


    <div className={`border rounded-lg ${isFullscreen ? "flex-1 flex flex-col min-h-0" : ""}`}>
      {activeTab === "track" && (<div className="flex items-center justify-between p-3 border-b bg-muted/30 shrink-0">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={allSelected ? deselectAll : selectAll}>
            {allSelected ? "Deselect All" : "Select All"}
          </Button>
          <span className="text-sm text-muted-foreground">{selectedFiles.size} of {allAudioFiles.length} file(s) selected</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => handlePreview(true)} disabled={selectedFiles.size === 0 || loading}>
            <Eye className="h-4 w-4" />
            Preview
          </Button>
          <Button size="sm" onClick={() => handlePreview(false)} disabled={selectedFiles.size === 0 || loading}>
            <Pencil className="h-4 w-4" />
            Rename
          </Button>
        </div>
      </div>)}
      {activeTab === "quality-upgrade" && (<div className="space-y-2 p-3 border-b bg-muted/30 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">{allAudioFiles.length} audio file(s)</span>
            {qualityUpgradeSuggestions.size > 0 && (<span className="text-sm text-muted-foreground">• {qualityUpgradeSuggestions.size} scanned</span>)}
            {batchScanning && (<span className="text-sm text-muted-foreground">• {batchScanProgress.current}/{batchScanProgress.total}</span>)}
          </div>
          <div className="flex items-center gap-2">
            {qualityUpgradeSuggestions.size > 0 && (
              <Button variant="ghost" size="sm" onClick={clearAllScans}>
                <X className="h-4 w-4" />Clear
              </Button>
            )}
            {batchScanning ? (
              <Button variant="destructive" size="sm" onClick={handleStopBatchScan}>
                <StopCircle className="h-4 w-4" />Stop Scan
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={handleBatchScan} disabled={allAudioFiles.length === 0}>
                <TrendingUp className="h-4 w-4" />Scan All
              </Button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <Select value={formatFilter} onValueChange={(v: string) => setFormatFilter(v as typeof formatFilter)}>
            <SelectTrigger className="h-8 w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Formats</SelectItem>
              <SelectItem value="lossy-only">Lossy Only</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sortBy} onValueChange={(v: string) => setSortBy(v as typeof sortBy)}>
            <SelectTrigger className="h-8 w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">Sort: Name</SelectItem>
              <SelectItem value="size-asc">Sort: Worst First</SelectItem>
              <SelectItem value="size-desc">Sort: Best First</SelectItem>
            </SelectContent>
          </Select>
          <Select value={upgradeFilter} onValueChange={(v: string) => setUpgradeFilter(v as typeof upgradeFilter)}>
            <SelectTrigger className="h-8 w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Files</SelectItem>
              <SelectItem value="available">Upgrades Available</SelectItem>
              <SelectItem value="unavailable">No Upgrades</SelectItem>
              <SelectItem value="errors">Errors Only</SelectItem>
            </SelectContent>
          </Select>
          <Select value={confidenceFilter} onValueChange={(v: string) => setConfidenceFilter(v as typeof confidenceFilter)}>
            <SelectTrigger className="h-8 w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Matches</SelectItem>
              <SelectItem value="high">High Confidence</SelectItem>
              <SelectItem value="medium">Medium Confidence</SelectItem>
              <SelectItem value="low">Low Confidence</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>)}

      <div className={`overflow-y-auto p-2 ${isFullscreen ? "flex-1 min-h-0" : "max-h-[400px]"}`}>
        {loading ? (
          <div className="flex items-center justify-center py-8"><Spinner className="h-6 w-6" /></div>
        ) : activeTab === "quality-upgrade" ? (
          allAudioFiles.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {rootPath ? "No audio files found in this folder" : "Select a folder to browse"}
            </div>
          ) : (() => {
            let filteredUpgradeFiles = allAudioFiles;

            // Format filter - skip high-quality formats by default
            if (formatFilter === "lossy-only") {
              filteredUpgradeFiles = filteredUpgradeFiles.filter(f => {
                const ext = f.name.split('.').pop()?.toLowerCase();
                return ext !== 'flac' && ext !== 'wav' && ext !== 'aiff' && ext !== 'alac';
              });
            }

            // Apply upgrade/confidence filters
            filteredUpgradeFiles = filteredUpgradeFiles.filter(file => {
              const suggestion = qualityUpgradeSuggestions.get(file.path);

              // Upgrade filter
              if (upgradeFilter === "available") {
                const hasAvailability = suggestion?.availability &&
                  (suggestion.availability.tidal || suggestion.availability.amazon || suggestion.availability.qobuz);
                if (!hasAvailability) return false;
              }
              if (upgradeFilter === "unavailable") {
                const hasAvailability = suggestion?.availability &&
                  (suggestion.availability.tidal || suggestion.availability.amazon || suggestion.availability.qobuz);
                if (!suggestion || hasAvailability || suggestion.error) return false;
              }
              if (upgradeFilter === "errors") {
                if (!suggestion?.error) return false;
              }

              // Confidence filter
              if (confidenceFilter !== "all" && suggestion?.match_confidence) {
                if (suggestion.match_confidence !== confidenceFilter) return false;
              }

              return true;
            });

            // Sort files by quality
            if (sortBy === "size-asc") {
              filteredUpgradeFiles.sort((a, b) => a.size - b.size); // Smallest = worst quality
            } else if (sortBy === "size-desc") {
              filteredUpgradeFiles.sort((a, b) => b.size - a.size); // Largest = best quality
            } else {
              filteredUpgradeFiles.sort((a, b) => a.name.localeCompare(b.name));
            }

            return filteredUpgradeFiles.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No files match the current filters
              </div>
            ) : renderQualityUpgradeFiles(filteredUpgradeFiles);
          })()
        ) : activeTab === "duplicates" ? (
          scanningDuplicates ? (
            <div className="flex items-center justify-center py-8">
              <Spinner className="h-6 w-6 mr-2" />
              Scanning for duplicates...
            </div>
          ) : duplicates.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p>No duplicates found</p>
              <Button size="sm" className="mt-2" onClick={handleFindDuplicates}>
                <RefreshCw className="h-4 w-4 mr-1" />
                Scan Again
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {duplicates.map((group, idx) => (
                <div key={idx} className="p-3 rounded-lg border bg-card">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1">
                      <div className="font-medium">{group.title}</div>
                      <div className="text-sm text-muted-foreground">{group.artist}</div>
                    </div>
                    <div className="text-xs text-muted-foreground text-right">
                      <div>{group.files.length} files</div>
                      <div>{(group.total_size / 1024 / 1024).toFixed(1)} MB total</div>
                    </div>
                  </div>
                  <div className="flex gap-1 mb-2 flex-wrap">
                    {group.formats.map(fmt => (
                      <Badge key={fmt} variant="outline" className="text-xs">{fmt}</Badge>
                    ))}
                  </div>
                  <div className="space-y-1">
                    {group.files.map((file, fileIdx) => {
                      const fileName = file.split('/').pop() || file;
                      const ext = fileName.split('.').pop()?.toUpperCase();
                      const isBest = file === group.best_quality_file;
                      const details = group.file_details?.[fileIdx];
                      return (
                        <div key={file} className={`flex items-center justify-between p-2 rounded gap-2 ${isBest ? 'bg-green-500/10 border border-green-500/20' : 'bg-muted/30'}`}>
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            <FileMusic className="h-3.5 w-3.5 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="text-xs truncate">{fileName}</div>
                              {details && (
                                <div className="text-[10px] text-muted-foreground">
                                  {(details.size / 1024 / 1024).toFixed(1)} MB
                                  {details.duration > 0 && ` • ${Math.floor(details.duration / 60000)}:${String(Math.floor((details.duration % 60000) / 1000)).padStart(2, '0')}`}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {isBest && <Badge variant="outline" className="text-[10px] px-1">Best</Badge>}
                            <Badge variant="outline" className="text-xs">{ext}</Badge>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 w-6 p-0"
                              onClick={async () => {
                                console.log("[FileManagerPage] Opening file location for:", file);
                                console.log("[FileManagerPage] File path:", file);
                                console.log("[FileManagerPage] File name:", file.split('/').pop());
                                try {
                                  await OpenFileLocation(file);
                                  console.log("[FileManagerPage] Successfully called OpenFileLocation");
                                } catch (err) {
                                  console.error("[FileManagerPage] Error opening file location:", err);
                                  toast.error("Failed to open file location", {
                                    description: err instanceof Error ? err.message : "Unknown error"
                                  });
                                }
                              }}
                              title="Open in file manager"
                            >
                              <FolderOpen className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : filteredFiles.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            {rootPath ? `No ${activeTab} files found` : "Select a folder to browse"}
          </div>
        ) : (
          activeTab === "track" ? renderTrackTree(filteredFiles) :
            activeTab === "lyric" ? renderLyricTree(filteredFiles) :
              renderCoverTree(filteredFiles)
        )}
      </div>
    </div>


    <Dialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
      <DialogContent className="max-w-md [&>button]:hidden">
        <DialogHeader>
          <DialogTitle>Reset to Default?</DialogTitle>
          <DialogDescription>This will reset the rename format to "Title - Artist". Your custom format will be lost.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowResetConfirm(false)}>Cancel</Button>
          <Button onClick={resetToDefault}>Reset</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>


    <Dialog open={showPreview} onOpenChange={setShowPreview}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col [&>button]:hidden">
        <DialogHeader>
          <DialogTitle>Rename Preview</DialogTitle>
          <DialogDescription>Review the changes before renaming. Files with errors will be skipped.</DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto space-y-2 py-4">
          {previewData.map((item, index) => (<div key={index} className={`p-3 rounded-lg border ${item.error ? "border-destructive/50 bg-destructive/5" : "border-border"}`}>
            <div className="text-sm">
              <div className="text-muted-foreground break-all">{item.old_name}</div>
              {item.error ? <div className="text-destructive text-xs mt-1">{item.error}</div> : <div className="text-primary font-medium break-all mt-1">→ {item.new_name}</div>}
            </div>
          </div>))}
        </div>
        <DialogFooter>
          {previewOnly ? (<Button onClick={() => setShowPreview(false)}>Close</Button>) : (<>
            <Button variant="outline" onClick={() => setShowPreview(false)}>Cancel</Button>
            <Button onClick={handleRename} disabled={renaming}>
              {renaming ? <><Spinner className="h-4 w-4" />Renaming...</> : <>Rename {previewData.filter((p) => !p.error).length} File(s)</>}
            </Button>
          </>)}
        </DialogFooter>
      </DialogContent>
    </Dialog>


    <Dialog open={showMetadata} onOpenChange={setShowMetadata}>
      <DialogContent className="max-w-md [&>button]:hidden">
        <DialogHeader>
          <DialogTitle>File Metadata</DialogTitle>
          <DialogDescription className="break-all">{metadataFile.split(/[/\\]/).pop()}</DialogDescription>
        </DialogHeader>
        {loadingMetadata ? (<div className="flex items-center justify-center py-8"><Spinner className="h-6 w-6" /></div>) : metadataInfo ? (<div className="space-y-3 py-2">
          <div className="grid grid-cols-[100px_1fr] gap-2 text-sm"><span className="text-muted-foreground">Title</span><span>{metadataInfo.title || "-"}</span></div>
          <div className="grid grid-cols-[100px_1fr] gap-2 text-sm"><span className="text-muted-foreground">Artist</span><span>{metadataInfo.artist || "-"}</span></div>
          <div className="grid grid-cols-[100px_1fr] gap-2 text-sm"><span className="text-muted-foreground">Album</span><span>{metadataInfo.album || "-"}</span></div>
          <div className="grid grid-cols-[100px_1fr] gap-2 text-sm"><span className="text-muted-foreground">Album Artist</span><span>{metadataInfo.album_artist || "-"}</span></div>
          <div className="grid grid-cols-[100px_1fr] gap-2 text-sm"><span className="text-muted-foreground">Track</span><span>{metadataInfo.track_number || "-"}</span></div>
          <div className="grid grid-cols-[100px_1fr] gap-2 text-sm"><span className="text-muted-foreground">Disc</span><span>{metadataInfo.disc_number || "-"}</span></div>
          <div className="grid grid-cols-[100px_1fr] gap-2 text-sm"><span className="text-muted-foreground">Year</span><span>{metadataInfo.year ? metadataInfo.year.substring(0, 4) : "-"}</span></div>
        </div>) : (<div className="text-center py-4 text-muted-foreground">No metadata available</div>)}
        <DialogFooter><Button onClick={() => setShowMetadata(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>


    <Dialog open={showFFprobeDialog} onOpenChange={setShowFFprobeDialog}>
      <DialogContent className="max-w-md [&>button]:hidden">
        <DialogHeader>
          <DialogTitle>FFprobe Required</DialogTitle>
          <DialogDescription>Reading M4A metadata requires FFprobe. Would you like to download and install it now?</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowFFprobeDialog(false)} disabled={installingFFprobe}>Cancel</Button>
          <Button onClick={handleInstallFFprobe} disabled={installingFFprobe}>
            {installingFFprobe ? <><Spinner className="h-4 w-4" />Installing...</> : "Install FFprobe"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>


    <Dialog open={showLyricsPreview} onOpenChange={setShowLyricsPreview}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-hidden flex flex-col [&>button]:hidden">
        <DialogHeader>
          <DialogTitle>Lyrics Preview</DialogTitle>
          <DialogDescription className="break-all">{lyricsFile.split(/[/\\]/).pop()}</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2 border-b pb-2">
          <Button variant={lyricsTab === "synced" ? "default" : "ghost"} size="sm" onClick={() => setLyricsTab("synced")}>Synced</Button>
          <Button variant={lyricsTab === "plain" ? "default" : "ghost"} size="sm" onClick={() => setLyricsTab("plain")}>Plain</Button>
        </div>
        <div className="flex-1 overflow-y-auto py-4">
          {lyricsTab === "synced" ? (<div className="bg-muted/30 p-4 rounded-lg space-y-0">
            {renderSyncedLyrics(lyricsContent)}
          </div>) : (<pre className="text-sm whitespace-pre-wrap font-mono bg-muted/30 p-4 rounded-lg">
            {getPlainLyrics(lyricsContent) || "No lyrics content"}
          </pre>)}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleCopyLyrics} className="gap-1.5">
            {copySuccess ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
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
          <DialogDescription className="break-all">{coverFile.split(/[/\\]/).pop()}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-center p-4">
          {coverData ? <img src={coverData} alt="Cover" className="max-w-full max-h-[350px] rounded-lg object-contain" /> : <div className="text-muted-foreground">Loading...</div>}
        </div>
        <DialogFooter><Button onClick={() => setShowCoverPreview(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>


    <Dialog open={showManualRename} onOpenChange={setShowManualRename}>
      <DialogContent className="max-w-2xl [&>button]:hidden">
        <DialogHeader>
          <DialogTitle>Rename File</DialogTitle>
          <DialogDescription className="break-all">{manualRenameFile.split(/[/\\]/).pop()}</DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <Label htmlFor="newName" className="text-sm">New Name</Label>
          <div className="flex items-center gap-2 mt-2">
            <InputWithContext id="newName" value={manualRenameName} onChange={(e) => setManualRenameName(e.target.value)} placeholder="Enter new name" className="flex-1" onKeyDown={(e) => {
              if (e.key === "Enter" && !manualRenaming)
                handleConfirmManualRename();
            }} />
            <span className="text-sm text-muted-foreground shrink-0">{manualRenameFile.match(/\.[^.]+$/)?.[0] || ""}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowManualRename(false)} disabled={manualRenaming}>Cancel</Button>
          <Button onClick={handleConfirmManualRename} disabled={manualRenaming || !manualRenameName.trim()}>
            {manualRenaming ? <><Spinner className="h-4 w-4" />Renaming...</> : "Rename"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>);
}
