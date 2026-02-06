import { useState, useRef } from "react";
import { downloadTrackWithRetry, fetchSpotifyMetadata } from "@/lib/api";
import { getSettings, parseTemplate, type TemplateData } from "@/lib/settings";
import { toastWithSound as toast } from "@/lib/toast-with-sound";
import { joinPath, sanitizePath } from "@/lib/utils";
import { logger } from "@/lib/logger";
import { runWithConcurrency, createThrottledUpdater } from "@/lib/download-helpers";
import type { TrackMetadata } from "@/types/api";
interface CheckFileExistenceRequest {
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
}
interface FileExistenceResult {
    spotify_id: string;
    exists: boolean;
    file_path?: string;
    track_name?: string;
    artist_name?: string;
}
// const CheckFilesExistence = (outputDir: string, tracks: CheckFileExistenceRequest[]): Promise<FileExistenceResult[]> => (window as any)["go"]["main"]["App"]["CheckFilesExistence"](outputDir, tracks);
const CheckFilesExistenceInMusicDir = (rootDir: string, tracks: CheckFileExistenceRequest[]): Promise<FileExistenceResult[]> => (window as any)["go"]["main"]["App"]["CheckFilesExistenceInMusicDir"](rootDir, tracks);
const SkipDownloadItem = (itemID: string, filePath: string): Promise<void> => (window as any)["go"]["main"]["App"]["SkipDownloadItem"](itemID, filePath);

const CONCURRENT_DOWNLOADS = 3;
const PROGRESS_UPDATE_THROTTLE_MS = 280;

/** Extract full error message from a failed download (response or thrown error). */
function getDownloadErrorMessage(err: unknown, response?: { error?: string } | null): string {
    if (response?.error && response.error.trim() !== "") return response.error.trim();
    if (err instanceof Error && err.message?.trim() !== "") return err.message.trim();
    if (err != null && typeof err === "object" && "error" in err && typeof (err as { error?: string }).error === "string") return (err as { error: string }).error;
    if (err != null && typeof err === "object" && "message" in err && typeof (err as { message?: string }).message === "string") return (err as { message: string }).message;
    if (typeof err === "string" && err.trim() !== "") return err.trim();
    try { const s = String(err); if (s && s !== "[object Object]") return s; } catch { /* ignore */ }
    return "Download failed (no details from backend)";
}

