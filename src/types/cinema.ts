export interface MovieCardItem {
  id: string;
  title: string;
  url: string;
  path: string;
  poster: string;
  quality: string;
  views: string;
  language: string;
  typeBadge: 'MOVIE' | 'SERIES' | 'ANIME' | 'DRAMA';
  timeAgo: string;
  episodePill: string;
  isPinned: boolean;
  isAdult: boolean;
  folder?: WatchlistFolder;
  rating?: string;
  hypeScore?: number;
  isHot?: boolean;
  isDhamaka?: boolean;
  hypeBadge?: string;
  uploadedAtMs?: number;
}

export type WatchlistFolder = 'favorites' | 'watch_later' | 'anime_series';

export interface StreamSource {
  id: string;
  quality: number;
  qualityLabel: string;
  audio: string;
  audioLanguages: string[];
  provider: string;
  url: string;
  downloadUrl: string;
  type: string;
  name: string;
  screenshot?: string;
}

export interface EpisodeItem {
  id: string;
  label: string;
  number: number | null;
  rangeStart?: number | null;
  rangeEnd?: number | null;
  season: number | null;
  kind: string;
  sources: StreamSource[];
}

export interface DirectDownloadButton {
  label: string;
  url: string;
  quality: string;
  size: string;
}

export interface CastMember {
  name: string;
  role: string;
  photo: string;
  url: string;
}

export interface MovieDetailData {
  title: string;
  url: string;
  poster: string;
  backdrop?: string;
  qualityNote: string;
  typeBadge: string;
  language: string;
  quality: string;
  genre: string;
  resolution: string;
  releaseDate: string;
  storyline: string;
  youtubeTrailerId: string;
  screenshots: string[];
  episodes: EpisodeItem[];
  downloadButtons: DirectDownloadButton[];
  cast: CastMember[];
  relatedSeasons?: MovieCardItem[];
  communityScore?: {
    recommendedPercent: number;
    totalVotes: number;
    verdict: string;
  };
}

export interface CategoryOption {
  label: string;
  bnLabel: string;
  path: string;
  group: 'zone' | 'language' | 'genre' | 'collection';
  isAdult?: boolean;
}

export interface WatchProgressItem {
  movie: MovieCardItem;
  episodeId?: string;
  episodeIdx?: number;
  episodeLabel?: string;
  quality?: number;
  audio?: string;
  updatedAt: number;
  progressSeconds?: number;
  durationSeconds?: number;
}

export interface ServerNodeStatus {
  id: string;
  name: string;
  region: string;
  latencyMs: number;
  online: boolean;
}

export interface UserMovieRequest {
  id: string;
  title: string;
  type: 'MOVIE' | 'SERIES' | 'ANIME' | 'BROKEN_LINK';
  language: string;
  notes: string;
  status: 'Queued' | 'Processing';
  createdAt: number;
}
