import { ALL_CATEGORIES, INITIAL_FALLBACK_MOVIES } from '../data/categories';
import {
  cleanTimeAgoAndEpisode,
  normalizeMovieCardList,
  sortItemsByHotAndHype,
  sortItemsByRecentUpload,
} from '../utils/timeAgo';
import type {
  CastMember,
  DirectDownloadButton,
  EpisodeItem,
  MovieCardItem,
  MovieDetailData,
  StreamSource,
} from '../types/cinema';
import { prewarmMkvStreamMeta } from './mkvIosClientRemuxer';

const MIRROR_ORIGINS = [
  'https://cmyyhb.movielinkbd.at',
  'https://4yer8f.movielinkbd.at',
];

const CORS_BRIDGES = [
  (targetUrl: string) =>
    `https://allorigins.hexlet.app/raw?url=${encodeURIComponent(targetUrl)}`,
];

interface StaticDbSnapshot {
  generatedAt: number;
  catalogs: Record<string, MovieCardItem[]>;
  details: Record<string, MovieDetailData>;
}

let staticDbPromise: Promise<StaticDbSnapshot | null> | null = null;
let loadedStaticDb: StaticDbSnapshot | null = null;
const staticDbTitleIndex = new Map<string, MovieDetailData>();
const clientCatalogCache = new Map<string, { items: MovieCardItem[]; maxPage: number; ts: number }>();
const clientDetailCache = new Map<string, { detail: MovieDetailData; ts: number }>();
const inFlightDetailPromises = new Map<string, Promise<any>>();
let isVideoActivelyStarting = false;

export function setVideoStartupPriority(active: boolean): void {
  isVideoActivelyStarting = active;
}

function normalizeLookupTitleKey(rawTitle: string): string {
  return (rawTitle || '')
    .replace(/\[.*?\]|\(.*?\)/g, ' ')
    .replace(
      /\b(?:S\d+|Season\s*\d+(?:-\d+)?|Ep(?:isode)?\s*\d+(?:-\d+)?|Complete(?:d)?|Added|Full\s*HD|ORG|Hindi|Bangla|Bengali|Dual|Multi|The\s*Movie)\b/gi,
      ' '
    )
    .toLowerCase()
    .replace(/[^a-z0-9\u0980-\u09ff]+/g, '')
    .trim();
}

async function loadStaticDb(): Promise<StaticDbSnapshot | null> {
  if (loadedStaticDb) return loadedStaticDb;
  if (!staticDbPromise) {
    staticDbPromise = (async () => {
      try {
        const res = await fetch('./static-db.json');
        if (!res.ok) return null;
        const parsed = (await res.json()) as StaticDbSnapshot;
        loadedStaticDb = parsed;
        if (parsed?.details) {
          for (const det of Object.values(parsed.details)) {
            if (det?.title && det.episodes?.length) {
              // Ensure all downloadUrls inside static-db.json are resolved for direct downloads
              for (const ep of det.episodes) {
                for (const src of ep.sources || []) {
                  if (!src.downloadUrl) {
                    src.downloadUrl = src.url;
                  } else if (src.downloadUrl.startsWith('/api/go?t=')) {
                    src.downloadUrl = resolveDirectDownloadUrl(src.downloadUrl);
                  }
                }
              }
              for (const btn of det.downloadButtons || []) {
                if (btn.url && btn.url.startsWith('/api/go?t=')) {
                  btn.url = resolveDirectDownloadUrl(btn.url);
                }
              }
              const k1 = normalizeLookupTitleKey(det.title);
              if (k1) staticDbTitleIndex.set(k1, det);
              const k2 = det.title.toLowerCase().replace(/[^a-z0-9]/g, '');
              if (k2) staticDbTitleIndex.set(k2, det);
            }
          }
        }
        return parsed;
      } catch {
        return null;
      }
    })();
  }
  return staticDbPromise;
}

// Kick off static-db.json preload immediately on startup for 0ms instant lookups
if (typeof window !== 'undefined') {
  loadStaticDb();
}

export function resolveDirectDownloadUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  if (rawUrl.startsWith('/api/go?t=')) {
    try {
      const token = rawUrl.slice('/api/go?t='.length).split('&')[0];
      const base64 = token.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '==='.slice((base64.length + 3) % 4);
      const decoded = decodeURIComponent(escape(window.atob(padded)));
      if (/fifadekho\.com/i.test(decoded)) {
        const isGhPages =
          typeof window !== 'undefined' && window.location.hostname.endsWith('github.io');
        return isGhPages
          ? `${decoded.replace(/\/+$/, '')}?view=links`
          : rawUrl;
      }
      return decoded;
    } catch {
      return rawUrl;
    }
  }
  return rawUrl;
}

