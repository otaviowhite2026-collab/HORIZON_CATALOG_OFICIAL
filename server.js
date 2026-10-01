'use strict';

const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 7000);
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const LANGUAGE = process.env.LANGUAGE || 'pt-BR';
const REGION = process.env.REGION || 'BR';
const INCLUDE_SPECIALS = String(process.env.INCLUDE_SPECIALS || 'true').toLowerCase() !== 'false';
const PREFER_IMDB_IDS = String(process.env.PREFER_IMDB_IDS || 'true').toLowerCase() !== 'false';
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 21600);

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';
const cache = new Map();

const MOVIE_GENRES = {
  'Ação': 28, 'Aventura': 12, 'Animação': 16, 'Comédia': 35, 'Crime': 80,
  'Documentário': 99, 'Drama': 18, 'Família': 10751, 'Fantasia': 14,
  'História': 36, 'Terror': 27, 'Música': 10402, 'Mistério': 9648,
  'Romance': 10749, 'Ficção científica': 878, 'Cinema TV': 10770,
  'Thriller': 53, 'Guerra': 10752, 'Faroeste': 37
};

const TV_GENRES = {
  'Ação e Aventura': 10759, 'Animação': 16, 'Comédia': 35, 'Crime': 80,
  'Documentário': 99, 'Drama': 18, 'Família': 10751, 'Infantil': 10762,
  'Mistério': 9648, 'Notícias': 10763, 'Reality': 10764,
  'Sci-Fi e Fantasia': 10765, 'Novela': 10766, 'Talk Show': 10767,
  'Guerra e Política': 10768, 'Faroeste': 37
};

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'cache-control': status === 200 ? 'public, max-age=300' : 'no-store',
    ...headers
  });
  res.end(payload);
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=3600'
  });
  res.end(body);
}

