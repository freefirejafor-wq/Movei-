import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIRROR_ORIGINS = [
  'https://cmyyhb.movielinkbd.at',
  'https://4yer8f.movielinkbd.at',
  'https://movielinkbd.tv',
  'https://movielinkbd.one',
];

const ALL_CATEGORY_PATHS = [
  '/',
  '/anime',
  '/ongoing',
  '/drama',
  '/southIndian',
  '/genre/animation',
  '/adult18plus',
  '/language/bangla',
  '/language/bangla-dubbed',
  '/bollywood',
  '/language/hindi',
  '/language/hindi-dubbed',
  '/language/dual-audio',
  '/language/english',
  '/language/korean',
  '/language/tamil',
  '/language/telugu',
  '/language/malayalam',
  '/language/kannada',
  '/language/japanese',
  '/language/chinese',
  '/language/turkish',
  '/language/indonesian',
  '/language/spanish',
  '/language/thai',
  '/genre/action',
  '/genre/thriller',
  '/genre/horror',
  '/genre/romance',
  '/genre/comedy',
  '/genre/crime',
  '/genre/sci-fi',
  '/genre/adventure',
  '/genre/fantasy',
  '/genre/mystery',
  '/genre/drama',
  '/genre/family',
  '/genre/history',
  '/genre/war',
  '/genre/documentary',
  '/genre/biography',
  '/genre/sport',
  '/category/wwe',
  '/mostwatch/7d',
  '/type/movies',
  '/type/series',
  '/collection/mcu-marvel-cinematic-universe',
  '/collection/dc-universe-dceu-dcu',
  '/collection/best-bangla-dubbed-movies',
  '/collection/top-rated-hindi-dubbed-action',
  '/collection/bangla-web-series',
  '/collection/korean-drama-must-watch',
  '/collection/south-indian-blockbusters',
  '/collection/horror-night',
  '/collection/family-animation',
  '/collection/thriller-mystery',
];

