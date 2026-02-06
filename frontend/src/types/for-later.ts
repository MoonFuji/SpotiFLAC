export interface ForLaterItem {
  id: string;
  addedAt: number;
  label: string;
  sublabel?: string;
  image?: string;
  spotifyUrl?: string;
  searchQuery?: string;
  type: "track" | "album" | "playlist" | "artist" | "search";
  source: "fetch" | "quality-upgrade";
  filePath?: string;
}
