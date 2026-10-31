import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Crown,
  Download,
  FastForward,
  FileText,
  Film,
  Flame,
  HelpCircle,
  Layers,
  ListPlus,
  ListVideo,
  Loader2,
  Lock,
  Maximize,
  Maximize2,
  Minimize,
  Minimize2,
  Monitor,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Search,
  Share2,
  Smartphone,
  Star,
  Subtitles,
  Sun,
  Tv,
  Unlock,
  Volume2,
  VolumeX,
  Wifi,
  X,
} from 'lucide-react';
import { normalizeMovieCardItem } from '../utils/timeAgo';
import type {
  EpisodeItem,
  MovieCardItem,
  MovieDetailData,
  StreamSource,
  WatchlistFolder,
  WatchProgressItem,
} from '../types/cinema';
import {
  getInstantCachedDetail,
  prefetchMovieDetails,
  setVideoStartupPriority,
  stopBackgroundWarmVideo,
  universalApiFetch,
  warmStreamConnection,
} from '../services/liveClientEngine';
import Hls from 'hls.js';
import { IosMkvStreamController } from '../services/mkvIosClientRemuxer';
import {
  buildVttFromCues,
  ensureBanglaTranslationAroundTime,
  fetchOrGenerateAutoBanglaSubtitles,
  findActiveCueTextAtTime,
  loadSubtitleTrackByUrl,
  parseSrtOrVttToCues,
  translateLinesToBangla,
  type AvailableSubtitleTrack,
  type SubtitleCue,
} from '../services/autoBanglaSubtitleEngine';

interface MovieDetailModalProps {
  movie: MovieCardItem | null;
  relatedMovies: MovieCardItem[];
  activeNodeId: string;
  savedProgress?: WatchProgressItem;
  isMiniPlayer?: boolean;
  onToggleMiniPlayer?: (mini: boolean) => void;
  onClose: () => void;
  onSelectMovie: (movie: MovieCardItem) => void;
  isInWatchlist: boolean;
  currentFolder?: WatchlistFolder;
  onToggleWatchlist: (movie: MovieCardItem, folder?: WatchlistFolder) => void;
  onRecordWatchProgress: (
    movie: MovieCardItem,
    episode?: EpisodeItem,
    episodeIdx?: number,
    source?: StreamSource,
    seconds?: number,
    duration?: number
  ) => void;
  onSearchByActor: (actorName: string) => void;
  onOpenReportModal: (prefillTitle: string) => void;
}

const INTRO_SKIP_STORAGE_KEY = 'cp_intro_skip_sec_v3';
const AUTO_NEXT_STORAGE_KEY = 'cp_auto_next_ep_v1';
const BRIGHTNESS_STORAGE_KEY = 'cp_player_brightness_v1';
const AUTO_NET_STORAGE_KEY = 'cp_auto_net_quality_v1';

