import { spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { ALL_CATEGORIES, INITIAL_FALLBACK_MOVIES } from './src/data/categories.ts';
import {
  cleanTimeAgoAndEpisode,
  normalizeMovieCardList,
  sortItemsByHotAndHype,
  sortItemsByRecentUpload,
} from './src/utils/timeAgo.ts';
import type {
  CastMember,
  DirectDownloadButton,
  EpisodeItem,
  MovieCardItem,
  MovieDetailData,
  ServerNodeStatus,
  StreamSource,
  UserMovieRequest,
} from './src/types/cinema.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (kept server alive):', err?.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (kept server alive):', reason);
});

interface MirrorNodeConfig {
  id: string;
  name: string;
  region: string;
  origin: string;
}

const SERVER_NODES: MirrorNodeConfig[] = [
  { id: 'node-alpha', name: 'Node Alpha', region: 'BD-Fast Edge', origin: 'https://cmyyhb.movielinkbd.at' },
  { id: 'node-beta', name: 'Node Beta', region: 'SG-Ultra CDN', origin: 'https://4yer8f.movielinkbd.at' },
  { id: 'node-gamma', name: 'Node Gamma', region: 'Global Stream', origin: 'https://movielinkbd.tv' },
  { id: 'node-delta', name: 'Node Delta', region: 'Backup Core', origin: 'https://movielinkbd.one' },
  { id: 'node-myflix', name: 'Node MyFlix', region: 'BD-Dual Hub', origin: 'https://myflixbd.to' },
];

const PRIMARY_MIRROR_NODES = SERVER_NODES.filter((n) => n.id !== 'node-myflix');
const MYFLIX_ORIGIN = 'https://myflixbd.to';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const catalogCache = new Map<string, CacheEntry<{ items: MovieCardItem[]; maxPage: number; activeNodeId: string }>>();
const detailCache = new Map<string, CacheEntry<MovieDetailData>>();
let healthCache: CacheEntry<ServerNodeStatus[]> | null = null;

const movieRequestsStore: UserMovieRequest[] = [
  {
    id: 'req-1',
    title: 'Pushpa 2: The Rule (2025) [Bangla Dubbed 4K]',
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

function encodeGatewayUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const token = Buffer.from(rawUrl, 'utf8').toString('base64url');
    return `/api/go?t=${token}`;
  } catch {
    return rawUrl;
  }
}

