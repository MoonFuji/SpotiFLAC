import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  ExternalLink,
  X,
  Music2,
  Disc3,
  ListMusic,
  UserRound,
  Search,
  Bookmark,
} from "lucide-react";
import type { ForLaterItem } from "@/types/for-later";
import { openInSpotify, openExternal } from "@/lib/utils";

interface ForLaterPageProps {
  items: ForLaterItem[];
  onRemove: (id: string) => void;
  onOpen: (item: ForLaterItem) => void;
}

export function ForLaterPage({
  items,
  onRemove,
  onOpen,
}: ForLaterPageProps) {
  const getTypeIcon = (type: string) => {
    switch (type) {
      case "track":
        return Music2;
      case "album":
        return Disc3;
      case "playlist":
        return ListMusic;
      case "artist":
        return UserRound;
      case "search":
        return Search;
      default:
        return null;
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case "track":
        return "Track";
      case "album":
        return "Album";
      case "playlist":
        return "Playlist";
      case "artist":
        return "Artist";
      case "search":
        return "Search";
      default:
        return type;
    }
  };

  const getSourceBadge = (source: string) => {
    if (source === "quality-upgrade") {
      return (
        <Badge variant="outline" className="text-xs">
          From Quality Upgrade
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="text-xs">
        From Fetch
      </Badge>
    );
  };

  const handleOpenInSpotify = (item: ForLaterItem) => {
    if (item.spotifyUrl) {
      // Extract track ID from URL if it's a track URL
      const trackMatch = item.spotifyUrl.match(/\/track\/([a-zA-Z0-9]+)/);
      if (trackMatch && item.type === "track") {
        openInSpotify(trackMatch[1], item.spotifyUrl);
      } else {
        // For album/playlist/artist, just open the URL
        openExternal(item.spotifyUrl);
      }
    }
  };

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16">
          <Bookmark className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold mb-2">Nothing saved for later</h3>
          <p className="text-sm text-muted-foreground text-center max-w-md">
            Add tracks from Fetch or Quality Upgrade when you're on mobile data.
            They'll appear here so you can download them later when you're on WiFi.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">For Later</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {items.length} {items.length === 1 ? "item" : "items"} saved
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {items.map((item) => {
          const TypeIcon = getTypeIcon(item.type);
          return (
            <Card key={item.id} className="hover:bg-accent/50 transition-colors">
              <CardContent className="p-4">
                <div className="flex items-start gap-4">
                  {/* Thumbnail */}
                  <div className="shrink-0">
                    {item.image ? (
                      <div className="w-16 h-16 rounded-md overflow-hidden bg-muted">
                        <img
                          src={item.image}
                          alt={item.label}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    ) : (
                      <div className="w-16 h-16 rounded-md bg-muted flex items-center justify-center">
                        {TypeIcon ? (
                          <TypeIcon className="h-8 w-8 text-muted-foreground" />
                        ) : (
                          <Bookmark className="h-8 w-8 text-muted-foreground" />
                        )}
                      </div>
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium truncate" title={item.label}>
                          {item.label}
                        </h3>
                        {item.sublabel && (
                          <p className="text-sm text-muted-foreground truncate" title={item.sublabel}>
                            {item.sublabel}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap mt-2">
                      {getSourceBadge(item.source)}
                      {TypeIcon && (
                        <Badge variant="outline" className="text-xs">
                          <TypeIcon className="h-3 w-3 mr-1" />
                          {getTypeLabel(item.type)}
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {new Date(item.addedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          onClick={() => onOpen(item)}
                          variant="default"
                        >
                          Open
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        Open in SpotiFLAC Fetch to download
                      </TooltipContent>
                    </Tooltip>

                    {item.spotifyUrl && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleOpenInSpotify(item)}
                          >
                            <ExternalLink className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          Open in Spotify to check version
                        </TooltipContent>
                      </Tooltip>
                    )}

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onRemove(item.id)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Remove from list</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