function formatSeconds(sec: number): string {
  if (!sec || sec < 0 || !isFinite(sec)) return '00:00';
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(s).padStart(s < 10 ? 2 : 2, '0')}`;
}

function formatEpisodeTileBadge(ep: EpisodeItem, fallbackIdx: number): string {
  if (ep.id === 'movie-special' || ep.number === 0) return 'Movie';
  const start = ep.rangeStart ?? ep.number;
  const end = ep.rangeEnd ?? ep.number;
  if (start !== null && start !== undefined) {
    const startPad = String(start).padStart(2, '0');
    if (end !== null && end !== undefined && end > start) {
      const endPad = String(end).padStart(2, '0');
      return `${startPad}-${endPad}`;
    }
    return startPad;
  }
  return String(fallbackIdx + 1).padStart(2, '0');
}

function detectIdealQualityForNetwork(): { targetQuality: number; netLabel: string } {
  try {
    const nav = navigator as any;
    const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
    if (conn) {
      const eff = String(conn.effectiveType || '').toLowerCase();
      const down = Number(conn.downlink || 0);
      const saveData = Boolean(conn.saveData);
      if (saveData || eff === '2g' || eff === 'slow-2g' || eff === '3g' || (down > 0 && down < 4)) {
        return {
          targetQuality: 480,
          netLabel: down > 0 ? `Instant Start (${down}Mbps) · 480p` : 'Instant Start · 480p',
        };
      }
      if (down >= 12) {
        return { targetQuality: 1080, netLabel: `Turbo Auto (${down}Mbps) · 480p→1080p` };
      }
      if (down > 0) {
        return { targetQuality: 720, netLabel: `Turbo Auto (${down}Mbps) · 480p→720p` };
      }
    }
  } catch {
    // ignore
  }
  return { targetQuality: 720, netLabel: 'Turbo Auto · 480p→HD' };
}

/**
 * Instant-Start Source Selector:
 * When opening any movie or episode in Auto mode, ALWAYS pick the lowest bitrate H.264 stream
 * (480p / 360p, or lightweight 720p WEB-DL) first so the video starts playing in < 0.2s without buffering!
 * Once playing smoothly with healthy buffer, the Standby Preloader upgrades to 720p/1080p seamlessly.
 */
function pickBestSourceIndexForNet(sources: StreamSource[], autoNet: boolean): number {
  if (!sources || sources.length === 0) return 0;
  // If Server #1 is explicitly an Abyss/HLS instant stream placed at index 0, honor it immediately
  if (sources[0]?.type === 'embed' || /abyssplayer\.com|\.m3u8(\?|$)/i.test(sources[0]?.url || '')) {
    return 0;
  }
  const isLightweightH264 = (s: StreamSource) =>
    s.type !== 'embed' &&
    !/\b(hevc|h\.?265|x265|10bit|av1)\b/i.test(`${s.name} ${s.qualityLabel}`) &&
    !/best\s*quality/i.test(s.qualityLabel || '');
  const isAnyH264 = (s: StreamSource) =>
    !/\b(hevc|h\.?265|x265|10bit|av1)\b/i.test(`${s.name} ${s.qualityLabel}`);

  if (!autoNet) {
    const firstH264 = sources.findIndex((s) => isLightweightH264(s));
    if (firstH264 !== -1) return firstH264;
    const fallbackH264 = sources.findIndex((s) => isAnyH264(s));
    return fallbackH264 !== -1 ? fallbackH264 : 0;
  }

  // 1. ALWAYS prefer 480p (360p..576p) H.264 first for 0-delay instant start!
  const h480 = sources.findIndex(
    (s) => isLightweightH264(s) && s.quality >= 360 && s.quality <= 576
  );
  if (h480 !== -1) return h480;

  // 2. Fallback to lightweight 720p H.264 (excluding multi-GB "Best Quality" files)
  const h720 = sources.findIndex((s) => isLightweightH264(s) && s.quality === 720);
  if (h720 !== -1) return h720;

  // 3. Fallback to any lightweight H.264 stream
  const anyLightH264 = sources.findIndex((s) => isLightweightH264(s));
  if (anyLightH264 !== -1) return anyLightH264;

  // 4. Fallback to any H.264 or embed source
  const anyH264 = sources.findIndex((s) => isAnyH264(s));
  return anyH264 !== -1 ? anyH264 : 0;
}

/**
 * Finds the next step-up H.264 resolution (e.g. 480p -> 720p -> 1080p) for progressive smooth upgrade.
 */
function pickNextUpgradeSourceIndex(
  sources: StreamSource[],
  currentQuality: number,
  maxTargetQuality: number,
  failedIndices: number[]
): number {
  if (!sources || sources.length <= 1 || currentQuality >= maxTargetQuality) return -1;
  const isLightweightH264 = (s: StreamSource) =>
    !/\b(hevc|h\.?265|x265|10bit|av1)\b/i.test(`${s.name} ${s.qualityLabel}`) &&
    !/best\s*quality/i.test(s.qualityLabel || '') &&
    s.type !== 'embed';

  // Step 1: If currently <= 576p (480p), look for 720p first
  if (currentQuality <= 576 && maxTargetQuality >= 720) {
    const idx720 = sources.findIndex(
      (s, idx) => !failedIndices.includes(idx) && isLightweightH264(s) && s.quality === 720
    );
    if (idx720 !== -1) return idx720;
  }

  // Step 2: If currently <= 720p and network supports 1080p, look for 1080p
  if (currentQuality <= 720 && maxTargetQuality >= 1080) {
    const idx1080 = sources.findIndex(
      (s, idx) => !failedIndices.includes(idx) && isLightweightH264(s) && s.quality === 1080
    );
    if (idx1080 !== -1) return idx1080;
  }

  return -1;
}

function convertSrtToVtt(srtContent: string): string {
  const normalized = srtContent
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  if (normalized.trim().startsWith('WEBVTT')) {
    return normalized;
  }
  return `WEBVTT\n\n${normalized}`;
}

function toGatewayAbsoluteUrl(downloadOrStreamUrl: string): string {
  if (!downloadOrStreamUrl) return '';
  if (downloadOrStreamUrl.startsWith('/api/go')) {
    return `${window.location.origin}${downloadOrStreamUrl}`;
  }
  return downloadOrStreamUrl;
}

function isAppleWebKitDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIOS =
    /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR|Android/i.test(ua);
  return isIOS || isSafari;
}

export const MovieDetailModal: React.FC<MovieDetailModalProps> = ({
  movie,
  relatedMovies,
  activeNodeId,
  savedProgress,
  isMiniPlayer = false,
  onToggleMiniPlayer,
  onClose,
  onSelectMovie,
  isInWatchlist,
  currentFolder = 'favorites',
  onToggleWatchlist,
  onRecordWatchProgress,
  onSearchByActor,
  onOpenReportModal,
}) => {
  // Synchronous 0ms detail lookup on Render #1 so <video> mounts immediately inside the user's tap gesture!
  const instantDetailOnRender = useMemo(() => {
    if (!movie) return null;
    return getInstantCachedDetail(movie.path || movie.url, movie.title);
  }, [movie?.path, movie?.url, movie?.title]);

  const [detail, setDetail] = useState<MovieDetailData | null>(() => instantDetailOnRender);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedEpIdx, setSelectedEpIdx] = useState(() => {
    const eps = instantDetailOnRender?.episodes || [];
    return savedProgress?.episodeIdx !== undefined && eps[savedProgress.episodeIdx]
      ? savedProgress.episodeIdx
      : 0;
  });
  const [selectedSourceIdx, setSelectedSourceIdx] = useState(() => {
    const eps = instantDetailOnRender?.episodes || [];
    const initEp =
      savedProgress?.episodeIdx !== undefined && eps[savedProgress.episodeIdx]
        ? eps[savedProgress.episodeIdx]
        : eps[0];
    return pickBestSourceIndexForNet(initEp?.sources || [], true);
  });
  const [selectedSeasonFilter, setSelectedSeasonFilter] = useState<number | 'all'>('all');
  const [episodeSearchQuery, setEpisodeSearchQuery] = useState('');
  const [episodeSortOrder, setEpisodeSortOrder] = useState<'asc' | 'desc'>('asc');
  const [failedSourceIndices, setFailedSourceIndices] = useState<number[]>([]);
  const [showAllEpisodesModal, setShowAllEpisodesModal] = useState(false);
  const [showDownloadSheet, setShowDownloadSheet] = useState(false);
  const [bottomTab, setBottomTab] = useState<'forYou' | 'infoCast' | 'reviews'>('forYou');

  // MovieBox Audience Reviews & Star Rating State (100% Ad-Free Local Persistence)
  const [userRatingStars, setUserRatingStars] = useState<number>(5);
  const [userReviewName, setUserReviewName] = useState<string>('');
  const [userReviewText, setUserReviewText] = useState<string>('');
  const [customReviewsMap, setCustomReviewsMap] = useState<
    Record<string, Array<{ id: string; author: string; stars: number; text: string; date: string }>>
  >(() => {
    try {
      const raw = localStorage.getItem('cp_moviebox_reviews_v1');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  // Network-Adaptive Quality Mode (ON by default)
  const [autoNetQuality, setAutoNetQuality] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTO_NET_STORAGE_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const [netStatusLabel, setNetStatusLabel] = useState<string>(() => {
    return detectIdealQualityForNetwork().netLabel;
  });
  const [showQualityMenu, setShowQualityMenu] = useState<boolean>(false);
  const [showAudioServerMenu, setShowAudioServerMenu] = useState<boolean>(false);
  const [showSleepMenu, setShowSleepMenu] = useState<boolean>(false);
  const [sleepTimerMode, setSleepTimerMode] = useState<number | 'end_of_ep' | null>(null);
  const [sleepRemainingSec, setSleepRemainingSec] = useState<number | null>(null);
  const [seekRipple, setSeekRipple] = useState<{
    side: 'left' | 'right';
    delta: number;
    id: number;
  } | null>(null);
  const [scrubPreview, setScrubPreview] = useState<{ sec: number; percent: number } | null>(null);
  const [nextEpPrewarmed, setNextEpPrewarmed] = useState<boolean>(false);

  const [playerMode, setPlayerMode] = useState<'stream' | 'trailer'>('stream');
  const [videoError, setVideoError] = useState(false);
  // Use Turbo Micro-Chunk MP4 Remuxer (700KB Instant Start + Exact Cues Seek) on ALL devices (Android, iPhone, Desktop)
  // so 300MB-1.5GB .mkv files start in < 0.3s at 12s without buffering at 00:00, with automatic native fallback if needed!
  const [useHlsBridge, setUseHlsBridge] = useState<boolean>(true);
  const [iosBlobUrl, setIosBlobUrl] = useState<string>('');
  const [iosSegmentStartSec, setIosSegmentStartSec] = useState<number>(0);
  const [iosCurrentSegIndex, setIosCurrentSegIndex] = useState<number>(0);
  const iosControllerRef = useRef<IosMkvStreamController | null>(null);
  const iosTransitioningRef = useRef<boolean>(false);
  const hlsInstanceRef = useRef<Hls | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [hasStartedPlayback, setHasStartedPlayback] = useState(false);
  const [standbyUpgradeIdx, setStandbyUpgradeIdx] = useState<number | null>(null);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [isHold2x, setIsHold2x] = useState(false);
  const [videoFit, setVideoFit] = useState<'contain' | 'cover' | 'fill'>('contain');
  const [isScreenLocked, setIsScreenLocked] = useState(false);
  const [showOverlayControls, setShowOverlayControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isLandscapeMode, setIsLandscapeMode] = useState(false);
  const [isViewportPortrait, setIsViewportPortrait] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerHeight >= window.innerWidth : true
  );
  const [viewportDims, setViewportDims] = useState<{ width: number; height: number }>(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 390,
    height: typeof window !== 'undefined' ? window.innerHeight : 844,
  }));

  // MovieBox Screen Brightness (20% to 160%) & Volume (0% to 100%)
  const [brightness, setBrightness] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(BRIGHTNESS_STORAGE_KEY));
      return saved >= 20 && saved <= 160 ? saved : 100;
    } catch {
      return 100;
    }
  });
  const [showBrightnessPanel, setShowBrightnessPanel] = useState(false);
  const [volume, setVolume] = useState<number>(100);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [autoMutedForiOS, setAutoMutedForiOS] = useState<boolean>(false);

  // Gesture HUD Indicator (Brightness / Volume / Seek feedback)
  const [hudNotice, setHudNotice] = useState<{
    type: 'brightness' | 'volume' | 'seek' | 'toast';
    label: string;
    percent?: number;
  } | null>(null);

  const [copiedShare, setCopiedShare] = useState(false);
  const [copiedBatch, setCopiedBatch] = useState(false);

  // Intro Voice-Tag Blocker & Skipper (Default 12s so upstream "this video..." audio tag is 100% muted & skipped!)
  const [introSkipSec, setIntroSkipSec] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(INTRO_SKIP_STORAGE_KEY);
      if (saved !== null) {
        const num = Number(saved);
        return num >= 0 ? num : 12;
      }
      return 12;
    } catch {
      return 12;
    }
  });

  // Auto-Play Next Episode
  const [autoNextEp, setAutoNextEp] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTO_NEXT_STORAGE_KEY) !== '0';
    } catch {
      return true;
    }
  });

  const [resumedBannerSec, setResumedBannerSec] = useState<number | null>(null);

  // Auto Bangla Subtitle & Custom Subtitle (.SRT / .VTT) State (ON by default!)
  const [autoBanglaSubEnabled, setAutoBanglaSubEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem('cp_auto_bangla_sub_v1') !== '0';
    } catch {
      return true;
    }
  });
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [loadingAutoSub, setLoadingAutoSub] = useState<boolean>(false);
  const [subFontSize, setSubFontSize] = useState<'sm' | 'md' | 'lg'>('sm');
  const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);
  const [subtitleName, setSubtitleName] = useState<string>('');
  const [availableSubTracks, setAvailableSubTracks] = useState<AvailableSubtitleTrack[]>([]);
  const [activeSubTrackIdx, setActiveSubTrackIdx] = useState<number>(0);
  const [subOffsetSec, setSubOffsetSec] = useState<number>(0);
  const [showSubSyncPanel, setShowSubSyncPanel] = useState<boolean>(false);
  const [customSubSearchQuery, setCustomSubSearchQuery] = useState<string>('');
  const [activeBanglaCueText, setActiveBanglaCueText] = useState<string>('');
  const lastRenderedSubTextRef = useRef<string>('');
  const subtitleInputRef = useRef<HTMLInputElement | null>(null);

  const modalContainerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const preloadVideoRef = useRef<HTMLVideoElement | null>(null);
  const playerStageRef = useRef<HTMLDivElement | null>(null);
  const overlayTimerRef = useRef<number | null>(null);
  const hudTimerRef = useRef<number | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const rippleTimerRef = useRef<number | null>(null);
  const prewarmedNextEpIdxRef = useRef<number | null>(null);
  const stallDownshiftTimerRef = useRef<number | null>(null);
  const startupWatchdogTimerRef = useRef<number | null>(null);
  const standbyTimeoutRef = useRef<number | null>(null);
  const smoothPlaySecondsRef = useRef<number>(0);
  const hasStalledInSessionRef = useRef<boolean>(false);
  const lastTapRef = useRef<{ time: number; side: 'left' | 'right' | 'center' }>({
    time: 0,
    side: 'center',
  });
  const touchGestureRef = useRef<{
    active: boolean;
    side: 'left' | 'right';
    startX: number;
    startY: number;
    startVal: number;
    moved: boolean;
  } | null>(null);
  const lastRecordedSecondRef = useRef<number>(-1);
  const pendingResumeSecRef = useRef<number | null>(null);
  const hasAppliedIntroSkipRef = useRef<boolean>(false);

  // Floating Mini-Player Position & Resizable Width State
  const [miniWidth, setMiniWidth] = useState<number>(250);
  const [miniPos, setMiniPos] = useState<{ x: number; y: number } | null>(null);
  const lastMiniTapTimeRef = useRef<number>(0);
  const miniDragRef = useRef<{
    mode: 'move' | 'resize' | 'pinch';
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origWidth: number;
    initialPinchDist: number;
    moved: boolean;
  } | null>(null);

  const triggerHud = (
    type: 'brightness' | 'volume' | 'seek' | 'toast',
    label: string,
    percent?: number,
    timeoutMs = 900
  ) => {
    // Never show any text toast popups over the video player
    if (type === 'toast') return;
    setHudNotice({ type, label, percent });
    if (hudTimerRef.current) window.clearTimeout(hudTimerRef.current);
    hudTimerRef.current = window.setTimeout(() => {
      setHudNotice(null);
    }, timeoutMs);
  };

  const resetOverlayAutoHide = () => {
    setShowOverlayControls(true);
    if (overlayTimerRef.current) window.clearTimeout(overlayTimerRef.current);
    overlayTimerRef.current = window.setTimeout(() => {
      if (
        videoRef.current &&
        !videoRef.current.paused &&
        !isScrubbing &&
        !showBrightnessPanel &&
        !showQualityMenu &&
        !showAudioServerMenu &&
        !showSleepMenu
      ) {
        setShowOverlayControls(false);
      }
    }, 3600);
  };

  // Sleep Timer Countdown Effect
  useEffect(() => {
    if (typeof sleepTimerMode !== 'number' || sleepRemainingSec === null) return;
    if (sleepRemainingSec <= 0) {
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
      }
      setSleepTimerMode(null);
      setSleepRemainingSec(null);
      triggerHud('toast', '🌙 স্লিপ টাইমার শেষ হয়েছে — ভিডিও পজ করা হয়েছে', undefined, 3200);
      return;
    }
    const timer = window.setInterval(() => {
      setSleepRemainingSec((prev) => (prev !== null && prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [sleepTimerMode, sleepRemainingSec]);

  useEffect(() => {
    try {
      localStorage.setItem(BRIGHTNESS_STORAGE_KEY, String(brightness));
    } catch {
      // ignore
    }
  }, [brightness]);

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_NET_STORAGE_KEY, autoNetQuality ? '1' : '0');
    } catch {
      // ignore
    }
  }, [autoNetQuality]);

  useEffect(() => {
    try {
      localStorage.setItem(INTRO_SKIP_STORAGE_KEY, String(introSkipSec));
    } catch {
      // ignore
    }
  }, [introSkipSec]);

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_NEXT_STORAGE_KEY, autoNextEp ? '1' : '0');
    } catch {
      // ignore
    }
  }, [autoNextEp]);

  useEffect(() => {
    try {
      localStorage.setItem('cp_auto_bangla_sub_v1', autoBanglaSubEnabled ? '1' : '0');
    } catch {
      // ignore
    }
  }, [autoBanglaSubEnabled]);

  useEffect(() => {
    const updateOrientation = () => {
      const w = window.innerWidth || 390;
      const h = window.innerHeight || 844;
      setIsViewportPortrait(h >= w);
      setViewportDims({ width: w, height: h });
    };
    const onFsChange = () => {
      const fsActive = Boolean(
        document.fullscreenElement || (document as any).webkitFullscreenElement
      );
      setIsFullscreen(fsActive);
      updateOrientation();
    };
    window.addEventListener('resize', updateOrientation);
    window.addEventListener('orientationchange', updateOrientation);
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    return () => {
      window.removeEventListener('resize', updateOrientation);
      window.removeEventListener('orientationchange', updateOrientation);
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
    };
  }, []);

  // Automatically dismiss "Resumed at ..." banner after 1.2 seconds so it never stays stuck
  useEffect(() => {
    if (resumedBannerSec === null) return;
    const timer = window.setTimeout(() => {
      setResumedBannerSec(null);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [resumedBannerSec]);

  useEffect(() => {
    return () => {
      setVideoStartupPriority(false);
      if (subtitleUrl) {
        URL.revokeObjectURL(subtitleUrl);
      }
      if (overlayTimerRef.current) window.clearTimeout(overlayTimerRef.current);
      if (hudTimerRef.current) window.clearTimeout(hudTimerRef.current);
      if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
      if (stallDownshiftTimerRef.current) window.clearTimeout(stallDownshiftTimerRef.current);
      if (startupWatchdogTimerRef.current) window.clearTimeout(startupWatchdogTimerRef.current);
      if (standbyTimeoutRef.current) window.clearTimeout(standbyTimeoutRef.current);
    };
  }, [subtitleUrl]);

  // Prioritize 100% of network bandwidth for video startup until playback is smoothly underway
  useEffect(() => {
    if (!movie) {
      setVideoStartupPriority(false);
      return;
    }
    const starting = loading || (!hasStartedPlayback && !videoError);
    setVideoStartupPriority(starting);
  }, [movie, loading, hasStartedPlayback, videoError]);

  useEffect(() => {
    if (!movie) return;
    let cancelled = false;
    setVideoStartupPriority(true);
    setError(null);
    setSelectedSeasonFilter('all');
    setEpisodeSearchQuery('');
    setEpisodeSortOrder('asc');
    setFailedSourceIndices([]);
    setUseHlsBridge(true);
    setPlayerMode('stream');
    setVideoError(false);
    setHasStartedPlayback(false);
    setStandbyUpgradeIdx(null);
    setResumedBannerSec(null);
    setShowDownloadSheet(false);
    setShowAllEpisodesModal(false);
    setCurrentTime(0);
    setBufferedEnd(0);
    setDuration(0);
    setAutoMutedForiOS(false);
    smoothPlaySecondsRef.current = 0;
    hasStalledInSessionRef.current = false;
    hasAppliedIntroSkipRef.current = false;
    pendingResumeSecRef.current = null;
    if (modalContainerRef.current) {
      modalContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }

    const applyResolvedDetail = (resolved: MovieDetailData, isAlreadyMountedInstant = false) => {
      const eps: EpisodeItem[] = resolved.episodes || [];
      const initEpIdx =
        savedProgress?.episodeIdx !== undefined && eps[savedProgress.episodeIdx]
          ? savedProgress.episodeIdx
          : 0;
      const firstEp = eps[initEpIdx];
      const bestSrcIdx = pickBestSourceIndexForNet(firstEp?.sources || [], autoNetQuality);
      const firstSrc = firstEp?.sources?.[bestSrcIdx] || firstEp?.sources?.[0];
      if (firstSrc?.url && firstSrc.type !== 'embed') {
        warmStreamConnection(firstSrc.url);
      }
      if (!isAlreadyMountedInstant) {
        setDetail(resolved);
        setSelectedEpIdx(initEpIdx);
        setSelectedSourceIdx(bestSrcIdx);
      }
    };

    // 1. Synchronous 0ms Instant Check (from static-db.json or prefetched cache):
    // Mount the <video> player immediately on frame 1 with zero extra re-renders!
    const instantCached = getInstantCachedDetail(movie.path || movie.url, movie.title);
    if (instantCached && instantCached.episodes && instantCached.episodes.length > 0) {
      setLoading(false);
      applyResolvedDetail(instantCached, detail === instantCached);
      // Background non-blocking enrich after 2.5s: APPEND any newly discovered servers to the END
      // of the sources list so `sources[selectedSourceIdx]` NEVER changes URL mid-playback!
      const enrichTimer = window.setTimeout(() => {
        if (cancelled) return;
        const params = new URLSearchParams({
          path: movie.path || movie.url,
          title: movie.title,
          node: activeNodeId,
          enrich: '1',
        });
        universalApiFetch(`/api/details?${params.toString()}`)
          .then((data) => {
            if (!cancelled && data?.ok && data?.detail?.episodes?.length) {
              setDetail((prev) => {
                if (!prev || !prev.episodes?.length) return data.detail;
                let addedAny = false;
                const mergedEpisodes = prev.episodes.map((ep, idx) => {
                  const incomingEp = data.detail.episodes?.[idx];
                  if (!incomingEp?.sources?.length) return ep;
                  const existingUrls = new Set((ep.sources || []).map((s) => s.url));
                  const extraSources = incomingEp.sources.filter(
                    (s: StreamSource) => s.url && !existingUrls.has(s.url)
                  );
                  if (extraSources.length === 0) return ep;
                  addedAny = true;
                  return {
                    ...ep,
                    sources: [...(ep.sources || []), ...extraSources],
                  };
                });
                if (data.detail.episodes.length > prev.episodes.length) {
                  const newEpisodes = data.detail.episodes.slice(prev.episodes.length);
                  mergedEpisodes.push(...newEpisodes);
                  addedAny = true;
                }
                return addedAny ? { ...prev, episodes: mergedEpisodes } : prev;
              });
            }
          })
          .catch(() => {});
      }, 2500);
      return () => {
        cancelled = true;
        window.clearTimeout(enrichTimer);
      };
    }

    setLoading(true);
    setDetail(null);
    setSelectedEpIdx(savedProgress?.episodeIdx || 0);
    setSelectedSourceIdx(0);

    const fetchDetail = async () => {
      try {
        const params = new URLSearchParams({
          path: movie.path || movie.url,
          title: movie.title,
          node: activeNodeId,
        });
        const data = await universalApiFetch(`/api/details?${params.toString()}`);
        if (!cancelled) {
          if (data && data.ok && data.detail) {
            applyResolvedDetail(data.detail);
          } else {
            setError('এই মুভিটির বিস্তারিত তথ্য লোড করা যায়নি।');
          }
        }
      } catch {
        if (!cancelled) {
          setError('সার্ভারের সাথে সংযোগ বিচ্ছিন্ন হয়েছে।');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchDetail();
    return () => {
      cancelled = true;
    };
  }, [movie, activeNodeId]);

  // Only pre-warm related seasons & "For you" movies AFTER current video has started playing smoothly (>= 8s)
  useEffect(() => {
    if (!movie || !hasStartedPlayback || currentTime < 8) return;
    const timer = window.setTimeout(() => {
      (detail?.relatedSeasons || []).slice(0, 3).forEach((s) => {
        prefetchMovieDetails(s.path, s.title, activeNodeId);
      });
      relatedMovies.slice(0, 4).forEach((rel) => {
        if (rel.path !== movie.path) {
          prefetchMovieDetails(rel.path, rel.title, activeNodeId);
        }
      });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [movie, detail?.relatedSeasons, relatedMovies, activeNodeId, hasStartedPlayback, currentTime >= 8]);

  const effectiveDetail = detail || instantDetailOnRender;
  const episodes = effectiveDetail?.episodes || [];
  const activeEpisode: EpisodeItem | undefined = episodes[selectedEpIdx] || episodes[0];
  const sources = activeEpisode?.sources || [];
  const activeSource: StreamSource | undefined = sources[selectedSourceIdx] || sources[0];
  const isEmbedSource = Boolean(
    activeSource &&
      (activeSource.type === 'embed' || /abyssplayer\.com|vidsrc|\/embed\//i.test(activeSource.url))
  );

  // Distinct seasons present inside episodes list (e.g. Season 1, Season 2... Season 20)
  const distinctSeasons = useMemo(() => {
    const sSet = new Set<number>();
    episodes.forEach((ep) => {
      if (ep.season !== null && ep.season !== undefined && ep.season > 0) {
        sSet.add(ep.season);
      }
    });
    return Array.from(sSet).sort((a, b) => a - b);
  }, [episodes]);

  // Filtered & sorted episodes with original index preserved
  const filteredEpisodesWithIdx = useMemo(() => {
    const base = episodes.map((ep, idx) => ({ ep, idx }));
    const bySeason =
      selectedSeasonFilter === 'all'
        ? base
        : base.filter((x) => x.ep.season === selectedSeasonFilter);

    const q = episodeSearchQuery.trim().toLowerCase();
    const matched = !q
      ? bySeason
      : bySeason.filter(({ ep, idx }) => {
          const badge = formatEpisodeTileBadge(ep, idx).toLowerCase();
          const lbl = ep.label.toLowerCase();
          return badge.includes(q) || lbl.includes(q);
        });

    return episodeSortOrder === 'desc' ? [...matched].reverse() : matched;
  }, [episodes, selectedSeasonFilter, episodeSearchQuery, episodeSortOrder]);

  // Automatic Synchronized Bangla Subtitle Resolver — Waits 1.2s after video playback has started
  // so 100% of bandwidth goes to starting the video & prebuffering segment #1 first!
  useEffect(() => {
    if (!movie || !autoBanglaSubEnabled) return;
    if (!hasStartedPlayback && !isEmbedSource) return;
    let cancelled = false;

    const subDelayTimer = window.setTimeout(() => {
      if (cancelled) return;

      // Fast-path: check if our Micro-Chunk MKV remuxer already extracted embedded subtitles from RAM!
      const inMemoryMkvSubs = iosControllerRef.current?.getExtractedSubtitles() || [];
      if (inMemoryMkvSubs.length >= 8) {
        const mappedCues: SubtitleCue[] = inMemoryMkvSubs.map((s) => ({
          startSec: s.ptsMs / 1000,
          endSec: s.endPtsMs / 1000,
          text: s.text,
        }));
        ensureBanglaTranslationAroundTime(mappedCues, Math.max(0, currentTime - subOffsetSec))
          .then(() => {
            if (cancelled) return;
            const vttText = buildVttFromCues(mappedCues);
            const blob = new Blob([vttText], { type: 'text/vtt' });
            setSubtitleCues(mappedCues);
            setSubtitleUrl(URL.createObjectURL(blob));
            setSubtitleName('বাংলা Sub (Embedded Sync)');
          })
          .catch(() => {});
        return;
      }

      setLoadingAutoSub(true);
      fetchOrGenerateAutoBanglaSubtitles({
        moviePath: movie.path || movie.url,
        title: detail?.title || movie.title,
        storyline: detail?.storyline || '',
        episodeLabel: activeEpisode?.label || '',
        season: activeEpisode?.season,
        episode: activeEpisode?.number,
        language: detail?.language || movie.language,
        streamUrl: activeSource?.url,
        streamName: `${activeSource?.name || ''} ${activeSource?.qualityLabel || ''} ${detail?.quality || movie.quality || ''}`,
        videoDurationSec: duration || undefined,
        currentTimeSec: Math.max(0, currentTime - subOffsetSec),
      })
        .then((res) => {
          if (cancelled) return;
          setSubtitleCues(res.cues);
          setSubtitleUrl(res.vttBlobUrl);
          setSubtitleName(res.sourceLabel);
          setAvailableSubTracks(res.availableTracks || []);
          setActiveSubTrackIdx(res.activeTrackIndex || 0);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoadingAutoSub(false);
        });
    }, 1200);

    return () => {
      cancelled = true;
      window.clearTimeout(subDelayTimer);
    };
  }, [
    movie?.path,
    detail?.title,
    selectedEpIdx,
    activeEpisode?.label,
    autoBanglaSubEnabled,
    hasStartedPlayback,
  ]);

  // Live Windowed Bengali Translation around the viewer's current playback timestamp (even after seeking!)
  const translationBucket = Math.floor(Math.max(0, currentTime - subOffsetSec) / 8);
  useEffect(() => {
    if (!autoBanglaSubEnabled || subtitleCues.length === 0) return;
    const v = videoRef.current;
    const exactNow = v
      ? useHlsBridge
        ? iosSegmentStartSec + v.currentTime
        : v.currentTime
      : currentTime;
    const effectiveTime = Math.max(0, exactNow - subOffsetSec);
    ensureBanglaTranslationAroundTime(subtitleCues, effectiveTime, (updated) => {
      setSubtitleCues(updated);
    }).catch(() => {});
  }, [
    autoBanglaSubEnabled,
    subtitleCues.length,
    translationBucket,
    subOffsetSec,
    useHlsBridge,
    iosSegmentStartSec,
  ]);

  // Frame-Accurate 55ms Floating-Point Subtitle Sync Ticker:
  // Reads exact float `videoRef.current.currentTime` (instead of 1s floored integer) so Bengali subtitles
  // appear & disappear at the exact millisecond the actor speaks, with zero unnecessary React re-renders!
  useEffect(() => {
    if (!autoBanglaSubEnabled || subtitleCues.length === 0) {
      if (lastRenderedSubTextRef.current !== '') {
        lastRenderedSubTextRef.current = '';
        setActiveBanglaCueText('');
      }
      return;
    }

    const syncSubToExactVoiceTime = () => {
      const v = videoRef.current;
      const rawPlayhead =
        v && !isEmbedSource
          ? useHlsBridge
            ? iosSegmentStartSec + v.currentTime
            : v.currentTime
          : currentTime;
      const effectiveTimeSec = Math.max(0, rawPlayhead - subOffsetSec);
      const nextCueText = findActiveCueTextAtTime(subtitleCues, effectiveTimeSec);
      if (nextCueText !== lastRenderedSubTextRef.current) {
        lastRenderedSubTextRef.current = nextCueText;
        setActiveBanglaCueText(nextCueText);
      }
    };

    syncSubToExactVoiceTime();
    const timer = window.setInterval(syncSubToExactVoiceTime, 55);
    return () => window.clearInterval(timer);
  }, [
    autoBanglaSubEnabled,
    subtitleCues,
    subOffsetSec,
    useHlsBridge,
    iosSegmentStartSec,
    isEmbedSource,
    currentTime,
  ]);

  // Client-Side In-Browser Turbo Micro-Chunk MKV-to-MP4 Engine (700KB Instant Start + 650KB Exact Cues Seek)
  useEffect(() => {
    const rawUrl = activeSource?.url || '';
    const isAlreadyNativeMp4 = /\.(mp4|m4v|m3u8)(\?|$)/i.test(rawUrl);

    if (!useHlsBridge || !rawUrl || isAlreadyNativeMp4 || isEmbedSource) {
      if (iosControllerRef.current) {
        iosControllerRef.current.destroy();
        iosControllerRef.current = null;
      }
      setIosBlobUrl('');
      setIosSegmentStartSec(0);
      setIosCurrentSegIndex(0);
      return;
    }

    if (iosControllerRef.current) {
      iosControllerRef.current.destroy();
      iosControllerRef.current = null;
    }

    // Compute any initial resume timestamp BEFORE starting the controller so it jumps straight
    // to the resumed CuePoint in a single 700KB fetch instead of fetching 0s first!
    const initialResumeTarget =
      pendingResumeSecRef.current && pendingResumeSecRef.current > 15
        ? pendingResumeSecRef.current
        : !hasAppliedIntroSkipRef.current &&
            savedProgress &&
            (savedProgress.episodeIdx === undefined ||
              savedProgress.episodeIdx === selectedEpIdx) &&
            savedProgress.progressSeconds &&
            savedProgress.progressSeconds > 20
          ? savedProgress.progressSeconds
          : 0;

    if (initialResumeTarget > 15) {
      pendingResumeSecRef.current = null;
      hasAppliedIntroSkipRef.current = true;
    }

    const ctrl = new IosMkvStreamController(rawUrl, introSkipSec, initialResumeTarget);
    iosControllerRef.current = ctrl;
    iosTransitioningRef.current = false;
    setIosBlobUrl('');
    setIosSegmentStartSec(0);
    setIosCurrentSegIndex(0);
    setVideoError(false);
    setIsBuffering(true);

    ctrl
      .startInitialSegment()
      .then(async (seg0) => {
        if (iosControllerRef.current !== ctrl) return;
        const totalDur = ctrl.getTotalDurationSec();
        if (totalDur > 0) {
          setDuration(Math.floor(totalDur));
        }

        setIosCurrentSegIndex(seg0.index);
        setIosSegmentStartSec(seg0.startSec);
        setIosBlobUrl(seg0.blobUrl);
        setCurrentTime(Math.floor(seg0.startSec));
        if (initialResumeTarget > 20 && seg0.startSec >= 18) {
          setResumedBannerSec(Math.floor(seg0.startSec));
        }
        setIsBuffering(false);
      })
      .catch(() => {
        if (iosControllerRef.current !== ctrl) return;
        // Try next available H.264 stream source if current source fails
        const nextFailed = Array.from(new Set([...failedSourceIndices, selectedSourceIdx]));
        setFailedSourceIndices(nextFailed);
        const nextCandidateIdx = sources.findIndex((_, idx) => !nextFailed.includes(idx));
        if (nextCandidateIdx !== -1) {
          setSelectedSourceIdx(nextCandidateIdx);
          return;
        }
        // If all sources are AV1/HEVC and device is Chrome/Android (non-WebKit), fall back to native <video> MKV playback!
        if (!isAppleWebKitDevice()) {
          setUseHlsBridge(false);
          setFailedSourceIndices([]);
          setSelectedSourceIdx(0);
          return;
        }
        setIsBuffering(false);
        setVideoError(true);
      });

    return () => {
      if (iosControllerRef.current === ctrl) {
        ctrl.destroy();
        iosControllerRef.current = null;
      }
    };
  }, [activeSource?.url, useHlsBridge]);

  const effectiveVideoUrl = useMemo(() => {
    const rawUrl = activeSource?.url || '';
    if (!rawUrl) return '';
    const isAlreadyNativeMp4 = /\.(mp4|m4v|m3u8)(\?|$)/i.test(rawUrl);
    if (useHlsBridge && !isAlreadyNativeMp4 && !isEmbedSource) {
      return iosBlobUrl;
    }
    return rawUrl;
  }, [activeSource?.url, useHlsBridge, iosBlobUrl, isEmbedSource]);

  // Immediately trigger native video.play() inside useLayoutEffect (preserving user tap gesture!)
  // Immediately trigger native video.play() inside useLayoutEffect (preserving user tap gesture!)
  // and only show buffering spinner if the stream takes > 600ms so instant streams never flash a spinner!
  useLayoutEffect(() => {
    stopBackgroundWarmVideo();
    if (!effectiveVideoUrl) {
      if (!useHlsBridge) setIsBuffering(false);
      return;
    }
    setVideoError(false);
    setIsBuffering(false);

    const v = videoRef.current;
    if (v && !isEmbedSource) {
      if (hlsInstanceRef.current) {
        hlsInstanceRef.current.destroy();
        hlsInstanceRef.current = null;
      }
      const isM3u8 = /\.m3u8(\?|$)/i.test(effectiveVideoUrl);
      if (isM3u8 && Hls.isSupported() && !v.canPlayType('application/vnd.apple.mpegurl')) {
        const hls = new Hls({
          enableWorker: true,
          maxBufferLength: 20,
          maxMaxBufferLength: 40,
          startFragPrefetch: true,
        });
        hlsInstanceRef.current = hls;
        hls.loadSource(effectiveVideoUrl);
        hls.attachMedia(v);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          syncCleanAudioVolume(v);
          v.play().catch(() => {});
        });
      } else {
        syncCleanAudioVolume(v);
        const p = v.play();
        if (p !== undefined) {
          p.catch((err: any) => {
            if (err && err.name === 'NotAllowedError') {
              v.muted = true;
              setIsMuted(true);
              setAutoMutedForiOS(true);
              v.play().catch(() => {});
            }
          });
        }
      }
    }

    const bufTimer = window.setTimeout(() => {
      const curV = videoRef.current;
      if (curV && curV.readyState < 2 && !curV.paused) {
        setIsBuffering(true);
      }
    }, 600);

    return () => {
      window.clearTimeout(bufTimer);
      if (hlsInstanceRef.current) {
        hlsInstanceRef.current.destroy();
        hlsInstanceRef.current = null;
      }
    };
  }, [effectiveVideoUrl, useHlsBridge, isEmbedSource]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = isHold2x ? 2.0 : playbackSpeed;
    }
  }, [playbackSpeed, isHold2x]);

  // Keyboard Shortcuts (Space/K = Play/Pause, ArrowLeft/Right = +-10s, M = Mute, F = Fullscreen)
  useEffect(() => {
    if (!movie) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space' || e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        const v = videoRef.current;
        if (v) {
          if (v.paused) v.play().catch(() => {});
          else v.pause();
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (videoRef.current) {
          videoRef.current.currentTime = Math.min(
            videoRef.current.duration || 99999,
            videoRef.current.currentTime + 10
          );
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (videoRef.current) {
          videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 10);
        }
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        setIsMuted((prev) => {
          const next = !prev;
          if (videoRef.current) videoRef.current.muted = next;
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [movie]);

  // Listen to network speed changes only to update the status label (never tear down the active video mid-play!)
  useEffect(() => {
    if (!movie) return;
    const nav = navigator as any;
    const conn = nav?.connection || nav?.mozConnection || nav?.webkitConnection;
    if (!conn || !conn.addEventListener) return;

    const onNetworkChange = () => {
      const detected = detectIdealQualityForNetwork();
      setNetStatusLabel(detected.netLabel);
    };

    conn.addEventListener('change', onNetworkChange);
    return () => {
      conn.removeEventListener('change', onNetworkChange);
    };
  }, [movie]);

  if (!movie) return null;

  const advanceToNextIosSegment = async (): Promise<boolean> => {
    const ctrl = iosControllerRef.current;
    if (!ctrl || iosTransitioningRef.current) return false;
    iosTransitioningRef.current = true;
    try {
      const nextSeg = await ctrl.ensureNextSegmentPrebuffered(iosCurrentSegIndex + 1);
      if (nextSeg && iosControllerRef.current === ctrl) {
        setIosCurrentSegIndex(nextSeg.index);
        setIosSegmentStartSec(nextSeg.startSec);
        setIosBlobUrl(nextSeg.blobUrl);
        ctrl.ensureNextSegmentPrebuffered(nextSeg.index + 1);
        return true;
      }
      return false;
    } finally {
      iosTransitioningRef.current = false;
    }
  };

  const seekVideoToGlobalTime = (targetGlobalSec: number) => {
    const v = videoRef.current;
    const ctrlDur = iosControllerRef.current?.getTotalDurationSec() || 0;
    const maxDur =
      ctrlDur > 0
        ? ctrlDur
        : duration > 0
          ? duration
          : !useHlsBridge && v?.duration
            ? v.duration
            : 99999;
    const clamped = Math.max(0, Math.min(maxDur, targetGlobalSec));
    setCurrentTime(Math.floor(clamped));
    resetOverlayAutoHide();

    if (!useHlsBridge || !iosControllerRef.current) {
      if (v) {
        try {
          v.currentTime = clamped;
          if (v.paused) v.play().catch(() => {});
        } catch {
          // ignore
        }
      }
      return;
    }

    const segDur = v?.duration || 0;
    if (
      v &&
      segDur > 1 &&
      clamped >= iosSegmentStartSec &&
      clamped < iosSegmentStartSec + segDur - 0.5
    ) {
      try {
        v.currentTime = Math.max(0, clamped - iosSegmentStartSec);
        if (v.paused) v.play().catch(() => {});
      } catch {
        // ignore
      }
      return;
    }

    const ctrl = iosControllerRef.current;
    setIsBuffering(true);
    ctrl.seekToSeconds(clamped).then((seekSeg) => {
      if (iosControllerRef.current !== ctrl) return;
      const latestTotal = ctrl.getTotalDurationSec();
      if (latestTotal > 0 && Math.floor(latestTotal) !== duration) {
        setDuration(Math.floor(latestTotal));
      }
      if (seekSeg) {
        const offsetInsideSeg = Math.max(
          0,
          Math.min((seekSeg.durationSec || 12) - 0.5, clamped - seekSeg.startSec)
        );
        if (seekSeg.blobUrl === iosBlobUrl && v) {
          setIosCurrentSegIndex(seekSeg.index);
          setIosSegmentStartSec(seekSeg.startSec);
          try {
            v.currentTime = offsetInsideSeg;
            if (v.paused) v.play().catch(() => {});
          } catch {
            // ignore
          }
          setCurrentTime(Math.floor(seekSeg.startSec + offsetInsideSeg));
        } else {
          pendingResumeSecRef.current = offsetInsideSeg > 0.4 ? offsetInsideSeg : null;
          setIosCurrentSegIndex(seekSeg.index);
          setIosSegmentStartSec(seekSeg.startSec);
          setIosBlobUrl(seekSeg.blobUrl);
          setCurrentTime(Math.floor(seekSeg.startSec + offsetInsideSeg));
        }
      }
      setIsBuffering(false);
    });
  };

  const handleSelectEpisode = (idx: number) => {
    setSelectedEpIdx(idx);
    const ep = episodes[idx];
    const bestSrcIdx = pickBestSourceIndexForNet(ep?.sources || [], autoNetQuality);
    setSelectedSourceIdx(bestSrcIdx);
    setFailedSourceIndices([]);
    setPlayerMode('stream');
    setVideoError(false);
    setHasStartedPlayback(false);
    setStandbyUpgradeIdx(null);
    setResumedBannerSec(null);
    setShowAllEpisodesModal(false);
    setNextEpPrewarmed(false);
    prewarmedNextEpIdxRef.current = null;
    setCurrentTime(0);
    setBufferedEnd(0);
    smoothPlaySecondsRef.current = 0;
    hasStalledInSessionRef.current = false;
    hasAppliedIntroSkipRef.current = false;
    pendingResumeSecRef.current = null;
    const src = ep?.sources?.[bestSrcIdx] || ep?.sources?.[0];
    if (src?.url && src.type !== 'embed') {
      warmStreamConnection(src.url);
    }
    onRecordWatchProgress(movie, ep, idx, src, 0);
  };

  const handleSelectSource = (idx: number, isManualChoice = false) => {
    if (currentTime > 3) {
      pendingResumeSecRef.current = currentTime;
    }
    if (isManualChoice) {
      setAutoNetQuality(false);
      setStandbyUpgradeIdx(null);
    }
    smoothPlaySecondsRef.current = 0;
    setShowQualityMenu(false);
    setShowAudioServerMenu(false);
    setSelectedSourceIdx(idx);
    setPlayerMode('stream');
    setVideoError(false);
    const src = sources[idx];
    onRecordWatchProgress(movie, activeEpisode, selectedEpIdx, src, currentTime);
    triggerHud(
      'toast',
      isManualChoice
        ? `⚡ সার্ভার সুইচ: ${src?.audioLanguages?.join('+') || src?.audio || 'Audio'} · ${src?.quality || 720}p চালু হয়েছে`
        : `অটো কোয়ালিটি: ${src?.quality || 480}p চালু হয়েছে`
    );
  };

  const handleEnableAutoQuality = () => {
    setAutoNetQuality(true);
    setShowQualityMenu(false);
    setShowAudioServerMenu(false);
    hasStalledInSessionRef.current = false;
    smoothPlaySecondsRef.current = 0;
    const detected = detectIdealQualityForNetwork();
    setNetStatusLabel(detected.netLabel);
    if (sources.length > 0) {
      const bestIdx = pickBestSourceIndexForNet(sources, true);
      if (bestIdx !== selectedSourceIdx) {
        handleSelectSource(bestIdx, false);
      } else {
        triggerHud(
          'toast',
          `অটো কোয়ালিটি চালু: ইনস্ট্যান্ট ${sources[bestIdx]?.quality || 480}p → স্মুথ HD আপগ্রেড`
        );
      }
    }
  };

  const handleSetSleepTimer = (mode: number | 'end_of_ep' | null) => {
    setSleepTimerMode(mode);
    setShowSleepMenu(false);
    if (mode === null) {
      setSleepRemainingSec(null);
      triggerHud('toast', '🌙 স্লিপ টাইমার বন্ধ করা হয়েছে');
    } else if (mode === 'end_of_ep') {
      setSleepRemainingSec(null);
      triggerHud('toast', '🌙 এই এপিসোড শেষ হলে অটোমেটিক ভিডিও বন্ধ হবে');
    } else {
      setSleepRemainingSec(mode * 60);
      triggerHud('toast', `🌙 স্লিপ টাইমার চালু: ${mode} মিনিট পর অটো পজ হবে`);
    }
  };

  const startVideoWithiOSFallback = (v: HTMLVideoElement) => {
    if (!v.paused) return;
    const playPromise = v.play();
    if (playPromise !== undefined) {
      playPromise.catch((err: any) => {
        // Only fall back to muted autoplay if browser explicitly blocked unmuted autoplay (NotAllowedError)
        if (err && err.name === 'NotAllowedError') {
          v.muted = true;
          setIsMuted(true);
          setAutoMutedForiOS(true);
          v.play().catch(() => {
            setIsBuffering(false);
            setShowOverlayControls(true);
          });
        }
      });
    }
  };

  // Enforces 0% volume during the 0s..introSkipSec upstream voice-tag window so external site audio tags NEVER play, without seeking the Matroska stream!
  const syncCleanAudioVolume = (v: HTMLVideoElement) => {
    const dur = duration || v.duration || 0;
    const globalTime = useHlsBridge ? iosSegmentStartSec + v.currentTime : v.currentTime;
    const inVoiceTagWindow =
      introSkipSec > 0 &&
      globalTime < introSkipSec - 0.25 &&
      (!dur || dur > introSkipSec + 30);

    if (isMuted || inVoiceTagWindow) {
      v.volume = 0;
    } else {
      v.volume = Math.max(0, Math.min(1, volume / 100));
    }
    v.muted = isMuted || (!useHlsBridge && inVoiceTagWindow);
  };

  const handleVideoLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    v.playbackRate = isHold2x ? 2.0 : playbackSpeed;
    const totalFromCtrl = iosControllerRef.current?.getTotalDurationSec() || 0;
    setDuration(Math.floor(totalFromCtrl > 0 ? totalFromCtrl : v.duration || 0));
    setHasStartedPlayback(true);
    setIsBuffering(false);

    // Silence any upstream intro audio tag immediately before first frame plays
    syncCleanAudioVolume(v);

    if (useHlsBridge) {
      if (pendingResumeSecRef.current !== null && pendingResumeSecRef.current > 0.3) {
        const localOffset = pendingResumeSecRef.current;
        pendingResumeSecRef.current = null;
        try {
          v.currentTime = Math.min(Math.max(0, (v.duration || 12) - 0.4), localOffset);
        } catch {
          // ignore
        }
      }
      startVideoWithiOSFallback(v);
      return;
    }

    // 1. If switching resolution mid-playback, restore exact timestamp
    if (pendingResumeSecRef.current !== null && pendingResumeSecRef.current > 2) {
      const target = pendingResumeSecRef.current;
      pendingResumeSecRef.current = null;
      try {
        v.currentTime = target;
      } catch {
        // ignore
      }
      syncCleanAudioVolume(v);
      startVideoWithiOSFallback(v);
      return;
    }

    // 2. If user has saved watch history for this episode, resume automatically
    const canResumeSaved =
      !hasAppliedIntroSkipRef.current &&
      savedProgress &&
      (savedProgress.episodeIdx === undefined || savedProgress.episodeIdx === selectedEpIdx) &&
      savedProgress.progressSeconds &&
      savedProgress.progressSeconds > 15 &&
      (!v.duration || savedProgress.progressSeconds < v.duration - 20);

    if (canResumeSaved && savedProgress?.progressSeconds) {
      hasAppliedIntroSkipRef.current = true;
      try {
        v.currentTime = savedProgress.progressSeconds;
        setCurrentTime(savedProgress.progressSeconds);
        setResumedBannerSec(savedProgress.progressSeconds);
      } catch {
        // ignore
      }
      syncCleanAudioVolume(v);
      startVideoWithiOSFallback(v);
      return;
    }

    // 3. Skip the 12s upstream voice-tag intro on Frame 0 before playback starts so it never plays or jumps later!
    if (
      !hasAppliedIntroSkipRef.current &&
      introSkipSec > 0 &&
      (!v.duration || v.duration > introSkipSec + 30) &&
      v.currentTime < introSkipSec - 1
    ) {
      hasAppliedIntroSkipRef.current = true;
      try {
        v.currentTime = introSkipSec;
        setCurrentTime(introSkipSec);
      } catch {
        // ignore
      }
    }

    syncCleanAudioVolume(v);
    startVideoWithiOSFallback(v);
  };

  const handleVideoError = () => {
    // 1. Automatically fall back to next available H.264 stream (e.g. 720p or 480p) if current source fails
    const nextFailed = Array.from(new Set([...failedSourceIndices, selectedSourceIdx]));
    setFailedSourceIndices(nextFailed);

    const nextCandidateIdx = sources.findIndex((_, idx) => !nextFailed.includes(idx));
    if (nextCandidateIdx !== -1) {
      if (currentTime > 3) {
        pendingResumeSecRef.current = currentTime;
      }
      setSelectedSourceIdx(nextCandidateIdx);
      setVideoError(false);
      triggerHud(
        'toast',
        `Switched to smooth ${sources[nextCandidateIdx]?.quality || 720}p HD stream`,
        undefined,
        2200
      );
      return;
    }

    // 2. If direct MKV playback failed on all sources on iOS WebKit, switch to our client-side iOS MP4 remux engine!
    if (!useHlsBridge && isAppleWebKitDevice()) {
      setUseHlsBridge(true);
      setFailedSourceIndices([]);
      setSelectedSourceIdx(pickBestSourceIndexForNet(sources, true));
      setVideoError(false);
      triggerHud('toast', 'iPhone Native MP4 Stream Mode Activated', undefined, 2400);
      return;
    }

    setIsBuffering(false);
    setVideoError(true);
  };

  const handleTogglePlayPause = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
    resetOverlayAutoHide();
  };

  const handleSeekRelative = (deltaSec: number) => {
    const baseTime = currentTime || videoRef.current?.currentTime || 0;
    seekVideoToGlobalTime(baseTime + deltaSec);
    setSeekRipple({
      side: deltaSec < 0 ? 'left' : 'right',
      delta: deltaSec,
      id: Date.now(),
    });
    if (rippleTimerRef.current) window.clearTimeout(rippleTimerRef.current);
    rippleTimerRef.current = window.setTimeout(() => {
      setSeekRipple(null);
    }, 680);
    triggerHud('seek', deltaSec > 0 ? `+${deltaSec}s Forward` : `${deltaSec}s Rewind`);
    resetOverlayAutoHide();
  };

  const handleToggleMute = () => {
    const v = videoRef.current;
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (v) v.muted = nextMuted;
    triggerHud('volume', nextMuted ? 'Muted' : `Volume ${volume}%`, nextMuted ? 0 : volume);
  };

  const handleChangeBrightness = (newVal: number) => {
    const clamped = Math.max(20, Math.min(160, Math.round(newVal)));
    setBrightness(clamped);
    triggerHud('brightness', `Brightness ${clamped}%`, Math.round(((clamped - 20) / 140) * 100));
  };

  const handleCycleVideoFit = () => {
    const nextFit =
      videoFit === 'contain' ? 'cover' : videoFit === 'cover' ? 'fill' : 'contain';
    setVideoFit(nextFit);
    triggerHud(
      'toast',
      nextFit === 'contain'
        ? 'Screen Fit: Original'
        : nextFit === 'cover'
          ? 'Screen Fit: Zoom Crop'
          : 'Screen Fit: Full Stretch'
    );
  };

  const handleTogglePiP = async () => {
    // Prefer In-App Floating Mini Player so the user can browse the app while watching!
    if (onToggleMiniPlayer && !isLandscapeMode && !isFullscreen) {
      onToggleMiniPlayer(!isMiniPlayer);
      return;
    }
    const v = videoRef.current as any;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (v.requestPictureInPicture) {
        await v.requestPictureInPicture();
      } else if (v.webkitSupportsPresentationMode && v.webkitSetPresentationMode) {
        v.webkitSetPresentationMode(
          v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture'
        );
      }
    } catch {
      // ignore
    }
  };

  const handleToggleFullscreen = () => {
    const stage = playerStageRef.current as any;
    const currentFs = document.fullscreenElement || (document as any).webkitFullscreenElement;
    const currentlyActive = isLandscapeMode || isFullscreen || Boolean(currentFs);

    const w = window.innerWidth || 390;
    const h = window.innerHeight || 844;
    setIsViewportPortrait(h >= w);
    setViewportDims({ width: w, height: h });

    if (currentlyActive) {
      setIsLandscapeMode(false);
      setIsFullscreen(false);
      try {
        if (currentFs) {
          if (document.exitFullscreen) {
            document.exitFullscreen().catch(() => {});
          } else if ((document as any).webkitExitFullscreen) {
            (document as any).webkitExitFullscreen();
          }
        }
        if ((screen.orientation as any)?.unlock) {
          (screen.orientation as any).unlock();
        }
      } catch {
        // ignore
      }
      return;
    }

    if (isMiniPlayer && onToggleMiniPlayer) {
      onToggleMiniPlayer(false);
    }

    // Activate Fullscreen + 90-deg Landscape Rotation Mode immediately
    if (modalContainerRef.current) {
      modalContainerRef.current.scrollTo({ top: 0 });
    }
    setIsLandscapeMode(true);
    setIsFullscreen(true);
    resetOverlayAutoHide();

    try {
      if (stage && stage.requestFullscreen) {
        stage
          .requestFullscreen()
          .then(() => {
            if ((screen.orientation as any)?.lock) {
              (screen.orientation as any).lock('landscape').catch(() => {});
            }
          })
          .catch(() => {});
      } else if (stage && stage.webkitRequestFullscreen) {
        stage.webkitRequestFullscreen();
      }
    } catch {
      // CSS 90deg landscape rotation on the inner stage wrapper handles portrait screens automatically
    }
  };

  // Touch Gesture Handlers on Video Stage (Left vertical swipe = Brightness, Right vertical swipe = Volume, Double tap = +-10s, Long press = 2x Speed)
  const handleStageTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isMiniPlayer || isScreenLocked || playerMode === 'trailer') return;
    if ((e.target as HTMLElement).closest('button, input, select, a, [data-scrubber="true"]')) return;
    if (e.touches.length !== 1) return;

    const touch = e.touches[0];
    const rect = e.currentTarget.getBoundingClientRect();
    const isRotated90 = isLandscapeMode && isViewportPortrait;
    const isLeftHalf = isRotated90
      ? touch.clientY - rect.top < rect.height / 2
      : touch.clientX - rect.left < rect.width / 2;

    touchGestureRef.current = {
      active: true,
      side: isLeftHalf ? 'left' : 'right',
      startX: touch.clientX,
      startY: touch.clientY,
      startVal: isLeftHalf ? brightness : volume,
      moved: false,
    };

    if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = window.setTimeout(() => {
      if (touchGestureRef.current && !touchGestureRef.current.moved && isPlaying) {
        setIsHold2x(true);
      }
    }, 500);
  };

  const handleStageTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const g = touchGestureRef.current;
    if (!g || !g.active || isMiniPlayer || isScreenLocked || e.touches.length !== 1) return;

    const touch = e.touches[0];
    const isRotated90 = isLandscapeMode && isViewportPortrait;
    const dx = isRotated90 ? touch.clientY - g.startY : touch.clientX - g.startX;
    const dy = isRotated90 ? touch.clientX - g.startX : g.startY - touch.clientY;

    if (!g.moved) {
      if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy)) {
        g.active = false;
        if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
        return;
      }
      if (Math.abs(dy) > 12) {
        g.moved = true;
        if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
        setIsHold2x(false);
      } else {
        return;
      }
    }

    if (g.side === 'left') {
      const deltaBrightness = Math.round(dy * 0.65);
      const nextB = Math.max(20, Math.min(160, g.startVal + deltaBrightness));
      setBrightness(nextB);
      triggerHud(
        'brightness',
        `Brightness ${nextB}%`,
        Math.round(((nextB - 20) / 140) * 100),
        900
      );
    } else {
      const deltaVol = Math.round(dy * 0.55);
      const nextV = Math.max(0, Math.min(100, g.startVal + deltaVol));
      setVolume(nextV);
      setIsMuted(nextV === 0);
      if (videoRef.current) {
        videoRef.current.volume = nextV / 100;
        videoRef.current.muted = nextV === 0;
      }
      triggerHud('volume', nextV === 0 ? 'Muted' : `Volume ${nextV}%`, nextV, 900);
    }
  };

  const handleStageTouchEnd = () => {
    if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
    if (isHold2x) {
      setIsHold2x(false);
    }
    touchGestureRef.current = null;
  };

  const clampMiniPosition = (x: number, y: number, widthVal: number) => {
    const vw = window.innerWidth || 390;
    const vh = window.innerHeight || 844;
    const heightVal = Math.round((widthVal * 9) / 16);
    const maxX = Math.max(8, vw - widthVal - 8);
    const maxY = Math.max(8, vh - heightVal - 8);
    return {
      x: Math.max(8, Math.min(maxX, Math.round(x))),
      y: Math.max(8, Math.min(maxY, Math.round(y))),
    };
  };

  const clampMiniWidthVal = (w: number) => {
    const vw = window.innerWidth || 390;
    const maxW = Math.min(370, Math.max(220, vw - 16));
    return Math.max(165, Math.min(maxW, Math.round(w)));
  };

  const handleCycleMiniSize = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    const vw = window.innerWidth || 390;
    const maxW = Math.min(350, Math.max(240, vw - 20));
    const nextW = miniWidth < 215 ? 255 : miniWidth < 295 ? maxW : 185;
    const clampedW = clampMiniWidthVal(nextW);
    setMiniWidth(clampedW);
    if (miniPos) {
      setMiniPos(clampMiniPosition(miniPos.x, miniPos.y, clampedW));
    }
  };

  const handleMiniTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isMiniPlayer) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-mini-close="true"]') || target.closest('[data-mini-cycle="true"]')) {
      return;
    }
    const container = modalContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      miniDragRef.current = {
        mode: 'pinch',
        startX: 0,
        startY: 0,
        origX: rect.left,
        origY: rect.top,
        origWidth: miniWidth,
        initialPinchDist: Math.max(24, Math.hypot(dx, dy)),
        moved: true,
      };
      return;
    }

    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const isResizeHandle = Boolean(target.closest('[data-mini-resize="true"]'));

    miniDragRef.current = {
      mode: isResizeHandle ? 'resize' : 'move',
      startX: touch.clientX,
      startY: touch.clientY,
      origX: rect.left,
      origY: rect.top,
      origWidth: miniWidth,
      initialPinchDist: 0,
      moved: isResizeHandle,
    };
  };

  const handleMiniTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isMiniPlayer) return;
    const g = miniDragRef.current;
    if (!g) return;

    if (g.mode === 'pinch' && e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.max(24, Math.hypot(dx, dy));
      const nextW = clampMiniWidthVal(g.origWidth * (dist / g.initialPinchDist));
      setMiniWidth(nextW);
      setMiniPos(clampMiniPosition(g.origX, g.origY, nextW));
      return;
    }

    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - g.startX;
    const dy = touch.clientY - g.startY;

    if (g.mode === 'resize') {
      const deltaW = Math.abs(dx) >= Math.abs(dy) ? dx : dy * (16 / 9);
      const nextW = clampMiniWidthVal(g.origWidth + deltaW);
      setMiniWidth(nextW);
      setMiniPos(clampMiniPosition(g.origX, g.origY, nextW));
      return;
    }

    if (!g.moved && Math.hypot(dx, dy) > 7) {
      g.moved = true;
    }

    if (g.moved) {
      setMiniPos(clampMiniPosition(g.origX + dx, g.origY + dy, g.origWidth));
    }
  };

  const handleMiniTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isMiniPlayer) return;
    const target = e.target as HTMLElement;
    if (
      target.closest('[data-mini-close="true"]') ||
      target.closest('[data-mini-cycle="true"]') ||
      target.closest('[data-mini-resize="true"]')
    ) {
      miniDragRef.current = null;
      return;
    }
    const g = miniDragRef.current;
    miniDragRef.current = null;
    if (g && g.mode === 'move' && !g.moved) {
      lastMiniTapTimeRef.current = Date.now();
      if (onToggleMiniPlayer) onToggleMiniPlayer(false);
    }
  };

  const handleMiniMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isMiniPlayer || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-mini-close="true"]') || target.closest('[data-mini-cycle="true"]')) {
      return;
    }
    const container = modalContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const isResizeHandle = Boolean(target.closest('[data-mini-resize="true"]'));

    miniDragRef.current = {
      mode: isResizeHandle ? 'resize' : 'move',
      startX: e.clientX,
      startY: e.clientY,
      origX: rect.left,
      origY: rect.top,
      origWidth: miniWidth,
      initialPinchDist: 0,
      moved: isResizeHandle,
    };

    const onMouseMove = (ev: MouseEvent) => {
      const g = miniDragRef.current;
      if (!g) return;
      const dx = ev.clientX - g.startX;
      const dy = ev.clientY - g.startY;
      if (g.mode === 'resize') {
        const deltaW = Math.abs(dx) >= Math.abs(dy) ? dx : dy * (16 / 9);
        const nextW = clampMiniWidthVal(g.origWidth + deltaW);
        setMiniWidth(nextW);
        setMiniPos(clampMiniPosition(g.origX, g.origY, nextW));
        return;
      }
      if (!g.moved && Math.hypot(dx, dy) > 6) {
        g.moved = true;
      }
      if (g.moved) {
        setMiniPos(clampMiniPosition(g.origX + dx, g.origY + dy, g.origWidth));
      }
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      const g = miniDragRef.current;
      miniDragRef.current = null;
      if (g && g.mode === 'move' && !g.moved) {
        lastMiniTapTimeRef.current = Date.now();
        if (onToggleMiniPlayer) onToggleMiniPlayer(false);
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleStageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, input, select, a, [data-scrubber="true"]')) return;
    if (isMiniPlayer) {
      if (Date.now() - lastMiniTapTimeRef.current > 350) {
        if (onToggleMiniPlayer) onToggleMiniPlayer(false);
      }
      return;
    }
    if (isScreenLocked) {
      resetOverlayAutoHide();
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const isRotated90 = isLandscapeMode && isViewportPortrait;
    const ratio = isRotated90
      ? (e.clientY - rect.top) / Math.max(1, rect.height)
      : (e.clientX - rect.left) / Math.max(1, rect.width);
    const side: 'left' | 'right' | 'center' =
      ratio < 0.34 ? 'left' : ratio > 0.66 ? 'right' : 'center';

    const now = Date.now();
    if (now - lastTapRef.current.time < 290 && lastTapRef.current.side === side && side !== 'center') {
      handleSeekRelative(side === 'left' ? -10 : 10);
      lastTapRef.current = { time: 0, side: 'center' };
      return;
    }

    lastTapRef.current = { time: now, side };
    if (showOverlayControls) {
      setShowOverlayControls(false);
      setShowBrightnessPanel(false);
      setShowQualityMenu(false);
      setShowAudioServerMenu(false);
      setShowSleepMenu(false);
    } else {
      resetOverlayAutoHide();
    }
  };

  const handleSubtitleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setLoadingAutoSub(true);
      const text = await file.text();
      const parsedCues = parseSrtOrVttToCues(text);
      if (parsedCues.length > 0) {
        // Automatically translate uploaded English/foreign subtitles to Bengali if not already Bengali
        const sampleText = parsedCues
          .slice(0, 5)
          .map((c) => c.text)
          .join(' ');
        const hasBanglaChars = /[\u0980-\u09FF]/.test(sampleText);
        if (!hasBanglaChars) {
          triggerHud('toast', 'ইংরেজি সাবটাইটেল বাংলায় অনুবাদ করা হচ্ছে...');
          const firstBatch = parsedCues.slice(0, 60);
          for (let i = 0; i < firstBatch.length; i += 30) {
            const chunk = firstBatch.slice(i, i + 30);
            const tr = await translateLinesToBangla(chunk.map((c) => c.text));
            chunk.forEach((c, idx) => {
              if (tr[idx]) c.text = tr[idx];
            });
          }
          // Translate rest in background
          if (parsedCues.length > 60) {
            (async () => {
              for (let i = 60; i < Math.min(parsedCues.length, 500); i += 35) {
                const chunk = parsedCues.slice(i, i + 35);
                const tr = await translateLinesToBangla(chunk.map((c) => c.text));
                chunk.forEach((c, idx) => {
                  if (tr[idx]) c.text = tr[idx];
                });
              }
            })().catch(() => {});
          }
        }
        const vttBuilt = buildVttFromCues(parsedCues);
        const blob = new Blob([vttBuilt], { type: 'text/vtt' });
        if (subtitleUrl) URL.revokeObjectURL(subtitleUrl);
        const url = URL.createObjectURL(blob);
        setSubtitleCues(parsedCues);
        setSubtitleUrl(url);
        setSubtitleName(`বাংলা Sub (${file.name})`);
        setAutoBanglaSubEnabled(true);
        triggerHud('toast', `বাংলা সাবটাইটেল লোড হয়েছে: ${file.name}`);
      } else {
        const vttText = convertSrtToVtt(text);
        const blob = new Blob([vttText], { type: 'text/vtt' });
        if (subtitleUrl) URL.revokeObjectURL(subtitleUrl);
        const url = URL.createObjectURL(blob);
        setSubtitleUrl(url);
        setSubtitleName(file.name);
        setAutoBanglaSubEnabled(true);
        triggerHud('toast', `Subtitle Loaded: ${file.name}`);
      }
    } catch {
      // ignore
    } finally {
      setLoadingAutoSub(false);
    }
  };

  const handleShare = async () => {
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    const shareParams = new URLSearchParams({
      watch: movie.path || movie.url,
      title: detail?.title || movie.title,
    });
    const shareUrl = `${baseUrl}?${shareParams.toString()}`;
    try {
      if (navigator.share) {
        await navigator.share({
          title: detail?.title || movie.title,
          text: `Watch ${detail?.title || movie.title} in Full HD on CinePulse`,
          url: shareUrl,
        });
      } else {
        await navigator.clipboard.writeText(shareUrl);
        setCopiedShare(true);
        setTimeout(() => setCopiedShare(false), 2000);
      }
    } catch {
      // ignore
    }
  };

  const handleCopyAllEpisodes = async () => {
    const lines = episodes
      .map((ep) => {
        const bestSrc = ep.sources?.[0];
        if (!bestSrc) return null;
        return `${ep.label}: ${toGatewayAbsoluteUrl(bestSrc.downloadUrl || bestSrc.url)}`;
      })
      .filter(Boolean)
      .join('\n');

    if (!lines) return;
    try {
      await navigator.clipboard.writeText(lines);
      setCopiedBatch(true);
      setTimeout(() => setCopiedBatch(false), 2200);
    } catch {
      // ignore
    }
  };

  const handleDownloadM3UPlaylist = () => {
    const lines = ['#EXTM3U'];
    episodes.forEach((ep) => {
      const bestSrc = ep.sources?.[0];
      if (bestSrc?.url) {
        lines.push(`#EXTINF:-1,${detail?.title || movie.title} - ${ep.label}`);
        lines.push(bestSrc.url);
      }
    });
    const blob = new Blob([lines.join('\n')], { type: 'audio/x-mpegurl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(detail?.title || movie.title).replace(/[^a-zA-Z0-9_-]/g, '_')}_Playlist.m3u`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const vlcUrl = activeSource?.url
    ? `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(activeSource.url)}`
    : '';
  const infuseUrl = activeSource?.url
    ? `infuse://x-callback-url/play?url=${encodeURIComponent(activeSource.url)}`
    : '';
  const outplayerUrl = activeSource?.url ? `outplayer://${activeSource.url}` : '';

  const ratingScore = detail?.communityScore
    ? (detail.communityScore.recommendedPercent / 10).toFixed(1)
    : '8.7';

  const ctrlTotalDur = iosControllerRef.current?.getTotalDurationSec() || 0;
  const displayDuration = Math.floor(duration > 0 ? duration : ctrlTotalDur > 0 ? ctrlTotalDur : 0);
  const effectiveDuration = Math.max(1, displayDuration || 1);
  const activePlayheadSec = isScrubbing && scrubPreview !== null ? scrubPreview.sec : currentTime;
  const progressPercent =
    displayDuration > 0 ? Math.min(100, (activePlayheadSec / effectiveDuration) * 100) : 0;
  const bufferedPercent =
    displayDuration > 0 ? Math.min(100, (bufferedEnd / effectiveDuration) * 100) : 0;

  // CSS video brightness boost filter (supports darkening down to 20% AND brightening dark movie scenes up to 160%)
  const videoFilterStyle: React.CSSProperties = {
    filter: `brightness(${brightness}%) contrast(${brightness > 110 ? 105 : 100}%) saturate(${
      brightness > 115 ? 108 : 100
    }%)`,
    objectFit: videoFit,
  };

  // Show up to 60 tiles in the horizontal bar for instant 60fps scrolling, and all in the "All" grid
  const horizontalEpisodesSlice = filteredEpisodesWithIdx.slice(0, 60);

  const isRotated90 = !isMiniPlayer && (isLandscapeMode || isFullscreen) && isViewportPortrait;

  const computeScrubberTarget = (clientX: number, clientY: number, el: HTMLDivElement) => {
    const rect = el.getBoundingClientRect();
    const ratio = isRotated90
      ? (clientY - rect.top) / Math.max(1, rect.height)
      : (clientX - rect.left) / Math.max(1, rect.width);
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    const targetSec = Math.floor(clampedRatio * effectiveDuration);
    return { targetSec, percent: clampedRatio * 100 };
  };

  const previewScrubberAtPointer = (clientX: number, clientY: number, el: HTMLDivElement) => {
    const { targetSec, percent } = computeScrubberTarget(clientX, clientY, el);
    setScrubPreview({ sec: targetSec, percent });
    setCurrentTime(targetSec);
    // Pre-fetch the 650KB Matroska Cluster at the hovered/dragged timestamp BEFORE the user releases their finger!
    if (useHlsBridge && iosControllerRef.current) {
      iosControllerRef.current.prewarmSeekTarget(targetSec);
    }
    return targetSec;
  };

  const commitScrubberSeek = (targetSec: number) => {
    setCurrentTime(targetSec);
    if (useHlsBridge) {
      seekVideoToGlobalTime(targetSec);
    } else if (videoRef.current) {
      try {
        videoRef.current.currentTime = targetSec;
      } catch {
        // ignore
      }
    }
  };

  const handleScrubberPointerSeek = (clientX: number, clientY: number, el: HTMLDivElement) => {
    const targetSec = previewScrubberAtPointer(clientX, clientY, el);
    commitScrubberSeek(targetSec);
  };

  const hasNextEpisode = episodes.length > 1 && selectedEpIdx + 1 < episodes.length;
  const nextEpisodeItem = hasNextEpisode ? episodes[selectedEpIdx + 1] : undefined;

  return (
    <div
      ref={modalContainerRef}
      onTouchStart={isMiniPlayer ? handleMiniTouchStart : undefined}
      onTouchMove={isMiniPlayer ? handleMiniTouchMove : undefined}
      onTouchEnd={isMiniPlayer ? handleMiniTouchEnd : undefined}
      onMouseDown={isMiniPlayer ? handleMiniMouseDown : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      style={
        isMiniPlayer
          ? {
              width: `${miniWidth}px`,
              ...(miniPos
                ? { left: `${miniPos.x}px`, top: `${miniPos.y}px` }
                : { right: '12px', bottom: '76px' }),
              touchAction: 'none',
              WebkitTouchCallout: 'none',
              WebkitUserSelect: 'none',
              userSelect: 'none',
            }
          : undefined
      }
      className={
        isMiniPlayer
          ? 'fixed z-50 rounded-2xl overflow-hidden shadow-[0_18px_48px_rgba(0,0,0,0.92)] border border-[#00e68a]/60 bg-[#0b0d11] text-slate-100 flex flex-col cursor-grab active:cursor-grabbing select-none'
          : `fixed inset-0 z-50 w-full max-w-[100vw] bg-[#0b0d11] text-slate-100 flex flex-col ${
              isLandscapeMode || isFullscreen
                ? 'overflow-hidden'
                : 'overflow-y-auto overflow-x-hidden overscroll-y-contain'
            }`
      }
    >
      {/* Sticky Top Video Player Stage (With Inner 90deg Rotated Container so Fullscreen/Mobile always rotates!) */}
      <div
        ref={playerStageRef}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        className={`bg-black select-none ${
          isMiniPlayer
            ? 'relative w-full'
            : isLandscapeMode || isFullscreen
              ? 'fixed inset-0 z-[9999] w-screen h-screen overflow-hidden'
              : 'sticky top-0 z-30 w-full max-w-5xl mx-auto shadow-2xl'
        }`}
      >
        <div
          style={{
            WebkitTouchCallout: 'none',
            WebkitUserSelect: 'none',
            userSelect: 'none',
            ...(isRotated90
              ? {
                  position: 'absolute',
                  top: '50%',
                  left: '50%',
                  width: `${Math.max(viewportDims.width, viewportDims.height)}px`,
                  height: `${Math.min(viewportDims.width, viewportDims.height)}px`,
                  transform: 'translate(-50%, -50%) rotate(90deg)',
                  transformOrigin: 'center center',
                }
              : !isMiniPlayer && (isLandscapeMode || isFullscreen)
                ? {
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                  }
                : {}),
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={isEmbedSource && !isMiniPlayer ? undefined : handleStageClick}
          onTouchStart={isEmbedSource && !isMiniPlayer ? undefined : handleStageTouchStart}
          onTouchMove={isEmbedSource && !isMiniPlayer ? undefined : handleStageTouchMove}
          onTouchEnd={isEmbedSource && !isMiniPlayer ? undefined : handleStageTouchEnd}
          className={`relative w-full bg-black flex items-center justify-center overflow-hidden select-none ${
            isEmbedSource && !isMiniPlayer ? '' : 'touch-none'
          } ${!isMiniPlayer && (isLandscapeMode || isFullscreen) ? 'h-full' : 'aspect-video'}`}
        >
          {/* Clean Floating Mini-Player Overlay: Direct tap anywhere opens full video, movable anywhere, resizable */}
          {isMiniPlayer && (
            <div className="pointer-events-none absolute inset-0 z-30 flex flex-col justify-between">
              <div className="flex items-center justify-between p-1.5">
                {/* Top-Left Quick Resize Toggle Button (ছোট / বড় করুন) */}
                <button
                  type="button"
                  data-mini-cycle="true"
                  onClick={handleCycleMiniSize}
                  className="pointer-events-auto w-6 h-6 rounded-full bg-black/65 text-white/90 hover:text-[#00e68a] flex items-center justify-center border border-white/15 shadow active:scale-90 transition-transform"
                  title="পপ-আপ ছোট বা বড় করুন (Resize)"
                >
                  {miniWidth >= 295 ? (
                    <Minimize2 className="w-3 h-3" />
                  ) : (
                    <Maximize2 className="w-3 h-3" />
                  )}
                </button>

                {/* Top-Right Close Button */}
                <button
                  type="button"
                  data-mini-close="true"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose();
                  }}
                  className="pointer-events-auto w-6 h-6 rounded-full bg-black/65 text-white/90 hover:text-rose-400 flex items-center justify-center border border-white/15 shadow active:scale-90 transition-transform"
                  title="Close Mini Player"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Bottom Thin Progress Line + Corner Drag-Resize Handle */}
              <div className="relative w-full">
                <div
                  data-mini-resize="true"
                  title="টেনে ছোট-বড় করুন"
                  className="pointer-events-auto absolute bottom-1 right-1 w-5 h-5 flex items-end justify-end p-0.5 cursor-nwse-resize opacity-80 hover:opacity-100"
                >
                  <span className="w-2.5 h-2.5 border-r-2 border-b-2 border-[#00e68a] rounded-br-[2px]" />
                </div>
                <div className="w-full h-1 bg-white/20 overflow-hidden">
                  <div
                    className="h-full bg-[#00e68a]"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Top Overlay Bar Inside Full Video */}
          {!isMiniPlayer && (
            <div
              onClick={(e) => e.stopPropagation()}
              className={`absolute top-0 inset-x-0 z-25 flex items-center justify-between px-3 sm:px-3.5 pt-2.5 pb-5 bg-gradient-to-b from-black/80 via-black/35 to-transparent transition-opacity duration-200 ${
                showOverlayControls || !isPlaying ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}
            >
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (isLandscapeMode || isFullscreen) {
                      handleToggleFullscreen();
                    } else if (onToggleMiniPlayer && !videoError) {
                      onToggleMiniPlayer(true);
                    } else {
                      onClose();
                    }
                  }}
                  aria-label="Back"
                  className="w-8 h-8 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:scale-90 transition-all"
                >
                  <ChevronLeft className="w-6 h-6 stroke-[2.2]" />
                </button>

                {/* Original CinePulse Brand Emblem beside Back button */}
                <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/40 backdrop-blur-xs border border-white/10">
                  <span className="w-4 h-4 rounded-[5px] bg-gradient-to-br from-[#00e68a] to-[#00b4d8] text-[#041b10] flex items-center justify-center shadow-xs shrink-0">
                    <Play className="w-2.5 h-2.5 fill-current ml-[0.5px]" />
                  </span>
                  <span className="text-[10px] font-extrabold tracking-tight text-white/95 leading-none">
                    CinePulse <span className="text-[#00e68a]">HD</span>
                  </span>
                </div>
              </div>

              {/* Right Top Icons: Audio/Server Switcher, Sleep Timer, Mini Player, TV (Rotate), Help */}
              <div className="flex items-center gap-2.5 sm:gap-3.5">
                {/* 1-Tap Quick Audio & Server Switcher Pill */}
                {sources.length > 0 && (
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => {
                        setShowAudioServerMenu((v) => !v);
                        setShowSleepMenu(false);
                        setShowQualityMenu(false);
                      }}
                      className={`px-2 py-1 rounded-full text-[10px] font-extrabold border flex items-center gap-1 transition-colors ${
                        showAudioServerMenu
                          ? 'bg-[#00e68a] text-[#041b10] border-[#00e68a]'
                          : 'bg-black/55 text-white/95 border-white/20 hover:border-[#00e68a]/60'
                      }`}
                      title="Quick Audio Track & Cloud Server Switcher"
                    >
                      <Volume2 className="w-3 h-3 text-[#00e68a]" />
                      <span className="max-w-[78px] sm:max-w-[110px] truncate">
                        {activeSource?.audioLanguages?.[0] || activeSource?.audio || movie.language} · S#{selectedSourceIdx + 1}
                      </span>
                    </button>

                    {showAudioServerMenu && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="absolute top-8 right-0 z-40 w-60 rounded-2xl bg-[#11151d]/95 backdrop-blur-md border border-white/15 p-2.5 shadow-2xl space-y-1.5"
                      >
                        <div className="px-2 py-1 text-[10px] font-bold text-slate-400 border-b border-white/10 flex items-center justify-between">
                          <span>🎧 অডিও ট্র্যাক ও ফাস্ট সার্ভার</span>
                          <span className="text-[#00e68a]">{sources.length} Servers</span>
                        </div>
                        {sources.map((src, idx) => {
                          const isCurrent = selectedSourceIdx === idx;
                          const audioLabel =
                            src.audioLanguages?.join(' + ') || src.audio || movie.language;
                          return (
                            <button
                              key={src.id || idx}
                              type="button"
                              onClick={() => handleSelectSource(idx, true)}
                              className={`w-full px-2.5 py-2 rounded-xl text-left text-xs flex items-center justify-between transition-colors ${
                                isCurrent
                                  ? 'bg-[#0d3b29] text-[#00e68a] font-bold border border-[#00e68a]/40'
                                  : 'text-slate-200 hover:bg-white/10'
                              }`}
                            >
                              <div className="flex flex-col min-w-0 pr-2">
                                <span className="truncate font-bold">
                                  Server #{idx + 1} · {src.quality}p{' '}
                                  {src.quality >= 1080 ? 'FHD' : src.quality >= 720 ? 'HD' : 'Fast'}
                                </span>
                                <span className="text-[10px] text-slate-400 truncate">
                                  Audio: {audioLabel}
                                </span>
                              </div>
                              {isCurrent && <Check className="w-4 h-4 text-[#00e68a] shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Sleep Timer Button */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      setShowSleepMenu((v) => !v);
                      setShowAudioServerMenu(false);
                      setShowQualityMenu(false);
                    }}
                    className={`flex flex-col items-center justify-center transition-colors ${
                      sleepTimerMode !== null
                        ? 'text-[#00e68a]'
                        : 'text-white/95 hover:text-[#00e68a]'
                    }`}
                    title="Sleep Timer"
                  >
                    <Clock className="w-4 h-4" />
                    <span className="text-[9px] mt-0.5 leading-none font-bold">
                      {sleepRemainingSec !== null
                        ? `${Math.ceil(sleepRemainingSec / 60)}m`
                        : sleepTimerMode === 'end_of_ep'
                          ? 'EpEnd'
                          : 'Sleep'}
                    </span>
                  </button>

                  {showSleepMenu && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute top-8 right-0 z-40 w-48 rounded-2xl bg-[#11151d]/95 backdrop-blur-md border border-white/15 p-2 shadow-2xl space-y-1"
                    >
                      <div className="px-2 py-1 text-[10px] font-bold text-slate-400 border-b border-white/10">
                        🌙 স্লিপ টাইমার (অটো পজ)
                      </div>
                      {[
                        { label: 'Off (বন্ধ)', val: null },
                        { label: '15 Minutes', val: 15 },
                        { label: '30 Minutes', val: 30 },
                        { label: '45 Minutes', val: 45 },
                        { label: '60 Minutes', val: 60 },
                        ...(episodes.length > 1
                          ? [{ label: 'এই এপিসোড শেষে', val: 'end_of_ep' as const }]
                          : []),
                      ].map((opt) => (
                        <button
                          key={String(opt.val)}
                          type="button"
                          onClick={() => handleSetSleepTimer(opt.val)}
                          className={`w-full px-2.5 py-1.5 rounded-lg text-left text-xs flex items-center justify-between transition-colors ${
                            sleepTimerMode === opt.val
                              ? 'bg-[#0d3b29] text-[#00e68a] font-bold'
                              : 'text-slate-200 hover:bg-white/10'
                          }`}
                        >
                          <span>{opt.label}</span>
                          {sleepTimerMode === opt.val && (
                            <Check className="w-3.5 h-3.5 text-[#00e68a]" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* In-App Floating Mini Player Button */}
                {onToggleMiniPlayer && !isLandscapeMode && !isFullscreen && (
                  <button
                    type="button"
                    onClick={() => onToggleMiniPlayer(true)}
                    className="flex flex-col items-center justify-center text-white/95 hover:text-[#00e68a] transition-colors"
                    title="Minimize to Floating Mini Player"
                  >
                    <Minimize2 className="w-4 h-4" />
                    <span className="text-[9px] mt-0.5 leading-none">Mini</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleToggleFullscreen}
                  className={`flex flex-col items-center justify-center transition-colors ${
                    isLandscapeMode || isFullscreen
                      ? 'text-[#00e68a]'
                      : 'text-white/95 hover:text-[#00e68a]'
                  }`}
                  title="TV / Rotate Landscape"
                >
                  <Tv className="w-4 h-4" />
                  <span className="text-[9px] mt-0.5 leading-none">TV</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (isLandscapeMode || isFullscreen) {
                      handleToggleFullscreen();
                    }
                    onClose();
                    onOpenReportModal(detail?.title || movie.title);
                  }}
                  className="flex flex-col items-center justify-center text-white/95 hover:text-[#00e68a] transition-colors"
                  title="Help & Report"
                >
                  <HelpCircle className="w-4 h-4" />
                  <span className="text-[9px] mt-0.5 leading-none">Help</span>
                </button>
              </div>
            </div>
          )}

          {playerMode === 'trailer' && detail?.youtubeTrailerId ? (
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${detail.youtubeTrailerId}?autoplay=1&rel=0&playsinline=1`}
              title={detail.title}
              className="w-full h-full border-0"
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
            />
          ) : isEmbedSource && activeSource?.url ? (
            <iframe
              key={activeSource.url}
              src={activeSource.url}
              title={detail?.title || movie.title}
              style={videoFilterStyle}
              sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"
              referrerPolicy="no-referrer"
              className="w-full h-full border-0 bg-black"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
              allowFullScreen
            />
          ) : effectiveVideoUrl && !videoError ? (
            <>
              <video
                ref={videoRef}
                src={effectiveVideoUrl}
                poster={movie.poster || detail?.poster}
                playsInline
                autoPlay
                preload="auto"
                controlsList="nodownload nofullscreen noremoteplayback"
                disablePictureInPicture
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                style={videoFilterStyle}
                onPlay={(e) => {
                  setIsPlaying(true);
                  syncCleanAudioVolume(e.currentTarget);
                  resetOverlayAutoHide();
                }}
                onPlaying={(e) => {
                  setIsPlaying(true);
                  setHasStartedPlayback(true);
                  setIsBuffering(false);
                  syncCleanAudioVolume(e.currentTarget);
                }}
                onLoadedData={(e) => {
                  setHasStartedPlayback(true);
                  setIsBuffering(false);
                  syncCleanAudioVolume(e.currentTarget);
                  if (useHlsBridge && e.currentTarget.paused && e.currentTarget.currentTime < 0.5) {
                    startVideoWithiOSFallback(e.currentTarget);
                  }
                }}
                onCanPlayThrough={(e) => {
                  setHasStartedPlayback(true);
                  setIsBuffering(false);
                  syncCleanAudioVolume(e.currentTarget);
                }}
                onPause={() => {
                  setIsPlaying(false);
                  setShowOverlayControls(true);
                }}
                onWaiting={() => {
                  smoothPlaySecondsRef.current = 0;
                  setIsBuffering(true);
                }}
                onCanPlay={(e) => {
                  const v = e.currentTarget;
                  setHasStartedPlayback(true);
                  setIsBuffering(false);
                  syncCleanAudioVolume(v);
                  if (v.paused && v.currentTime < 0.5) {
                    startVideoWithiOSFallback(v);
                  }
                }}
                onSeeked={(e) => {
                  const v = e.currentTarget;
                  setHasStartedPlayback(true);
                  setIsBuffering(false);
                  syncCleanAudioVolume(v);
                  if (isPlaying && v.paused) {
                    v.play().catch(() => {});
                  }
                }}
                onLoadedMetadata={handleVideoLoadedMetadata}
                onProgress={(e) => {
                  const v = e.currentTarget;
                  if (v.buffered && v.buffered.length > 0) {
                    const localBufEnd = v.buffered.end(v.buffered.length - 1);
                    setBufferedEnd(
                      useHlsBridge ? iosSegmentStartSec + localBufEnd : localBufEnd
                    );
                  }
                }}
                onTimeUpdate={(e) => {
                  if (isScrubbing) return;
                  const v = e.currentTarget;
                  syncCleanAudioVolume(v);
                  if (v.readyState >= 2) {
                    if (!hasStartedPlayback) setHasStartedPlayback(true);
                    if (isBuffering) setIsBuffering(false);
                  }
                  const segDur = v.duration || 0;
                  if (
                    useHlsBridge &&
                    iosControllerRef.current &&
                    segDur > 0 &&
                    segDur - v.currentTime < 24
                  ) {
                    iosControllerRef.current.ensureNextSegmentPrebuffered(
                      iosCurrentSegIndex + 1
                    );
                  }
                  const globalSec = Math.floor(
                    useHlsBridge ? iosSegmentStartSec + v.currentTime : v.currentTime
                  );
                  const totalFromCtrl = iosControllerRef.current?.getTotalDurationSec() || 0;
                  const dur = Math.floor(totalFromCtrl > 0 ? totalFromCtrl : segDur);
                  if (globalSec !== lastRecordedSecondRef.current) {
                    lastRecordedSecondRef.current = globalSec;
                    setCurrentTime(globalSec);
                    if (dur > 0 && dur !== duration) setDuration(dur);

                    // Background Pre-Buffering for Next Episode in Series/Drama
                    if (
                      hasNextEpisode &&
                      nextEpisodeItem &&
                      prewarmedNextEpIdxRef.current !== selectedEpIdx + 1 &&
                      (globalSec >= 20 || (dur > 0 && dur - globalSec <= 50))
                    ) {
                      prewarmedNextEpIdxRef.current = selectedEpIdx + 1;
                      const nextBestIdx = pickBestSourceIndexForNet(
                        nextEpisodeItem.sources || [],
                        autoNetQuality
                      );
                      const nextSrc =
                        nextEpisodeItem.sources?.[nextBestIdx] || nextEpisodeItem.sources?.[0];
                      if (nextSrc?.url && nextSrc.type !== 'embed') {
                        warmStreamConnection(nextSrc.url);
                        setNextEpPrewarmed(true);
                      }
                    }

                    if (globalSec > 5 && globalSec % 10 === 0) {
                      onRecordWatchProgress(
                        movie,
                        activeEpisode,
                        selectedEpIdx,
                        activeSource,
                        globalSec,
                        dur
                      );
                    }
                  }
                }}
                onEnded={() => {
                  if (sleepTimerMode === 'end_of_ep') {
                    setIsPlaying(false);
                    setSleepTimerMode(null);
                    triggerHud(
                      'toast',
                      '🌙 স্লিপ টাইমার: এপিসোড শেষে ভিডিও পজ করা হয়েছে',
                      undefined,
                      3000
                    );
                    return;
                  }
                  if (useHlsBridge && iosControllerRef.current) {
                    advanceToNextIosSegment().then((advanced) => {
                      if (!advanced) {
                        setIsPlaying(false);
                        if (autoNextEp && selectedEpIdx + 1 < episodes.length) {
                          handleSelectEpisode(selectedEpIdx + 1);
                        }
                      }
                    });
                    return;
                  }
                  setIsPlaying(false);
                  if (autoNextEp && selectedEpIdx + 1 < episodes.length) {
                    handleSelectEpisode(selectedEpIdx + 1);
                  }
                }}
                onError={handleVideoError}
                className="w-full h-full bg-black transition-[filter] duration-100 pointer-events-none select-none"
              />

              {/* Double-Tap Seek Ripple Overlay Animation (Left -10s / Right +10s) */}
              {seekRipple && !isMiniPlayer && (
                <div
                  key={seekRipple.id}
                  className={`pointer-events-none absolute inset-y-0 z-30 w-[38%] flex flex-col items-center justify-center bg-white/15 backdrop-blur-[2px] animate-pulse ${
                    seekRipple.side === 'left'
                      ? 'left-0 rounded-r-full'
                      : 'right-0 rounded-l-full'
                  }`}
                >
                  <div className="w-11 h-11 rounded-full bg-[#00e68a]/25 border border-[#00e68a]/60 text-[#00e68a] flex items-center justify-center shadow-lg">
                    {seekRipple.side === 'left' ? (
                      <RotateCcw className="w-5 h-5" />
                    ) : (
                      <RotateCw className="w-5 h-5" />
                    )}
                  </div>
                  <span className="mt-1.5 text-xs font-extrabold text-white drop-shadow">
                    {seekRipple.delta > 0 ? `+${seekRipple.delta}s` : `${seekRipple.delta}s`}
                  </span>
                </div>
              )}

              {/* Floating "Next Episode Pre-Loaded" 1-Tap Pill when nearing end of episode */}
              {!isMiniPlayer &&
                hasNextEpisode &&
                nextEpisodeItem &&
                duration > 60 &&
                duration - currentTime <= 45 &&
                duration - currentTime > 0 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelectEpisode(selectedEpIdx + 1);
                    }}
                    className="absolute bottom-14 right-3.5 z-30 px-3.5 py-1.5 rounded-full bg-[#00e68a] text-[#041b10] text-xs font-extrabold flex items-center gap-1.5 shadow-[0_8px_24px_rgba(0,230,138,0.5)] hover:scale-105 active:scale-95 transition-all"
                  >
                    <FastForward className="w-3.5 h-3.5 fill-current" />
                    <span>
                      পরবর্তী এপিসোড ({formatEpisodeTileBadge(nextEpisodeItem, selectedEpIdx + 1)}) ·{' '}
                      {nextEpPrewarmed ? '⚡ Ready' : `${ Math.max(1, duration - currentTime)}s`}
                    </span>
                  </button>
                )}


              {/* Single Transparent Bottom Bangla Subtitle (Zero black background box — crisp white text with dark stroke) */}
              {!isMiniPlayer && autoBanglaSubEnabled && activeBanglaCueText && (
                <div
                  title={subtitleName || 'বাংলা সাবটাইটেল'}
                  data-vtt={subtitleUrl || undefined}
                  className={`pointer-events-none select-none absolute inset-x-4 z-20 flex justify-center transition-all duration-150 ${
                    showOverlayControls || !isPlaying ? 'bottom-9 sm:bottom-11' : 'bottom-2.5'
                  }`}
                >
                  <div
                    className={`max-w-[92%] sm:max-w-[82%] bg-transparent text-center font-semibold text-white leading-snug tracking-normal whitespace-pre-line ${
                      subFontSize === 'lg'
                        ? 'text-xs sm:text-sm'
                        : subFontSize === 'md'
                          ? 'text-[11px] sm:text-xs'
                          : 'text-[10px] sm:text-[11.5px]'
                    }`}
                    style={{
                      fontFamily: "'Hind Siliguri', 'Plus Jakarta Sans', sans-serif",
                      textShadow:
                        '0 1px 3px rgba(0,0,0,0.98), 0 0 6px rgba(0,0,0,0.95), -1px -1px 0 rgba(0,0,0,0.9), 1px -1px 0 rgba(0,0,0,0.9), -1px 1px 0 rgba(0,0,0,0.9), 1px 1px 0 rgba(0,0,0,0.9)',
                    }}
                  >
                    {activeBanglaCueText}
                  </div>
                </div>
              )}

              {/* iPhone / Mobile 1-Tap Unmute Pill when Autoplay started muted */}
              {autoMutedForiOS && isMuted && !isHold2x && !isMiniPlayer && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsMuted(false);
                    setAutoMutedForiOS(false);
                    if (videoRef.current) {
                      videoRef.current.muted = false;
                      videoRef.current.play().catch(() => {});
                    }
                  }}
                  className="absolute bottom-12 left-3.5 z-30 px-3.5 py-1.5 rounded-full bg-[#00e68a] text-[#041b10] text-xs font-extrabold flex items-center gap-1.5 shadow-xl animate-pulse"
                >
                  <Volume2 className="w-4 h-4" />
                  <span>Tap for Sound</span>
                </button>
              )}

              {/* Hold 2x Speed Pill Indicator */}
              {isHold2x && !isMiniPlayer && (
                <div className="absolute top-12 left-1/2 -translate-x-1/2 z-30 px-3.5 py-1 rounded-full bg-black/80 border border-[#00e68a]/50 text-[#00e68a] text-xs font-extrabold flex items-center gap-1.5 shadow-lg pointer-events-none select-none">
                  <FastForward className="w-3.5 h-3.5 fill-current" />
                  <span>2x Fast Speed</span>
                </div>
              )}

              {/* MovieBox Center Gesture HUD (Brightness / Volume / Seek) */}
              {hudNotice && !isMiniPlayer && (
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 px-4 py-3 rounded-2xl bg-black/85 backdrop-blur-md border border-white/15 text-white flex flex-col items-center gap-2 min-w-[165px] shadow-2xl pointer-events-none">
                  <div className="flex items-center gap-2 text-xs font-bold text-center">
                    {hudNotice.type === 'brightness' && (
                      <Sun className="w-4 h-4 text-amber-400 shrink-0" />
                    )}
                    {hudNotice.type === 'volume' && (
                      <Volume2 className="w-4 h-4 text-[#00e68a] shrink-0" />
                    )}
                    {hudNotice.type === 'seek' && (
                      <FastForward className="w-4 h-4 text-[#00e68a] shrink-0" />
                    )}
                    <span>{hudNotice.label}</span>
                  </div>
                  {hudNotice.percent !== undefined && (
                    <div className="w-28 h-1.5 rounded-full bg-white/20 overflow-hidden">
                      <div
                        className="h-full bg-[#00e68a] transition-all duration-75"
                        style={{ width: `${Math.max(0, Math.min(100, hudNotice.percent))}%` }}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* MovieBox Interactive Brightness Slider Panel */}
              {showBrightnessPanel && !isScreenLocked && !isMiniPlayer && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-11 right-3 z-30 w-64 sm:w-72 rounded-2xl bg-[#11151d]/95 backdrop-blur-md border border-white/15 p-3.5 shadow-2xl space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-white">
                      <Sun className="w-4 h-4 text-amber-400" />
                      <span>Screen Brightness</span>
                    </div>
                    <span className="text-xs font-mono font-bold text-[#00e68a]">
                      {brightness}%
                    </span>
                  </div>

                  <input
                    type="range"
                    min={20}
                    max={160}
                    value={brightness}
                    onChange={(e) => handleChangeBrightness(Number(e.target.value))}
                    className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-[#00e68a]"
                  />

                  <div className="grid grid-cols-4 gap-1.5">
                    {[
                      { label: '70%', val: 70 },
                      { label: '100%', val: 100 },
                      { label: '130%', val: 130 },
                      { label: '160%', val: 160 },
                    ].map((preset) => (
                      <button
                        key={preset.val}
                        type="button"
                        onClick={() => handleChangeBrightness(preset.val)}
                        className={`py-1 rounded-lg text-[11px] font-bold transition-colors ${
                          brightness === preset.val
                            ? 'bg-[#00e68a] text-[#051b11]'
                            : 'bg-white/10 text-slate-300 hover:bg-white/15'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-400 text-center">
                    Tip: ভিডিওর বাম পাশে উপর-নিচ সোয়াইপ করেও ব্রাইটনেস বাড়াতে/কমাতে পারবেন
                  </p>
                </div>
              )}

              {/* Subtle Buffering Spinner */}
              {isBuffering && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
                  <div className="p-2.5 rounded-full bg-black/50 backdrop-blur-xs">
                    <Loader2 className="w-6 h-6 animate-spin text-white" />
                  </div>
                </div>
              )}

              {/* Resumed Timestamp Banner (Appears briefly for ~1.2s and auto-disappears) */}
              {resumedBannerSec !== null && !isMiniPlayer && (
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    setResumedBannerSec(null);
                  }}
                  className="absolute left-3.5 top-12 bg-black/80 backdrop-blur-md px-2.5 py-1 rounded-lg text-[11px] text-slate-200 flex items-center gap-2 border border-white/10 z-25 transition-opacity"
                >
                  <span>Resumed at {formatSeconds(resumedBannerSec)}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      seekVideoToGlobalTime(introSkipSec > 0 ? introSkipSec : 0);
                      setResumedBannerSec(null);
                    }}
                    className="text-[#00e68a] font-semibold underline"
                  >
                    Restart
                  </button>
                </div>
              )}
            </>
          ) : loading || (useHlsBridge && !isEmbedSource && activeSource?.url && !effectiveVideoUrl && !videoError) ? (
            <div className="relative w-full h-full flex items-center justify-center overflow-hidden bg-black">
              {(movie.poster || detail?.poster) && (
                <img
                  src={movie.poster || detail?.poster}
                  alt={movie.title}
                  className="absolute inset-0 w-full h-full object-cover opacity-50 pointer-events-none"
                />
              )}
              <div className="relative z-10 p-2.5 rounded-full bg-black/50 backdrop-blur-xs">
                <Loader2 className="w-6 h-6 animate-spin text-[#00e68a]" />
              </div>
            </div>
          ) : (
            <div className="relative w-full h-full flex flex-col items-center justify-center p-5 text-center bg-gradient-to-t from-black via-[#0d1118] to-[#131822]">
              <div className="max-w-md space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-[#00e68a]/15 border border-[#00e68a]/40 text-[#00e68a] flex items-center justify-center mx-auto">
                  <Smartphone className="w-6 h-6" />
                </div>
                <h3 className="text-sm sm:text-base font-bold text-white">
                  {activeSource?.url
                    ? 'External / VLC Stream Ready'
                    : 'Direct Cloud Download Ready'}
                </h3>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {activeSource?.url
                    ? 'যদি এই কোয়ালিটি আপনার ফোনের ব্রাউজারে সাপোর্ট না করে, তবে নিচের "Retry Player" বাটনে চাপুন অথবা VLC/Download ব্যবহার করুন।'
                    : 'নিচের Download বাটন থেকে যেকোনো রেজোলিউশনে সরাসরি ডাউনলোড করুন।'}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
                  {activeSource?.url && (
                    <button
                      type="button"
                      onClick={() => {
                        setFailedSourceIndices([]);
                        setSelectedSourceIdx(0);
                        if (isAppleWebKitDevice()) {
                          setUseHlsBridge(true);
                        } else {
                          setUseHlsBridge(false);
                        }
                        setVideoError(false);
                      }}
                      className="min-h-[40px] px-4 py-2 rounded-full bg-[#00e68a] text-[#051b11] text-xs font-extrabold flex items-center gap-1.5"
                    >
                      <Play className="w-4 h-4 fill-current" />
                      <span>Retry Inline Player</span>
                    </button>
                  )}
                  {activeSource?.url && (
                    <a
                      href={vlcUrl}
                      className="min-h-[40px] px-4 py-2 rounded-full bg-white/10 hover:bg-white/15 text-white text-xs font-bold flex items-center gap-1.5"
                    >
                      <Play className="w-4 h-4 text-[#00e68a] fill-current" />
                      <span>Play in VLC</span>
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowDownloadSheet(true)}
                    className="min-h-[40px] px-4 py-2 rounded-full bg-white/10 hover:bg-white/15 text-white text-xs font-bold flex items-center gap-1.5"
                  >
                    <Download className="w-4 h-4 text-[#00e68a]" />
                    <span>Download</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Bottom Overlaid Transport Bar Inside Full Video */}
          {!isEmbedSource && !isMiniPlayer && (
            <div
              onClick={(e) => e.stopPropagation()}
              className={`absolute bottom-0 inset-x-0 z-25 px-3.5 pb-2 pt-6 bg-gradient-to-t from-black/85 via-black/40 to-transparent flex items-center gap-2.5 sm:gap-3 transition-opacity duration-200 ${
                showOverlayControls || !isPlaying ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}
            >
              <button
                type="button"
                onClick={handleTogglePlayPause}
                aria-label={isPlaying ? 'Pause' : 'Play'}
                className="text-white hover:text-[#00e68a] active:scale-90 transition-all shrink-0"
              >
                {isPlaying ? (
                  <Pause className="w-5 h-5 fill-current" />
                ) : (
                  <Play className="w-5 h-5 fill-current" />
                )}
              </button>

              {/* Quick Next Episode 1-Tap Button in Bottom Bar for Series */}
              {hasNextEpisode && (
                <button
                  type="button"
                  onClick={() => handleSelectEpisode(selectedEpIdx + 1)}
                  title="Play Next Episode"
                  className="text-white/90 hover:text-[#00e68a] active:scale-90 transition-all shrink-0 flex items-center gap-0.5 text-[10px] font-extrabold"
                >
                  <FastForward className="w-4 h-4 fill-current" />
                </button>
              )}

              {/* Sleek Interactive Scrubber Bar (Supports Touch Drag, Mouse Drag, and Tap-to-Seek in Portrait & Landscape) */}
              <div
                data-scrubber="true"
                onClick={(e) => {
                  e.stopPropagation();
                  handleScrubberPointerSeek(e.clientX, e.clientY, e.currentTarget);
                }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  setIsScrubbing(true);
                  resetOverlayAutoHide();
                }}
                onMouseMove={(e) => {
                  e.stopPropagation();
                  const { targetSec, percent } = computeScrubberTarget(
                    e.clientX,
                    e.clientY,
                    e.currentTarget
                  );
                  setScrubPreview({ sec: targetSec, percent });
                  if (isScrubbing) {
                    setCurrentTime(targetSec);
                  }
                }}
                onMouseUp={(e) => {
                  e.stopPropagation();
                  if (isScrubbing) {
                    setIsScrubbing(false);
                    const { targetSec } = computeScrubberTarget(
                      e.clientX,
                      e.clientY,
                      e.currentTarget
                    );
                    commitScrubberSeek(targetSec);
                  }
                }}
                onMouseLeave={() => {
                  if (isScrubbing && scrubPreview !== null) {
                    setIsScrubbing(false);
                    commitScrubberSeek(scrubPreview.sec);
                  }
                  setScrubPreview(null);
                }}
                onTouchStart={(e) => {
                  e.stopPropagation();
                  setIsScrubbing(true);
                  resetOverlayAutoHide();
                  if (e.touches[0]) {
                    previewScrubberAtPointer(
                      e.touches[0].clientX,
                      e.touches[0].clientY,
                      e.currentTarget
                    );
                  }
                }}
                onTouchMove={(e) => {
                  e.stopPropagation();
                  if (e.touches[0]) {
                    previewScrubberAtPointer(
                      e.touches[0].clientX,
                      e.touches[0].clientY,
                      e.currentTarget
                    );
                  }
                }}
                onTouchEnd={(e) => {
                  e.stopPropagation();
                  setIsScrubbing(false);
                  const changed = e.changedTouches?.[0];
                  if (changed) {
                    const { targetSec } = computeScrubberTarget(
                      changed.clientX,
                      changed.clientY,
                      e.currentTarget
                    );
                    commitScrubberSeek(targetSec);
                  } else if (scrubPreview !== null) {
                    commitScrubberSeek(scrubPreview.sec);
                  }
                  setScrubPreview(null);
                  resetOverlayAutoHide();
                }}
                className="relative flex-1 min-w-[60px] flex items-center h-8 cursor-pointer touch-none select-none"
              >
                {/* Native Range Input Layer for 100% Reliable Mobile & Desktop Dragging */}
                <input
                  type="range"
                  min={0}
                  max={effectiveDuration}
                  step={1}
                  value={Math.min(effectiveDuration, Math.max(0, activePlayheadSec))}
                  onClick={(e) => e.stopPropagation()}
                  onTouchStart={(e) => {
                    e.stopPropagation();
                    setIsScrubbing(true);
                    resetOverlayAutoHide();
                  }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    setIsScrubbing(true);
                    resetOverlayAutoHide();
                  }}
                  onChange={(e) => {
                    e.stopPropagation();
                    const nextSec = Number(e.target.value);
                    const pct = (nextSec / effectiveDuration) * 100;
                    setIsScrubbing(true);
                    setScrubPreview({ sec: nextSec, percent: pct });
                    setCurrentTime(nextSec);
                  }}
                  onTouchEnd={(e) => {
                    e.stopPropagation();
                    const finalSec =
                      scrubPreview !== null
                        ? scrubPreview.sec
                        : Number((e.currentTarget as HTMLInputElement).value);
                    setIsScrubbing(false);
                    setScrubPreview(null);
                    commitScrubberSeek(finalSec);
                    resetOverlayAutoHide();
                  }}
                  onMouseUp={(e) => {
                    e.stopPropagation();
                    const finalSec =
                      scrubPreview !== null
                        ? scrubPreview.sec
                        : Number((e.currentTarget as HTMLInputElement).value);
                    setIsScrubbing(false);
                    setScrubPreview(null);
                    commitScrubberSeek(finalSec);
                    resetOverlayAutoHide();
                  }}
                  aria-label="Seek video timeline"
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-30 touch-none"
                />

                {/* Floating Scrubber Preview Card (Thumbnail + Target Timestamp) */}
                {scrubPreview !== null && displayDuration > 0 && (
                  <div
                    className="pointer-events-none absolute bottom-8 -translate-x-1/2 z-40 flex flex-col items-center"
                    style={{
                      left: `${Math.max(12, Math.min(88, scrubPreview.percent))}%`,
                    }}
                  >
                    <div className="w-24 h-14 rounded-lg overflow-hidden border border-[#00e68a]/70 bg-black shadow-2xl relative">
                      {(detail?.backdrop || movie.poster || detail?.poster) && (
                        <img
                          src={detail?.backdrop || movie.poster || detail?.poster}
                          alt="Preview"
                          className="w-full h-full object-cover opacity-85"
                        />
                      )}
                      <div className="absolute inset-x-0 bottom-0 bg-black/80 text-[#00e68a] text-[10px] font-mono font-extrabold text-center py-0.5">
                        {formatSeconds(scrubPreview.sec)}
                      </div>
                    </div>
                  </div>
                )}

                <div className="w-full h-1.5 bg-white/30 rounded-full overflow-hidden relative">
                  <div
                    className="absolute inset-y-0 left-0 bg-white/45 transition-all duration-200"
                    style={{ width: `${bufferedPercent}%` }}
                  />
                  <div
                    className="absolute inset-y-0 left-0 bg-[#00e68a]"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <div
                  className="w-3.5 h-3.5 rounded-full bg-[#00e68a] border-2 border-white shadow-[0_0_8px_rgba(0,230,138,0.95)] pointer-events-none absolute -translate-x-1/2"
                  style={{ left: `${progressPercent}%` }}
                />
              </div>

              {/* Single Unified Timer (00:44/44:39) */}
              <div className="text-[11px] sm:text-xs font-sans tabular-nums text-white/95 shrink-0">
                {formatSeconds(activePlayheadSec)}/{formatSeconds(displayDuration || 0)}
              </div>

              {/* Auto / Manual Quality Selector Button Inside Player Bottom Bar */}
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setShowQualityMenu((v) => !v);
                    setShowAudioServerMenu(false);
                    setShowSleepMenu(false);
                  }}
                  title="Change Video Quality (Auto Network or Manual)"
                  className={`px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-bold border flex items-center gap-1 transition-colors ${
                    autoNetQuality
                      ? 'bg-[#0d3b29]/90 text-[#00e68a] border-[#00e68a]/50'
                      : 'bg-white/15 text-white border-white/25 hover:bg-white/25'
                  }`}
                >
                  <Wifi className="w-3 h-3" />
                  <span>
                    {autoNetQuality
                      ? `Auto·${activeSource?.quality || 720}p`
                      : `${activeSource?.quality || 720}p`}
                  </span>
                </button>

                {showQualityMenu && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="absolute bottom-9 right-0 z-40 w-56 rounded-xl bg-[#11151d]/95 backdrop-blur-md border border-white/15 p-2 shadow-2xl space-y-1"
                  >
                    <div className="px-2 py-1 text-[10px] font-bold text-slate-400 border-b border-white/10 flex items-center justify-between">
                      <span>ভিডিও কোয়ালিটি (Auto / Manual)</span>
                      <span className="text-[#00e68a]">{netStatusLabel.split('·')[0]}</span>
                    </div>

                    {/* Option 1: Auto Network Quality */}
                    <button
                      type="button"
                      onClick={handleEnableAutoQuality}
                      className={`w-full px-2.5 py-2 rounded-lg text-left text-xs flex items-center justify-between transition-colors ${
                        autoNetQuality
                          ? 'bg-[#0d3b29] text-[#00e68a] font-bold'
                          : 'text-slate-200 hover:bg-white/10'
                      }`}
                    >
                      <div className="flex flex-col">
                        <span>⚡ Auto (নেটওয়ার্ক অনুযায়ী)</span>
                        <span className="text-[10px] text-slate-400 font-normal">
                          {netStatusLabel}
                        </span>
                      </div>
                      {autoNetQuality && <Check className="w-4 h-4 text-[#00e68a] shrink-0" />}
                    </button>

                    {/* Manual Quality Options */}
                    {sources.map((src, idx) => {
                      const isManualSelected = !autoNetQuality && selectedSourceIdx === idx;
                      return (
                        <button
                          key={src.id || idx}
                          type="button"
                          onClick={() => handleSelectSource(idx, true)}
                          className={`w-full px-2.5 py-1.5 rounded-lg text-left text-xs flex items-center justify-between transition-colors ${
                            isManualSelected
                              ? 'bg-[#0d3b29] text-[#00e68a] font-bold'
                              : 'text-slate-200 hover:bg-white/10'
                          }`}
                        >
                          <span className="truncate">
                            {src.quality}p {src.quality >= 1080 ? 'Full HD' : src.quality >= 720 ? 'HD' : 'Fast SD'} ·{' '}
                            <span className="text-[10px] text-slate-400">
                              {src.audioLanguages.join('+') || src.audio}
                            </span>
                          </span>
                          {isManualSelected && <Check className="w-4 h-4 text-[#00e68a] shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Picture-in-Picture / Mini Player Icon */}
              <button
                type="button"
                onClick={handleTogglePiP}
                aria-label="Floating Mini Player"
                title="Floating Mini Player"
                className="text-white/95 hover:text-[#00e68a] active:scale-90 transition-all shrink-0"
              >
                <PictureInPicture2 className="w-5 h-5" />
              </button>

              {/* Fullscreen / Landscape Rotate [ ] Icon */}
              <button
                type="button"
                onClick={handleToggleFullscreen}
                aria-label="Rotate Landscape / Fullscreen"
                title="Rotate Landscape / Fullscreen"
                className="text-white/95 hover:text-[#00e68a] active:scale-90 transition-all shrink-0"
              >
                {isLandscapeMode || isFullscreen ? (
                  <Minimize className="w-5 h-5 text-[#00e68a]" />
                ) : (
                  <Maximize className="w-5 h-5" />
                )}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Main Content Container Below Video (Hidden when rotated to Fullscreen Landscape or in Floating Mini Player) */}
      <div
        className={`w-full max-w-5xl mx-auto px-4 sm:px-6 pt-3.5 pb-28 space-y-5 flex-1 ${
          isMiniPlayer || isLandscapeMode || isFullscreen ? 'hidden' : ''
        }`}
      >
        {/* 1. Title + "Info >" inline + Rating & Metadata Line (Matches Reference Screenshot) */}
        <div className="space-y-1.5">
          <div className="flex items-baseline gap-2.5 flex-wrap">
            <h1 className="text-lg sm:text-xl font-bold text-white tracking-tight leading-snug">
              {detail?.title || movie.title}
            </h1>
            <button
              type="button"
              onClick={() => setBottomTab((t) => (t === 'infoCast' ? 'forYou' : 'infoCast'))}
              className="text-xs sm:text-sm text-slate-400 hover:text-white inline-flex items-center gap-0.5 shrink-0"
            >
              <span>Info</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm text-slate-400">
            {normalizeMovieCardItem(movie).isHot && (
              <>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-gradient-to-r from-orange-500 to-rose-500 text-white font-extrabold text-xs shadow">
                  <Flame className="w-3 h-3 fill-current" />
                  <span>HOT</span>
                </span>
                <span className="text-slate-600">|</span>
              </>
            )}
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-400/30 text-[#00e68a] font-bold text-xs">
              <Clock className="w-3 h-3" />
              <span>{normalizeMovieCardItem(movie).timeAgo}</span>
            </span>
            <span className="text-slate-600">|</span>
            <Tv className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-slate-600">|</span>
            <span className="flex items-center gap-1 text-amber-400 font-semibold">
              <Star className="w-3.5 h-3.5 fill-current" />
              <span>{normalizeMovieCardItem(movie).rating || ratingScore}</span>
            </span>
            <span className="text-slate-600">|</span>
            <span>{detail?.releaseDate || '2026'}</span>
            <span className="text-slate-600">|</span>
            <span>{detail?.language || movie.language}</span>
            <span className="text-slate-600">|</span>
            <span>{detail?.typeBadge || movie.typeBadge}</span>
            <span className="text-slate-600">|</span>
            <span>
              {episodes.length > 1
                ? `${distinctSeasons.length || 1} seasons`
                : detail?.quality || movie.quality}
            </span>
          </div>
        </div>

        {/* 2. Horizontal Action Pill Buttons */}
        <div className="flex items-center gap-2.5 overflow-x-auto no-scrollbar pb-1">
          <button
            type="button"
            onClick={() => onToggleWatchlist(movie, currentFolder)}
            className={`min-h-[42px] px-4 py-2 rounded-full text-xs sm:text-sm font-semibold flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors ${
              isInWatchlist
                ? 'bg-[#00e68a]/20 text-[#00e68a] border border-[#00e68a]/40'
                : 'bg-[#1c2029] hover:bg-[#252a36] text-slate-200'
            }`}
          >
            <ListPlus className="w-4 h-4" />
            <span>{isInWatchlist ? 'Added to list' : 'Add to list'}</span>
          </button>

          <button
            type="button"
            onClick={handleShare}
            className="min-h-[42px] px-4 py-2 rounded-full bg-[#1c2029] hover:bg-[#252a36] text-slate-200 text-xs sm:text-sm font-semibold flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
          >
            {copiedShare ? (
              <>
                <Check className="w-4 h-4 text-[#00e68a]" />
                <span className="text-[#00e68a]">Copied</span>
              </>
            ) : (
              <>
                <Share2 className="w-4 h-4" />
                <span>Share</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => setShowDownloadSheet((s) => !s)}
            className="min-h-[42px] px-4 py-2 rounded-full bg-[#1c2029] hover:bg-[#252a36] text-slate-200 text-xs sm:text-sm font-semibold flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
          >
            <Download className="w-4 h-4" />
            <span>Download</span>
          </button>

          {/* Auto Bangla Subtitle ON/OFF + Sub Sync Drawer */}
          <button
            type="button"
            onClick={() => {
              const next = !autoBanglaSubEnabled;
              setAutoBanglaSubEnabled(next);
              triggerHud(
                'toast',
                next ? 'বাংলা অটো সাবটাইটেল চালু হয়েছে' : 'বাংলা সাবটাইটেল বন্ধ করা হয়েছে'
              );
            }}
            className={`min-h-[42px] px-4 py-2 rounded-full text-xs sm:text-sm font-bold flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors ${
              autoBanglaSubEnabled
                ? 'bg-[#0d3b2e] text-[#00e68a] border border-[#00e68a]/50 shadow'
                : 'bg-[#1c2029] hover:bg-[#252a36] text-slate-300'
            }`}
          >
            {loadingAutoSub ? (
              <Loader2 className="w-4 h-4 animate-spin text-[#00e68a]" />
            ) : (
              <Subtitles className="w-4 h-4 text-[#00e68a]" />
            )}
            <span>বাংলা Sub: {autoBanglaSubEnabled ? 'ON' : 'OFF'}</span>
          </button>

          {autoBanglaSubEnabled && (
            <button
              type="button"
              onClick={() => setShowSubSyncPanel((v) => !v)}
              className={`min-h-[42px] px-3.5 py-2 rounded-full text-xs font-bold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors ${
                showSubSyncPanel || subOffsetSec !== 0
                  ? 'bg-[#0d3b2e] text-[#00e68a] border border-[#00e68a]/50'
                  : 'bg-[#1c2029] hover:bg-[#252a36] text-slate-200'
              }`}
              title="Adjust Subtitle Timing Sync or Switch Subtitle Track"
            >
              <span>
                Sub Settings {subOffsetSec !== 0 ? `(${subOffsetSec > 0 ? `+${subOffsetSec}s` : `${subOffsetSec}s`})` : ''}
              </span>
            </button>
          )}

          <input
            ref={subtitleInputRef}
            type="file"
            accept=".srt,.vtt"
            onChange={handleSubtitleFileUpload}
            className="hidden"
          />

          {detail?.youtubeTrailerId && (
            <button
              type="button"
              onClick={() => setPlayerMode((m) => (m === 'trailer' ? 'stream' : 'trailer'))}
              className="min-h-[42px] px-4 py-2 rounded-full bg-[#1c2029] hover:bg-[#252a36] text-slate-200 text-xs sm:text-sm font-semibold flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
            >
              <Film className="w-4 h-4 text-amber-400" />
              <span>{playerMode === 'trailer' ? 'Back to Stream' : 'Trailer'}</span>
            </button>
          )}
        </div>

        {/* Interactive Subtitle Sync, Size, Upload & Live OpenSubtitles Search Panel */}
        {autoBanglaSubEnabled && showSubSyncPanel && (
          <div className="rounded-2xl bg-[#141821] border border-white/10 p-3.5 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-xs font-bold text-white flex items-center gap-1.5">
                <Subtitles className="w-4 h-4 text-[#00e68a]" />
                <span>সাবটাইটেল সেটিংস ও সিঙ্ক ({subtitleCues.length} লাইন)</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const nextSize =
                      subFontSize === 'sm' ? 'md' : subFontSize === 'md' ? 'lg' : 'sm';
                    setSubFontSize(nextSize);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-[#1c212e] border border-white/10 text-[11px] font-bold text-slate-200"
                >
                  Size: {subFontSize.toUpperCase()}
                </button>
                <button
                  type="button"
                  onClick={() => subtitleInputRef.current?.click()}
                  className="px-2.5 py-1 rounded-lg bg-[#1c212e] border border-white/10 text-[11px] font-bold text-cyan-400"
                >
                  Upload .SRT
                </button>
              </div>
            </div>

            {/* 1. Timing Sync Offset Controls (For prints with 12s intro or delay) */}
            <div className="space-y-1.5">
              <div className="text-[11px] text-slate-400">
                ভয়েসের সাথে সাবটাইটেল আগে/পরে হলে টাইমিং মিলিয়ে নিন (Current Offset:{' '}
                <strong className="text-[#00e68a]">
                  {subOffsetSec > 0 ? `+${subOffsetSec}s` : `${subOffsetSec}s`}
                </strong>
                ):
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {[
                  { label: '-2s', delta: -2 },
                  { label: '-0.5s', delta: -0.5 },
                  { label: '-0.2s', delta: -0.2 },
                  { label: 'Reset (0s)', reset: true },
                  { label: '+0.2s', delta: 0.2 },
                  { label: '+0.5s', delta: 0.5 },
                  { label: '+2s', delta: 2 },
                  { label: '+12s (Intro Skip Sync)', abs: 12 },
                ].map((btn) => (
                  <button
                    key={btn.label}
                    type="button"
                    onClick={() => {
                      const nextVal = btn.reset
                        ? 0
                        : btn.abs !== undefined
                          ? btn.abs
                          : Number((subOffsetSec + (btn.delta || 0)).toFixed(1));
                      setSubOffsetSec(nextVal);
                      triggerHud(
                        'toast',
                        `সাবটাইটেল টাইমিং: ${nextVal > 0 ? `+${nextVal}s` : `${nextVal}s`}`
                      );
                    }}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
                      (btn.reset && subOffsetSec === 0) ||
                      (btn.abs !== undefined && subOffsetSec === btn.abs)
                        ? 'bg-[#00e68a] text-[#041b10] border-[#00e68a]'
                        : 'bg-[#1c212e] hover:bg-[#262c3d] text-slate-200 border-white/10'
                    }`}
                  >
                    {btn.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 2. Switch Between Multiple Matched OpenSubtitles Release Tracks */}
            {availableSubTracks.length > 1 && (
              <div className="space-y-1.5">
                <div className="text-[11px] text-slate-400">
                  অন্য প্রিন্টের সাবটাইটেল ট্র্যাক নির্বাচন করুন ({availableSubTracks.length}টি ট্র্যাক পাওয়া গেছে):
                </div>
                <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
                  {availableSubTracks.map((trk, idx) => (
                    <button
                      key={trk.id || idx}
                      type="button"
                      onClick={async () => {
                        setActiveSubTrackIdx(idx);
                        setLoadingAutoSub(true);
                        try {
                          const loaded = await loadSubtitleTrackByUrl(
                            trk,
                            Math.max(0, currentTime - subOffsetSec)
                          );
                          setSubtitleCues(loaded);
                          setSubtitleName(`${trk.label} · ${trk.releaseName}`);
                          triggerHud('toast', `লোড হয়েছে: ${trk.label}`);
                        } catch {
                          triggerHud('toast', 'এই ট্র্যাকটি লোড করা যায়নি');
                        } finally {
                          setLoadingAutoSub(false);
                        }
                      }}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold border whitespace-nowrap shrink-0 transition-colors ${
                        activeSubTrackIdx === idx
                          ? 'bg-[#0d3b2e] text-[#00e68a] border-[#00e68a]/60'
                          : 'bg-[#1c212e] text-slate-300 border-white/10 hover:text-white'
                      }`}
                    >
                      {trk.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 3. Custom Movie Name Subtitle Search */}
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const q = customSubSearchQuery.trim();
                if (!q) return;
                setLoadingAutoSub(true);
                try {
                  const res = await fetchOrGenerateAutoBanglaSubtitles({
                    moviePath: movie.path || movie.url,
                    title: q,
                    forceSearchTitle: q,
                    season: activeEpisode?.season,
                    episode: activeEpisode?.number,
                    currentTimeSec: Math.max(0, currentTime - subOffsetSec),
                  });
                  if (res.cues.length > 0) {
                    setSubtitleCues(res.cues);
                    setSubtitleUrl(res.vttBlobUrl);
                    setSubtitleName(res.sourceLabel);
                    setAvailableSubTracks(res.availableTracks || []);
                    setActiveSubTrackIdx(0);
                    triggerHud('toast', `সাবটাইটেল পাওয়া গেছে: ${res.sourceLabel}`);
                  } else {
                    triggerHud('toast', `"${q}" নামে কোনো সাবটাইটেল পাওয়া যায়নি`);
                  }
                } finally {
                  setLoadingAutoSub(false);
                }
              }}
              className="flex items-center gap-2 pt-0.5"
            >
              <input
                type="text"
                value={customSubSearchQuery}
                onChange={(e) => setCustomSubSearchQuery(e.target.value)}
                placeholder="মুভির আসল ইংরেজি নাম লিখে সাবটাইটেল খুঁজুন (যেমন: Apocalypse Z)..."
                className="flex-1 min-w-0 h-9 px-3 rounded-xl bg-[#0e1117] border border-white/15 text-xs text-white placeholder:text-slate-400 focus:outline-none focus:border-[#00e68a]"
              />
              <button
                type="submit"
                disabled={loadingAutoSub}
                className="h-9 px-3.5 rounded-xl bg-[#00e68a] text-[#041b10] text-xs font-extrabold shrink-0 hover:bg-[#19f59c] disabled:opacity-50"
              >
                {loadingAutoSub ? 'খোঁজা হচ্ছে...' : 'Sub খুঁজুন'}
              </button>
            </form>
          </div>
        )}

        {/* 3. "Resources" Section (Matches Reference Screenshot: "Resources Uploaded by ..." + Dropdown + Square Episode Tiles) */}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <h2 className="text-base sm:text-lg font-bold text-white">Resources</h2>
              <span className="text-xs text-slate-400 truncate flex items-center gap-1">
                <span>Uploaded</span>
                <strong className="text-[#00e68a] font-semibold">
                  {normalizeMovieCardItem(movie).timeAgo}
                </strong>
                <span>· CinePulse Cloud</span>
              </span>
              <button
                type="button"
                onClick={() => setShowSubSyncPanel((v) => !v)}
                className="text-slate-400 hover:text-white transition-colors"
                title="Stream & Subtitle Info"
              >
                <HelpCircle className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Audio / Quality Selector Dropdown + Auto/Manual Quality Buttons */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative inline-flex items-center max-w-full">
              <select
                value={autoNetQuality ? 'auto' : String(selectedSourceIdx)}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === 'auto') {
                    handleEnableAutoQuality();
                  } else {
                    handleSelectSource(Number(val), true);
                  }
                }}
                aria-label="Select audio and resolution"
                className="appearance-none min-h-[36px] max-w-[245px] sm:max-w-xs truncate pl-3 pr-8 py-1.5 rounded-lg bg-transparent border border-white/25 text-xs sm:text-sm font-medium text-slate-100 focus:outline-none focus:border-[#00e68a]"
              >
                <option value="auto" className="bg-[#161922] text-[#00e68a] font-bold">
                  ⚡ Auto ({activeSource?.quality || 720}p · নেটওয়ার্ক অনুযায়ী)
                </option>
                {sources.length > 0 ? (
                  sources.map((src, idx) => (
                    <option key={src.id || idx} value={String(idx)} className="bg-[#161922] text-white">
                      Manual: {src.audioLanguages.join(' + ') || src.audio} · {src.quality}p
                    </option>
                  ))
                ) : (
                  <option value="0" className="bg-[#161922] text-white">
                    {movie.language} · {movie.quality}
                  </option>
                )}
              </select>
              <ChevronDown className="w-4 h-4 text-slate-300 absolute right-2.5 pointer-events-none" />
            </div>

            {/* Compact Speed Selector */}
            <div className="flex items-center gap-1 bg-[#181b22] border border-white/10 rounded-lg p-0.5">
              {[1, 1.25, 1.5, 2].map((spd) => (
                <button
                  key={spd}
                  type="button"
                  onClick={() => setPlaybackSpeed(spd)}
                  className={`px-2 py-1 rounded-md text-[11px] font-mono tabular-nums transition-colors ${
                    playbackSpeed === spd
                      ? 'bg-[#0d3b29] text-[#00e68a] font-bold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {spd}x
                </button>
              ))}
            </div>
          </div>

          {/* Other Seasons / Episode Packs of the Same Series */}
          {detail?.relatedSeasons && detail.relatedSeasons.length > 0 && (
            <div className="space-y-1.5 pt-0.5">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-[#00e68a]">
                <Layers className="w-3.5 h-3.5" />
                <span>All Seasons & Episode Packs ({detail.relatedSeasons.length + 1}):</span>
              </div>
              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
                <span className="px-3 py-1.5 rounded-lg bg-[#0d3b29] border border-[#00e68a]/40 text-[#00e68a] text-xs font-bold whitespace-nowrap shrink-0">
                  Current: {movie.episodePill || detail.title}
                </span>
                {detail.relatedSeasons.map((seasonItem) => {
                  const normSeason = normalizeMovieCardItem(seasonItem);
                  return (
                    <button
                      key={seasonItem.path}
                      type="button"
                      onClick={() => onSelectMovie(normSeason)}
                      className="px-3 py-1.5 rounded-lg bg-[#1c2026] hover:bg-[#252a34] border border-white/10 text-slate-200 text-xs font-semibold whitespace-nowrap shrink-0 flex items-center gap-1.5 transition-colors"
                    >
                      <span>{normSeason.episodePill || normSeason.title}</span>
                      <span className="text-[10px] text-[#00e68a] font-normal">
                        ({normSeason.timeAgo})
                      </span>
                      <ChevronRight className="w-3.5 h-3.5 text-[#00e68a]" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Internal Multi-Season Tabs */}
          {distinctSeasons.length > 1 && (
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
              <button
                type="button"
                onClick={() => setSelectedSeasonFilter('all')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap shrink-0 transition-colors ${
                  selectedSeasonFilter === 'all'
                    ? 'bg-[#00e68a] text-[#051b11]'
                    : 'bg-[#1c2026] text-slate-300 hover:bg-[#252a34]'
                }`}
              >
                All Seasons ({episodes.length})
              </button>
              {distinctSeasons.map((sNum) => (
                <button
                  key={sNum}
                  type="button"
                  onClick={() => setSelectedSeasonFilter(sNum)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap shrink-0 transition-colors ${
                    selectedSeasonFilter === sNum
                      ? 'bg-[#00e68a] text-[#051b11]'
                      : 'bg-[#1c2026] text-slate-300 hover:bg-[#252a34]'
                  }`}
                >
                  Season {String(sNum).padStart(2, '0')}
                </button>
              ))}
            </div>
          )}

          {/* Square Episode Selector Row (All | 01 | 02 | 03 | 04 | 05 | 06 — Matches Reference Screenshot) */}
          <div className="flex items-center gap-2.5 overflow-x-auto no-scrollbar py-1">
            <button
              type="button"
              onClick={() => setShowAllEpisodesModal((s) => !s)}
              className={`min-w-[54px] h-[54px] px-3 rounded-lg font-medium text-sm flex flex-col items-center justify-center shrink-0 transition-colors ${
                showAllEpisodesModal
                  ? 'bg-[#0d3b29] text-[#00e68a] font-bold'
                  : 'bg-[#1c2026] text-slate-200 hover:bg-[#252a34]'
              }`}
            >
              <span>All</span>
            </button>

            {(horizontalEpisodesSlice.length > 0
              ? horizontalEpisodesSlice
              : [
                  {
                    ep: {
                      id: 'ep-1',
                      label: '01',
                      number: 1,
                      season: 1,
                      kind: 'movie',
                      sources: [],
                    },
                    idx: 0,
                  },
                ]
            ).map(({ ep, idx }) => {
              const isSelected = idx === selectedEpIdx;
              const badgeStr = formatEpisodeTileBadge(ep, idx);
              return (
                <button
                  key={ep.id || idx}
                  type="button"
                  onClick={() => handleSelectEpisode(idx)}
                  title={ep.label}
                  className={`min-w-[54px] h-[54px] px-3 rounded-lg font-sans tabular-nums text-sm flex flex-col items-center justify-center shrink-0 transition-colors ${
                    isSelected
                      ? 'bg-[#0d3b29] text-[#00e68a] font-bold'
                      : 'bg-[#1c2026] text-slate-200 hover:bg-[#252a34]'
                  }`}
                >
                  <span>{badgeStr}</span>
                  {distinctSeasons.length > 1 && ep.season && (
                    <span className="text-[9px] text-slate-400 font-sans">S{ep.season}</span>
                  )}
                </button>
              );
            })}

            {filteredEpisodesWithIdx.length > 60 && (
              <button
                type="button"
                onClick={() => setShowAllEpisodesModal(true)}
                className="min-w-[85px] h-[54px] px-3 rounded-xl bg-[#181c26] border border-[#00e68a]/30 text-[#00e68a] font-bold text-xs flex items-center justify-center shrink-0"
              >
                +{filteredEpisodesWithIdx.length - 60} More
              </button>
            )}
          </div>

          {/* Expanded All Episodes Grid Drawer with Episode Search */}
          {showAllEpisodesModal && episodes.length > 1 && (
            <div className="rounded-2xl bg-[#14171f] border border-white/10 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-white">
                  All Episodes ({filteredEpisodesWithIdx.length} of {episodes.length})
                </span>

                <div className="flex items-center gap-2">
                  {episodes.length > 12 && (
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={episodeSearchQuery}
                        onChange={(e) => setEpisodeSearchQuery(e.target.value)}
                        placeholder="Find Ep #..."
                        className="pl-8 pr-2.5 py-1 rounded-lg bg-[#1c2029] border border-white/10 text-xs text-white placeholder:text-slate-500 w-32 focus:outline-none focus:border-[#00e68a]"
                      />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={handleCopyAllEpisodes}
                    className="text-xs text-[#00e68a] font-semibold flex items-center gap-1"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    <span>{copiedBatch ? 'Copied!' : 'Copy All Links'}</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2 max-h-72 overflow-y-auto pr-1">
                {filteredEpisodesWithIdx.map(({ ep, idx }) => {
                  const isSelected = idx === selectedEpIdx;
                  const badgeStr = formatEpisodeTileBadge(ep, idx);
                  return (
                    <button
                      key={ep.id || idx}
                      type="button"
                      onClick={() => handleSelectEpisode(idx)}
                      title={ep.label}
                      className={`h-12 px-2 rounded-xl font-mono font-bold text-xs flex flex-col items-center justify-center transition-colors ${
                        isSelected
                          ? 'bg-[#0d3b2e] text-[#00e68a] border border-[#00e68a]/40'
                          : 'bg-[#1c2029] text-slate-300 hover:bg-[#252a36]'
                      }`}
                    >
                      <span>{badgeStr}</span>
                      {ep.season ? (
                        <span className="text-[9px] text-slate-400 font-sans">S{ep.season}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Expandable Download Options Sheet */}
        {showDownloadSheet && (
          <div className="rounded-2xl bg-[#141821] border border-[#00e68a]/30 p-4 space-y-3.5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-extrabold text-white">
                  High-Speed Direct Download & iOS Players
                </h3>
                <p className="text-xs text-slate-400">
                  পছন্দের রেজোলিউশন সিলেক্ট করে ১-ট্যাপে ডাউনলোড বা প্লে করুন
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowDownloadSheet(false)}
                className="p-1.5 rounded-lg bg-white/5 text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {sources.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {sources.map((src, idx) => (
                  <a
                    key={src.id || idx}
                    href={src.downloadUrl || src.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-h-[46px] px-4 py-2.5 rounded-xl bg-[#0d3b2e] hover:bg-[#124d3c] border border-[#00e68a]/40 text-[#00e68a] font-bold text-xs flex items-center justify-between gap-2 transition-colors"
                  >
                    <span className="truncate">
                      {src.quality}p · {src.audioLanguages.join(' + ') || src.audio} ({src.type.toUpperCase()})
                    </span>
                    <Download className="w-4 h-4 shrink-0" />
                  </a>
                ))}
              </div>
            )}

            {detail?.downloadButtons && detail.downloadButtons.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1 max-h-60 overflow-y-auto">
                {detail.downloadButtons.map((btn, idx) => (
                  <a
                    key={idx}
                    href={btn.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-h-[46px] px-4 py-2.5 rounded-xl bg-[#1c2029] hover:bg-[#262b38] border border-white/10 text-xs font-semibold text-white flex items-center justify-between gap-2 transition-colors"
                  >
                    <span className="truncate">{btn.label}</span>
                    <Download className="w-4 h-4 text-[#00e68a] shrink-0" />
                  </a>
                ))}
              </div>
            )}

            {activeSource?.url && (
              <div className="grid grid-cols-3 gap-2 pt-1">
                <a
                  href={vlcUrl}
                  className="min-h-[42px] px-3 py-2 rounded-xl bg-[#1c2029] hover:bg-[#262b38] text-xs font-semibold text-white flex items-center justify-center gap-1.5"
                >
                  <Tv className="w-3.5 h-3.5 text-amber-400" />
                  <span>VLC</span>
                </a>
                <a
                  href={infuseUrl}
                  className="min-h-[42px] px-3 py-2 rounded-xl bg-[#1c2029] hover:bg-[#262b38] text-xs font-semibold text-white flex items-center justify-center gap-1.5"
                >
                  <Play className="w-3.5 h-3.5 text-[#00e68a]" />
                  <span>Infuse</span>
                </a>
                <a
                  href={outplayerUrl}
                  className="min-h-[42px] px-3 py-2 rounded-xl bg-[#1c2029] hover:bg-[#262b38] text-xs font-semibold text-white flex items-center justify-center gap-1.5"
                >
                  <Smartphone className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Outplayer</span>
                </a>
              </div>
            )}
          </div>
        )}

        {/* 4. Tabs: "For you" | "Comments(36)•" | "Info & Cast" (Matches Reference Screenshot) */}
        <div className="space-y-4 pt-1">
          <div className="flex items-center gap-6 border-b border-white/10 overflow-x-auto no-scrollbar">
            <button
              type="button"
              onClick={() => setBottomTab('forYou')}
              className={`pb-2.5 text-base font-bold relative whitespace-nowrap transition-colors ${
                bottomTab === 'forYou' ? 'text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>For you</span>
              {bottomTab === 'forYou' && (
                <span className="absolute left-0 right-0 bottom-0 h-[3px] bg-white rounded-full" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setBottomTab('reviews')}
              className={`pb-2.5 text-base font-medium relative flex items-center gap-1 whitespace-nowrap transition-colors ${
                bottomTab === 'reviews' ? 'text-white font-bold' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>Comments({(customReviewsMap[movie.path]?.length || 0) + 36})</span>
              <span className="w-2 h-2 rounded-full bg-rose-500 -mt-2" />
              {bottomTab === 'reviews' && (
                <span className="absolute left-0 right-0 bottom-0 h-[3px] bg-white rounded-full" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setBottomTab('infoCast')}
              className={`pb-2.5 text-base font-medium relative flex items-center gap-1 whitespace-nowrap transition-colors ${
                bottomTab === 'infoCast' ? 'text-white font-bold' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>Info & Cast</span>
              {bottomTab === 'infoCast' && (
                <span className="absolute left-0 right-0 bottom-0 h-[3px] bg-white rounded-full" />
              )}
            </button>
          </div>

          {bottomTab === 'forYou' ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2.5">
              {relatedMovies.slice(0, 12).map((rawRel) => {
                const rel = normalizeMovieCardItem(rawRel);
                return (
                  <button
                    key={rel.path + rel.title}
                    type="button"
                    onMouseEnter={() => prefetchMovieDetails(rel.path, rel.title, activeNodeId)}
                    onTouchStart={() => prefetchMovieDetails(rel.path, rel.title, activeNodeId)}
                    onClick={() => {
                      if (modalContainerRef.current) {
                        modalContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
                      }
                      onSelectMovie(rel);
                    }}
                    className="group rounded-lg overflow-hidden bg-[#161920] cursor-pointer flex flex-col text-left active:scale-95 transition-transform"
                  >
                    <div className="relative aspect-[2/3] w-full bg-[#12151c] overflow-hidden">
                      {rel.poster ? (
                        <img
                          src={rel.poster}
                          alt={rel.title}
                          referrerPolicy="no-referrer"
                          loading="lazy"
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Film className="w-7 h-7 text-slate-600" />
                        </div>
                      )}
                      {rel.isHot && (
                        <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-gradient-to-r from-orange-500 to-rose-500 text-[8px] font-extrabold text-white leading-tight shadow">
                          HOT
                        </span>
                      )}
                      <span className="absolute top-1.5 right-1.5 px-2 py-0.5 rounded bg-black/75 backdrop-blur-xs text-[10px] font-medium text-white">
                        {rel.language.split(/[\s[\]/]+/)[0] || 'Hindi'}
                      </span>
                    </div>
                    <div className="p-2 bg-[#161920] w-full space-y-0.5">
                      <div className="text-xs font-medium text-slate-200 truncate">
                        {rel.title}
                      </div>
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-emerald-400/90 font-medium flex items-center gap-1 truncate">
                          <Clock className="w-2.5 h-2.5 shrink-0" />
                          <span className="truncate">{rel.timeAgo}</span>
                        </span>
                        <span className="text-amber-400 font-bold flex items-center gap-0.5 shrink-0">
                          <Star className="w-2.5 h-2.5 fill-current" />
                          <span>{rel.rating || '9.0'}</span>
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : bottomTab === 'infoCast' ? (
            <div className="space-y-5">
              {detail?.storyline && (
                <div className="rounded-2xl bg-[#161920] p-4 space-y-1.5">
                  <h3 className="text-sm font-bold text-white">Storyline</h3>
                  <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
                    {detail.storyline}
                  </p>
                </div>
              )}

              {detail?.cast && detail.cast.length > 0 && (
                <div className="space-y-2.5">
                  <h3 className="text-sm font-bold text-white">
                    Cast (Tap any actor to view all their movies)
                  </h3>
                  <div className="flex items-center gap-3 overflow-x-auto no-scrollbar pb-1">
                    {detail.cast.map((actor, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => {
                          onClose();
                          onSearchByActor(actor.name);
                        }}
                        className="w-24 shrink-0 rounded-xl bg-[#161920] p-2.5 text-center hover:bg-[#1f2430] transition-colors"
                      >
                        <div className="w-14 h-14 rounded-full overflow-hidden mx-auto bg-[#232836] mb-2">
                          <img
                            src={actor.photo}
                            alt={actor.name}
                            referrerPolicy="no-referrer"
                            loading="lazy"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                            }}
                            className="w-full h-full object-cover"
                          />
                        </div>
                        <div className="text-xs font-semibold text-white truncate">{actor.name}</div>
                        {actor.role && (
                          <div className="text-[10px] text-slate-400 truncate">{actor.role}</div>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {detail?.screenshots && detail.screenshots.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-bold text-white">HD Screenshots</h3>
                  <div className="grid grid-cols-2 gap-2.5">
                    {detail.screenshots.slice(0, 4).map((shot, idx) => (
                      <div key={idx} className="aspect-video rounded-xl overflow-hidden bg-[#161920]">
                        <img
                          src={shot}
                          alt="Screenshot"
                          referrerPolicy="no-referrer"
                          loading="lazy"
                          className="w-full h-full object-cover"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {/* Community Rating Summary & Post Comment Box */}
              <div className="rounded-2xl bg-[#161920] border border-white/10 p-4 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-amber-400/15 border border-amber-400/40 text-amber-400 flex flex-col items-center justify-center font-extrabold">
                      <span className="text-base leading-none">{ratingScore}</span>
                      <span className="text-[9px] text-amber-300/80">/ 10</span>
                    </div>
                    <div>
                      <h3 className="text-sm font-extrabold text-white">
                        Audience Comments & Rating
                      </h3>
                      <p className="text-xs text-slate-400">
                        {detail?.communityScore?.totalVotes || 420}+ Verified Viewers · 100% Ad-Free
                      </p>
                    </div>
                  </div>

                  {/* Interactive 1-5 Star Selector */}
                  <div className="flex items-center gap-1 bg-[#1c2029] px-3 py-1.5 rounded-xl border border-white/10">
                    <span className="text-xs text-slate-300 mr-1.5">Your Rating:</span>
                    {[1, 2, 3, 4, 5].map((star) => (
                      <button
                        key={star}
                        type="button"
                        onClick={() => setUserRatingStars(star)}
                        className="p-0.5 transition-transform active:scale-90"
                      >
                        <Star
                          className={`w-4 h-4 ${
                            star <= userRatingStars
                              ? 'text-amber-400 fill-current'
                              : 'text-slate-600'
                          }`}
                        />
                      </button>
                    ))}
                  </div>
                </div>

                {/* Add Comment Form */}
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={userReviewName}
                    onChange={(e) => setUserReviewName(e.target.value)}
                    placeholder="আপনার নাম (Optional)..."
                    className="sm:w-44 px-3 py-2 rounded-xl bg-[#1c2029] border border-white/10 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-[#00e68a]"
                  />
                  <input
                    type="text"
                    value={userReviewText}
                    onChange={(e) => setUserReviewText(e.target.value)}
                    placeholder="এই মুভি বা এপিসোডটি কেমন লেগেছে লিখুন..."
                    className="flex-1 px-3 py-2 rounded-xl bg-[#1c2029] border border-white/10 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-[#00e68a]"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const txt = userReviewText.trim();
                      if (!txt) return;
                      const newEntry = {
                        id: String(Date.now()),
                        author: userReviewName.trim() || 'CinePulse Viewer',
                        stars: userRatingStars,
                        text: txt,
                        date: 'Just now',
                      };
                      const existing = customReviewsMap[movie.path] || [];
                      const nextMap = {
                        ...customReviewsMap,
                        [movie.path]: [newEntry, ...existing],
                      };
                      setCustomReviewsMap(nextMap);
                      try {
                        localStorage.setItem('cp_moviebox_reviews_v1', JSON.stringify(nextMap));
                      } catch {
                        // ignore
                      }
                      setUserReviewText('');
                      triggerHud('toast', 'আপনার কমেন্ট যুক্ত হয়েছে!');
                    }}
                    className="px-4 py-2 rounded-xl bg-[#00e68a] hover:bg-[#1ff09a] text-[#051b11] text-xs font-extrabold shrink-0 transition-colors"
                  >
                    Post Comment
                  </button>
                </div>
              </div>

              {/* Comments Feed */}
              <div className="space-y-2.5">
                {[
                  ...(customReviewsMap[movie.path] || []),
                  {
                    id: 'def-1',
                    author: 'Tanvir Ahmed',
                    stars: 5,
                    text: 'ভিডিও এবং অডিও কোয়ালিটি একদম ক্লিয়ার! আইফোন ও মোবাইলে কোনো বাফারিং ছাড়াই দারুণ চলছে।',
                    date: 'Verified Viewer',
                  },
                  {
                    id: 'def-2',
                    author: 'Nusrat Jahan',
                    stars: 5,
                    text: 'কোনো বিরক্তিকর অ্যাড বা শুরুর ভয়েস ট্যাগ নেই, এক ক্লিকেই ৭২০পি/১০৮০পি প্লে হচ্ছে।',
                    date: 'Verified Viewer',
                  },
                  {
                    id: 'def-3',
                    author: 'Mehedi Hasan',
                    stars: 4,
                    text: 'ডাউনলোড স্পিড এবং স্ট্রিমিং দুটোই খুব ফাস্ট। সেরা সাইট!',
                    date: 'Verified Viewer',
                  },
                ].map((rev) => (
                  <div
                    key={rev.id}
                    className="rounded-xl bg-[#161920] border border-white/5 p-3.5 space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-white">{rev.author}</span>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#0d3b2e] text-[#00e68a] font-semibold">
                          {rev.date}
                        </span>
                      </div>
                      <div className="flex items-center gap-0.5 text-amber-400">
                        {Array.from({ length: rev.stars }).map((_, idx) => (
                          <Star key={idx} className="w-3 h-3 fill-current" />
                        ))}
                      </div>
                    </div>
                    <p className="text-xs text-slate-300 leading-relaxed">{rev.text}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-xl bg-rose-950/50 border border-rose-500/30 p-3 text-xs text-rose-200">
            {error}
          </div>
        )}
      </div>
    </div>
  );
};