function sanitizeBrandText(input) {
  if (!input) return '';
  return String(input)
    .replace(/https?:\/\/[^\s"'<>]*movielinkbd[^\s"'<>]*/gi, '')
    .replace(/\b[a-z0-9-]*\.?movielinkbd\.[a-z]{2,6}\b/gi, 'CinePulse')
    .replace(/movielinkbd/gi, 'CinePulse')
    .replace(/\bmlbd\b/gi, 'CP')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function decodeMlbdCipher(base64Str, hexSeed, rounds) {
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

function decodeHtmlEntities(str) {
  const cleaned = (str || '')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&bull;/g, '•')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .trim();
  return sanitizeBrandText(cleaned);
}

async function fetchFromMirrors(targetPath) {
  const cleanPath = targetPath.startsWith('http')
    ? new URL(targetPath).pathname + new URL(targetPath).search
    : targetPath.startsWith('/')
      ? targetPath
      : `/${targetPath}`;

  for (const origin of MIRROR_ORIGINS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      const url = `${origin}${cleanPath}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Cookie: 'mlbd_show18=1; hide18On=false',
          Referer: `${origin}/`,
        },
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const html = await res.text();
      if (
        html &&
        html.length > 1200 &&
        (html.includes('movie-card') || html.includes('mlbdInlinePlayerData'))
      ) {
        const finalOrigin = new URL(res.url || url).origin;
        return { html, finalOrigin };
      }
    } catch {
      // try next mirror
    }
  }
  throw new Error(`Unreachable: ${targetPath}`);
}

function parseMovieCards(html) {
  const bodyIdx = html.indexOf('<body');
  const body = bodyIdx >= 0 ? html.slice(bodyIdx) : html;
  const blocks = body.split(/<div class="movie-card"/i).slice(1);
  const items = [];
  const seenPaths = new Set();

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
      (chunk.match(/<span class=["']views-badge-top["'][^>]*>[\s\S]*?<\/i>\s*([^<]+)<\/span>/i) || [])[1] || '2.4K'
    );
    const rawTimeAgo = decodeHtmlEntities(
      (chunk.match(/<div class=["']upload-time["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || 'Recently added'
    );
    let episodePill = decodeHtmlEntities(
      (chunk.match(/<span class=["']badge ep-badge[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || ''
    );
    if (!episodePill && rawTimeAgo) {
      const epMatch = rawTimeAgo.match(
        /\b(S\d+\s*[|·•-]\s*Ep(?:isode)?\s*\d+[^\n]*|S\d+\s+Ep(?:isode)?\s*\d+[^\n]*|Ep(?:isode)?\s*\d+(?:\s*[-–]\s*\d+)?(?:\s*(?:Added|Completed|Full))?|Part\s*\d+[^\n]*)/i
      );
      if (epMatch) episodePill = epMatch[1].trim();
    }
    const relMatch = rawTimeAgo.match(
      /(\d+)\s*(sec(?:ond)?s?|min(?:ute)?s?|mins?|hr?s?|hours?|days?|weeks?|months?|years?)\s*ago/i
    );
    let timeAgo = '18 mins ago';
    if (relMatch) {
      const n = Math.max(1, parseInt(relMatch[1], 10) || 1);
      const u = relMatch[2].toLowerCase();
      if (u.startsWith('sec')) timeAgo = '1 min ago';
      else if (u.startsWith('min')) timeAgo = n === 1 ? '1 min ago' : `${n} mins ago`;
      else if (u.startsWith('h')) timeAgo = n === 1 ? '1 hour ago' : `${n} hours ago`;
      else if (u.startsWith('d')) timeAgo = n === 1 ? '1 day ago' : `${n} days ago`;
      else if (u.startsWith('w')) timeAgo = n === 1 ? '1 week ago' : `${n} weeks ago`;
      else if (u.startsWith('mo')) timeAgo = n === 1 ? '1 month ago' : `${n} months ago`;
      else timeAgo = n === 1 ? '1 year ago' : `${n} years ago`;
    }

    const isPinned = chunk.includes('pin-badge') || chunk.includes('data-pin="1"');
    const isAdult =
      chunk.includes('data-18="1"') ||
      itemPath.includes('18plus') ||
      episodePill.toUpperCase().includes('18+');

    let typeBadge = 'MOVIE';
    if (itemPath.includes('/anime/')) typeBadge = 'ANIME';
    else if (itemPath.includes('/drama/')) typeBadge = 'DRAMA';
    else if (itemPath.includes('/series/') || Boolean(episodePill)) typeBadge = 'SERIES';

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
      timeAgo,
      episodePill,
      isPinned,
      isAdult,
    });
  }

  return items;
}

function parseMovieDetail(html, itemPath, origin) {
  let inlineData = null;
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

  const downloadButtons = [];
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

  const extractInfoLine = (keyword) => {
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

  const scoreSourceForSmoothPlay = (src) => {
    const isHevc = /\b(hevc|h\.?265|x265|10bit)\b/i.test(`${src.name} ${src.qualityLabel}`);
    let score = isHevc ? 0 : 1000;
    if (src.quality === 720) score += 500;
    else if (src.quality === 480) score += 460;
    else if (src.quality === 1080) score += 300;
    else score += 150;
    return score;
  };

  const episodes = Array.isArray(inlineData?.episodes)
    ? inlineData.episodes
        .map((ep, idx) => {
          const rawSources = Array.isArray(ep.sources)
            ? ep.sources
                .filter((s) => s && (s.url || s.download_url))
                .map((s, sIdx) => {
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
                  return {
                    id: String(s.id || `src-${idx}-${s.quality || 720}-${sIdx}`),
                    quality: Number(s.quality) || 720,
                    qualityLabel: s.quality_label || `${s.quality || 720}p`,
                    audio: sanitizeBrandText(String(s.audio || 'Multi Audio')),
                    audioLanguages: Array.isArray(s.audio_languages)
                      ? s.audio_languages.map((a) => sanitizeBrandText(String(a)))
                      : [sanitizeBrandText(String(s.audio || 'Original'))],
                    provider: `Cloud Stream #${sIdx + 1}`,
                    url: rawStreamUrl,
                    downloadUrl: fullDlUrl,
                    type: String(s.type || 'mkv').toLowerCase(),
                    name: sanitizeBrandText(String(s.name || `${title} - ${s.quality || 720}p`)),
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
        })
        .filter((ep) => ep.sources.length > 0)
    : [];

  const screenshots = Array.isArray(inlineData?.screenshots)
    ? inlineData.screenshots.map((s) => s?.url).filter(Boolean).slice(0, 4)
    : [];

  return {
    title,
    url: itemPath,
    poster,
    qualityNote: '1080p / 720p High-Speed Cloud Stream',
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
    downloadButtons: downloadButtons.slice(0, 8),
    cast: [],
    communityScore: {
      recommendedPercent: 91,
      totalVotes: 340,
      verdict: 'Massive Hit',
    },
  };
}

async function main() {
  console.log('Generating complete multi-category live cinema database...');
  const catalogs = {};
  const details = {};

  // Fetch all 42+ categories in fast parallel batches of 10
  const catBatchSize = 10;
  for (let i = 0; i < ALL_CATEGORY_PATHS.length; i += catBatchSize) {
    const batch = ALL_CATEGORY_PATHS.slice(i, i + catBatchSize);
    await Promise.all(
      batch.map(async (catPath) => {
        try {
          const { html } = await fetchFromMirrors(catPath);
          const items = parseMovieCards(html);
          if (items.length > 0) {
            catalogs[catPath] = items;
          }
        } catch {
          // ignore single category failure
        }
      })
    );
  }

  // Also fetch Page 2 and Page 3 of Home ('/') so over 350+ latest items are available instantaneously
  await Promise.all(
    [2, 3].map(async (pageNum) => {
      try {
        const { html } = await fetchFromMirrors(`/page/${pageNum}`);
        const items = parseMovieCards(html);
        if (items.length > 0) {
          catalogs[`/page/${pageNum}`] = items;
        }
      } catch {
        // ignore
      }
    })
  );

  // Build sorted /new-uploads, /new-releases, and prioritize recent uploads in /
  const toMinutes = (tStr) => {
    const m = String(tStr || '').match(/(\d+)\s*(min|hour|day|week|month|year)/i);
    if (!m) return 999999;
    const n = parseInt(m[1], 10) || 1;
    const u = m[2].toLowerCase();
    if (u.startsWith('min')) return n;
    if (u.startsWith('hour')) return n * 60;
    if (u.startsWith('day')) return n * 1440;
    if (u.startsWith('week')) return n * 10080;
    if (u.startsWith('month')) return n * 43200;
    return n * 525600;
  };
  const allRecentMap = new Map();
  const seenTitles = new Set();
  for (const [catKey, list] of Object.entries(catalogs)) {
    if (catKey === '/adult18plus' || !Array.isArray(list)) continue;
    for (const item of list) {
      const tNorm = String(item?.title || '').toLowerCase().trim();
      if (item?.path && !item.isAdult && !allRecentMap.has(item.path) && !seenTitles.has(tNorm)) {
        allRecentMap.set(item.path, item);
        seenTitles.add(tNorm);
      }
    }
  }
  const sortedByUpload = Array.from(allRecentMap.values()).sort(
    (a, b) => toMinutes(a.timeAgo) - toMinutes(b.timeAgo)
  );
  if (sortedByUpload.length > 0) {
    catalogs['/new-uploads'] = sortedByUpload.slice(0, 42);
    catalogs['/new-releases'] = sortedByUpload
      .filter((i) => i.title.includes('2026') || i.title.includes('2025'))
      .slice(0, 42);
    if (Array.isArray(catalogs['/'])) {
      const homeSeen = new Set();
      const mergedHome = [];
      for (const item of [...sortedByUpload.slice(0, 18), ...catalogs['/']]) {
        const tk = String(item?.title || '').toLowerCase().trim();
        if (item?.path && !homeSeen.has(item.path) && !homeSeen.has(tk)) {
          homeSeen.add(item.path);
          homeSeen.add(tk);
          mergedHome.push(item);
        }
      }
      catalogs['/'] = mergedHome
        .sort((a, b) => toMinutes(a.timeAgo) - toMinutes(b.timeAgo))
        .slice(0, 36);
    }
  }

  // Collect unique top movies across all major zones + Top 10 This Week to pre-decrypt their stream URLs
  const top10ExplicitPaths = [
    '/series/mKs_2z7wauoxpphvgticrov7me2cnq',
    '/movie/mKs_ggzk4l33ktk7qiazi4ueeqi5ma',
    '/series/mKs_xcyjyuznclfoi4rdoo5hc3nxci',
    '/movie/mKs_w2wmvigomvj4wauldgbgjm767q',
    '/series/mKs_3bb2hmqqj25r7lsh5guzwzlouy',
    '/series/mKs_5egv5ywg7yuru7uokk2xarqu3y',
  ];
  const uniquePaths = [...top10ExplicitPaths];
  const seen = new Set(top10ExplicitPaths);
  const priorityPools = [
    catalogs['/']?.slice(0, 40) || [],
    catalogs['/mostwatch/7d']?.slice(0, 12) || [],
    catalogs['/anime']?.slice(0, 14) || [],
    catalogs['/ongoing']?.slice(0, 12) || [],
    catalogs['/drama']?.slice(0, 12) || [],
    catalogs['/language/bangla']?.slice(0, 14) || [],
    catalogs['/language/bangla-dubbed']?.slice(0, 10) || [],
    catalogs['/southIndian']?.slice(0, 12) || [],
    catalogs['/bollywood']?.slice(0, 12) || [],
    catalogs['/adult18plus']?.slice(0, 10) || [],
  ];

  for (const pool of priorityPools) {
    for (const item of pool) {
      if (item?.path && !seen.has(item.path)) {
        seen.add(item.path);
        uniquePaths.push(item.path);
      }
    }
  }

  const seenDetailTitles = new Set();
  const batchSize = 15;
  for (let i = 0; i < uniquePaths.length; i += batchSize) {
    const batch = uniquePaths.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (itemPath) => {
        try {
          const { html, finalOrigin } = await fetchFromMirrors(itemPath);
          const detail = parseMovieDetail(html, itemPath, finalOrigin);
          if (detail.episodes.length > 0 || detail.downloadButtons.length > 0) {
            const titleKey = (detail.title || '').toLowerCase().trim();
            // Avoid storing 5-7 duplicate 135KB objects for the same multi-episode daily series
            if (detail.episodes.length > 15 && seenDetailTitles.has(titleKey)) {
              return;
            }
            if (titleKey) seenDetailTitles.add(titleKey);
            details[itemPath] = detail;
          }
        } catch {
          // ignore
        }
      })
    );
  }

  const outPath = path.join(__dirname, '..', 'public', 'static-db.json');
  await fs.writeFile(
    outPath,
    JSON.stringify({
      generatedAt: Date.now(),
      catalogs,
      details,
    })
  );
  console.log(
    `Saved static-db.json with ${Object.keys(catalogs).length} full categories and ${Object.keys(details).length} pre-decrypted movie/series streams.`
  );
}

main().catch((err) => {
  console.warn('Static DB generation warning:', err.message);
  process.exit(0);
});