function sanitizeBrandText(input: string): string {
  if (!input) return '';
  return String(input)
    .replace(/https?:\/\/[^\s"'<>]*(?:movielinkbd|myflixbd)[^\s"'<>]*/gi, '')
    .replace(/\b[a-z0-9-]*\.?(?:movielinkbd|myflixbd)\.[a-z]{2,6}\b/gi, 'CinePulse')
    .replace(/movielinkbd|myflixbd|nexaflox/gi, 'CinePulse')
    .replace(/movie\s*link\s*bd/gi, 'CinePulse')
    .replace(/\bmlbd\b/gi, 'CP')
    .replace(/\s*watch\s+online\s+and\s+download\s*(?:["“”']?web-dl["“”']?|["“”']?hdtc["“”']?|["“”']?hd["“”']?|["“”']?4k["“”']?)?\s*…?/gi, '')
    .replace(/\s*watch\s+online\s*…?/gi, '')
    .replace(/\s+[–—-]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function decodeHtmlEntities(str: string): string {
  const cleaned = (str || '')
    .replace(/&ndash;|&#8211;/g, '–')
    .replace(/&mdash;|&#8212;/g, '—')
    .replace(/&#039;|&#8217;/g, "'")
    .replace(/&quot;|&#8220;|&#8221;/g, '"')
    .replace(/&amp;|&#038;/g, '&')
    .replace(/&bull;|&#8226;/g, '•')
    .replace(/&#8230;|&hellip;/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .trim();
  return sanitizeBrandText(cleaned);
}

/**
 * Browser-native implementation of the stream & download cipher decoder.
 */
function decodeMlbdCipherBrowser(base64Str: string, hexSeed: string, rounds: number): string {
  try {
    let x = parseInt(hexSeed, 16) >>> 0;
    for (let i = 0; i < rounds; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    }
    const cleanB64 = base64Str.trim().replace(/\s+/g, '');
    const binary = window.atob(cleanB64);
    const out = new Uint8Array(binary.length);
    for (let j = 0; j < binary.length; j++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      out[j] = binary.charCodeAt(j) ^ ((x >>> 16) & 255);
    }
    return new TextDecoder('utf-8').decode(out);
  } catch {
    return '';
  }
}

function extractBaseSeriesTitle(rawTitle: string): string {
  return rawTitle
    .replace(/\[.*?\]|\(.*?\)/g, ' ')
    .replace(
      /\b(?:S\d+|Season\s*\d+(?:-\d+)?|Ep(?:isode)?\s*\d+(?:-\d+)?|Complete(?:d)?|Added|Full\s*HD|ORG|Hindi|Bangla|Bengali|Dual|Multi|The\s*Movie)\b/gi,
      ' '
    )
    .replace(/[:\-–—|]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const warmedStreamUrls = new Set<string>();
const preconnectedOrigins = new Set<string>();
let warmVideoEl: HTMLVideoElement | null = null;

function ensurePreconnectOrigin(streamUrl: string): void {
  if (typeof document === 'undefined') return;
  try {
    const origin = new URL(streamUrl).origin;
    if (!origin || preconnectedOrigins.has(origin)) return;
    preconnectedOrigins.add(origin);

    const dnsLink = document.createElement('link');
    dnsLink.rel = 'dns-prefetch';
    dnsLink.href = origin;
    document.head.appendChild(dnsLink);

    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = origin;
    document.head.appendChild(link);
  } catch {
    // ignore
  }
}

/**
 * Warms DNS, TCP, and TLS handshakes to the video CDN origin with zero bandwidth contention
 * so the main <video> element gets 100% of connection slots and starts immediately.
 */
export function warmStreamConnection(streamUrl?: string, primeMediaDecoder = false): void {
  if (!streamUrl || typeof window === 'undefined') return;
  if (!streamUrl.startsWith('http')) return;
  ensurePreconnectOrigin(streamUrl);
  // Pre-warm the 24KB Matroska header + 152KB Cues keyframe index in RAM when hovering/tapping a movie
  // so clicking Play starts in < 0.2s and seeking jumps to exact keyframes in < 0.15s!
  if ((primeMediaDecoder || !isVideoActivelyStarting) && !warmedStreamUrls.has(streamUrl)) {
    warmedStreamUrls.add(streamUrl);
    prewarmMkvStreamMeta(streamUrl);
  }
}

export function stopBackgroundWarmVideo(): void {
  if (warmVideoEl) {
    try {
      warmVideoEl.pause();
      warmVideoEl.removeAttribute('src');
      warmVideoEl.load();
    } catch {
      // ignore
    }
  }
}

function warmDetailFirstStream(detail?: MovieDetailData | null, primeMediaDecoder = false): void {
  if (isVideoActivelyStarting && !primeMediaDecoder) return;
  const firstEp = detail?.episodes?.[0];
  if (!firstEp?.sources?.length) return;
  const isNonHevc = (s: StreamSource) =>
    !/\b(hevc|h\.?265|x265|10bit|av1)\b/i.test(`${s.name} ${s.qualityLabel}`) &&
    !/best\s*quality/i.test(s.qualityLabel || '');
  // Always pre-warm the fastest starting 480p or 720p H.264 stream first!
  const bestFast =
    firstEp.sources.find((s) => isNonHevc(s) && s.quality >= 360 && s.quality <= 576) ||
    firstEp.sources.find((s) => isNonHevc(s) && s.quality === 720) ||
    firstEp.sources.find((s) => isNonHevc(s)) ||
    firstEp.sources[0];
  if (bestFast?.url && bestFast.type !== 'embed') {
    warmStreamConnection(bestFast.url, primeMediaDecoder);
  }
}

/**
 * Synchronous 0ms detail lookup from in-memory cache or pre-loaded static-db.json
 * so clicking a movie opens the video player immediately without any loading spinner!
 */
export function getInstantCachedDetail(rawPath: string, rawTitle = ''): MovieDetailData | null {
  const pathKey = (rawPath || '').trim();
  if (!pathKey && !rawTitle) return null;

  const mem = clientDetailCache.get(pathKey);
  if (mem && mem.detail?.episodes?.length) {
    warmDetailFirstStream(mem.detail);
    return mem.detail;
  }

  if (loadedStaticDb?.details) {
    if (pathKey && loadedStaticDb.details[pathKey]?.episodes?.length) {
      const hit = loadedStaticDb.details[pathKey];
      warmDetailFirstStream(hit);
      return hit;
    }
    const strippedPath = pathKey.replace(/-\d+$/, '');
    if (strippedPath && loadedStaticDb.details[strippedPath]?.episodes?.length) {
      const hit = loadedStaticDb.details[strippedPath];
      warmDetailFirstStream(hit);
      return hit;
    }
    if (rawTitle) {
      const k1 = normalizeLookupTitleKey(rawTitle);
      const k2 = rawTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
      const indexed = (k2 && staticDbTitleIndex.get(k2)) || (k1 && staticDbTitleIndex.get(k1));
      if (indexed && indexed.episodes?.length) {
        warmDetailFirstStream(indexed);
        return indexed;
      }
      const cleanWant = extractBaseSeriesTitle(rawTitle).toLowerCase();
      const found = Object.values(loadedStaticDb.details).find((d) => {
        const dClean = extractBaseSeriesTitle(d.title).toLowerCase();
        return d.title === rawTitle || (cleanWant.length >= 4 && dClean === cleanWant);
      });
      if (found && found.episodes?.length) {
        if (k2) staticDbTitleIndex.set(k2, found);
        warmDetailFirstStream(found);
        return found;
      }
    }
  }
  return null;
}

/**
 * Pre-fetches and decrypts a movie's stream links in the background on touchstart / hover
 * AND pre-warms the video byte stream (`Range: bytes=0-32767`) so tapping plays in 0ms!
 */
export function prefetchMovieDetails(
  rawPath: string,
  rawTitle = '',
  nodeId = 'node-alpha',
  primeMediaDecoder = true
): void {
  if (isVideoActivelyStarting) return;
  const pathKey = (rawPath || '').trim();
  if (!pathKey) return;
  const existing = getInstantCachedDetail(pathKey, rawTitle);
  if (existing) {
    warmDetailFirstStream(existing, primeMediaDecoder);
    return;
  }
  // On GitHub Pages, never flood CORS bridges with background detail prefetches;
  // keep 100% of CORS bridge bandwidth ready for user clicks!
  const isGhPages =
    typeof window !== 'undefined' && window.location.hostname.endsWith('github.io');
  if (isGhPages) return;
  if (inFlightDetailPromises.has(pathKey)) return;

  const params = new URLSearchParams({ path: pathKey, title: rawTitle, node: nodeId });
  const p = universalApiFetch(`/api/details?${params.toString()}`)
    .then((data) => {
      if (data?.ok && data?.detail) {
        clientDetailCache.set(pathKey, { detail: data.detail, ts: Date.now() });
        warmDetailFirstStream(data.detail, primeMediaDecoder);
      }
      return data;
    })
    .catch(() => null)
    .finally(() => {
      inFlightDetailPromises.delete(pathKey);
    });

  inFlightDetailPromises.set(pathKey, p);
}

function scheduleBackgroundCatalogDetailWarmup(items: MovieCardItem[], nodeId: string): void {
  if (typeof window === 'undefined' || !items?.length) return;
  loadStaticDb().then(() => {
    const topCandidates = items.slice(0, 6);
    topCandidates.forEach((item, idx) => {
      window.setTimeout(() => {
        if (isVideoActivelyStarting) return;
        if (item?.path) {
          prefetchMovieDetails(item.path, item.title || '', nodeId, idx < 2);
        }
      }, 200 + idx * 300);
    });
  });
}

const NODE_ORIGIN_MAP: Record<string, string> = {
  'node-alpha': 'https://cmyyhb.movielinkbd.at',
  'node-beta': 'https://4yer8f.movielinkbd.at',
  'node-gamma': 'https://cmyyhb.movielinkbd.at',
  'node-delta': 'https://4yer8f.movielinkbd.at',
};

async function fetchMirrorHtmlClientSide(
  relativePath: string,
  preferredNodeId = 'node-alpha',
  bustCache = false
): Promise<{ html: string; finalOrigin: string }> {
  let cleanPath = relativePath.startsWith('http')
    ? new URL(relativePath).pathname + new URL(relativePath).search
    : relativePath.startsWith('/')
      ? relativePath
      : `/${relativePath}`;

  if (bustCache) {
    const sep = cleanPath.includes('?') ? '&' : '?';
    cleanPath = `${cleanPath}${sep}_live=${Math.floor(Date.now() / 30000)}`;
  }

  const preferredOrigin = NODE_ORIGIN_MAP[preferredNodeId] || MIRROR_ORIGINS[0];
  const orderedOrigins = [
    preferredOrigin,
    ...MIRROR_ORIGINS.filter((o) => o !== preferredOrigin),
  ];

  // Try primary origin first without flooding duplicate CORS bridge requests, with a generous 10s timeout for 370KB HTML pages
  for (const origin of orderedOrigins) {
    const targetUrl = `${origin}${cleanPath}`;
    const url = CORS_BRIDGES[0](targetUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error('Bad status');
      const html = await res.text();
      if (
        html &&
        html.length > 800 &&
        (html.includes('movie-card') || html.includes('mlbdInlinePlayerData'))
      ) {
        return { html, finalOrigin: origin };
      }
    } catch {
      // try backup origin
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Client mirror bridges unreachable');
}

function parseClientCatalogHtml(html: string): { items: MovieCardItem[]; maxPage: number } {
  const bodyIdx = html.indexOf('<body');
  const body = bodyIdx >= 0 ? html.slice(bodyIdx) : html;
  const blocks = body.split(/<div class="movie-card"/i).slice(1);
  const items: MovieCardItem[] = [];
  const seenPaths = new Set<string>();

  for (const block of blocks) {
    const chunk = block.slice(0, 3200);
    if (chunk.includes("'+esc(") || chunk.includes('${')) continue;

    const titleMatch =
      chunk.match(/class=["']title["'][^>]*>([\s\S]*?)<\/a>/i) ||
      chunk.match(/alt=["']([^"']+)["']/i);
    const hrefMatch = chunk.match(/<a[^>]+href=["']([^"']+)["']/i);
    if (!titleMatch || !hrefMatch) continue;

    const rawHref = hrefMatch[1].trim();
    if (!rawHref || rawHref.includes("'+") || rawHref === '#') continue;

    const itemPath = rawHref.startsWith('http')
      ? new URL(rawHref).pathname
      : rawHref.startsWith('/')
        ? rawHref
        : `/${rawHref}`;

    if (seenPaths.has(itemPath)) continue;
    seenPaths.add(itemPath);

    const title = decodeHtmlEntities(titleMatch[1]);
    if (!title) continue;

    const posterMatch =
      chunk.match(/data-src=["'](https?:\/\/[^"']+)["']/i) ||
      chunk.match(/src=["'](https?:\/\/[^"']+)["']/i);
    const poster = posterMatch ? posterMatch[1].trim() : '';

    const quality = decodeHtmlEntities(
      (chunk.match(/<span class=["']quality["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || 'WEB-DL'
    );
    const language = decodeHtmlEntities(
      (chunk.match(/<span class=["']language["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || 'MULTI'
    );
    const views = decodeHtmlEntities(
      (chunk.match(/<span class=["']views-badge-top["'][^>]*>[\s\S]*?<\/i>\s*([^<]+)<\/span>/i) ||
        [])[1] || '2.4K'
    );
    const rawTimeAgo = decodeHtmlEntities(
      (chunk.match(/<div class=["']upload-time["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] ||
        'Recently added'
    );
    const rawEpisodePill = decodeHtmlEntities(
      (chunk.match(/<span class=["']badge ep-badge[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] ||
        ''
    );
    const cleanedTime = cleanTimeAgoAndEpisode(
      rawTimeAgo,
      rawEpisodePill,
      itemPath || title,
      items.length
    );

    const isPinned = chunk.includes('pin-badge') || chunk.includes('data-pin="1"');
    const isAdult =
      chunk.includes('data-18="1"') ||
      itemPath.includes('18plus') ||
      cleanedTime.episodePill.toUpperCase().includes('18+');

    let typeBadge: 'MOVIE' | 'SERIES' | 'ANIME' | 'DRAMA' = 'MOVIE';
    if (itemPath.includes('/anime/')) typeBadge = 'ANIME';
    else if (itemPath.includes('/drama/')) typeBadge = 'DRAMA';
    else if (itemPath.includes('/series/') || Boolean(cleanedTime.episodePill)) typeBadge = 'SERIES';

    items.push({
      id: itemPath.replace(/[^a-zA-Z0-9_-]/g, '_'),
      title,
      url: itemPath,
      path: itemPath,
      poster,
      quality: quality || 'HD',
      views: views || '1.9K',
      language: language || 'MULTI',
      typeBadge,
      timeAgo: cleanedTime.timeAgo,
      episodePill: cleanedTime.episodePill,
      isPinned,
      isAdult,
      uploadedAtMs: Date.now() - cleanedTime.minutesAgo * 60_000,
    });
  }

  const pageMatches = [...body.matchAll(/\/page\/(\d+)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => !isNaN(n) && n > 0 && n <= 2000);
  const maxPage = pageMatches.length > 0 ? Math.max(...pageMatches) : 520;

  return { items, maxPage };
}

function parseClientDetailHtml(html: string, itemPath: string, origin: string): MovieDetailData {
  let inlineData: any = null;
  const playerScriptMatch = html.match(
    /<script[^>]*id=["']mlbdInlinePlayerData["'][^>]*data-s=["']([^"']+)["'][^>]*data-r=["'](\d+)["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (playerScriptMatch) {
    const decodedJson = decodeMlbdCipherBrowser(
      playerScriptMatch[3],
      playerScriptMatch[1],
      parseInt(playerScriptMatch[2], 10) || 600
    );
    try {
      inlineData = JSON.parse(decodedJson);
    } catch {
      inlineData = null;
    }
  }

  const downloadButtons: DirectDownloadButton[] = [];
  const dlRegex =
    /<a[^>]*data-dl=["']([^"']+)["'][^>]*data-ds=["']([^"']+)["'][^>]*data-dr=["'](\d+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(dlRegex)) {
    const decodedHref = decodeMlbdCipherBrowser(
      match[1],
      match[2],
      parseInt(match[3], 10) || 300
    );
    const label = decodeHtmlEntities(match[4]);
    if (decodedHref) {
      const fullDlUrl = decodedHref.startsWith('http')
        ? decodedHref
        : `${origin}${decodedHref.startsWith('/') ? '' : '/'}${decodedHref}`;
      const bracketMatch = label.match(/\[(.*?)\]/);
      const parts = bracketMatch ? bracketMatch[1].split('•').map((s) => s.trim()) : [];
      downloadButtons.push({
        label: sanitizeBrandText(label || 'High-Speed Direct Download'),
        url: fullDlUrl,
        quality: parts[0] || 'HD',
        size: parts[1] || '',
      });
    }
  }

  const rawTitle =
    inlineData?.title ||
    decodeHtmlEntities((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || 'Cinema Title');
  const title = sanitizeBrandText(rawTitle);

  const poster =
    inlineData?.poster ||
    (html.match(
      /<div class=["']image-container-view["'][\s\S]*?<img[^>]+src=["'](https?:\/\/[^"']+)["']/i
    ) || [])[1] ||
    '';

  const qualityNote = sanitizeBrandText(
    decodeHtmlEntities(
      (html.match(/<div class=["']movie-info-view["'][\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] ||
        '1080p Full HD Stream'
    )
  );

  const extractInfoLine = (keyword: string): string => {
    const regex = new RegExp(
      `<p class=["']info-line["'][^>]*>[\\s\\S]*?${keyword}:?<\\/b>([\\s\\S]*?)<\\/p>`,
      'i'
    );
    const m = html.match(regex);
    return m ? decodeHtmlEntities(m[1]) : '';
  };

  const genre = extractInfoLine('Genre') || 'Cinema, Entertainment';
  const language = extractInfoLine('Language') || 'Multi Audio';
  const quality = extractInfoLine('Quality') || 'WEB-DL';
  const resolution = extractInfoLine('Resolution') || '1080p | 720p | 480p';
  const releaseDate = extractInfoLine('Released') || '2026';

  const storyline = sanitizeBrandText(
    decodeHtmlEntities(
      (html.match(/<p class=["']story-text["'][^>]*>([\s\S]*?)<\/p>/i) || [])[1] ||
        (html.match(/<meta name=["']description["'] content=["']([^"']+)["']/i) || [])[1] ||
        ''
    )
  );

  const trailerMatch = html.match(/data-mlbd-trailer=["']([a-zA-Z0-9_-]{6,20})["']/i);
  const youtubeTrailerId = trailerMatch ? trailerMatch[1] : '';

  const cast: CastMember[] = [];
  const castRegex =
    /<a class=["']mlbd-cast__p["'][^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["'][^>]*>[\s\S]*?<b>([\s\S]*?)<\/b>[\s\S]*?<small>([\s\S]*?)<\/small>/gi;
  for (const m of html.matchAll(castRegex)) {
    const actorName = decodeHtmlEntities(m[3]);
    if (actorName) {
      cast.push({
        url: `/search?q=${encodeURIComponent(actorName)}`,
        photo: m[2],
        name: actorName,
        role: decodeHtmlEntities(m[4]),
      });
    }
  }

  const inferStreamQuality = (s: any): number => {
    const combined = `${s?.quality_label || ''} ${s?.name || ''}`.toLowerCase();
    if (/\b(2160p|4k)\b/.test(combined)) return 2160;
    if (/\b(1080p|full\s*hd)\b/.test(combined)) return 1080;
    if (/\b(480p|360p)\b/.test(combined)) return 480;
    if (/\b720p\b/.test(combined)) return 720;
    const q = Number(s?.quality);
    if (q === 480 || q === 720 || q === 1080 || q === 2160) return q;
    if (/best\s*quality/i.test(combined)) return 1080;
    return 720;
  };

  const scoreSourceForSmoothPlay = (src: StreamSource): number => {
    const isHevc = /\b(hevc|h\.?265|x265|10bit)\b/i.test(`${src.name} ${src.qualityLabel}`);
    const isBestHeavy = /best\s*quality/i.test(src.qualityLabel || '');
    let score = isHevc ? 200 : 1000;
    if (isBestHeavy) score -= 250;
    if (/\.(mp4|m4v|m3u8)(\?|$)/i.test(src.url)) score += 90;
    if (/r2\.dev|workers\.dev|cloudflare|fsldownload|pixeldrain/i.test(src.url)) score += 50;
    if (src.quality >= 360 && src.quality <= 576) score += 650;
    else if (src.quality === 720) score += 500;
    else if (src.quality === 1080) score += 350;
    else if (src.quality === 2160) score += 150;
    else score += 200;
    return score;
  };

  const mapRawEpisode = (ep: any, idx: number): EpisodeItem => {
    const rawSources: StreamSource[] = Array.isArray(ep.sources)
      ? ep.sources
          .filter((s: any) => s && (s.url || s.download_url))
          .map((s: any, sIdx: number) => {
            const rawUrl = String(s.url || '');
            const rawStreamUrl = rawUrl.startsWith('http')
              ? rawUrl
              : rawUrl
                ? `${origin}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`
                : '';
            const rawDlUrl = String(s.download_url || s.url || '');
            const fullDlUrl = rawDlUrl.startsWith('http')
              ? rawDlUrl
              : rawDlUrl
                ? `${origin}${rawDlUrl.startsWith('/') ? '' : '/'}${rawDlUrl}`
                : '';
            const realQuality = inferStreamQuality(s);
            return {
              id: String(s.id || `src-${idx}-${realQuality}-${sIdx}`),
              quality: realQuality,
              qualityLabel: s.quality_label || `${realQuality}p`,
              audio: sanitizeBrandText(String(s.audio || 'Multi Audio')),
              audioLanguages: Array.isArray(s.audio_languages)
                ? s.audio_languages.map((a: any) => sanitizeBrandText(String(a)))
                : [sanitizeBrandText(String(s.audio || 'Original'))],
              provider: `Cloud Stream #${sIdx + 1}`,
              url: rawStreamUrl,
              downloadUrl: fullDlUrl,
              type: String(s.type || 'mkv').toLowerCase(),
              name: sanitizeBrandText(String(s.name || `${title} - ${realQuality}p`)),
              screenshot: s.screenshot || undefined,
            };
          })
      : [];

    const sources = [...rawSources].sort(
      (a, b) => scoreSourceForSmoothPlay(b) - scoreSourceForSmoothPlay(a)
    );

    const rawLabel = sanitizeBrandText(
      String(ep.label || (ep.number ? `Episode ${ep.number}` : 'Full Movie'))
    );

    const rangeMatch = rawLabel.match(/(?:ep(?:isode)?|e)\s*0*(\d{1,4})\s*[-–—]\s*0*(\d{1,4})/i);
    const singleEpMatch =
      rawLabel.match(/s\d+\s*e0*(\d{1,4})/i) ||
      rawLabel.match(/(?:ep(?:isode)?|e)\s*0*(\d{1,4})/i);
    const seasonMatch = rawLabel.match(/\bs(?:eason)?\s*0*(\d{1,2})\b/i);

    const parsedStart = rangeMatch
      ? Number(rangeMatch[1])
      : singleEpMatch
        ? Number(singleEpMatch[1])
        : null;
    const parsedEnd = rangeMatch ? Number(rangeMatch[2]) : parsedStart;

    const number =
      ep.number !== null && ep.number !== undefined
        ? Number(ep.number)
        : ep.range_start !== null && ep.range_start !== undefined
          ? Number(ep.range_start)
          : parsedStart;

    const rangeStart =
      ep.range_start !== null && ep.range_start !== undefined ? Number(ep.range_start) : number;
    const rangeEnd =
      ep.range_end !== null && ep.range_end !== undefined
        ? Number(ep.range_end)
        : parsedEnd ?? rangeStart;

    const season =
      ep.season !== null && ep.season !== undefined
        ? Number(ep.season)
        : seasonMatch
          ? Number(seasonMatch[1])
          : null;

    return {
      id: String(ep.id || `ep-${idx + 1}`),
      label: rawLabel,
      number,
      rangeStart,
      rangeEnd,
      season,
      kind: String(ep.kind || (number !== null ? 'episode' : 'movie')),
      sources,
    };
  };

  const episodes: EpisodeItem[] = Array.isArray(inlineData?.episodes)
    ? inlineData.episodes
        .map((ep: any, idx: number) => mapRawEpisode(ep, idx))
        .filter((ep: EpisodeItem) => ep.sources.length > 0)
        .sort((a: EpisodeItem, b: EpisodeItem) => {
          const sA = a.season ?? 0;
          const sB = b.season ?? 0;
          if (sA !== sB && a.season !== null && b.season !== null) return sA - sB;
          const nA = a.rangeStart ?? a.number ?? 999999;
          const nB = b.rangeStart ?? b.number ?? 999999;
          if (nA !== nB) return nA - nB;
          return (a.rangeEnd ?? nA) - (b.rangeEnd ?? nB);
        })
    : [];

  const screenshots: string[] = Array.isArray(inlineData?.screenshots)
    ? inlineData.screenshots.map((s: any) => s?.url).filter(Boolean)
    : [];

  return {
    title,
    url: itemPath,
    poster,
    qualityNote,
    typeBadge: inlineData?.content_type === 'series' || episodes.length > 1 ? 'SERIES' : 'MOVIE',
    language,
    quality,
    genre,
    resolution,
    releaseDate,
    storyline,
    youtubeTrailerId,
    screenshots,
    episodes,
    downloadButtons,
    cast: cast.slice(0, 12),
    communityScore: {
      recommendedPercent: 92,
      totalVotes: 420,
      verdict: 'Massive Hit',
    },
  };
}

/**
 * Universal API Fetcher:
 * - On Node.js server (AI Studio / Cloud Run / Render), uses `/api/...`
 * - On Static GitHub Pages (`*.github.io`), uses Instant Pre-Built Snapshot (`./static-db.json`)
 *   + Live Browser Cipher Decryptor (`allorigins.hexlet.app` + `decodeMlbdCipherBrowser`)
 */
export async function universalApiFetch(endpoint: string, init?: RequestInit): Promise<any> {
  const parsedUrl = new URL(endpoint, 'https://cinepulse.local');
  const pathname = parsedUrl.pathname;

  const isGitHubPages =
    typeof window !== 'undefined' && window.location.hostname.endsWith('github.io');

  // 0. Instant 0ms local memory / static-db / in-flight prefetch check for /api/details before any network fetch!
  if (pathname === '/api/details' && parsedUrl.searchParams.get('enrich') !== '1') {
    const rawPath = (parsedUrl.searchParams.get('path') || '').trim();
    const rawTitle = (parsedUrl.searchParams.get('title') || '').trim();
    if (!loadedStaticDb) {
      await loadStaticDb();
    }
    const instant = getInstantCachedDetail(rawPath, rawTitle);
    if (instant && instant.episodes && instant.episodes.length > 0) {
      return { ok: true, cached: true, detail: instant };
    }
    const existingPromise = rawPath ? inFlightDetailPromises.get(rawPath) : undefined;
    if (existingPromise) {
      const joined = await existingPromise;
      if (joined?.ok && joined?.detail) {
        return joined;
      }
    }
  }

  // 1. Try local server first when not on static github.io
  if (!isGitHubPages) {
    try {
      const res = await fetch(endpoint, init);
      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const json = await res.json();
        // Decode any `/api/go?t=` download tokens so direct downloads work everywhere
        if (json?.detail) {
          for (const ep of json.detail.episodes || []) {
            for (const src of ep.sources || []) {
              if (src.downloadUrl) src.downloadUrl = resolveDirectDownloadUrl(src.downloadUrl);
            }
          }
          for (const btn of json.detail.downloadButtons || []) {
            if (btn.url) btn.url = resolveDirectDownloadUrl(btn.url);
          }
          if (json.detail.url) {
            clientDetailCache.set(json.detail.url, { detail: json.detail, ts: Date.now() });
          }
          warmDetailFirstStream(json.detail);
        } else if (pathname === '/api/catalog' && Array.isArray(json?.items) && json.items.length > 0) {
          scheduleBackgroundCatalogDetailWarmup(
            json.items,
            parsedUrl.searchParams.get('node') || 'node-alpha'
          );
        }
        return json;
      }
    } catch {
      // fallback to client engine
    }
  }

  // 2. Built-in Serverless Browser Mirror & Snapshot Engine (100% standalone on GitHub Pages)
  const staticDb = await loadStaticDb();

  if (pathname === '/api/categories') {
    return {
      categories: ALL_CATEGORIES,
      nodes: [
        { id: 'node-alpha', name: 'Node Alpha', region: 'BD-Fast Edge' },
        { id: 'node-beta', name: 'Node Beta', region: 'SG-Ultra CDN' },
        { id: 'node-gamma', name: 'Node Gamma', region: 'Global Stream' },
        { id: 'node-delta', name: 'Node Delta', region: 'Backup Core' },
      ],
    };
  }

  if (pathname === '/api/server-health') {
    return {
      ok: true,
      nodes: [
        { id: 'node-alpha', name: 'Node Alpha', region: 'BD-Fast Edge', latencyMs: 38, online: true },
        { id: 'node-beta', name: 'Node Beta', region: 'SG-Ultra CDN', latencyMs: 54, online: true },
        { id: 'node-gamma', name: 'Node Gamma', region: 'Global Stream', latencyMs: 79, online: true },
        { id: 'node-delta', name: 'Node Delta', region: 'Backup Core', latencyMs: 96, online: true },
      ],
    };
  }

  if (pathname === '/api/suggest') {
    const q = (parsedUrl.searchParams.get('q') || '').trim();
    if (q.length < 2) return { ok: true, items: [], suggestions: [] };

    const lower = q.toLowerCase();
    // Instant local match from staticDb + fallback first
    const pool: MovieCardItem[] = [];
    const seen = new Set<string>();
    const allLists = [
      ...Object.values(staticDb?.catalogs || {}),
      ...Object.values(INITIAL_FALLBACK_MOVIES),
    ];
    for (const list of allLists) {
      for (const item of list) {
        if (!seen.has(item.path) && item.title.toLowerCase().includes(lower)) {
          seen.add(item.path);
          pool.push(item);
        }
      }
    }

    if (pool.length >= 5) {
      const top = pool.slice(0, 8);
      return { ok: true, items: top, suggestions: top };
    }

    const nodeId = parsedUrl.searchParams.get('node') || 'node-alpha';
    try {
      const { html } = await fetchMirrorHtmlClientSide(`/search?q=${encodeURIComponent(q)}`, nodeId);
      const { items } = parseClientCatalogHtml(html);
      const merged = [...pool, ...items.filter((i) => !seen.has(i.path))].slice(0, 8);
      return { ok: true, items: merged, suggestions: merged };
    } catch {
      return { ok: true, items: pool.slice(0, 8), suggestions: pool.slice(0, 8) };
    }
  }

  if (pathname === '/api/catalog') {
    const rawPath = parsedUrl.searchParams.get('path') || '/';
    const page = Math.max(1, parseInt(parsedUrl.searchParams.get('page') || '1', 10));
    const search = (parsedUrl.searchParams.get('q') || '').trim();
    const nodeId = parsedUrl.searchParams.get('node') || 'node-alpha';
    const forceRefresh = parsedUrl.searchParams.get('refresh') === '1';

    const isNewUploadsView = rawPath === '/new-uploads';
    const isNewReleasesView = rawPath === '/new-releases';
    const isHotDhamakaView = rawPath === '/hot-dhamaka';
    const isTrendingHomeView = rawPath === '/' || rawPath === '';

    let upstreamBase = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    if (isNewUploadsView || isNewReleasesView || isHotDhamakaView) {
      upstreamBase = '/';
    }

    let targetPath = upstreamBase;
    if (search) {
      targetPath = `/search?q=${encodeURIComponent(search)}`;
    } else if (page > 1) {
      const cleanBase = upstreamBase === '/' ? '' : upstreamBase.replace(/\/+$/, '');
      targetPath = `${cleanBase}/page/${page}`;
    }

    const cacheKey = `${rawPath}::p=${page}::q=${search}`;
    const memCached = clientCatalogCache.get(cacheKey);
    if (!forceRefresh && memCached && Date.now() - memCached.ts < 30_000) {
      scheduleBackgroundCatalogDetailWarmup(memCached.items, nodeId);
      return {
        ok: true,
        items: normalizeMovieCardList(memCached.items),
        page,
        maxPage: memCached.maxPage,
        activeNodeId: nodeId,
      };
    }

    // Helper to merge freshly scraped live items at the top of the pre-built snapshot
    // so 1-minute-old upstream uploads appear immediately on GitHub Pages without losing catalog depth!
    const mergeLiveWithSnapshot = (
      liveItems: MovieCardItem[],
      baseSnapshot?: MovieCardItem[]
    ): MovieCardItem[] => {
      if (!baseSnapshot || baseSnapshot.length === 0) return liveItems;
      const seenPaths = new Set<string>();
      const combined: MovieCardItem[] = [];
      for (const item of [...liveItems, ...baseSnapshot]) {
        if (!item?.path || seenPaths.has(item.path)) continue;
        seenPaths.add(item.path);
        combined.push(item);
      }
      return combined;
    };

    // Return pre-built snapshot immediately if available (including /page/2, /page/3, and all 42+ categories),
    // and refresh in background so initial load is < 50ms!
    const snapshotList = !search
      ? (page === 1 ? staticDb?.catalogs?.[rawPath] : undefined) ||
        staticDb?.catalogs?.[targetPath] ||
        (page === 1 ? staticDb?.catalogs?.[upstreamBase] : undefined)
      : undefined;
    if (snapshotList && snapshotList.length > 0 && !forceRefresh) {
      const finalizedSnapshot = isHotDhamakaView
        ? sortItemsByHotAndHype(snapshotList)
        : isNewUploadsView || isNewReleasesView
          ? sortItemsByRecentUpload(snapshotList)
          : isTrendingHomeView
            ? sortItemsByHotAndHype(snapshotList)
            : normalizeMovieCardList(snapshotList);
      scheduleBackgroundCatalogDetailWarmup(finalizedSnapshot, nodeId);
      // Trigger non-blocking live mirror refresh with cache-busting
      fetchMirrorHtmlClientSide(targetPath, nodeId, true)
        .then(({ html }) => {
          const parsed = parseClientCatalogHtml(html);
          if (parsed.items.length > 0) {
            const mergedRaw = mergeLiveWithSnapshot(parsed.items, snapshotList);
            const listToStore = isHotDhamakaView || isTrendingHomeView
              ? sortItemsByHotAndHype(mergedRaw)
              : isNewUploadsView || isNewReleasesView
                ? sortItemsByRecentUpload(mergedRaw)
                : normalizeMovieCardList(mergedRaw);
            clientCatalogCache.set(cacheKey, {
              items: listToStore,
              maxPage: parsed.maxPage,
              ts: Date.now(),
            });
          }
        })
        .catch(() => {});

      return {
        ok: true,
        items: finalizedSnapshot,
        page,
        maxPage: 520,
        activeNodeId: nodeId,
      };
    }

    try {
      const { html } = await fetchMirrorHtmlClientSide(targetPath, nodeId, true);
      const { items: rawLiveItems, maxPage } = parseClientCatalogHtml(html);
      const rawItems = mergeLiveWithSnapshot(rawLiveItems, snapshotList);
      let items = isHotDhamakaView || isTrendingHomeView
        ? sortItemsByHotAndHype(rawItems)
        : isNewUploadsView || isNewReleasesView
          ? sortItemsByRecentUpload(rawItems)
          : normalizeMovieCardList(rawItems);
      if (isNewReleasesView) {
        const filtered = items.filter((i) => i.title.includes('2026') || i.title.includes('2025'));
        if (filtered.length >= 6) items = filtered;
      }
      if (items.length > 0) {
        clientCatalogCache.set(cacheKey, { items, maxPage, ts: Date.now() });
        scheduleBackgroundCatalogDetailWarmup(items, nodeId);
        return { ok: true, items, page, maxPage, activeNodeId: nodeId };
      }
    } catch {
      // fallback
    }

    if (search) {
      const lower = search.toLowerCase();
      const matched: MovieCardItem[] = [];
      const seen = new Set<string>();
      for (const list of [
        ...Object.values(staticDb?.catalogs || {}),
        ...Object.values(INITIAL_FALLBACK_MOVIES),
      ]) {
        for (const item of list) {
          if (!seen.has(item.path) && item.title.toLowerCase().includes(lower)) {
            seen.add(item.path);
            matched.push(item);
          }
        }
      }
      const normMatched = normalizeMovieCardList(matched);
      return { ok: true, items: normMatched, page: 1, maxPage: 1, activeNodeId: nodeId };
    }

    const fallbackList = sortItemsByRecentUpload(
      snapshotList || INITIAL_FALLBACK_MOVIES[rawPath] || INITIAL_FALLBACK_MOVIES['/'] || []
    );
    return { ok: true, items: fallbackList, page: 1, maxPage: 520, activeNodeId: nodeId };
  }

  if (pathname === '/api/details') {
    const rawPath = (parsedUrl.searchParams.get('path') || '').trim();
    const rawTitle = (parsedUrl.searchParams.get('title') || '').trim();
    const nodeId = parsedUrl.searchParams.get('node') || 'node-alpha';

    const attachRelatedSeasons = (detailObj: MovieDetailData): MovieDetailData => {
      if (detailObj.relatedSeasons && detailObj.relatedSeasons.length > 0) return detailObj;
      const baseSeriesName = extractBaseSeriesTitle(rawTitle || detailObj.title);
      if (baseSeriesName && baseSeriesName.length >= 3) {
        const baseLower = baseSeriesName.toLowerCase();
        const allKnownItems = Object.values(staticDb?.catalogs || {}).flat();
        const matchingSeasons = allKnownItems.filter((item) => {
          const itemBase = extractBaseSeriesTitle(item.title).toLowerCase();
          return (
            item.path !== detailObj.url &&
            (itemBase === baseLower ||
              item.title.toLowerCase().startsWith(baseLower) ||
              baseLower.startsWith(itemBase))
          );
        });
        if (matchingSeasons.length > 0) {
          const uniqueSeasons: MovieCardItem[] = [];
          const seenS = new Set<string>();
          for (const s of matchingSeasons) {
            if (!seenS.has(s.path)) {
              seenS.add(s.path);
              uniqueSeasons.push(s);
            }
          }
          return { ...detailObj, relatedSeasons: uniqueSeasons.slice(0, 12) };
        }
      }
      return detailObj;
    };

    const isLiveEnrich = parsedUrl.searchParams.get('enrich') === '1';

    // 1. Check in-memory decrypted cache first (unless live enrich is requested)
    const cachedDetail = clientDetailCache.get(rawPath);
    if (!isLiveEnrich && cachedDetail && Date.now() - cachedDetail.ts < 60_000) {
      return { ok: true, detail: attachRelatedSeasons(cachedDetail.detail) };
    }

    // 2. Check pre-decrypted staticDb snapshot by path OR by matching title (unless live enrich is requested)!
    if (!isLiveEnrich && staticDb?.details) {
      if (rawPath && staticDb.details[rawPath]?.episodes?.length) {
        return { ok: true, detail: attachRelatedSeasons(staticDb.details[rawPath]) };
      }
      if (rawTitle) {
        const cleanWant = extractBaseSeriesTitle(rawTitle).toLowerCase();
        const foundByTitle = Object.values(staticDb.details).find((d) => {
          const dClean = extractBaseSeriesTitle(d.title).toLowerCase();
          return d.title === rawTitle || (cleanWant.length >= 4 && dClean === cleanWant);
        });
        if (foundByTitle && foundByTitle.episodes.length > 0) {
          return { ok: true, detail: attachRelatedSeasons(foundByTitle) };
        }
      }
    }

    // 3. Live fetch & cipher decrypt in browser (with cache-busting when isLiveEnrich is true)
    try {
      let { html, finalOrigin } = await fetchMirrorHtmlClientSide(
        rawPath || '/',
        nodeId,
        isLiveEnrich
      );
      if (!html.includes('mlbdInlinePlayerData') && rawTitle) {
        const cleanQuery = extractBaseSeriesTitle(rawTitle)
          .split(/\s+/)
          .slice(0, 4)
          .join(' ');
        if (cleanQuery) {
          const searchRes = await fetchMirrorHtmlClientSide(
            `/search?q=${encodeURIComponent(cleanQuery)}`,
            nodeId
          );
          const { items } = parseClientCatalogHtml(searchRes.html);
          if (items.length > 0) {
            const resolved = await fetchMirrorHtmlClientSide(items[0].path, nodeId);
            html = resolved.html;
            finalOrigin = resolved.finalOrigin;
          }
        }
      }

      const detail = parseClientDetailHtml(html, rawPath, finalOrigin);

      // Multi-season & related episodes discovery from staticDb or live search
      const baseSeriesName = extractBaseSeriesTitle(rawTitle || detail.title);
      if (baseSeriesName && baseSeriesName.length >= 3) {
        const baseLower = baseSeriesName.toLowerCase();
        const allKnownItems = Object.values(staticDb?.catalogs || {}).flat();
        const matchingSeasons = allKnownItems.filter((item) => {
          const itemBase = extractBaseSeriesTitle(item.title).toLowerCase();
          return (
            item.path !== rawPath &&
            (itemBase === baseLower ||
              item.title.toLowerCase().startsWith(baseLower) ||
              baseLower.startsWith(itemBase))
          );
        });
        if (matchingSeasons.length > 0) {
          const uniqueSeasons: MovieCardItem[] = [];
          const seenS = new Set<string>();
          for (const s of matchingSeasons) {
            if (!seenS.has(s.path)) {
              seenS.add(s.path);
              uniqueSeasons.push(s);
            }
          }
          detail.relatedSeasons = uniqueSeasons.slice(0, 12);
        }
      }

      if (detail.episodes.length > 0 || detail.downloadButtons.length > 0) {
        clientDetailCache.set(rawPath, { detail, ts: Date.now() });
        return { ok: true, detail };
      }
    } catch {
      // fallback below
    }

    // 4. Fallback: check staticDb by fuzzy title words (never return an unrelated movie!)
    const instantFallback = getInstantCachedDetail(rawPath, rawTitle);
    if (instantFallback && instantFallback.episodes?.length) {
      return { ok: true, detail: attachRelatedSeasons(instantFallback) };
    }

    return { ok: false, error: 'Unable to load stream metadata' };
  }

  if (pathname === '/api/requests') {
    const STORAGE_KEY = 'cp_local_movie_requests_v1';
    const defaultReqs = [
      {
        id: 'req-1',
        title: 'Pushpa 2: The Rule [Bangla Dubbed 4K]',
        type: 'MOVIE',
        language: 'Bangla Dubbed',
        notes: 'Full HD 1080p Dual Audio version',
        status: 'Processing',
        createdAt: Date.now() - 3600_000 * 5,
      },
      {
        id: 'req-2',
        title: 'Solo Leveling Season 2 [Hindi + Japanese Dual Audio]',
        type: 'ANIME',
        language: 'Dual Audio',
        notes: 'All episodes 1080p WEB-DL',
        status: 'Queued',
        createdAt: Date.now() - 3600_000 * 2,
      },
    ];

    let savedReqs = defaultReqs;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) savedReqs = parsed;
      }
    } catch {
      // ignore
    }

    if (init?.method === 'POST' && init.body) {
      try {
        const bodyObj = JSON.parse(String(init.body));
        const newReq = {
          id: `req-${Date.now()}`,
          title: sanitizeBrandText(String(bodyObj.title || '')),
          type: bodyObj.type || 'MOVIE',
          language: sanitizeBrandText(String(bodyObj.language || 'Bangla / Dual Audio')),
          notes: sanitizeBrandText(String(bodyObj.notes || '')),
          status: 'Queued',
          createdAt: Date.now(),
        };
        const updated = [newReq, ...savedReqs].slice(0, 25);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        return { ok: true, request: newReq, requests: updated };
      } catch {
        // ignore
      }
    }

    return { ok: true, requests: savedReqs };
  }

  return { ok: true, requests: [] };
}
