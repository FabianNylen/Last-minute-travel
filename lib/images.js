'use strict';

/**
 * Riktiga destinationsbilder från gratiskällor – ingen API-nyckel krävs.
 *
 * Ordning:
 *   1. Wikipedia (sv -> en) via pageimages. Gratis, ingen nyckel, riktiga stadsbilder.
 *   2. Openverse (öppet licensierade bilder). Gratis, ingen nyckel.
 *   3. Unsplash – bara om UNSPLASH_ACCESS_KEY är satt (frivilligt).
 *   4. null -> frontend ritar en elegant gradient istället. Aldrig en trasig bild.
 *
 * Modulen kastar aldrig.
 */

const TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS || 12000);
const UNSPLASH_KEY = process.env.UNSPLASH_ACCESS_KEY || null;
const UA = 'Weekendkurator/0.1 (MVP; lokal demo)';

const cache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

async function getJson(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Wikipedia: hämtar sidans huvudbild i stort format. */
async function fromWikipedia(city, country, lang) {
  const title = city;
  const url = `https://${lang}.wikipedia.org/w/api.php`
    + '?action=query&format=json&formatversion=2&redirects=1'
    + '&prop=pageimages&piprop=thumbnail&pithumbsize=1600'
    + `&titles=${encodeURIComponent(title)}`;

  const data = await getJson(url);
  const page = data?.query?.pages?.[0];
  if (!page || page.missing || !page.thumbnail?.source) return null;

  return {
    url: page.thumbnail.source,
    width: page.thumbnail.width || null,
    height: page.thumbnail.height || null,
    credit: 'Wikipedia',
    creditUrl: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title || title)}`,
    source: 'wikipedia',
  };
}

/** Openverse: öppet licensierade bilder, ingen nyckel för enkla sökningar. */
async function fromOpenverse(city, country) {
  const q = `${city} ${country || ''} city`.trim();
  const url = 'https://api.openverse.org/v1/images/'
    + `?q=${encodeURIComponent(q)}&page_size=3&license_type=all&aspect_ratio=wide&mature=false`;

  const data = await getJson(url);
  const hit = Array.isArray(data?.results) ? data.results.find((r) => r.url) : null;
  if (!hit) return null;

  return {
    url: hit.url,
    width: hit.width || null,
    height: hit.height || null,
    credit: hit.creator ? `${hit.creator} (Openverse)` : 'Openverse',
    creditUrl: hit.foreign_landing_url || hit.url,
    source: 'openverse',
    license: hit.license || null,
  };
}

/** Unsplash – frivilligt, bara om nyckel finns i miljön. */
async function fromUnsplash(city, country) {
  if (!UNSPLASH_KEY) return null;
  const q = `${city} ${country || ''}`.trim();
  const url = 'https://api.unsplash.com/search/photos'
    + `?query=${encodeURIComponent(q)}&per_page=1&orientation=landscape&content_filter=high`;

  const data = await getJson(url, { Authorization: `Client-ID ${UNSPLASH_KEY}` });
  const hit = data?.results?.[0];
  if (!hit?.urls?.regular) return null;

  return {
    url: hit.urls.regular,
    width: hit.width || null,
    height: hit.height || null,
    credit: hit.user?.name ? `${hit.user.name} (Unsplash)` : 'Unsplash',
    creditUrl: hit.links?.html || 'https://unsplash.com',
    source: 'unsplash',
  };
}

/**
 * Hämtar en destinationsbild. Returnerar null om ingen källa svarar –
 * frontend visar då en gradient istället för en trasig bild.
 */
async function forDestination(city, country) {
  if (!city) return null;

  const key = `img:${city}|${country || ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const attempts = [
    () => fromUnsplash(city, country),
    () => fromWikipedia(city, country, 'sv'),
    () => fromWikipedia(city, country, 'en'),
    () => fromOpenverse(city, country),
  ];

  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result && result.url) {
        cache.set(key, { at: Date.now(), value: result });
        return result;
      }
    } catch {
      // Prova nästa källa.
    }
  }

  cache.set(key, { at: Date.now(), value: null });
  return null;
}

module.exports = { forDestination };
