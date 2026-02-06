import {
  Search,
  TrendingUp,
  FileMusic,
  Activity,
  FolderOpen,
  Settings,
  Download,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PageType } from "./Sidebar";

interface DashboardProps {
  onNavigate: (page: PageType) => void;
  onFocusSearch: () => void;
}

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  gradient: string;
  badge?: string;
}

function FeatureCard({
  icon,
  title,
  description,
  onClick,
  gradient,
  badge,
}: FeatureCardProps) {
  return (
    <button
      onClick={onClick}
      className={`group relative p-6 rounded-xl border bg-card hover:bg-muted/50 transition-all duration-200 text-left overflow-hidden hover:scale-[1.02] hover:shadow-lg`}
    >
      <div
        className={`absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 ${gradient}`}
      />
      <div className="relative z-10">
        <div className="flex items-start justify-between mb-3">
          <div className="p-2.5 rounded-lg bg-primary/10 text-primary group-hover:bg-primary/20 transition-colors">
            {icon}
          </div>
          {badge && (
            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary">
              {badge}
            </span>
          )}
        </div>
        <h3 className="font-semibold text-base mb-1.5">{title}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {description}
        </p>
      </div>
    </button>
  );
}

export function Dashboard({ onNavigate, onFocusSearch }: DashboardProps) {
  const features: (FeatureCardProps & { key: string })[] = [
    {
      key: "search",
      icon: <Search className="h-5 w-5" />,
      title: "Fetch Metadata",
      description:
        "Search Spotify for tracks, albums, artists, or playlists and download in FLAC quality",
      onClick: onFocusSearch,
      gradient: "bg-gradient-to-br from-green-500/5 to-emerald-500/10",
      badge: "Primary",
    },
    {
      key: "quality-upgrade",
      icon: <TrendingUp className="h-5 w-5" />,
      title: "Quality Upgrade",
      description:
        "Scan your music library and find higher quality versions of your existing tracks",
      onClick: () => onNavigate("quality-upgrade"),
      gradient: "bg-gradient-to-br from-blue-500/5 to-indigo-500/10",
      badge: "Popular",
    },
    {
      key: "file-manager",
      icon: <FolderOpen className="h-5 w-5" />,
      title: "File Manager",
      description:
        "Rename, organize, fetch lyrics, and manage your audio files with batch operations",
      onClick: () => onNavigate("file-manager"),
      gradient: "bg-gradient-to-br from-purple-500/5 to-violet-500/10",
    },
    {
      key: "audio-analysis",
      icon: <Activity className="h-5 w-5" />,
      title: "Audio Analyzer",
      description:
        "Analyze audio quality with spectrograms and bitrate detection to verify true quality",
      onClick: () => onNavigate("audio-analysis"),
      gradient: "bg-gradient-to-br from-orange-500/5 to-amber-500/10",
    },
    {
      key: "audio-converter",
      icon: <FileMusic className="h-5 w-5" />,
      title: "Audio Converter",
      description:
        "Convert audio files between formats like FLAC, MP3, M4A, OGG, and more",
      onClick: () => onNavigate("audio-converter"),
      gradient: "bg-gradient-to-br from-pink-500/5 to-rose-500/10",
    },
    {
      key: "settings",
      icon: <Settings className="h-5 w-5" />,
      title: "Settings",
      description:
        "Configure download options, output formats, naming templates, and preferences",
      onClick: () => onNavigate("settings"),
      gradient: "bg-gradient-to-br from-slate-500/5 to-gray-500/10",
    },
  ];

  return (
    <div className="space-y-8">
      {/* Hero Section */}
      <div className="text-center space-y-4 py-6">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Sparkles className="h-6 w-6 text-primary" />
          <h1 className="text-3xl font-bold tracking-tight">
            Welcome to SpotiFLAC
          </h1>
        </div>
        <p className="text-muted-foreground max-w-lg mx-auto">
          Download high-quality FLAC music from Spotify, Tidal, Amazon Music,
          and Qobuz. Manage, analyze, and upgrade your music library.
        </p>
      </div>

      {/* Quick Search */}
      <div className="flex justify-center">
        <Button
          size="lg"
          onClick={onFocusSearch}
          className="gap-2 px-8 shadow-lg hover:shadow-xl transition-shadow"
        >
          <Search className="h-5 w-5" />
          Search Spotify
          <kbd className="ml-2 text-xs bg-primary-foreground/20 px-1.5 py-0.5 rounded">
            ↵
          </kbd>
        </Button>
      </div>

      {/* Feature Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {features.map((feature) => (
          <FeatureCard
            key={feature.key}
            icon={feature.icon}
            title={feature.title}
            description={feature.description}
            onClick={feature.onClick}
            gradient={feature.gradient}
            badge={feature.badge}
          />
        ))}
      </div>

      {/* Quick Tips */}
      <div className="mt-8 p-4 rounded-lg bg-muted/50 border">
        <div className="flex items-start gap-3">
          <Download className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
          <div>
            <h4 className="font-medium text-sm mb-1">Quick Tip</h4>
            <p className="text-sm text-muted-foreground">
              Paste any Spotify link in the search bar to instantly fetch
              metadata. Supports tracks, albums, playlists, and artist pages.
              The app will automatically detect which services have the track in
              FLAC quality.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