export function useDownload() {
    const [downloadProgress, setDownloadProgress] = useState<number>(0);
    const [isDownloading, setIsDownloading] = useState(false);
    const [downloadingTrack, setDownloadingTrack] = useState<string | null>(null);
    const [bulkDownloadType, setBulkDownloadType] = useState<"all" | "selected" | null>(null);
    const [downloadedTracks, setDownloadedTracks] = useState<Set<string>>(new Set());
    const [failedTracks, setFailedTracks] = useState<Set<string>>(new Set());
    const [skippedTracks, setSkippedTracks] = useState<Set<string>>(new Set());
    const [currentDownloadInfo, setCurrentDownloadInfo] = useState<{
        name: string;
        artists: string;
    } | null>(null);
    const shouldStopDownloadRef = useRef(false);
    const downloadWithAutoFallback = async (isrc: string, settings: any, trackName?: string, artistName?: string, albumName?: string, playlistName?: string, position?: number, spotifyId?: string, durationMs?: number, releaseYear?: string, albumArtist?: string, releaseDate?: string, coverUrl?: string, spotifyTrackNumber?: number, spotifyDiscNumber?: number, spotifyTotalTracks?: number, spotifyTotalDiscs?: number, copyright?: string, publisher?: string) => {
        const service = settings.downloader;
        const query = trackName && artistName ? `${trackName} ${artistName}` : undefined;
        const os = settings.operatingSystem;
        let outputDir = settings.downloadPath;
        let useAlbumTrackNumber = false;
        const placeholder = "__SLASH_PLACEHOLDER__";
        let finalReleaseDate = releaseDate;
        let finalTrackNumber = spotifyTrackNumber || 0;
        if (spotifyId) {
            try {
                const trackURL = `https://open.spotify.com/track/${spotifyId}`;
                const trackMetadata = await fetchSpotifyMetadata(trackURL, false, 0, 10);
                if ("track" in trackMetadata && trackMetadata.track) {
                    if (trackMetadata.track.release_date) {
                        finalReleaseDate = trackMetadata.track.release_date;
                    }
                    if (trackMetadata.track.track_number > 0) {
                        finalTrackNumber = trackMetadata.track.track_number;
                    }
                }
            }
            catch (err) {
            }
        }
        const yearValue = releaseYear || finalReleaseDate?.substring(0, 4);
        const hasSubfolder = settings.folderTemplate && settings.folderTemplate.trim() !== "";
        const trackNumberForTemplate = (hasSubfolder && finalTrackNumber > 0) ? finalTrackNumber : (position || 0);
        if (hasSubfolder) {
            useAlbumTrackNumber = true;
        }
        const templateData: TemplateData = {
            artist: artistName?.replace(/\//g, placeholder),
            album: albumName?.replace(/\//g, placeholder),
            album_artist: albumArtist?.replace(/\//g, placeholder) || artistName?.replace(/\//g, placeholder),
            title: trackName?.replace(/\//g, placeholder),
            track: trackNumberForTemplate,
            year: yearValue,
            playlist: playlistName?.replace(/\//g, placeholder),
        };
        // Do not create a playlist-named folder: save to music dir + folder template only
        if (settings.folderTemplate) {
            const folderPath = parseTemplate(settings.folderTemplate, templateData);
            if (folderPath) {
                const parts = folderPath.split("/").filter((p: string) => p.trim());
                for (const part of parts) {
                    const sanitizedPart = part.replace(new RegExp(placeholder, "g"), " ");
                    outputDir = joinPath(os, outputDir, sanitizePath(sanitizedPart, os));
                }
            }
        }
        const serviceForCheck = service === "auto" ? "flac" : (service === "tidal" ? "flac" : (service === "qobuz" ? "flac" : "flac"));
        let fileExists = false;
        if (trackName && artistName) {
            try {
                const checkRequest: CheckFileExistenceRequest = {
                    spotify_id: spotifyId || isrc,
                    track_name: trackName,
                    artist_name: artistName,
                    album_name: albumName,
                    album_artist: albumArtist,
                    release_date: finalReleaseDate || releaseDate,
                    track_number: finalTrackNumber || spotifyTrackNumber || 0,
                    disc_number: spotifyDiscNumber || 0,
                    position: trackNumberForTemplate,
                    use_album_track_number: useAlbumTrackNumber,
                    filename_format: settings.filenameTemplate || "",
                    include_track_number: settings.trackNumber || false,
                    audio_format: serviceForCheck,
                };
                // Check entire music directory so we skip if track exists anywhere
                const existenceResults = await CheckFilesExistenceInMusicDir(settings.downloadPath, [checkRequest]);
                if (existenceResults.length > 0 && existenceResults[0].exists) {
                    fileExists = true;
                    return {
                        success: true,
                        message: "File already exists",
                        file: existenceResults[0].file_path || "",
                        already_exists: true,
                    };
                }
            }
            catch (err) {
                console.warn("File existence check failed:", err);
            }
        }
        const { AddToDownloadQueue } = await import("../../wailsjs/go/main/App");
        let itemID: string | undefined;
        if (!fileExists) {
            itemID = await AddToDownloadQueue(isrc, trackName || "", artistName || "", albumName || "");
        }
        if (service === "auto") {
            let streamingURLs: any = null;
            if (spotifyId) {
                try {
                    const { GetStreamingURLs } = await import("../../wailsjs/go/main/App");
                    const urlsJson = await GetStreamingURLs(spotifyId);
                    streamingURLs = JSON.parse(urlsJson);
                }
                catch (err) {
                    console.error("Failed to get streaming URLs:", err);
                }
            }
            const durationSeconds = durationMs ? Math.round(durationMs / 1000) : undefined;
            if (streamingURLs?.tidal_url) {
                try {
                    logger.debug(`trying tidal for: ${trackName} - ${artistName}`);
                    const tidalResponse = await downloadTrackWithRetry({
                        isrc,
                        service: "tidal",
                        query,
                        track_name: trackName,
                        artist_name: artistName,
                        album_name: albumName,
                        album_artist: albumArtist,
                        release_date: finalReleaseDate || releaseDate,
                        cover_url: coverUrl,
                        output_dir: outputDir,
                        filename_format: settings.filenameTemplate,
                        track_number: settings.trackNumber,
                        position,
                        use_album_track_number: useAlbumTrackNumber,
                        spotify_id: spotifyId,
                        embed_lyrics: settings.embedLyrics,
                        embed_max_quality_cover: settings.embedMaxQualityCover,
                        service_url: streamingURLs.tidal_url,
                        duration: durationSeconds,
                        item_id: itemID,
                        audio_format: settings.tidalQuality || "LOSSLESS",
                        spotify_track_number: spotifyTrackNumber,
                        spotify_disc_number: spotifyDiscNumber,
                        spotify_total_tracks: spotifyTotalTracks,
                        spotify_total_discs: spotifyTotalDiscs,
                        copyright: copyright,
                        publisher: publisher,
                    });
                    if (tidalResponse.success) {
                        logger.success(`tidal: ${trackName} - ${artistName}`);
                        return tidalResponse;
                    }
                    logger.warning(`tidal failed, trying amazon...`);
                }
                catch (tidalErr) {
                    logger.error(`tidal error: ${tidalErr}`);
                }
            }
            if (streamingURLs?.amazon_url) {
                try {
                    logger.debug(`trying amazon for: ${trackName} - ${artistName}`);
                    const amazonResponse = await downloadTrackWithRetry({
                        isrc,
                        service: "amazon",
                        query,
                        track_name: trackName,
                        artist_name: artistName,
                        album_name: albumName,
                        album_artist: albumArtist,
                        release_date: finalReleaseDate || releaseDate,
                        cover_url: coverUrl,
                        output_dir: outputDir,
                        filename_format: settings.filenameTemplate,
                        track_number: settings.trackNumber,
                        position,
                        use_album_track_number: useAlbumTrackNumber,
                        spotify_id: spotifyId,
                        embed_lyrics: settings.embedLyrics,
                        embed_max_quality_cover: settings.embedMaxQualityCover,
                        service_url: streamingURLs.amazon_url,
                        item_id: itemID,
                        spotify_track_number: spotifyTrackNumber,
                        spotify_disc_number: spotifyDiscNumber,
                        spotify_total_tracks: spotifyTotalTracks,
                        spotify_total_discs: spotifyTotalDiscs,
                        copyright: copyright,
                        publisher: publisher,
                    });
                    if (amazonResponse.success) {
                        logger.success(`amazon: ${trackName} - ${artistName}`);
                        return amazonResponse;
                    }
                    logger.warning(`amazon failed, trying qobuz...`);
                }
                catch (amazonErr) {
                    logger.error(`amazon error: ${amazonErr}`);
                }
            }
            logger.debug(`trying qobuz (fallback) for: ${trackName} - ${artistName}`);
            const qobuzResponse = await downloadTrackWithRetry({
                isrc,
                service: "qobuz",
                query,
                track_name: trackName,
                artist_name: artistName,
                album_name: albumName,
                album_artist: albumArtist,
                release_date: finalReleaseDate || releaseDate,
                cover_url: coverUrl,
                output_dir: outputDir,
                filename_format: settings.filenameTemplate,
                track_number: settings.trackNumber,
                position: trackNumberForTemplate,
                use_album_track_number: useAlbumTrackNumber,
                spotify_id: spotifyId,
                embed_lyrics: settings.embedLyrics,
                embed_max_quality_cover: settings.embedMaxQualityCover,
                duration: durationMs ? Math.round(durationMs / 1000) : undefined,
                item_id: itemID,
                audio_format: settings.qobuzQuality || "6",
                spotify_track_number: spotifyTrackNumber,
                spotify_disc_number: spotifyDiscNumber,
                spotify_total_tracks: spotifyTotalTracks,
                spotify_total_discs: spotifyTotalDiscs,
                copyright: copyright,
                publisher: publisher,
            });
            if (qobuzResponse.success) return qobuzResponse;

            if (!qobuzResponse.success && itemID) {
                try {
                    const { MarkDownloadItemFailed } = await import("../../wailsjs/go/main/App");
                    await MarkDownloadItemFailed(itemID, qobuzResponse.error || "All services failed");
                } catch (_) { /* don't block alternative-versions attempt */ }
            }

            const spotifyIdOrIsrc = spotifyId || isrc;
            if (spotifyIdOrIsrc && trackName && artistName) {
                try {
                    logger.info(`All services failed, searching for other Spotify versions of "${trackName}"...`);
                    const App = await import("../../wailsjs/go/main/App") as unknown as { GetAlternativeSpotifyTrackIDs: (track: string, artist: string, exclude: string, limit: number) => Promise<string> };
                    const idsJson = await App.GetAlternativeSpotifyTrackIDs(trackName, artistName, spotifyIdOrIsrc, 8);
                    const altIds: string[] = JSON.parse(idsJson || "[]");
                    if (altIds.length > 0) logger.info(`Found ${altIds.length} other version(s), trying each...`);
                    const durationSeconds = durationMs ? Math.round(durationMs / 1000) : undefined;
                    for (const altId of altIds) {
                        if (!altId || altId === spotifyIdOrIsrc) continue;
                        let urls: { tidal_url?: string; amazon_url?: string } | null = null;
                        try {
                            const { GetStreamingURLs } = await import("../../wailsjs/go/main/App");
                            const u = await GetStreamingURLs(altId);
                            urls = JSON.parse(u);
                        } catch { continue; }
                        if (urls?.tidal_url) {
                            try {
                                const r = await downloadTrackWithRetry({
                                    isrc,
                                    service: "tidal",
                                    query,
                                    track_name: trackName,
                                    artist_name: artistName,
                                    album_name: albumName,
                                    album_artist: albumArtist,
                                    release_date: finalReleaseDate || releaseDate,
                                    cover_url: coverUrl,
                                    output_dir: outputDir,
                                    filename_format: settings.filenameTemplate,
                                    track_number: settings.trackNumber,
                                    position,
                                    use_album_track_number: useAlbumTrackNumber,
                                    spotify_id: spotifyId,
                                    embed_lyrics: settings.embedLyrics,
                                    embed_max_quality_cover: settings.embedMaxQualityCover,
                                    service_url: urls.tidal_url,
                                    duration: durationSeconds,
                                    item_id: itemID,
                                    audio_format: settings.tidalQuality || "LOSSLESS",
                                    spotify_track_number: spotifyTrackNumber,
                                    spotify_disc_number: spotifyDiscNumber,
                                    spotify_total_tracks: spotifyTotalTracks,
                                    spotify_total_discs: spotifyTotalDiscs,
                                    copyright: copyright,
                                    publisher: publisher,
                                });
                                if (r.success) {
                                    logger.success(`tidal (other version): ${trackName} - ${artistName}`);
                                    return r;
                                }
                            } catch { /* try next */ }
                        }
                        if (urls?.amazon_url) {
                            try {
                                const r = await downloadTrackWithRetry({
                                    isrc,
                                    service: "amazon",
                                    query,
                                    track_name: trackName,
                                    artist_name: artistName,
                                    album_name: albumName,
                                    album_artist: albumArtist,
                                    release_date: finalReleaseDate || releaseDate,
                                    cover_url: coverUrl,
                                    output_dir: outputDir,
                                    filename_format: settings.filenameTemplate,
                                    track_number: settings.trackNumber,
                                    position,
                                    use_album_track_number: useAlbumTrackNumber,
                                    spotify_id: spotifyId,
                                    embed_lyrics: settings.embedLyrics,
                                    embed_max_quality_cover: settings.embedMaxQualityCover,
                                    service_url: urls.amazon_url,
                                    item_id: itemID,
                                    spotify_track_number: spotifyTrackNumber,
                                    spotify_disc_number: spotifyDiscNumber,
                                    spotify_total_tracks: spotifyTotalTracks,
                                    spotify_total_discs: spotifyTotalDiscs,
                                    copyright: copyright,
                                    publisher: publisher,
                                });
                                if (r.success) {
                                    logger.success(`amazon (other version): ${trackName} - ${artistName}`);
                                    return r;
                                }
                            } catch { /* try next */ }
                        }
                        try {
                            const r = await downloadTrackWithRetry({
                                isrc,
                                service: "qobuz",
                                query,
                                track_name: trackName,
                                artist_name: artistName,
                                album_name: albumName,
                                album_artist: albumArtist,
                                release_date: finalReleaseDate || releaseDate,
                                cover_url: coverUrl,
                                output_dir: outputDir,
                                filename_format: settings.filenameTemplate,
                                track_number: settings.trackNumber,
                                position: trackNumberForTemplate,
                                use_album_track_number: useAlbumTrackNumber,
                                spotify_id: spotifyId,
                                embed_lyrics: settings.embedLyrics,
                                embed_max_quality_cover: settings.embedMaxQualityCover,
                                duration: durationMs ? Math.round(durationMs / 1000) : undefined,
                                item_id: itemID,
                                audio_format: settings.qobuzQuality || "6",
                                spotify_track_number: spotifyTrackNumber,
                                spotify_disc_number: spotifyDiscNumber,
                                spotify_total_tracks: spotifyTotalTracks,
                                spotify_total_discs: spotifyTotalDiscs,
                                copyright: copyright,
                                publisher: publisher,
                            });
                            if (r.success) {
                                logger.success(`qobuz (other version): ${trackName} - ${artistName}`);
                                return r;
                            }
                        } catch { /* try next alt */ }
                    }
                } catch (altErr) {
                    logger.error(`alternative versions attempt failed: ${altErr}`);
                }
            }
            return qobuzResponse;
        }
        const durationSecondsForFallback = durationMs ? Math.round(durationMs / 1000) : undefined;
        let audioFormat: string | undefined;
        if (service === "tidal") {
            audioFormat = settings.tidalQuality || "LOSSLESS";
        }
        else if (service === "qobuz") {
            audioFormat = settings.qobuzQuality || "6";
        }
        const singleServiceResponse = await downloadTrackWithRetry({
            isrc,
            service: service as "tidal" | "qobuz" | "amazon",
            query,
            track_name: trackName,
            artist_name: artistName,
            album_name: albumName,
            album_artist: albumArtist,
            release_date: finalReleaseDate || releaseDate,
            cover_url: coverUrl,
            output_dir: outputDir,
            filename_format: settings.filenameTemplate,
            track_number: settings.trackNumber,
            position: trackNumberForTemplate,
            use_album_track_number: useAlbumTrackNumber,
            spotify_id: spotifyId,
            embed_lyrics: settings.embedLyrics,
            embed_max_quality_cover: settings.embedMaxQualityCover,
            duration: durationSecondsForFallback,
            item_id: itemID,
            audio_format: audioFormat,
            spotify_track_number: spotifyTrackNumber,
            spotify_disc_number: spotifyDiscNumber,
            spotify_total_tracks: spotifyTotalTracks,
            spotify_total_discs: spotifyTotalDiscs,
            copyright: copyright,
            publisher: publisher,
        });
        if (!singleServiceResponse.success && itemID) {
            const { MarkDownloadItemFailed } = await import("../../wailsjs/go/main/App");
            await MarkDownloadItemFailed(itemID, singleServiceResponse.error || "Download failed");
        }
        return singleServiceResponse;
    };
    const downloadWithItemID = async (isrc: string, settings: any, itemID: string, trackName?: string, artistName?: string, albumName?: string, folderName?: string, position?: number, spotifyId?: string, durationMs?: number, isAlbum?: boolean, releaseYear?: string, albumArtist?: string, releaseDate?: string, coverUrl?: string, spotifyTrackNumber?: number, spotifyDiscNumber?: number, spotifyTotalTracks?: number, spotifyTotalDiscs?: number, copyright?: string, publisher?: string) => {
        const service = settings.downloader;
        const query = trackName && artistName ? `${trackName} ${artistName}` : undefined;
        const os = settings.operatingSystem;
        let outputDir = settings.downloadPath;
        let useAlbumTrackNumber = false;
        const placeholder = "__SLASH_PLACEHOLDER__";
        let finalReleaseDate = releaseDate;
        let finalTrackNumber = spotifyTrackNumber || 0;
        if (isAlbum) {
            console.log("isAlbum", isAlbum);
        }
        if (spotifyId) {
            try {
                const trackURL = `https://open.spotify.com/track/${spotifyId}`;
                const trackMetadata = await fetchSpotifyMetadata(trackURL, false, 0, 10);
                if ("track" in trackMetadata && trackMetadata.track) {
                    if (trackMetadata.track.release_date) {
                        finalReleaseDate = trackMetadata.track.release_date;
                    }
                    if (trackMetadata.track.track_number > 0) {
                        finalTrackNumber = trackMetadata.track.track_number;
                    }
                }
            }
            catch (err) {
            }
        }
        const yearValue = releaseYear || finalReleaseDate?.substring(0, 4);
        const hasSubfolder = settings.folderTemplate && settings.folderTemplate.trim() !== "";
        const trackNumberForTemplate = (hasSubfolder && finalTrackNumber > 0) ? finalTrackNumber : (position || 0);
        if (hasSubfolder) {
            useAlbumTrackNumber = true;
        }
        const templateData: TemplateData = {
            artist: artistName?.replace(/\//g, placeholder),
            album: albumName?.replace(/\//g, placeholder),
            album_artist: albumArtist?.replace(/\//g, placeholder) || artistName?.replace(/\//g, placeholder),
            title: trackName?.replace(/\//g, placeholder),
            track: trackNumberForTemplate,
            year: yearValue,
            playlist: folderName?.replace(/\//g, placeholder),
        };
        // Do not create a playlist-named folder: use music dir + folder template only
        if (settings.folderTemplate) {
            const folderPath = parseTemplate(settings.folderTemplate, templateData);
            if (folderPath) {
                const parts = folderPath.split("/").filter(p => p.trim());
                for (const part of parts) {
                    const sanitizedPart = part.replace(new RegExp(placeholder, "g"), " ");
                    outputDir = joinPath(os, outputDir, sanitizePath(sanitizedPart, os));
                }
            }
        }
        if (service === "auto") {
            let streamingURLs: any = null;
            if (spotifyId) {
                try {
                    const { GetStreamingURLs } = await import("../../wailsjs/go/main/App");
                    const urlsJson = await GetStreamingURLs(spotifyId);
                    streamingURLs = JSON.parse(urlsJson);
                }
                catch (err) {
                    console.error("Failed to get streaming URLs:", err);
                }
            }
            const durationSeconds = durationMs ? Math.round(durationMs / 1000) : undefined;
            if (streamingURLs?.tidal_url) {
                try {
                    const tidalResponse = await downloadTrackWithRetry({
                        isrc,
                        service: "tidal",
                        query,
                        track_name: trackName,
                        artist_name: artistName,
                        album_name: albumName,
                        album_artist: albumArtist,
                        release_date: finalReleaseDate || releaseDate,
                        cover_url: coverUrl,
                        output_dir: outputDir,
                        filename_format: settings.filenameTemplate,
                        track_number: settings.trackNumber,
                        position,
                        use_album_track_number: useAlbumTrackNumber,
                        spotify_id: spotifyId,
                        embed_lyrics: settings.embedLyrics,
                        embed_max_quality_cover: settings.embedMaxQualityCover,
                        service_url: streamingURLs.tidal_url,
                        duration: durationSeconds,
                        item_id: itemID,
                        audio_format: settings.tidalQuality || "LOSSLESS",
                        spotify_track_number: spotifyTrackNumber,
                        spotify_disc_number: spotifyDiscNumber,
                        spotify_total_tracks: spotifyTotalTracks,
                        spotify_total_discs: spotifyTotalDiscs,
                        copyright: copyright,
                        publisher: publisher,
                    });
                    if (tidalResponse.success) {
                        return tidalResponse;
                    }
                }
                catch (tidalErr) {
                    console.error("Tidal error:", tidalErr);
                }
            }
            if (streamingURLs?.amazon_url) {
                try {
                    const amazonResponse = await downloadTrackWithRetry({
                        isrc,
                        service: "amazon",
                        query,
                        track_name: trackName,
                        artist_name: artistName,
                        album_name: albumName,
                        album_artist: albumArtist,
                        release_date: finalReleaseDate || releaseDate,
                        cover_url: coverUrl,
                        output_dir: outputDir,
                        filename_format: settings.filenameTemplate,
                        track_number: settings.trackNumber,
                        position,
                        use_album_track_number: useAlbumTrackNumber,
                        spotify_id: spotifyId,
                        embed_lyrics: settings.embedLyrics,
                        embed_max_quality_cover: settings.embedMaxQualityCover,
                        service_url: streamingURLs.amazon_url,
                        item_id: itemID,
                        spotify_track_number: spotifyTrackNumber,
                        spotify_disc_number: spotifyDiscNumber,
                        spotify_total_tracks: spotifyTotalTracks,
                        spotify_total_discs: spotifyTotalDiscs,
                        copyright: copyright,
                        publisher: publisher,
                    });
                    if (amazonResponse.success) {
                        return amazonResponse;
                    }
                }
                catch (amazonErr) {
                    console.error("Amazon error:", amazonErr);
                }
            }
            const qobuzResponse = await downloadTrackWithRetry({
                isrc,
                service: "qobuz",
                query,
                track_name: trackName,
                artist_name: artistName,
                album_name: albumName,
                album_artist: albumArtist,
                release_date: finalReleaseDate || releaseDate,
                cover_url: coverUrl,
                output_dir: outputDir,
                filename_format: settings.filenameTemplate,
                track_number: settings.trackNumber,
                position: trackNumberForTemplate,
                use_album_track_number: useAlbumTrackNumber,
                spotify_id: spotifyId,
                embed_lyrics: settings.embedLyrics,
                embed_max_quality_cover: settings.embedMaxQualityCover,
                duration: durationMs ? Math.round(durationMs / 1000) : undefined,
                item_id: itemID,
                audio_format: settings.qobuzQuality || "6",
                spotify_track_number: spotifyTrackNumber,
                spotify_disc_number: spotifyDiscNumber,
                spotify_total_tracks: spotifyTotalTracks,
                spotify_total_discs: spotifyTotalDiscs,
                copyright: copyright,
                publisher: publisher,
            });
            if (qobuzResponse.success) return qobuzResponse;

            const spotifyIdOrIsrcBatch = spotifyId || isrc;
            if (spotifyIdOrIsrcBatch && trackName && artistName) {
                try {
                    const App = await import("../../wailsjs/go/main/App") as unknown as { GetAlternativeSpotifyTrackIDs: (track: string, artist: string, exclude: string, limit: number) => Promise<string> };
                    logger.info(`All services failed, searching for other Spotify versions of "${trackName}"...`);
                    const idsJson = await App.GetAlternativeSpotifyTrackIDs(trackName, artistName, spotifyIdOrIsrcBatch, 8);
                    const altIds: string[] = JSON.parse(idsJson || "[]");
                    if (altIds.length > 0) logger.info(`Found ${altIds.length} other version(s), trying each...`);
                    const durationSecondsAlt = durationMs ? Math.round(durationMs / 1000) : undefined;
                    for (const altId of altIds) {
                        if (!altId || altId === spotifyIdOrIsrcBatch) continue;
                        let urls: { tidal_url?: string; amazon_url?: string } | null = null;
                        try {
                            const { GetStreamingURLs } = await import("../../wailsjs/go/main/App");
                            const u = await GetStreamingURLs(altId);
                            urls = JSON.parse(u);
                        } catch { continue; }
                        if (urls?.tidal_url) {
                            try {
                                const r = await downloadTrackWithRetry({
                                    isrc,
                                    service: "tidal",
                                    query,
                                    track_name: trackName,
                                    artist_name: artistName,
                                    album_name: albumName,
                                    album_artist: albumArtist,
                                    release_date: finalReleaseDate || releaseDate,
                                    cover_url: coverUrl,
                                    output_dir: outputDir,
                                    filename_format: settings.filenameTemplate,
                                    track_number: settings.trackNumber,
                                    position,
                                    use_album_track_number: useAlbumTrackNumber,
                                    spotify_id: spotifyId,
                                    embed_lyrics: settings.embedLyrics,
                                    embed_max_quality_cover: settings.embedMaxQualityCover,
                                    service_url: urls.tidal_url,
                                    duration: durationSecondsAlt,
                                    item_id: itemID,
                                    audio_format: settings.tidalQuality || "LOSSLESS",
                                    spotify_track_number: spotifyTrackNumber,
                                    spotify_disc_number: spotifyDiscNumber,
                                    spotify_total_tracks: spotifyTotalTracks,
                                    spotify_total_discs: spotifyTotalDiscs,
                                    copyright: copyright,
                                    publisher: publisher,
                                });
                                if (r.success) {
                                    logger.success(`tidal (other version): ${trackName} - ${artistName}`);
                                    return r;
                                }
                            } catch { /* try next */ }
                        }
                        if (urls?.amazon_url) {
                            try {
                                const r = await downloadTrackWithRetry({
                                    isrc,
                                    service: "amazon",
                                    query,
                                    track_name: trackName,
                                    artist_name: artistName,
                                    album_name: albumName,
                                    album_artist: albumArtist,
                                    release_date: finalReleaseDate || releaseDate,
                                    cover_url: coverUrl,
                                    output_dir: outputDir,
                                    filename_format: settings.filenameTemplate,
                                    track_number: settings.trackNumber,
                                    position,
                                    use_album_track_number: useAlbumTrackNumber,
                                    spotify_id: spotifyId,
                                    embed_lyrics: settings.embedLyrics,
                                    embed_max_quality_cover: settings.embedMaxQualityCover,
                                    service_url: urls.amazon_url,
                                    item_id: itemID,
                                    spotify_track_number: spotifyTrackNumber,
                                    spotify_disc_number: spotifyDiscNumber,
                                    spotify_total_tracks: spotifyTotalTracks,
                                    spotify_total_discs: spotifyTotalDiscs,
                                    copyright: copyright,
                                    publisher: publisher,
                                });
                                if (r.success) {
                                    logger.success(`amazon (other version): ${trackName} - ${artistName}`);
                                    return r;
                                }
                            } catch { /* try next */ }
                        }
                        try {
                            const r = await downloadTrackWithRetry({
                                isrc,
                                service: "qobuz",
                                query,
                                track_name: trackName,
                                artist_name: artistName,
                                album_name: albumName,
                                album_artist: albumArtist,
                                release_date: finalReleaseDate || releaseDate,
                                cover_url: coverUrl,
                                output_dir: outputDir,
                                filename_format: settings.filenameTemplate,
                                track_number: settings.trackNumber,
                                position: trackNumberForTemplate,
                                use_album_track_number: useAlbumTrackNumber,
                                spotify_id: spotifyId,
                                embed_lyrics: settings.embedLyrics,
                                embed_max_quality_cover: settings.embedMaxQualityCover,
                                duration: durationSecondsAlt,
                                item_id: itemID,
                                audio_format: settings.qobuzQuality || "6",
                                spotify_track_number: spotifyTrackNumber,
                                spotify_disc_number: spotifyDiscNumber,
                                spotify_total_tracks: spotifyTotalTracks,
                                spotify_total_discs: spotifyTotalDiscs,
                                copyright: copyright,
                                publisher: publisher,
                            });
                            if (r.success) {
                                logger.success(`qobuz (other version): ${trackName} - ${artistName}`);
                                return r;
                            }
                        } catch { /* try next alt */ }
                    }
                } catch (altErr) {
                    logger.debug(`alternative versions attempt failed: ${altErr}`);
                }
            }

            if (!qobuzResponse.success && itemID) {
                const { MarkDownloadItemFailed } = await import("../../wailsjs/go/main/App");
                await MarkDownloadItemFailed(itemID, qobuzResponse.error || "All services failed");
            }
            return qobuzResponse;
        }
        const durationSecondsForFallback = durationMs ? Math.round(durationMs / 1000) : undefined;
        let audioFormat: string | undefined;
        if (service === "tidal") {
            audioFormat = settings.tidalQuality || "LOSSLESS";
        }
        else if (service === "qobuz") {
            audioFormat = settings.qobuzQuality || "6";
        }
        const singleServiceResponse = await downloadTrackWithRetry({
            isrc,
            service: service as "tidal" | "qobuz" | "amazon",
            query,
            track_name: trackName,
            artist_name: artistName,
            album_name: albumName,
            album_artist: albumArtist,
            release_date: finalReleaseDate || releaseDate,
            cover_url: coverUrl,
            output_dir: outputDir,
            filename_format: settings.filenameTemplate,
            track_number: settings.trackNumber,
            position: trackNumberForTemplate,
            use_album_track_number: useAlbumTrackNumber,
            spotify_id: spotifyId,
            embed_lyrics: settings.embedLyrics,
            embed_max_quality_cover: settings.embedMaxQualityCover,
            duration: durationSecondsForFallback,
            item_id: itemID,
            audio_format: audioFormat,
            spotify_track_number: spotifyTrackNumber,
            spotify_disc_number: spotifyDiscNumber,
            spotify_total_tracks: spotifyTotalTracks,
            spotify_total_discs: spotifyTotalDiscs,
            copyright: copyright,
            publisher: publisher,
        });
        if (!singleServiceResponse.success && itemID) {
            const { MarkDownloadItemFailed } = await import("../../wailsjs/go/main/App");
            await MarkDownloadItemFailed(itemID, singleServiceResponse.error || "Download failed");
        }
        return singleServiceResponse;
    };
    const handleDownloadTrack = async (isrc: string, trackName?: string, artistName?: string, albumName?: string, spotifyId?: string, playlistName?: string, durationMs?: number, position?: number, albumArtist?: string, releaseDate?: string, coverUrl?: string, spotifyTrackNumber?: number, spotifyDiscNumber?: number, spotifyTotalTracks?: number, spotifyTotalDiscs?: number, copyright?: string, publisher?: string) => {
        if (!isrc) {
            toast.error("No ISRC found for this track");
            return;
        }
        logger.info(`starting download: ${trackName} - ${artistName}`);
        const settings = getSettings();
        setDownloadingTrack(isrc);
        try {
            const releaseYear = releaseDate?.substring(0, 4);
            const response = await downloadWithAutoFallback(isrc, settings, trackName, artistName, albumName, playlistName, position, spotifyId, durationMs, releaseYear, albumArtist || "", releaseDate, coverUrl, spotifyTrackNumber, spotifyDiscNumber, spotifyTotalTracks, spotifyTotalDiscs, copyright, publisher);
            if (response.success) {
                if (response.already_exists) {
                    toast.info(response.message);
                    setSkippedTracks((prev) => new Set(prev).add(isrc));
                }
                else {
                    toast.success(response.message);
                }
                setDownloadedTracks((prev) => new Set(prev).add(isrc));
                setFailedTracks((prev) => {
                    const newSet = new Set(prev);
                    newSet.delete(isrc);
                    return newSet;
                });
            }
            else {
                const msg = getDownloadErrorMessage(null, response);
                logger.error(`download failed: ${msg}`);
                toast.error(msg);
                setFailedTracks((prev) => new Set(prev).add(isrc));
            }
        }
        catch (err) {
            const msg = getDownloadErrorMessage(err, null);
            logger.error(`download failed: ${msg}`);
            toast.error(msg);
            setFailedTracks((prev) => new Set(prev).add(isrc));
        }
        finally {
            setDownloadingTrack(null);
        }
    };
    const handleDownloadSelected = async (selectedTracks: string[], allTracks: TrackMetadata[], folderName?: string, isAlbum?: boolean) => {
        if (selectedTracks.length === 0) {
            toast.error("No tracks selected");
            return;
        }
        logger.info(`starting batch download: ${selectedTracks.length} selected tracks`);
        const settings = getSettings();
        setIsDownloading(true);
        setBulkDownloadType("selected");
        setDownloadProgress(0);
        // Do not create a playlist-named folder; check existence in entire music directory
        const selectedTrackObjects = selectedTracks
            .map((isrc) => allTracks.find((t) => t.isrc === isrc))
            .filter((t): t is TrackMetadata => t !== undefined);
        logger.info(`checking existing files in parallel...`);
        const useAlbumTrackNumber = settings.folderTemplate?.includes("{album}") || false;
        const audioFormat = "flac";
        const existenceChecks = selectedTrackObjects.map((track, index) => {
            return {
                spotify_id: track.spotify_id || track.isrc,
                track_name: track.name || "",
                artist_name: track.artists || "",
                album_name: track.album_name || "",
                album_artist: track.album_artist || "",
                release_date: track.release_date || "",
                track_number: track.track_number || 0,
                disc_number: track.disc_number || 0,
                position: index + 1,
                use_album_track_number: useAlbumTrackNumber,
                filename_format: settings.filenameTemplate || "",
                include_track_number: settings.trackNumber || false,
                audio_format: audioFormat,
            };
        });
        const existenceResults = await CheckFilesExistenceInMusicDir(settings.downloadPath, existenceChecks);
        const existingSpotifyIDs = new Set<string>();
        const existingFilePaths = new Map<string, string>();
        for (const result of existenceResults) {
            if (result.exists) {
                existingSpotifyIDs.add(result.spotify_id);
                existingFilePaths.set(result.spotify_id, result.file_path || "");
            }
        }
        logger.info(`found ${existingSpotifyIDs.size} existing files`);
        const { AddToDownloadQueue } = await import("../../wailsjs/go/main/App");
        const itemIDs: string[] = [];
        for (const isrc of selectedTracks) {
            const track = allTracks.find((t) => t.isrc === isrc);
            const trackID = track?.spotify_id || isrc;
            const itemID = await AddToDownloadQueue(trackID, track?.name || "", track?.artists || "", track?.album_name || "");
            itemIDs.push(itemID);
            if (existingSpotifyIDs.has(trackID)) {
                const filePath = existingFilePaths.get(trackID) || "";
                setTimeout(() => SkipDownloadItem(itemID, filePath), 10);
                setSkippedTracks((prev) => new Set(prev).add(isrc));
                setDownloadedTracks((prev) => new Set(prev).add(isrc));
            }
        }
        const tracksToDownload = selectedTrackObjects.filter((track) => {
            const trackID = track.spotify_id || track.isrc;
            return !existingSpotifyIDs.has(trackID);
        });
        const total = selectedTracks.length;
        const initialSkippedIsrcs = selectedTracks.filter((isrc) => {
            const t = allTracks.find((tr) => tr.isrc === isrc);
            return existingSpotifyIDs.has(t?.spotify_id ?? isrc);
        });
        const batchState = {
            successCount: 0,
            errorCount: 0,
            skippedCount: existingSpotifyIDs.size,
            downloaded: new Set<string>(initialSkippedIsrcs),
            failed: new Set<string>(),
            skipped: new Set<string>(initialSkippedIsrcs),
        };
        const flushProgress = createThrottledUpdater(PROGRESS_UPDATE_THROTTLE_MS, () => {
            const completed = batchState.skippedCount + batchState.successCount + batchState.errorCount;
            setDownloadProgress(Math.min(100, Math.round((completed / total) * 100)));
            setDownloadedTracks(new Set(batchState.downloaded));
            setFailedTracks(new Set(batchState.failed));
            setSkippedTracks(new Set(batchState.skipped));
        });
        setDownloadingTrack(null);
        setCurrentDownloadInfo({ name: "Multiple tracks", artists: "" });
        const items = tracksToDownload.map((track) => {
            const originalIndex = selectedTracks.indexOf(track.isrc);
            return { track, itemID: itemIDs[originalIndex], originalIndex: originalIndex + 1 };
        });
        const { MarkDownloadItemFailed } = await import("../../wailsjs/go/main/App");
        await runWithConcurrency(
            items,
            CONCURRENT_DOWNLOADS,
            async ({ track, itemID, originalIndex }) => {
                if (shouldStopDownloadRef.current) return;
                try {
                    const releaseYear = track.release_date?.substring(0, 4);
                    const response = await downloadWithItemID(track.isrc, settings, itemID, track.name, track.artists, track.album_name, folderName, originalIndex, track.spotify_id, track.duration_ms, isAlbum, releaseYear, track.album_artist || "", track.release_date, track.images, track.track_number, track.disc_number, track.total_tracks, track.total_discs, track.copyright, track.publisher);
                    if (response.success) {
                        if (response.already_exists) {
                            batchState.skippedCount++;
                            batchState.skipped.add(track.isrc);
                            logger.info(`skipped: ${track.name} - ${track.artists} (already exists)`);
                        } else {
                            batchState.successCount++;
                            logger.success(`downloaded: ${track.name} - ${track.artists}`);
                        }
                        batchState.downloaded.add(track.isrc);
                        batchState.failed.delete(track.isrc);
                    } else {
                        batchState.errorCount++;
                        batchState.failed.add(track.isrc);
                        logger.error(`failed: ${track.name} - ${track.artists}`);
                    }
                } catch (err) {
                    batchState.errorCount++;
                    batchState.failed.add(track.isrc);
                    logger.error(`error: ${track.name} - ${err}`);
                    await MarkDownloadItemFailed(itemID, err instanceof Error ? err.message : String(err));
                }
                flushProgress();
            },
            { getAbort: () => shouldStopDownloadRef.current }
        );
        flushProgress();
        setDownloadingTrack(null);
        setCurrentDownloadInfo(null);
        setIsDownloading(false);
        setBulkDownloadType(null);
        const wasStopped = shouldStopDownloadRef.current;
        shouldStopDownloadRef.current = false;
        const { CancelAllQueuedItems } = await import("../../wailsjs/go/main/App");
        await CancelAllQueuedItems();
        const { successCount, errorCount, skippedCount } = batchState;
        if (wasStopped) {
            toast.info(`Download stopped. ${successCount} tracks downloaded, ${Math.max(0, tracksToDownload.length - successCount - errorCount)} remaining.`);
        }
        logger.info(`batch complete: ${successCount} downloaded, ${skippedCount} skipped, ${errorCount} failed`);
        if (errorCount === 0 && skippedCount === 0) {
            toast.success(`Downloaded ${successCount} tracks successfully`);
        }
        else if (errorCount === 0 && successCount === 0) {
            toast.info(`${skippedCount} tracks already exist`);
        }
        else if (errorCount === 0) {
            toast.info(`${successCount} downloaded, ${skippedCount} skipped`);
        }
        else {
            const parts = [];
            if (successCount > 0)
                parts.push(`${successCount} downloaded`);
            if (skippedCount > 0)
                parts.push(`${skippedCount} skipped`);
            parts.push(`${errorCount} failed`);
            toast.warning(parts.join(", "));
        }
    };
    const handleDownloadAll = async (tracks: TrackMetadata[], folderName?: string, isAlbum?: boolean) => {
        const tracksWithIsrc = tracks.filter((track) => track.isrc);
        if (tracksWithIsrc.length === 0) {
            toast.error("No tracks available for download");
            return;
        }
        logger.info(`starting batch download: ${tracksWithIsrc.length} tracks`);
        const settings = getSettings();
        setIsDownloading(true);
        setBulkDownloadType("all");
        setDownloadProgress(0);
        // Do not create a playlist-named folder; check existence in entire music directory
        logger.info(`checking existing files in parallel...`);
        const useAlbumTrackNumber = settings.folderTemplate?.includes("{album}") || false;
        const audioFormat = "flac";
        const existenceChecks = tracksWithIsrc.map((track, index) => {
            return {
                spotify_id: track.spotify_id || track.isrc,
                track_name: track.name || "",
                artist_name: track.artists || "",
                album_name: track.album_name || "",
                album_artist: track.album_artist || "",
                release_date: track.release_date || "",
                track_number: track.track_number || 0,
                disc_number: track.disc_number || 0,
                position: index + 1,
                use_album_track_number: useAlbumTrackNumber,
                filename_format: settings.filenameTemplate || "",
                include_track_number: settings.trackNumber || false,
                audio_format: audioFormat,
            };
        });
        const existenceResults = await CheckFilesExistenceInMusicDir(settings.downloadPath, existenceChecks);
        const existingSpotifyIDs = new Set<string>();
        const existingFilePaths = new Map<string, string>();
        for (const result of existenceResults) {
            if (result.exists) {
                existingSpotifyIDs.add(result.spotify_id);
                existingFilePaths.set(result.spotify_id, result.file_path || "");
            }
        }
        logger.info(`found ${existingSpotifyIDs.size} existing files`);
        const { AddToDownloadQueue } = await import("../../wailsjs/go/main/App");
        const itemIDs: string[] = [];
        for (const track of tracksWithIsrc) {
            const itemID = await AddToDownloadQueue(track.isrc, track.name, track.artists, track.album_name || "");
            itemIDs.push(itemID);
            const trackID = track.spotify_id || track.isrc;
            if (existingSpotifyIDs.has(trackID)) {
                const filePath = existingFilePaths.get(trackID) || "";
                setTimeout(() => SkipDownloadItem(itemID, filePath), 10);
                setSkippedTracks((prev) => new Set(prev).add(track.isrc));
                setDownloadedTracks((prev) => new Set(prev).add(track.isrc));
            }
        }
        const tracksToDownload = tracksWithIsrc.filter((track) => {
            const trackID = track.spotify_id || track.isrc;
            return !existingSpotifyIDs.has(trackID);
        });
        const total = tracksWithIsrc.length;
        const initialSkippedIsrcs = tracksWithIsrc.filter((t) => existingSpotifyIDs.has(t.spotify_id ?? t.isrc)).map((t) => t.isrc);
        const batchState = {
            successCount: 0,
            errorCount: 0,
            skippedCount: existingSpotifyIDs.size,
            downloaded: new Set<string>(initialSkippedIsrcs),
            failed: new Set<string>(),
            skipped: new Set<string>(initialSkippedIsrcs),
        };
        const flushProgress = createThrottledUpdater(PROGRESS_UPDATE_THROTTLE_MS, () => {
            const completed = batchState.skippedCount + batchState.successCount + batchState.errorCount;
            setDownloadProgress(Math.min(100, Math.round((completed / total) * 100)));
            setDownloadedTracks(new Set(batchState.downloaded));
            setFailedTracks(new Set(batchState.failed));
            setSkippedTracks(new Set(batchState.skipped));
        });
        setDownloadingTrack(null);
        setCurrentDownloadInfo({ name: "Multiple tracks", artists: "" });
        const items = tracksToDownload.map((track) => {
            const originalIndex = tracksWithIsrc.findIndex((t) => t.isrc === track.isrc);
            return { track, itemID: itemIDs[originalIndex], originalIndex: originalIndex + 1 };
        });
        const { MarkDownloadItemFailed } = await import("../../wailsjs/go/main/App");
        await runWithConcurrency(
            items,
            CONCURRENT_DOWNLOADS,
            async ({ track, itemID, originalIndex }) => {
                if (shouldStopDownloadRef.current) return;
                try {
                    const releaseYear = track.release_date?.substring(0, 4);
                    const response = await downloadWithItemID(track.isrc, settings, itemID, track.name, track.artists, track.album_name, folderName, originalIndex, track.spotify_id, track.duration_ms, isAlbum, releaseYear, track.album_artist || "", track.release_date, track.images, track.track_number, track.disc_number, track.total_tracks, track.total_discs, track.copyright, track.publisher);
                    if (response.success) {
                        if (response.already_exists) {
                            batchState.skippedCount++;
                            batchState.skipped.add(track.isrc);
                            logger.info(`skipped: ${track.name} - ${track.artists} (already exists)`);
                        } else {
                            batchState.successCount++;
                            logger.success(`downloaded: ${track.name} - ${track.artists}`);
                        }
                        batchState.downloaded.add(track.isrc);
                        batchState.failed.delete(track.isrc);
                    } else {
                        batchState.errorCount++;
                        batchState.failed.add(track.isrc);
                        logger.error(`failed: ${track.name} - ${track.artists}`);
                    }
                } catch (err) {
                    batchState.errorCount++;
                    batchState.failed.add(track.isrc);
                    logger.error(`error: ${track.name} - ${err}`);
                    await MarkDownloadItemFailed(itemID, err instanceof Error ? err.message : String(err));
                }
                flushProgress();
            },
            { getAbort: () => shouldStopDownloadRef.current }
        );
        flushProgress();
        setDownloadingTrack(null);
        setCurrentDownloadInfo(null);
        setIsDownloading(false);
        setBulkDownloadType(null);
        const wasStopped = shouldStopDownloadRef.current;
        shouldStopDownloadRef.current = false;
        const { CancelAllQueuedItems: CancelQueued } = await import("../../wailsjs/go/main/App");
        await CancelQueued();
        const { successCount, errorCount, skippedCount } = batchState;
        if (wasStopped) {
            toast.info(`Download stopped. ${successCount} tracks downloaded, ${Math.max(0, tracksToDownload.length - successCount - errorCount)} remaining.`);
        }
        logger.info(`batch complete: ${successCount} downloaded, ${skippedCount} skipped, ${errorCount} failed`);
        if (errorCount === 0 && skippedCount === 0) {
            toast.success(`Downloaded ${successCount} tracks successfully`);
        }
        else if (errorCount === 0 && successCount === 0) {
            toast.info(`${skippedCount} tracks already exist`);
        }
        else if (errorCount === 0) {
            toast.info(`${successCount} downloaded, ${skippedCount} skipped`);
        }
        else {
            const parts = [];
            if (successCount > 0)
                parts.push(`${successCount} downloaded`);
            if (skippedCount > 0)
                parts.push(`${skippedCount} skipped`);
            parts.push(`${errorCount} failed`);
            toast.warning(parts.join(", "));
        }
    };
    const handleStopDownload = () => {
        logger.info("download stopped by user");
        shouldStopDownloadRef.current = true;
        toast.info("Stopping download...");
    };
    const resetDownloadedTracks = () => {
        setDownloadedTracks(new Set());
        setFailedTracks(new Set());
        setSkippedTracks(new Set());
    };
    return {
        downloadProgress,
        isDownloading,
        downloadingTrack,
        bulkDownloadType,
        downloadedTracks,
        failedTracks,
        skippedTracks,
        currentDownloadInfo,
        handleDownloadTrack,
        handleDownloadSelected,
        handleDownloadAll,
        handleStopDownload,
        resetDownloadedTracks,
    };
}