function decodeGatewayToken(token: string): string {
  try {
    return Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Strips any upstream site names, domains, watermarks, or tags from scraped text.
 */
function sanitizeBrandText(input: string): string {
  if (!input) return '';
  return input
    .replace(/https?:\/\/[^\s"'<>]*(?:movielinkbd|myflixbd)[^\s"'<>]*/gi, '')
    .replace(/\b[a-z0-9-]*\.?(?:movielinkbd|myflixbd)\.[a-z]{2,6}\b/gi, 'CinePulse')
    .replace(/movielinkbd|myflixbd|nexaflox/gi, 'CinePulse')
    .replace(/\bmlbd\b/gi, 'CP')
    .replace(/\s*watch\s+online\s+and\s+download\s*(?:["“”']?web-dl["“”']?|["“”']?hdtc["“”']?|["“”']?hd["“”']?|["“”']?4k["“”']?)?\s*…?/gi, '')
    .replace(/\s*watch\s+online\s*…?/gi, '')
    .replace(/\s+[–—-]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function decodeMlbdCipher(base64Str: string, hexSeed: string, rounds: number): string {
  try {
    let x = parseInt(hexSeed, 16) >>> 0;
    for (let i = 0; i < rounds; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    }
    const raw = Buffer.from(base64Str.trim(), 'base64');
    const out = Buffer.alloc(raw.length);
    for (let j = 0; j < raw.length; j++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      out[j] = raw[j] ^ ((x >>> 16) & 255);
    }
    return out.toString('utf8');
  } catch {
    return '';
  }
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

function getOrderedNodes(preferredNodeId?: string): MirrorNodeConfig[] {
  if (!preferredNodeId || preferredNodeId === 'node-myflix') return PRIMARY_MIRROR_NODES;
  const preferred = PRIMARY_MIRROR_NODES.find((n) => n.id === preferredNodeId);
  if (!preferred) return PRIMARY_MIRROR_NODES;
  return [preferred, ...PRIMARY_MIRROR_NODES.filter((n) => n.id !== preferredNodeId)];
}

async function fetchFromMirrors(
  targetPath: string,
  preferredNodeId?: string
): Promise<{ html: string; finalOrigin: string; activeNodeId: string }> {
  const cleanPath = targetPath.startsWith('http')
    ? new URL(targetPath).pathname + new URL(targetPath).search
    : targetPath.startsWith('/')
      ? targetPath
      : `/${targetPath}`;

  const orderedNodes = getOrderedNodes(preferredNodeId);

  const attemptNode = async (node: MirrorNodeConfig, timeoutMs: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${node.origin}${cleanPath}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8',
          Cookie: 'mlbd_show18=1; hide18On=false',
          Referer: `${node.origin}/`,
        },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`HTTP ${res.status}`);
      }
      const html = await res.text();
      if (
        !html ||
        html.length < 1200 ||
        (!html.includes('movie-card') &&
          !html.includes('mlbdInlinePlayerData') &&
          !html.includes('<div class="n">404</div>'))
      ) {
        throw new Error('Challenge or incomplete HTML');
      }
      const finalOrigin = new URL(res.url || url).origin;
      return { html, finalOrigin, activeNodeId: node.id };
    } finally {
      clearTimeout(timer);
    }
  };

  // Race top 2 mirror nodes in parallel for sub-second response!
  try {
    return await Promise.any(
      orderedNodes.slice(0, 2).map((node) => attemptNode(node, 5500))
    );
  } catch {
    for (const node of orderedNodes.slice(2)) {
      try {
        return await attemptNode(node, 6500);
      } catch {
        // try next
      }
    }
  }
  throw new Error('All cinema stream nodes unreachable');
}

function parseMovieCards(html: string): { items: MovieCardItem[]; maxPage: number } {
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

    let itemPath = '';
    try {
      itemPath = rawHref.startsWith('http')
        ? new URL(rawHref).pathname
        : rawHref.startsWith('/')
          ? rawHref
          : `/${rawHref}`;
    } catch {
      continue;
    }

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
      (chunk.match(/<span class=["']views-badge-top["'][^>]*>[\s\S]*?<\/i>\s*([^<]+)<\/span>/i) || [])[1] || '2.4K'
    );
    const rawTimeAgo = decodeHtmlEntities(
      (chunk.match(/<div class=["']upload-time["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || 'Recently added'
    );
    const rawEpisodePill = decodeHtmlEntities(
      (chunk.match(/<span class=["']badge ep-badge[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || ''
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
      // Never expose upstream URL; keep clean relative path
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

function parseMovieDetail(html: string, itemPath: string, origin: string): MovieDetailData {
  let inlineData: any = null;
  const playerScriptMatch = html.match(
    /<script[^>]*id=["']mlbdInlinePlayerData["'][^>]*data-s=["']([^"']+)["'][^>]*data-r=["'](\d+)["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (playerScriptMatch) {
    const decodedJson = decodeMlbdCipher(
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
  const dlRegex = /<a[^>]*data-dl=["']([^"']+)["'][^>]*data-ds=["']([^"']+)["'][^>]*data-dr=["'](\d+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(dlRegex)) {
    const decodedHref = decodeMlbdCipher(match[1], match[2], parseInt(match[3], 10) || 300);
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
    (html.match(/<div class=["']image-container-view["'][\s\S]*?<img[^>]+src=["'](https?:\/\/[^"']+)["']/i) || [])[1] ||
    '';

  const qualityNote = sanitizeBrandText(
    decodeHtmlEntities(
      (html.match(/<div class=["']movie-info-view["'][\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || ''
    )
  );

  const extractInfoLine = (keyword: string): string => {
    const regex = new RegExp(`<p class=["']info-line["'][^>]*>[\\s\\S]*?${keyword}:?<\\/b>([\\s\\S]*?)<\\/p>`, 'i');
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
  const castRegex = /<a class=["']mlbd-cast__p["'][^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["'][^>]*>[\s\S]*?<b>([\s\S]*?)<\/b>[\s\S]*?<small>([\s\S]*?)<\/small>/gi;
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

  let communityScore: MovieDetailData['communityScore'] | undefined;
  const voteMatch = html.match(/data-summary=["']([^"']+)["']/i);
  if (voteMatch) {
    try {
      const parsedVote = JSON.parse(decodeHtmlEntities(voteMatch[1]));
      communityScore = {
        recommendedPercent: Number(parsedVote.recommended_percent) || 88,
        totalVotes: Number(parsedVote.total) || 24,
        verdict: sanitizeBrandText(parsedVote.verdict || 'দর্শকদের পছন্দ'),
      };
    } catch {
      // ignore
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
              downloadUrl: encodeGatewayUrl(fullDlUrl),
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

    // Parse episode range or season from label if not explicitly set
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
      ep.range_start !== null && ep.range_start !== undefined
        ? Number(ep.range_start)
        : number;
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
    communityScore,
  };
}

function extractBaseSeriesTitle(rawTitle: string): string {
  return rawTitle
    .replace(/\[.*?\]|\(.*?\)/g, ' ')
    .replace(/\b(?:S\d+|Season\s*\d+(?:-\d+)?|Ep(?:isode)?\s*\d+(?:-\d+)?|Complete(?:d)?|Added|Full\s*HD|ORG|Hindi|Bangla|Bengali|Dual|Multi|Audio|Watch|Online|Download|WEB-DL|HDTC|4K|The\s*Movie)\b/gi, ' ')
    .replace(/[:\-–—|]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function mapCategoryToMyFlixPath(rawPath: string, page = 1, search = ''): string {
  if (search) {
    return page > 1
      ? `/page/${page}/?s=${encodeURIComponent(search)}`
      : `/?s=${encodeURIComponent(search)}`;
  }

  const p = (rawPath || '/').toLowerCase().replace(/\/page\/\d+\/?$/, '').replace(/\/+$/, '') || '/';
  let mfBase = '/';

  if (p === '/' || p === '/home' || p === '/movies') mfBase = '/';
  else if (p.includes('bangla-dubbed') || p.includes('bangladubbed')) mfBase = '/movie-genre/bangla-dubbed/';
  else if (p.includes('bangla') || p.includes('bengali') || p.includes('kolkata')) mfBase = '/movie-genre/bangla/';
  else if (p.includes('hindi-dubbed') || p.includes('hindidubbed')) mfBase = '/movie-genre/hindi-dubbed/';
  else if (p.includes('bollywood') || p.includes('hindi')) mfBase = '/movie-genre/hindi/';
  else if (p.includes('south') || p.includes('tamil') || p.includes('telugu') || p.includes('malayalam') || p.includes('kannada'))
    mfBase = '/movie-genre/south-indian/';
  else if (p.includes('hollywood') || p.includes('english')) mfBase = '/movie-genre/hollywood/';
  else if (p.includes('anime') || p.includes('animation')) mfBase = '/tv-genre/anime/';
  else if (p.includes('drama') || p.includes('korean') || p.includes('k-drama')) mfBase = '/tv-genre/k-drama/';
  else if (p.includes('series') || p.includes('ongoing') || p.includes('tv')) mfBase = '/tv-show/';
  else return '';

  if (page > 1) {
    const clean = mfBase === '/' ? '' : mfBase.replace(/\/+$/, '');
    return `${clean}/page/${page}/`;
  }
  return mfBase;
}

async function fetchMyFlixHtml(mfPath: string, timeoutMs = 4800): Promise<string> {
  if (!mfPath) throw new Error('Empty MyFlix path');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const cleanPath = mfPath.startsWith('http')
      ? new URL(mfPath).pathname + new URL(mfPath).search
      : mfPath.startsWith('/')
        ? mfPath
        : `/${mfPath}`;
    const url = `${MYFLIX_ORIGIN}${cleanPath}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8',
        Referer: `${MYFLIX_ORIGIN}/`,
      },
    });
    if (!res.ok) throw new Error(`MyFlix HTTP ${res.status}`);
    const html = await res.text();
    if (!html || html.length < 1000) throw new Error('Incomplete MyFlix HTML');
    return html;
  } finally {
    clearTimeout(timer);
  }
}

function parseMyFlixCards(html: string): { items: MovieCardItem[]; maxPage: number } {
  const bodyIdx = html.indexOf('<body');
  const body = bodyIdx >= 0 ? html.slice(bodyIdx) : html;
  const cardRegex = /<a\s+href=["'](https?:\/\/myflixbd\.to\/(?:movie|tv-show)\/[^"']+)["'][^>]*class=["'][^"']*movie-card[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  const items: MovieCardItem[] = [];
  const seenPaths = new Set<string>();

  for (const match of body.matchAll(cardRegex)) {
    const rawHref = match[1].trim();
    const chunk = match[2];
    if (!rawHref) continue;

    let cleanPathname = '';
    try {
      cleanPathname = new URL(rawHref).pathname.replace(/^\/+|\/+$/g, '');
    } catch {
      continue;
    }
    if (!cleanPathname) continue;

    const itemPath = `/mf/${cleanPathname}`;
    if (seenPaths.has(itemPath)) continue;
    seenPaths.add(itemPath);

    const titleMatch =
      chunk.match(/<h3[^>]*class=["'][^"']*movie-title[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i) ||
      chunk.match(/alt=["']([^"']+)["']/i);
    if (!titleMatch) continue;

    const title = decodeHtmlEntities(titleMatch[1]);
    if (!title) continue;

    const posterMatch =
      chunk.match(/data-src=["'](https?:\/\/[^"']+)["']/i) ||
      chunk.match(/src=["'](https?:\/\/[^"']+)["']/i);
    const poster = posterMatch ? posterMatch[1].trim() : '';

    const quality = decodeHtmlEntities(
      (chunk.match(/card-badge-quality["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || 'WEB-DL'
    );
    const language = decodeHtmlEntities(
      (chunk.match(/card-badge-lang["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || 'MULTI'
    );
    const epBadge = decodeHtmlEntities(
      (chunk.match(/card-badge-ep["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || ''
    );
    const ratingBadge = decodeHtmlEntities(
      (chunk.match(/card-badge-rating["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || ''
    );
    const catBadge = decodeHtmlEntities(
      (chunk.match(/card-badge-category["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || ''
    ).toUpperCase();

    let typeBadge: 'MOVIE' | 'SERIES' | 'ANIME' | 'DRAMA' = 'MOVIE';
    if (catBadge.includes('ANIME') || title.toLowerCase().includes('anime')) typeBadge = 'ANIME';
    else if (catBadge.includes('DRAMA') || language.toUpperCase().includes('KOREAN')) typeBadge = 'DRAMA';
    else if (
      catBadge.includes('SERIES') ||
      cleanPathname.startsWith('tv-show/') ||
      Boolean(epBadge) ||
      /season\s*\d+/i.test(title)
    ) {
      typeBadge = 'SERIES';
    }

    const cleanedTime = cleanTimeAgoAndEpisode(
      '',
      epBadge || (quality.toUpperCase().includes('SEASON') ? quality : ''),
      itemPath || title,
      items.length + 2
    );

    items.push({
      id: itemPath.replace(/[^a-zA-Z0-9_-]/g, '_'),
      title,
      url: itemPath,
      path: itemPath,
      poster,
      quality: quality || 'WEB-DL',
      views: ratingBadge || '★ 8.1',
      language: language || 'MULTI',
      typeBadge,
      timeAgo: cleanedTime.timeAgo,
      episodePill: cleanedTime.episodePill,
      isPinned: chunk.includes('card-badge-trending'),
      isAdult: false,
      uploadedAtMs: Date.now() - cleanedTime.minutesAgo * 60_000,
    });
  }

  const pageMatches = [...body.matchAll(/\/page\/(\d+)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => !isNaN(n) && n > 0 && n <= 2000);
  const maxPage = pageMatches.length > 0 ? Math.max(...pageMatches) : 342;

  return { items, maxPage };
}

function mergeCatalogItems(
  primaryItems: MovieCardItem[],
  secondaryItems: MovieCardItem[],
  preferSecondaryFirst = false
): MovieCardItem[] {
  const firstList = preferSecondaryFirst ? secondaryItems : primaryItems;
  const secondList = preferSecondaryFirst ? primaryItems : secondaryItems;

  const result: MovieCardItem[] = [];
  const seenPaths = new Set<string>();
  const seenBaseTitles = new Set<string>();

  const normKey = (t: string): string => {
    const base = extractBaseSeriesTitle(t).toLowerCase().replace(/[^a-z0-9\u0980-\u09ff]+/g, '');
    return base.length >= 3 ? base : t.toLowerCase().trim();
  };

  for (const item of firstList) {
    if (seenPaths.has(item.path)) continue;
    seenPaths.add(item.path);
    seenBaseTitles.add(normKey(item.title));
    result.push(item);
  }

  for (const item of secondList) {
    if (seenPaths.has(item.path)) continue;
    const key = normKey(item.title);
    if (seenBaseTitles.has(key)) continue;
    seenPaths.add(item.path);
    seenBaseTitles.add(key);
    result.push(item);
  }

  return result;
}

function parseMyFlixDetail(html: string, itemPath: string): MovieDetailData {
  const rawTitle = decodeHtmlEntities(
    (html.match(/<h1[^>]*class=["'][^"']*movie-title-text[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i) ||
      html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
      [])[1] || 'Cinema Title'
  );
  const title = sanitizeBrandText(rawTitle);

  const poster =
    (html.match(/<div class=["']poster-wrapper["'][\s\S]*?data-src=["'](https?:\/\/[^"']+)["']/i) ||
      html.match(/<div class=["']poster-wrapper["'][\s\S]*?src=["'](https?:\/\/[^"']+)["']/i) ||
      html.match(/property=["']og:image["']\s+content=["'](https?:\/\/[^"']+)["']/i) ||
      [])[1] || '';

  const extractMetaGrid = (label: string): string => {
    const regex = new RegExp(
      `<span class=["']meta-label["'][^>]*>\\s*${label}\\s*<\\/span>\\s*<span class=["']meta-value["'][^>]*>([\\s\\S]*?)<\\/span>`,
      'i'
    );
    const m = html.match(regex);
    return m ? decodeHtmlEntities(m[1]) : '';
  };

  const year = extractMetaGrid('Year') || '2026';
  const genre = extractMetaGrid('Genre') || 'Action, Drama, Thriller';
  const runtime = extractMetaGrid('Runtime') || '';
  const releaseDate = extractMetaGrid('Release') || year;

  const langBracketMatch = rawTitle.match(/\[(.*?)\]/);
  const language = langBracketMatch ? decodeHtmlEntities(langBracketMatch[1]) : 'Multi Audio';
  const quality =
    decodeHtmlEntities((html.match(/<div class=["']badge-hd["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '') ||
    'WEB-DL';

  const storyline = sanitizeBrandText(
    decodeHtmlEntities(
      (html.match(/<p id=["']synopsisText["'][^>]*>([\s\S]*?)<\/p>/i) ||
        html.match(/<div class=["']synopsis-box["'][\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ||
        [])[1] || ''
    )
  );

  const ratingScoreNum = parseFloat(
    (html.match(/<span class=["']rating-score["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '8.4'
  );
  const communityScore = {
    recommendedPercent: Math.min(99, Math.max(70, Math.round((ratingScoreNum || 8.4) * 10))),
    totalVotes: 310,
    verdict: 'দর্শকদের পছন্দ',
  };

  const cast: CastMember[] = [];
  const castRegex =
    /<div class=["']cast-card["'][^>]*>[\s\S]*?(?:data-src|src)=["'](https?:\/\/[^"']+)["'][\s\S]*?<p class=["']cast-name["'][^>]*>([\s\S]*?)<\/p>/gi;
  for (const m of html.matchAll(castRegex)) {
    const actorName = decodeHtmlEntities(m[2]);
    if (actorName) {
      cast.push({
        url: `/search?q=${encodeURIComponent(actorName)}`,
        photo: m[1],
        name: actorName,
        role: 'Cast',
      });
    }
  }

  const downloadButtons: DirectDownloadButton[] = [];
  const dlBtnRegex =
    /<a[^>]*class=["'][^"']*dl-v2-btn[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<div class=["']dl-v2-title["'][^>]*>([\s\S]*?)<\/div>/gi;
  for (const m of html.matchAll(dlBtnRegex)) {
    const rawDlHref = m[1].trim();
    const rawLabel = decodeHtmlEntities(m[2]);
    if (!rawDlHref || rawDlHref === '#') continue;
    const qMatch = rawLabel.match(/(2160p|4k|1080p|720p|480p)/i);
    const qLabel = qMatch ? qMatch[1] : 'HD';
    downloadButtons.push({
      label: sanitizeBrandText(rawLabel || `Download ${qLabel}`),
      url: encodeGatewayUrl(rawDlHref),
      quality: qLabel,
      size: runtime || 'Full HD',
    });
  }

  const episodes: EpisodeItem[] = [];

  // 1. Check if `seasonsData` JSON array is embedded (for Series / K-Drama / Anime)
  const seasonsMatch = html.match(/(?:const|let|var)\s+seasonsData\s*=\s*(\[\s*\{[\s\S]*?\}\s*\])\s*;?/);
  if (seasonsMatch) {
    try {
      const parsedSeasons = JSON.parse(seasonsMatch[1]);
      if (Array.isArray(parsedSeasons)) {
        let globalIdx = 0;
        for (const sObj of parsedSeasons) {
          const seasonNum = Number(sObj?.index) || 1;
          const epArray = Array.isArray(sObj?.episodes) ? sObj.episodes : [];
          for (const epObj of epArray) {
            globalIdx++;
            const epNum = Number(epObj?.index) || globalIdx;
            const epTitle = decodeHtmlEntities(String(epObj?.title || `Episode ${epNum}`));
            const servers = Array.isArray(epObj?.servers) ? epObj.servers : [];
            const sources: StreamSource[] = servers
              .filter((srv: any) => srv && srv.url)
              .map((srv: any, sIdx: number) => {
                const srvUrl = String(srv.url).replace(/\\\//g, '/').trim();
                const fallbackDl = downloadButtons[0]?.url || encodeGatewayUrl(srvUrl);
                return {
                  id: `mf-s${seasonNum}-e${epNum}-srv${sIdx}`,
                  quality: 1080,
                  qualityLabel: decodeHtmlEntities(String(srv.label || `Server ${sIdx + 1} (HD)`)),
                  audio: language,
                  audioLanguages: [language],
                  provider: `Stream Server #${sIdx + 1}`,
                  url: srvUrl,
                  downloadUrl: fallbackDl,
                  type: 'embed',
                  name: `${title} - ${epTitle}`,
                };
              });

            if (sources.length > 0) {
              episodes.push({
                id: `mf-ep-${seasonNum}-${epNum}`,
                label: epTitle.toLowerCase().includes('all')
                  ? `Season ${seasonNum} • Full Stream`
                  : `S${String(seasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')} • ${epTitle}`,
                number: epNum,
                rangeStart: epNum,
                rangeEnd: epNum,
                season: seasonNum,
                kind: 'episode',
                sources,
              });
            }
          }
        }
      }
    } catch {
      // ignore JSON parse issues
    }
  }

  // 2. Also extract inline `.btn-server[data-url]` or `.video-container iframe` for Movies
  if (episodes.length === 0) {
    const serverUrls: Array<{ label: string; url: string }> = [];
    const seenSrv = new Set<string>();

    const btnSrvRegex = /<button[^>]*class=["'][^"']*btn-server[^"']*["'][^>]*data-url=["']([^"']+)["'][^>]*>([\s\S]*?)<\/button>/gi;
    for (const m of html.matchAll(btnSrvRegex)) {
      const u = m[1].trim();
      const lbl = decodeHtmlEntities(m[2]) || `Server ${serverUrls.length + 1}`;
      if (u && u.startsWith('http') && !seenSrv.has(u)) {
        seenSrv.add(u);
        serverUrls.push({ label: lbl, url: u });
      }
    }

    const iframeMatch =
      html.match(/<div class=["']video-container["'][\s\S]*?<iframe[^>]+data-litespeed-src=["'](https?:\/\/[^"']+)["']/i) ||
      html.match(/<div class=["']video-container["'][\s\S]*?<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i);
    if (iframeMatch && iframeMatch[1] && !seenSrv.has(iframeMatch[1])) {
      seenSrv.add(iframeMatch[1]);
      serverUrls.push({ label: 'Server 1 (HD)', url: iframeMatch[1].trim() });
    }

    if (serverUrls.length > 0) {
      const fallbackDl = downloadButtons[0]?.url || encodeGatewayUrl(serverUrls[0].url);
      episodes.push({
        id: 'mf-movie-main',
        label: 'Full Movie',
        number: 1,
        rangeStart: 1,
        rangeEnd: 1,
        season: null,
        kind: 'movie',
        sources: serverUrls.map((srv, idx) => ({
          id: `mf-movie-srv-${idx}`,
          quality: idx === 0 ? 1080 : 720,
          qualityLabel: srv.label,
          audio: language,
          audioLanguages: [language],
          provider: srv.label,
          url: srv.url,
          downloadUrl: fallbackDl,
          type: 'embed',
          name: `${title} (${srv.label})`,
        })),
      });
    }
  }

  return {
    title,
    url: itemPath,
    poster,
    qualityNote: `${quality} • ${language}${runtime ? ` • ${runtime}` : ''}`,
    typeBadge: itemPath.includes('/tv-show/') || episodes.length > 1 ? 'SERIES' : 'MOVIE',
    language,
    quality,
    genre,
    resolution: '1080p | 720p | 480p',
    releaseDate,
    storyline,
    youtubeTrailerId: '',
    screenshots: [],
    episodes,
    downloadButtons,
    cast: cast.slice(0, 12),
    communityScore,
  };
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json());

  // Preload static-db.json into RAM asynchronously after startup so server binds port 3000 immediately
  const preloadStaticDb = async () => {
    try {
      const staticDbPath = path.join(__dirname, 'public', 'static-db.json');
      if (fs.existsSync(staticDbPath)) {
        const rawJson = await fs.promises.readFile(staticDbPath, 'utf8');
        const parsed = JSON.parse(rawJson);
        const catalogTtl = Date.now() + 45_000;
        const detailTtl = Date.now() + 3600_000 * 6;
        if (parsed?.catalogs) {
          for (const [catPath, items] of Object.entries(parsed.catalogs)) {
            if (Array.isArray(items) && items.length > 0) {
              const normItems = normalizeMovieCardList(items as MovieCardItem[]);
              catalogCache.set(`${catPath}::page=1::q=::node=auto`, {
                data: { items: normItems, maxPage: 520, activeNodeId: 'node-alpha' },
                expiresAt: catalogTtl,
              });
              catalogCache.set(`${catPath}::page=1::q=::node=node-alpha`, {
                data: { items: normItems, maxPage: 520, activeNodeId: 'node-alpha' },
                expiresAt: catalogTtl,
              });
            }
          }
        }
        if (parsed?.details) {
          for (const [itemPath, det] of Object.entries(parsed.details)) {
            if (det && typeof det === 'object') {
              detailCache.set(itemPath, {
                data: det as MovieDetailData,
                expiresAt: detailTtl,
              });
            }
          }
        }
      }
    } catch {
      // ignore preload errors
    }
  };
  setTimeout(preloadStaticDb, 100);

  // Pre-warm & auto-sync main catalog categories in background (merging primary nodes + myflixbd.to!)
  const syncLiveCategories = async () => {
    const warmPaths = ['/', '/anime', '/ongoing', '/drama', '/southIndian', '/bollywood', '/language/bangla', '/adult18plus'];
    for (const wp of warmPaths) {
      try {
        const cacheKey = `${wp}::page=1::q=::node=auto`;
        const mfPath = mapCategoryToMyFlixPath(wp, 1, '');
        const [primaryRes, mfRes] = await Promise.allSettled([
          fetchFromMirrors(wp),
          mfPath ? fetchMyFlixHtml(mfPath) : Promise.reject(new Error('No MF mapping')),
        ]);

        const primaryParsed =
          primaryRes.status === 'fulfilled'
            ? parseMovieCards(primaryRes.value.html)
            : { items: [], maxPage: 520 };
        const activeNodeId =
          primaryRes.status === 'fulfilled' ? primaryRes.value.activeNodeId : 'node-alpha';
        const mfParsed =
          mfRes.status === 'fulfilled' ? parseMyFlixCards(mfRes.value) : { items: [], maxPage: 342 };

        const rawMergedItems = mergeCatalogItems(primaryParsed.items, mfParsed.items, false);
        const mergedItems =
          wp === '/'
            ? sortItemsByHotAndHype(rawMergedItems)
            : normalizeMovieCardList(rawMergedItems);
        if (mergedItems.length > 0) {
          const entry = {
            data: {
              items: mergedItems,
              maxPage: Math.max(primaryParsed.maxPage, mfParsed.maxPage),
              activeNodeId,
            },
            expiresAt: Date.now() + 180_000,
          };
          catalogCache.set(cacheKey, entry);
          catalogCache.set(`${wp}::page=1::q=::node=${activeNodeId}`, entry);

          // Gently pre-warm top 3 uncached details per category
          for (const card of mergedItems.slice(0, 3)) {
            if (!card.path || card.path.startsWith('/mf/') || detailCache.has(card.path)) continue;
            try {
              const { html, finalOrigin } = await fetchFromMirrors(card.path, activeNodeId);
              const det = parseMovieDetail(html, card.path, finalOrigin);
              if (det.episodes.length > 0) {
                detailCache.set(card.path, {
                  data: det,
                  expiresAt: Date.now() + 3600_000,
                });
              }
            } catch {
              // ignore single detail warmup failure
            }
          }
        }
      } catch {
        // ignore background warmup errors
      }
    }
  };
  setTimeout(syncLiveCategories, 12_000).unref();
  setInterval(syncLiveCategories, 180_000).unref();

  // 1. Categories & Anonymized Server Nodes Endpoint
  app.get('/api/categories', (_req, res) => {
    res.json({
      categories: ALL_CATEGORIES,
      nodes: SERVER_NODES.map(({ id, name, region }) => ({ id, name, region })),
    });
  });

  // 2. Live Server Node Ping & Health Check Endpoint (Anonymized)
  app.get('/api/server-health', async (_req, res) => {
    if (healthCache && healthCache.expiresAt > Date.now()) {
      res.json({ ok: true, nodes: healthCache.data });
      return;
    }

    const checks = await Promise.all(
      SERVER_NODES.map(async (node): Promise<ServerNodeStatus> => {
        const start = Date.now();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 4500);
          const r = await fetch(node.origin, {
            method: 'HEAD',
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0' },
          });
          clearTimeout(timer);
          const latencyMs = Math.max(18, Date.now() - start);
          return {
            id: node.id,
            name: node.name,
            region: node.region,
            latencyMs,
            online: r.ok || r.status < 500,
          };
        } catch {
          return {
            id: node.id,
            name: node.name,
            region: node.region,
            latencyMs: 999,
            online: false,
          };
        }
      })
    );

    healthCache = {
      data: checks,
      expiresAt: Date.now() + 30_000,
    };

    res.json({ ok: true, nodes: checks });
  });

  // 3. Instant Live Search Suggestions Endpoint (Searches both Primary Mirrors & MyFlixBD in parallel!)
  app.get('/api/suggest', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const nodeId = String(req.query.node || '').trim();
    if (q.length < 2) {
      res.json({ ok: true, items: [] });
      return;
    }

    const targetPath = `/search?q=${encodeURIComponent(q)}`;
    const cacheKey = `suggest::${targetPath}::${nodeId || 'auto'}`;
    const cached = catalogCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.json({ ok: true, items: cached.data.items.slice(0, 12) });
      return;
    }

    try {
      const [primaryRes, mfRes] = await Promise.allSettled([
        fetchFromMirrors(targetPath, nodeId),
        fetchMyFlixHtml(`/?s=${encodeURIComponent(q)}`, 4200),
      ]);

      const primaryItems =
        primaryRes.status === 'fulfilled' ? parseMovieCards(primaryRes.value.html).items : [];
      const mfItems =
        mfRes.status === 'fulfilled' ? parseMyFlixCards(mfRes.value).items : [];
      const activeNodeId =
        primaryRes.status === 'fulfilled' ? primaryRes.value.activeNodeId : 'node-myflix';

      const merged = mergeCatalogItems(primaryItems, mfItems, nodeId === 'node-myflix');
      if (merged.length > 0) {
        catalogCache.set(cacheKey, {
          data: { items: merged, maxPage: 1, activeNodeId },
          expiresAt: Date.now() + 120_000,
        });
        res.json({ ok: true, items: merged.slice(0, 12) });
        return;
      }
    } catch {
      // fallback below
    }

    const fallback = (INITIAL_FALLBACK_MOVIES['/'] || []).filter((item) =>
      item.title.toLowerCase().includes(q.toLowerCase())
    );
    res.json({ ok: true, items: fallback.slice(0, 10) });
  });

  // 4. Live Catalog & Search Endpoint (Merging Primary Mirrors + MyFlixBD for 100% Content Coverage!)
  app.get('/api/catalog', async (req, res) => {
    const rawPath = String(req.query.path || '/').trim();
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const search = String(req.query.q || '').trim();
    const nodeId = String(req.query.node || '').trim();
    const forceRefresh = String(req.query.refresh || '0') === '1';

    const isNewUploadsView = rawPath === '/new-uploads';
    const isNewReleasesView = rawPath === '/new-releases';
    const isHotDhamakaView = rawPath === '/hot-dhamaka';
    const isTrendingHomeView = rawPath === '/' || rawPath === '';

    let upstreamBasePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    if (isNewUploadsView || isNewReleasesView || isHotDhamakaView) {
      upstreamBasePath = '/';
    }

    let targetPath = upstreamBasePath;
    if (search) {
      targetPath = `/search?q=${encodeURIComponent(search)}`;
    } else if (page > 1) {
      const base = upstreamBasePath === '/' ? '' : upstreamBasePath.replace(/\/+$/, '');
      targetPath = `${base}/page/${page}`;
    }

    const cacheKey = `${rawPath}::page=${page}::q=${search}::node=${nodeId || 'auto'}`;
    const cached = catalogCache.get(cacheKey);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      res.json({
        ok: true,
        cached: true,
        path: rawPath,
        page,
        maxPage: cached.data.maxPage,
        activeNodeId: cached.data.activeNodeId,
        items: normalizeMovieCardList(cached.data.items),
      });
      return;
    }

    try {
      const mfTargetPath = mapCategoryToMyFlixPath(upstreamBasePath, page, search);
      const [primaryRes, mfRes] = await Promise.allSettled([
        fetchFromMirrors(targetPath, nodeId),
        mfTargetPath ? fetchMyFlixHtml(mfTargetPath) : Promise.reject(new Error('No MF path')),
      ]);

      const primaryParsed =
        primaryRes.status === 'fulfilled'
          ? parseMovieCards(primaryRes.value.html)
          : { items: [], maxPage: 520 };
      const mfParsed =
        mfRes.status === 'fulfilled'
          ? parseMyFlixCards(mfRes.value)
          : { items: [], maxPage: 342 };

      const activeNodeId =
        nodeId === 'node-myflix'
          ? 'node-myflix'
          : primaryRes.status === 'fulfilled'
            ? primaryRes.value.activeNodeId
            : 'node-myflix';

      let items = mergeCatalogItems(
        primaryParsed.items,
        mfParsed.items,
        nodeId === 'node-myflix'
      );

      // For Trending (/), Hot & Dhamaka (/hot-dhamaka), New Upload (/new-uploads), and New Release (/new-releases) on page 1,
      // also include any brand-new uploads discovered in other cached categories!
      if (!search && (isTrendingHomeView || isHotDhamakaView || isNewUploadsView || isNewReleasesView)) {
        if (page === 1) {
          const extraRecent: MovieCardItem[] = [];
          for (const [k, entry] of catalogCache.entries()) {
            if (k.includes('adult18plus')) continue;
            for (const it of entry.data.items.slice(0, 10)) {
              if (!it.isAdult) extraRecent.push(it);
            }
          }
          items = mergeCatalogItems(items, extraRecent, false);
        }
        if (isHotDhamakaView) {
          items = sortItemsByHotAndHype(items);
        } else if (isNewUploadsView) {
          items = sortItemsByRecentUpload(items);
        } else if (isNewReleasesView) {
          items = sortItemsByRecentUpload(items);
          const releaseFiltered = items.filter(
            (i) => i.title.includes('2026') || i.title.includes('2025')
          );
          if (releaseFiltered.length >= 6) {
            items = releaseFiltered;
          }
        } else {
          // Trending & Hot view (/): keep Hot/Dhamaka and Recent Uploads prioritized
          items = sortItemsByHotAndHype(items);
        }
      } else {
        items = normalizeMovieCardList(items);
      }

      const maxPage = Math.max(primaryParsed.maxPage, mfParsed.maxPage);

      if (items.length > 0) {
        catalogCache.set(cacheKey, {
          data: { items, maxPage, activeNodeId },
          expiresAt: Date.now() + 30_000,
        });
        res.json({
          ok: true,
          cached: false,
          path: rawPath,
          page,
          maxPage,
          activeNodeId,
          items,
        });
        return;
      }
    } catch (err) {
      console.error('Catalog fetch error:', err);
    }

    const fallbackItems = sortItemsByRecentUpload(
      INITIAL_FALLBACK_MOVIES[rawPath] || INITIAL_FALLBACK_MOVIES['/'] || []
    );
    res.json({
      ok: true,
      fallback: true,
      path: rawPath,
      page,
      maxPage: 520,
      activeNodeId: 'node-alpha',
      items: fallbackItems,
    });
  });

  // 5. Live Movie / Anime / Series Decryptor & Detail Extractor (Supports both Primary & MyFlixBD `/mf/...` + Cross-Source Stream Merging!)
  app.get('/api/details', async (req, res) => {
    const rawPath = String(req.query.path || req.query.url || '').trim();
    const fallbackTitle = String(req.query.title || '').trim();
    const nodeId = String(req.query.node || '').trim();

    if (!rawPath && !fallbackTitle) {
      res.status(400).json({ ok: false, error: 'Missing path or title parameter' });
      return;
    }

    const attachFastRelatedSeasons = (detailObj: MovieDetailData): MovieDetailData => {
      if (detailObj.relatedSeasons && detailObj.relatedSeasons.length > 0) return detailObj;
      const baseSeriesName = extractBaseSeriesTitle(fallbackTitle || detailObj.title);
      if (baseSeriesName && baseSeriesName.length >= 3) {
        const baseLower = baseSeriesName.toLowerCase();
        const matchingSeasons: MovieCardItem[] = [];
        const seenPaths = new Set<string>();
        for (const entry of catalogCache.values()) {
          for (const item of entry.data.items) {
            if (seenPaths.has(item.path) || item.path === detailObj.url) continue;
            const itemBase = extractBaseSeriesTitle(item.title).toLowerCase();
            if (
              itemBase === baseLower ||
              item.title.toLowerCase().startsWith(baseLower) ||
              baseLower.startsWith(itemBase)
            ) {
              seenPaths.add(item.path);
              matchingSeasons.push(item);
            }
          }
        }
        if (matchingSeasons.length > 0) {
          return { ...detailObj, relatedSeasons: matchingSeasons.slice(0, 12) };
        }
      }
      return detailObj;
    };

    const isEnrich = req.query.enrich === '1';
    const hasTurboHlsSource = (d: MovieDetailData) =>
      Boolean(
        d.episodes?.some((ep) =>
          ep.sources?.some((s) => s.id.startsWith('mf-') || /abyssplayer\.com|\.m3u8/i.test(s.url))
        )
      );

    // 1. Instant 0ms check by path
    const cached = detailCache.get(rawPath);
    if (cached && cached.expiresAt > Date.now() && (!isEnrich || hasTurboHlsSource(cached.data))) {
      res.json({ ok: true, cached: true, detail: attachFastRelatedSeasons(cached.data) });
      return;
    }

    // 2. Instant 0ms check by matching title in detailCache
    if (fallbackTitle && !rawPath.startsWith('/mf/') && !isEnrich) {
      const cleanWant = extractBaseSeriesTitle(fallbackTitle).toLowerCase();
      for (const entry of detailCache.values()) {
        const d = entry.data;
        const dClean = extractBaseSeriesTitle(d.title).toLowerCase();
        if (
          d.episodes?.length &&
          (d.title === fallbackTitle || (cleanWant.length >= 4 && dClean === cleanWant))
        ) {
          res.json({ ok: true, cached: true, detail: attachFastRelatedSeasons(d) });
          return;
        }
      }
    }

    // 3. Dedicated MyFlixBD `/mf/...` Detail & Stream Extractor (Parallel race with Primary Mirror for sub-second response!)
    if (rawPath.startsWith('/mf/')) {
      try {
        const mfRealPath = rawPath.replace(/^\/mf\//, '/');
        const searchTitle = extractBaseSeriesTitle(fallbackTitle)
          .split(/\s+/)
          .slice(0, 4)
          .join(' ');

        const [mfHtmlRes, primarySearchRes] = await Promise.allSettled([
          fetchMyFlixHtml(`${mfRealPath}/`, 4200),
          searchTitle.length >= 3
            ? fetchFromMirrors(`/search?q=${encodeURIComponent(searchTitle)}`, nodeId)
            : Promise.reject(new Error('No search title')),
        ]);

        if (mfHtmlRes.status !== 'fulfilled') {
          throw new Error('MyFlix unreachable');
        }

        let detail = parseMyFlixDetail(mfHtmlRes.value, rawPath);

        if (primarySearchRes.status === 'fulfilled') {
          try {
            const { items } = parseMovieCards(primarySearchRes.value.html);
            if (items.length > 0) {
              const wantBase = extractBaseSeriesTitle(fallbackTitle || detail.title).toLowerCase();
              const matchedItem = items.find(
                (it) => extractBaseSeriesTitle(it.title).toLowerCase() === wantBase
              );
              if (matchedItem) {
                const cachedPrimary = detailCache.get(matchedItem.path);
                const primaryDetail = cachedPrimary
                  ? cachedPrimary.data
                  : await fetchFromMirrors(matchedItem.path, nodeId).then((r) =>
                      parseMovieDetail(r.html, rawPath, r.finalOrigin)
                    );
                if (primaryDetail.episodes.length > 0) {
                  if (detail.episodes.length === 1 && primaryDetail.episodes.length === 1) {
                    detail.episodes[0].sources = [
                      ...detail.episodes[0].sources,
                      ...primaryDetail.episodes[0].sources,
                    ];
                  } else if (detail.episodes.length > 0) {
                    detail.episodes = detail.episodes.map((ep, idx) => {
                      const matchedPrimaryEp =
                        primaryDetail.episodes.find(
                          (pEp) => pEp.number && ep.number && pEp.number === ep.number
                        ) || primaryDetail.episodes[idx];
                      return matchedPrimaryEp
                        ? { ...ep, sources: [...ep.sources, ...matchedPrimaryEp.sources] }
                        : ep;
                    });
                  } else {
                    detail.episodes = primaryDetail.episodes;
                  }
                  detail.downloadButtons = [
                    ...primaryDetail.downloadButtons,
                    ...detail.downloadButtons,
                  ];
                }
              }
            }
          } catch {
            // keep MyFlix streams
          }
        }

        detail = attachFastRelatedSeasons(detail);
        if (detail.episodes.length > 0 || detail.downloadButtons.length > 0) {
          detailCache.set(rawPath, {
            data: detail,
            expiresAt: Date.now() + 30 * 60_000,
          });
        }
        res.json({ ok: true, detail });
        return;
      } catch (err) {
        console.error('MyFlix detail fetch error:', err);
      }
    }

    try {
      const mfQuery = extractBaseSeriesTitle(fallbackTitle)
        .split(/\s+/)
        .slice(0, 4)
        .join(' ');
      const mfParallelPromise =
        mfQuery.length >= 3
          ? fetchMyFlixHtml(`/?s=${encodeURIComponent(mfQuery)}`, 2800).catch(() => '')
          : Promise.resolve('');

      let { html, finalOrigin } = await fetchFromMirrors(rawPath || '/', nodeId);

      const is404 =
        html.length < 1500 ||
        html.includes('<div class="n">404</div>') ||
        html.includes('Page not found') ||
        !html.includes('mlbdInlinePlayerData');

      if (is404 && fallbackTitle) {
        const cleanQuery = extractBaseSeriesTitle(fallbackTitle)
          .split(/\s+/)
          .slice(0, 4)
          .join(' ');

        if (cleanQuery) {
          const searchRes = await fetchFromMirrors(`/search?q=${encodeURIComponent(cleanQuery)}`, nodeId);
          const { items } = parseMovieCards(searchRes.html);
          if (items.length > 0) {
            const wantSeasonMatch = fallbackTitle.match(/\b(S\d+|Season\s*\d+)/i);
            const wantSeason = wantSeasonMatch ? wantSeasonMatch[1].toLowerCase() : '';
            const bestItem =
              items.find((it) => wantSeason && it.title.toLowerCase().includes(wantSeason)) ||
              items.find((it) => Boolean(it.episodePill)) ||
              items[0];
            const resolved = await fetchFromMirrors(bestItem.path, nodeId);
            html = resolved.html;
            finalOrigin = resolved.finalOrigin;
          }
        }
      }

      let detail = parseMovieDetail(html, rawPath, finalOrigin);

      // Merge MyFlixBD's ultra-smooth AbyssPlayer HLS streams when available (or as fallback)
      try {
        const effectiveQuery =
          mfQuery.length >= 3
            ? mfQuery
            : extractBaseSeriesTitle(detail.title)
                .split(/\s+/)
                .slice(0, 4)
                .join(' ');
        const mfSearchHtml =
          mfQuery.length >= 3
            ? await mfParallelPromise
            : effectiveQuery.length >= 3
              ? await fetchMyFlixHtml(`/?s=${encodeURIComponent(effectiveQuery)}`, 2800)
              : '';
        if (mfSearchHtml) {
          const mfCards = parseMyFlixCards(mfSearchHtml).items;
          if (mfCards.length > 0) {
            const wantBase = extractBaseSeriesTitle(fallbackTitle || detail.title).toLowerCase();
            const matchedCard =
              mfCards.find((c) => extractBaseSeriesTitle(c.title).toLowerCase() === wantBase) ||
              (detail.episodes.length === 0 ? mfCards[0] : undefined);
            if (matchedCard) {
              const mfRealPath = matchedCard.path.replace(/^\/mf\//, '/');
              const mfDetailHtml = await fetchMyFlixHtml(`${mfRealPath}/`, 3200);
              const mfDetail = parseMyFlixDetail(mfDetailHtml, rawPath);
              if (mfDetail.episodes.length > 0) {
                if (detail.episodes.length === 0) {
                  detail = {
                    ...detail,
                    episodes: mfDetail.episodes,
                    downloadButtons:
                      detail.downloadButtons.length > 0
                        ? detail.downloadButtons
                        : mfDetail.downloadButtons,
                  };
                } else if (detail.episodes.length === 1 && mfDetail.episodes.length === 1) {
                  detail.episodes[0].sources = [
                    ...detail.episodes[0].sources,
                    ...mfDetail.episodes[0].sources,
                  ];
                } else {
                  detail.episodes = detail.episodes.map((ep, idx) => {
                    const matchedMfEp =
                      mfDetail.episodes.find(
                        (mEp) => mEp.number && ep.number && mEp.number === ep.number
                      ) || mfDetail.episodes[idx];
                    return matchedMfEp
                      ? { ...ep, sources: [...ep.sources, ...matchedMfEp.sources] }
                      : ep;
                  });
                }
              }
            }
          }
        }
      } catch {
        // ignore MyFlix merge error
      }

      detail = attachFastRelatedSeasons(detail);

      if (detail.episodes.length > 0 || detail.downloadButtons.length > 0 || detail.storyline) {
        detailCache.set(rawPath, {
          data: detail,
          expiresAt: Date.now() + 30 * 60_000,
        });
      }

      res.json({ ok: true, detail });
    } catch (err) {
      console.error('Detail fetch error:', err);
      res.status(500).json({
        ok: false,
        error: 'ক্লাউড সার্ভার থেকে মুভির বিস্তারিত তথ্য লোড করা যায়নি। অনুগ্রহ করে অন্য Server Node সিলেক্ট করে চেষ্টা করুন।',
      });
    }
  });

  // 6. Opaque Anonymized Download & Stream Redirect Gateway (Automatically bypasses fifadekho landing gate!)
  app.get('/api/go', async (req, res) => {
    const token = String(req.query.t || '').trim();
    let target = decodeGatewayToken(token);
    if (!target || !target.startsWith('http')) {
      res.status(400).send('Invalid gateway link');
      return;
    }

    // If the link is a fifadekho.com gateway URL, automatically resolve `?view=links` to extract direct cloud download URL!
    if (/fifadekho\.com\/[a-z0-9]+/i.test(target) && !target.includes('view=links')) {
      try {
        const linksUrl = `${target.replace(/\/+$/, '')}?view=links`;
        const gwRes = await fetch(linksUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (gwRes.ok) {
          const gwHtml = await gwRes.text();
          const directCloudMatch = gwHtml.match(
            /<a\s+href=["'](https?:\/\/(?:hubcloud|new\d*\.xcloud|gdflix)[^"']+)["'][^>]*class=["'][^"']*nl-link-btn/i
          );
          if (directCloudMatch && directCloudMatch[1]) {
            target = directCloudMatch[1].trim();
          } else {
            target = linksUrl;
          }
        }
      } catch {
        target = `${target.replace(/\/+$/, '')}?view=links`;
      }
    }

    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, target);
  });

  // 6b. Ultra-Fast Sequential MKV-to-HLS Live Streamer for iPhone / iPad (iOS Safari)
  interface IosHlsSession {
    hash: string;
    dir: string;
    targetUrl: string;
    proc: ChildProcess | null;
    abortController: AbortController;
    lastAccess: number;
    finished: boolean;
  }

  const iosHlsSessions = new Map<string, IosHlsSession>();

  const cleanupIosHlsSession = (hash: string) => {
    const sess = iosHlsSessions.get(hash);
    if (!sess) return;
    iosHlsSessions.delete(hash);
    try {
      sess.abortController.abort();
    } catch {
      // ignore
    }
    try {
      if (sess.proc && !sess.proc.killed) {
        sess.proc.kill('SIGKILL');
      }
    } catch {
      // ignore
    }
    try {
      fs.rmSync(sess.dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  setInterval(() => {
    const now = Date.now();
    for (const [hash, sess] of iosHlsSessions.entries()) {
      if (now - sess.lastAccess > 120_000) {
        cleanupIosHlsSession(hash);
      }
    }
  }, 30_000).unref();

  const ensureIosHlsSession = async (targetUrl: string): Promise<IosHlsSession> => {
    const hash = crypto.createHash('sha1').update(targetUrl).digest('hex').slice(0, 16);
    const existing = iosHlsSessions.get(hash);
    if (existing && fs.existsSync(path.join(existing.dir, 'index.m3u8'))) {
      existing.lastAccess = Date.now();
      return existing;
    }

    if (existing) {
      cleanupIosHlsSession(hash);
    }

    // Keep at most 2 concurrent HLS remux sessions so /tmp stays lightweight
    if (iosHlsSessions.size >= 2) {
      const oldest = Array.from(iosHlsSessions.values()).sort(
        (a, b) => a.lastAccess - b.lastAccess
      )[0];
      if (oldest) cleanupIosHlsSession(oldest.hash);
    }

    const dir = path.join('/tmp', `cp-hls-${hash}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const abortController = new AbortController();
    const session: IosHlsSession = {
      hash,
      dir,
      targetUrl,
      proc: null,
      abortController,
      lastAccess: Date.now(),
      finished: false,
    };
    iosHlsSessions.set(hash, session);

    const upstreamRes = await fetch(targetUrl, {
      signal: abortController.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      },
    });

    if (!upstreamRes.ok || !upstreamRes.body) {
      cleanupIosHlsSession(hash);
      throw new Error(`Upstream stream HTTP ${upstreamRes.status}`);
    }

    const ff = spawn('/usr/bin/ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      '+nobuffer+genpts',
      '-probesize',
      '131072',
      '-analyzeduration',
      '100000',
      '-f',
      'matroska',
      '-i',
      'pipe:0',
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-ac',
      '2',
      '-b:a',
      '128k',
      '-af',
      "volume=enable='between(t,0,11)':volume=0",
      '-bsf:v',
      'h264_mp4toannexb',
      '-f',
      'hls',
      '-hls_playlist_type',
      'event',
      '-hls_time',
      '2',
      '-hls_list_size',
      '0',
      '-hls_flags',
      'independent_segments+temp_file',
      '-hls_segment_filename',
      path.join(dir, 'seg_%04d.ts'),
      path.join(dir, 'index.m3u8'),
    ]);

    session.proc = ff;
    ff.on('exit', () => {
      session.finished = true;
    });
    ff.stdin.on('error', () => {});

    const reader = upstreamRes.body.getReader();
    (async () => {
      let bytesTransferred = 0;
      const BURST_BYTES = 24 * 1024 * 1024; // 24MB instant high-speed burst (~3 mins of video)
      try {
        while (true) {
          if (Date.now() - session.lastAccess > 120_000) {
            cleanupIosHlsSession(hash);
            break;
          }
          const { done, value } = await reader.read();
          if (done) {
            ff.stdin.end();
            break;
          }
          bytesTransferred += value.byteLength;
          if (!ff.stdin.write(Buffer.from(value))) {
            await new Promise<void>((resolve) => ff.stdin.once('drain', () => resolve()));
          }
          // After initial 24MB burst, lightly pace download so /tmp is never flooded
          if (bytesTransferred > BURST_BYTES) {
            await new Promise((r) => setTimeout(r, 25));
          }
        }
      } catch {
        try {
          ff.stdin.end();
        } catch {
          // ignore
        }
      }
    })();

    // Wait up to 4.5s for index.m3u8 + first segments (seg_0001.ts or seg_0000.ts) to appear
    const startWait = Date.now();
    while (Date.now() - startWait < 4500) {
      const m3u8Path = path.join(dir, 'index.m3u8');
      const seg1Path = path.join(dir, 'seg_0001.ts');
      const seg0Path = path.join(dir, 'seg_0000.ts');
      if (
        fs.existsSync(m3u8Path) &&
        (fs.existsSync(seg1Path) || (fs.existsSync(seg0Path) && Date.now() - startWait > 1400))
      ) {
        return session;
      }
      await new Promise((r) => setTimeout(r, 45));
    }

    return session;
  };

  app.options('/api/ios-hls/:token/:file', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.status(204).end();
  });

  app.get('/api/ios-hls/:token/:file', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

    const token = String(req.params.token || '').trim();
    const file = String(req.params.file || '').trim();
    const targetUrl = decodeGatewayToken(token);

    if (!targetUrl || !targetUrl.startsWith('http')) {
      res.status(400).send('Invalid stream token');
      return;
    }

    try {
      if (file === 'index.m3u8') {
        const session = await ensureIosHlsSession(targetUrl);
        session.lastAccess = Date.now();
        const m3u8Path = path.join(session.dir, 'index.m3u8');
        if (!fs.existsSync(m3u8Path)) {
          res.status(503).send('HLS playlist initializing');
          return;
        }
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(fs.readFileSync(m3u8Path, 'utf8'));
        return;
      }

      if (/^seg_\d+\.ts$/.test(file)) {
        const hash = crypto.createHash('sha1').update(targetUrl).digest('hex').slice(0, 16);
        let session = iosHlsSessions.get(hash);
        if (!session) {
          session = await ensureIosHlsSession(targetUrl);
        }
        session.lastAccess = Date.now();
        const segPath = path.join(session.dir, file);

        // Wait briefly if segment is currently being finalized by ffmpeg
        const waitStart = Date.now();
        while (!fs.existsSync(segPath) && Date.now() - waitStart < 3500) {
          await new Promise((r) => setTimeout(r, 50));
        }

        if (!fs.existsSync(segPath)) {
          res.status(404).send('Segment not ready');
          return;
        }

        res.setHeader('Content-Type', 'video/mp2t');
        res.setHeader('Cache-Control', 'public, max-age=600');
        fs.createReadStream(segPath).pipe(res);
        return;
      }

      res.status(404).send('Not found');
    } catch (err) {
      console.error('iOS HLS stream error:', err);
      res.status(502).send('Stream transcode failed');
    }
  });

  // 6c. Embedded MKV Subtitle & Exact Audio-Visual Sync Extractor (/api/subtitles/extract)
  const mkvSubExtractCache = new Map<string, { srt: string; expiresAt: number }>();

  app.get('/api/subtitles/extract', async (req, res) => {
    const streamUrl = String(req.query.url || '').trim();
    const startSec = Math.max(0, Number(req.query.startSec || 0) || 0);
    const windowMode = String(req.query.mode || 'probe').trim(); // 'probe' (fast 6MB header+opening) or 'window' (15-min seek window)

    if (!streamUrl || !streamUrl.startsWith('http') || !fs.existsSync('/usr/bin/ffmpeg')) {
      res.json({ ok: false, srt: '' });
      return;
    }

    const cacheKey = `${streamUrl}::${windowMode}::${Math.floor(startSec / 300)}`;
    const cached = mkvSubExtractCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.json({ ok: true, srt: cached.srt, cached: true });
      return;
    }

    try {
      let extractedSrt = '';

      if (windowMode === 'window' && startSec > 0) {
        // Seek directly over HTTP to startSec and demux 12 minutes of embedded subtitle packets (-vn -an = zero video/audio decode overhead)
        extractedSrt = await new Promise<string>((resolve) => {
          const chunks: Buffer[] = [];
          const ff = spawn('/usr/bin/ffmpeg', [
            '-hide_banner',
            '-loglevel',
            'error',
            '-ss',
            String(startSec),
            '-t',
            '720',
            '-i',
            streamUrl,
            '-vn',
            '-an',
            '-map',
            '0:s:0?',
            '-c:s',
            'srt',
            '-f',
            'srt',
            'pipe:1',
          ]);
          const killTimer = setTimeout(() => {
            try {
              ff.kill('SIGKILL');
            } catch {}
            resolve(Buffer.concat(chunks).toString('utf8'));
          }, 5200);

          ff.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
          ff.on('close', () => {
            clearTimeout(killTimer);
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
          ff.on('error', () => {
            clearTimeout(killTimer);
            resolve('');
          });
        });
      } else {
        // Fast 5.5MB Range probe from byte 0: downloads in ~350ms and gives exact opening embedded subtitle cues for auto-sync!
        const controller = new AbortController();
        const fetchTimer = setTimeout(() => controller.abort(), 4200);
        const upstream = await fetch(streamUrl, {
          signal: controller.signal,
          headers: {
            Range: 'bytes=0-5767167',
            'User-Agent': 'Mozilla/5.0',
          },
        }).finally(() => clearTimeout(fetchTimer));

        if (upstream.ok && upstream.body) {
          const arrayBuf = await upstream.arrayBuffer();
          const inputBuf = Buffer.from(arrayBuf);
          extractedSrt = await new Promise<string>((resolve) => {
            const outChunks: Buffer[] = [];
            const ff = spawn('/usr/bin/ffmpeg', [
              '-hide_banner',
              '-loglevel',
              'error',
              '-i',
              'pipe:0',
              '-vn',
              '-an',
              '-map',
              '0:s:0?',
              '-c:s',
              'srt',
              '-f',
              'srt',
              'pipe:1',
            ]);
            const killTimer = setTimeout(() => {
              try {
                ff.kill('SIGKILL');
              } catch {}
              resolve(Buffer.concat(outChunks).toString('utf8'));
            }, 2500);

            ff.stdout.on('data', (chunk: Buffer) => outChunks.push(chunk));
            ff.stdin.on('error', () => {});
            ff.on('close', () => {
              clearTimeout(killTimer);
              resolve(Buffer.concat(outChunks).toString('utf8'));
            });
            ff.on('error', () => {
              clearTimeout(killTimer);
              resolve('');
            });

            ff.stdin.end(inputBuf);
          });
        }
      }

      if (extractedSrt && extractedSrt.includes('-->')) {
        mkvSubExtractCache.set(cacheKey, {
          srt: extractedSrt,
          expiresAt: Date.now() + 30 * 60_000,
        });
        res.json({ ok: true, srt: extractedSrt });
        return;
      }
    } catch {
      // ignore probe failure
    }

    res.json({ ok: false, srt: '' });
  });

  // 7. User Movie Requests & Broken Link Reports API
  app.get('/api/requests', (_req, res) => {
    res.json({ ok: true, requests: movieRequestsStore });
  });

  app.post('/api/requests', (req, res) => {
    const title = sanitizeBrandText(String(req.body?.title || '').trim());
    const type = String(req.body?.type || 'MOVIE').toUpperCase() as UserMovieRequest['type'];
    const language = sanitizeBrandText(String(req.body?.language || 'Bangla / Dual Audio').trim());
    const notes = sanitizeBrandText(String(req.body?.notes || '').trim());

    if (!title) {
      res.status(400).json({ ok: false, error: 'অনুগ্রহ করে মুভি বা সিরিজের নাম লিখুন' });
      return;
    }

    const item: UserMovieRequest = {
      id: `req-${Date.now()}`,
      title,
      type: ['MOVIE', 'SERIES', 'ANIME', 'BROKEN_LINK'].includes(type) ? type : 'MOVIE',
      language,
      notes,
      status: 'Queued',
      createdAt: Date.now(),
    };
    movieRequestsStore.unshift(item);
    if (movieRequestsStore.length > 30) movieRequestsStore.pop();

    res.json({ ok: true, request: item, requests: movieRequestsStore });
  });

  // 8. Ultra-Stealth White-Label Proxy Mode (Hides all upstream logos, links, sidebars & intro sounds)
  app.get('/api/proxy-page', async (req, res) => {
    const rawPath = String(req.query.path || '/').trim();
    const nodeId = String(req.query.node || '').trim();

    try {
      const { html, finalOrigin } = await fetchFromMirrors(rawPath, nodeId);
      let processed = html;

      // Remove iOS redirect & ad scripts
      processed = processed
        .replace(/<script>\(function\(\)\{try\{var ua=navigator\.userAgent[\s\S]*?<\/script>/i, '')
        .replace(/<script[^>]*id=["']mlbd-display-ads[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<script[^>]*id=["']mlbd-click-ads[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/\/mlbd-adopen\.php/g, '/api/noop')
        .replace(/MovieLinkBD/gi, 'CinePulse HD')
        .replace(/movielinkbd\.[a-z]+/gi, 'CinePulse');

      const stealthBridge = `
        <base href="${finalOrigin}/" />
        <style>
          #mlbd-adfree, .mlbd-ad-slot, [data-mlbd-ad], #mlbd-install,
          header .logo, .site-logo, .telegram-join, .tg-banner, .social-links,
          a[href*="t.me"], a[href*="telegram"], .footer, footer {
            display: none !important;
          }
        </style>
        <script>
          // Mute any automatic intro sound or page audio synth
          try {
            window.Audio = function() {
              return { play: function(){ return Promise.resolve(); }, pause: function(){}, addEventListener: function(){} };
            };
            if (window.speechSynthesis) {
              window.speechSynthesis.speak = function() {};
            }
          } catch (_) {}

          document.addEventListener('click', function(e) {
            var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
            if (!a) return;
            var href = a.getAttribute('href') || '';
            if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
            try {
              var u = new URL(href, '${finalOrigin}');
              if (u.hostname.includes('movielinkbd')) {
                e.preventDefault();
                e.stopPropagation();
                window.location.href = '/api/proxy-page?path=' + encodeURIComponent(u.pathname + u.search);
              }
            } catch (_) {}
          }, true);
        </script>
      `;

      processed = processed.replace(/<head[^>]*>/i, (match) => `${match}${stealthBridge}`);

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(processed);
    } catch {
      res.status(502).send(`
        <!doctype html>
        <html>
          <body style="background:#090b10;color:#f1f5f9;font-family:sans-serif;padding:2rem;text-align:center;">
            <h3>সার্ভারের সাথে সংযোগ করা যাচ্ছে না</h3>
            <p>অনুগ্রহ করে অ্যাপের মেইন ভিউ ব্যবহার করুন অথবা অন্য Server Node নির্বাচন করুন।</p>
          </body>
        </html>
      `);
    }
  });

  app.all('/api/noop', (_req, res) => {
    res.status(204).end();
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CinePulse HD Cinema Server running on http://localhost:${PORT}`);
  });
}

startServer();