function cacheGet(key) {
  const row = cache.get(key);
  if (!row) return null;
  if (row.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  return row.value;
}

function cacheSet(key, value, ttlSeconds = CACHE_TTL_SECONDS) {
  cache.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
  return value;
}

async function tmdb(path, params = {}) {
  if (!TMDB_API_KEY) throw new Error('TMDB_API_KEY is not configured');

  const url = new URL(TMDB_BASE + path);
  url.searchParams.set('api_key', TMDB_API_KEY);
  if (!('language' in params)) url.searchParams.set('language', LANGUAGE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const key = url.toString();
  const cached = cacheGet(key);
  if (cached) return cached;

  const response = await fetch(url, {
    headers: { 'accept': 'application/json' }
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`TMDB ${response.status}: ${detail.slice(0, 300)}`);
  }
  const data = await response.json();
  return cacheSet(key, data);
}

function poster(path, size = 'w500') {
  return path ? `${IMG}/${size}${path}` : undefined;
}

function backdrop(path, size = 'w1280') {
  return path ? `${IMG}/${size}${path}` : undefined;
}

function year(date) {
  return date && /^\d{4}/.test(date) ? date.slice(0, 4) : undefined;
}

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

function parseExtra(extraSegment) {
  const result = {};
  if (!extraSegment) return result;
  const raw = extraSegment.replace(/\.json$/, '');
  const params = new URLSearchParams(raw);
  for (const [k, v] of params.entries()) result[k] = v;
  return result;
}

function pageFromSkip(skip) {
  const n = Math.max(0, Number(skip || 0));
  return Math.floor(n / 20) + 1;
}

async function externalId(type, tmdbId) {
  const key = `external:${type}:${tmdbId}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached;
  const path = type === 'movie' ? `/movie/${tmdbId}/external_ids` : `/tv/${tmdbId}/external_ids`;
  const data = await tmdb(path, { language: undefined });
  return cacheSet(key, data.imdb_id || '', 86400);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); }
      catch { out[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function canonicalId(type, item) {
  if (!PREFER_IMDB_IDS) return `tmdb:${type === 'series' ? 'tv' : 'movie'}:${item.id}`;
  const imdb = await externalId(type === 'series' ? 'tv' : 'movie', item.id);
  return imdb || `tmdb:${type === 'series' ? 'tv' : 'movie'}:${item.id}`;
}

async function catalogMeta(type, item) {
  const id = await canonicalId(type, item);
  const date = item.release_date || item.first_air_date;
  return clean({
    id,
    type,
    name: item.title || item.name,
    poster: poster(item.poster_path),
    background: backdrop(item.backdrop_path),
    description: item.overview,
    releaseInfo: year(date),
  });
}

async function fetchCatalog(type, catalogId, extra) {
  const page = pageFromSkip(extra.skip);
  const search = (extra.search || '').trim();
  const isSeries = type === 'series';
  const tmdbType = isSeries ? 'tv' : 'movie';
  const isAnime = catalogId === 'tmdb-anime' || catalogId === 'tmdb-anime-movies';

  let data;
  if (search) {
    data = await tmdb(`/search/${tmdbType}`, {
      query: search,
      page,
      include_adult: false,
      region: type === 'movie' ? REGION : undefined
    });
    if (isAnime) {
      data.results = (data.results || []).filter(x =>
        Array.isArray(x.genre_ids) && x.genre_ids.includes(16) && x.original_language === 'ja'
      );
    }
  } else {
    const params = {
      page,
      include_adult: false,
      sort_by: 'popularity.desc',
      region: type === 'movie' ? REGION : undefined
    };

    if (isAnime) {
      params.with_genres = 16;
      params.with_original_language = 'ja';
    }

    if (extra.genre) {
      const genreTable = type === 'movie' ? MOVIE_GENRES : TV_GENRES;
      const genreId = genreTable[extra.genre];
      if (genreId) {
        params.with_genres = params.with_genres
          ? `${params.with_genres},${genreId}`
          : genreId;
      }
    }

    data = await tmdb(`/discover/${tmdbType}`, params);
  }

  const results = (data.results || []).slice(0, 20);
  const metas = await mapLimit(results, 6, item => catalogMeta(type, item));
  return metas.filter(Boolean);
}

async function resolveTmdbId(type, id) {
  const direct = id.match(/^tmdb:(movie|tv):(\d+)$/);
  if (direct) {
    const wanted = type === 'movie' ? 'movie' : 'tv';
    if (direct[1] !== wanted) return null;
    return Number(direct[2]);
  }

  if (/^tt\d+$/.test(id)) {
    const found = await tmdb(`/find/${id}`, {
      external_source: 'imdb_id',
      language: undefined
    });
    const list = type === 'movie' ? found.movie_results : found.tv_results;
    return list && list[0] ? list[0].id : null;
  }

  return null;
}

async function movieMeta(id) {
  const tmdbId = await resolveTmdbId('movie', id);
  if (!tmdbId) return null;
  const d = await tmdb(`/movie/${tmdbId}`, { append_to_response: 'external_ids' });
  const imdbId = d.external_ids?.imdb_id || (/^tt\d+$/.test(id) ? id : undefined);

  return clean({
    id: imdbId || `tmdb:movie:${d.id}`,
    type: 'movie',
    name: d.title,
    poster: poster(d.poster_path),
    background: backdrop(d.backdrop_path),
    logo: undefined,
    description: d.overview,
    releaseInfo: year(d.release_date),
    runtime: d.runtime ? `${d.runtime} min` : undefined,
    genres: (d.genres || []).map(g => g.name),
    website: d.homepage || undefined
  });
}

async function fetchSeason(tvId, seasonNumber) {
  return tmdb(`/tv/${tvId}/season/${seasonNumber}`);
}

async function seriesMeta(id) {
  const tmdbId = await resolveTmdbId('series', id);
  if (!tmdbId) return null;

  const d = await tmdb(`/tv/${tmdbId}`, {
    append_to_response: 'external_ids,content_ratings'
  });
  const imdbId = d.external_ids?.imdb_id || (/^tt\d+$/.test(id) ? id : undefined);
  const canonical = imdbId || `tmdb:tv:${d.id}`;

  const seasons = (d.seasons || [])
    .filter(s => INCLUDE_SPECIALS || s.season_number !== 0)
    .filter(s => s.episode_count > 0)
    .sort((a, b) => a.season_number - b.season_number);

  const seasonPayloads = await mapLimit(seasons, 5, s => fetchSeason(d.id, s.season_number));
  const videos = [];

  for (const season of seasonPayloads.filter(Boolean)) {
    for (const ep of season.episodes || []) {
      videos.push(clean({
        id: `${canonical}:${ep.season_number}:${ep.episode_number}`,
        title: ep.name || `Episódio ${ep.episode_number}`,
        released: ep.air_date ? `${ep.air_date}T00:00:00.000Z` : undefined,
        season: ep.season_number,
        episode: ep.episode_number,
        overview: ep.overview || undefined,
        thumbnail: poster(ep.still_path, 'w780')
      }));
    }
  }

  return clean({
    id: canonical,
    type: 'series',
    name: d.name,
    poster: poster(d.poster_path),
    background: backdrop(d.backdrop_path),
    description: d.overview,
    releaseInfo: d.first_air_date
      ? `${year(d.first_air_date)}${d.status === 'Ended' && d.last_air_date ? `-${year(d.last_air_date)}` : '-'}`
      : undefined,
    runtime: d.episode_run_time?.[0] ? `${d.episode_run_time[0]} min` : undefined,
    genres: (d.genres || []).map(g => g.name),
    website: d.homepage || undefined,
    videos
  });
}

function manifest(origin) {
  const movieExtra = [
    { name: 'search', isRequired: false },
    { name: 'genre', isRequired: false, options: Object.keys(MOVIE_GENRES) },
    { name: 'skip', isRequired: false }
  ];
  const seriesExtra = [
    { name: 'search', isRequired: false },
    { name: 'genre', isRequired: false, options: Object.keys(TV_GENRES) },
    { name: 'skip', isRequired: false }
  ];

  return {
    id: 'org.horizon.catalog',
    version: '1.0.0',
    name: 'Horizon Catalog',
    description: 'Catálogo e metadados via TMDB para filmes, séries e anime, incluindo temporadas e episódios.',
    logo: `${origin}/logo.svg`,
    resources: [
      { name: 'catalog', types: ['movie', 'series'] },
      { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt', 'tmdb:movie:', 'tmdb:tv:'] }
    ],
    types: ['movie', 'series'],
    catalogs: [
      { type: 'movie', id: 'tmdb-popular-movies', name: 'Horizon • Filmes', extra: movieExtra },
      { type: 'series', id: 'tmdb-popular-series', name: 'Horizon • Séries', extra: seriesExtra },
      { type: 'series', id: 'tmdb-anime', name: 'Horizon • Anime', extra: seriesExtra },
      { type: 'movie', id: 'tmdb-anime-movies', name: 'Horizon • Filmes de Anime', extra: movieExtra }
    ],
    behaviorHints: {
      configurable: false,
      configurationRequired: false
    }
  };
}

const logoSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1d4ed8"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="110" fill="url(#g)"/>
  <path d="M118 120h62v106h152V120h62v272h-62V286H180v106h-62z" fill="#fff"/>
  <circle cx="391" cy="122" r="25" fill="#38bdf8"/>
</svg>`;

const homeHtml = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Horizon Catalog</title><style>
body{font-family:system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;background:#0f172a;color:#e2e8f0}
.card{background:#111827;border:1px solid #334155;border-radius:18px;padding:24px}code{background:#020617;padding:3px 7px;border-radius:7px;word-break:break-all}a{color:#38bdf8}
</style></head><body><div class="card"><h1>Horizon Catalog</h1>
<p>Addon de catálogo e metadados do Stremio usando TMDB para filmes, séries e anime.</p>
<p>Manifesto: <a href="/manifest.json"><code>/manifest.json</code></a></p>
<p>Este produto usa a API do TMDB, mas não é endossado nem certificado pelo TMDB.</p>
</div></body></html>`;

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,OPTIONS'
    });
    return res.end();
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || (/^(localhost|127\.0\.0\.1|\[::1\])/.test(host) ? 'http' : 'https');
  const origin = `${proto}://${host}`;
  const url = new URL(req.url, origin);
  const path = decodeURIComponent(url.pathname);

  try {
    if (path === '/') return text(res, 200, homeHtml, 'text/html; charset=utf-8');
    if (path === '/logo.svg') return text(res, 200, logoSvg, 'image/svg+xml; charset=utf-8');
    if (path === '/manifest.json') return json(res, 200, manifest(origin));
    if (path === '/health') return json(res, 200, { ok: true, tmdbConfigured: Boolean(TMDB_API_KEY) });

    const catalogMatch = path.match(/^\/catalog\/(movie|series)\/([^/]+)(?:\/(.+))?\.json$/);
    if (catalogMatch) {
      const [, type, catalogId, rawExtra] = catalogMatch;
      const allowed = new Set(['tmdb-popular-movies', 'tmdb-popular-series', 'tmdb-anime', 'tmdb-anime-movies']);
      if (!allowed.has(catalogId)) return json(res, 200, { metas: [] });
      if (catalogId.includes('movies') && type !== 'movie') return json(res, 200, { metas: [] });
      if ((catalogId === 'tmdb-popular-series' || catalogId === 'tmdb-anime') && type !== 'series') return json(res, 200, { metas: [] });
      const extra = parseExtra(rawExtra);
      const metas = await fetchCatalog(type, catalogId, extra);
      return json(res, 200, { metas });
    }

    const metaMatch = path.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    if (metaMatch) {
      const [, type, id] = metaMatch;
      const meta = type === 'movie' ? await movieMeta(id) : await seriesMeta(id);
      return json(res, 200, { meta: meta || {} });
    }

    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: err.message || 'Internal error' });
  }
}

http.createServer(handler).listen(PORT, '0.0.0.0', () => {
  console.log(`Horizon Catalog listening on port ${PORT}`);
  if (!TMDB_API_KEY) console.warn('TMDB_API_KEY is not configured.');
});
