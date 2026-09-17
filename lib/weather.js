'use strict';

/**
 * Väder via Open-Meteo (gratis, ingen API-nyckel).
 *  - geokodning:  geocoding-api.open-meteo.com
 *  - prognos:     api.open-meteo.com
 *
 * Modulen kastar aldrig. Går något fel returneras { available: false, ... }
 * så att en resa fortfarande kan visas – men utan påhittat väder.
 */

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = Number(process.env.WEATHER_TIMEOUT_MS || 12000);

/** Open-Meteo ger prognos ca 16 dygn framåt. */
const MAX_FORECAST_DAYS = 16;

const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

/** WMO weather code -> svensk text + symbol. */
const WMO = {
  0: ['Klart', '☀️'],
  1: ['Mest klart', '🌤️'],
  2: ['Halvklart', '⛅'],
  3: ['Mulet', '☁️'],
  45: ['Dimma', '🌫️'],
  48: ['Underkyld dimma', '🌫️'],
  51: ['Lätt duggregn', '🌦️'],
  53: ['Duggregn', '🌦️'],
  55: ['Tätt duggregn', '🌧️'],
  56: ['Underkylt duggregn', '🌧️'],
  57: ['Underkylt duggregn', '🌧️'],
  61: ['Lätt regn', '🌦️'],
  63: ['Regn', '🌧️'],
  65: ['Kraftigt regn', '🌧️'],
  66: ['Underkylt regn', '🌧️'],
  67: ['Kraftigt underkylt regn', '🌧️'],
  71: ['Lätt snöfall', '🌨️'],
  73: ['Snöfall', '🌨️'],
  75: ['Kraftigt snöfall', '❄️'],
  77: ['Snökorn', '🌨️'],
  80: ['Lätta regnskurar', '🌦️'],
  81: ['Regnskurar', '🌧️'],
  82: ['Kraftiga regnskurar', '⛈️'],
  85: ['Snöbyar', '🌨️'],
  86: ['Kraftiga snöbyar', '❄️'],
  95: ['Åska', '⛈️'],
  96: ['Åska med hagel', '⛈️'],
  99: ['Åska med kraftigt hagel', '⛈️'],
};

const WEEKDAYS = ['Söndag', 'Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lördag'];

function describeCode(code) {
  return WMO[code] || ['Växlande', '🌤️'];
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Weekendkurator/0.1 (MVP)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Slår upp koordinater för en stad. */
async function geocode(city, country) {
  const key = `geo:${city}|${country}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const url = `${GEO_URL}?name=${encodeURIComponent(city)}&count=5&language=sv&format=json`;
  const data = await getJson(url);
  const results = Array.isArray(data.results) ? data.results : [];
  if (!results.length) return null;

  // Föredra träff i rätt land om vi vet landet.
  const wanted = String(country || '').toLowerCase().trim();
  const match = results.find((r) => {
    const c = `${r.country || ''} ${r.country_code || ''}`.toLowerCase();
    return wanted && c.includes(wanted);
  }) || results[0];

  const value = {
    latitude: match.latitude,
    longitude: match.longitude,
    name: match.name,
    country: match.country,
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Hämtar dagsprognos för resans dagar.
 * @returns {Promise<{available:boolean, summary:string, days:Array, source?:string, reason?:string}>}
 */
async function forecastFor(city, country, fromDate, toDate) {
  const unavailable = (reason) => ({ available: false, summary: reason, days: [], reason });

  try {
    if (!city) return unavailable('Prognos saknas');

    const start = fromDate instanceof Date ? fromDate : new Date(fromDate);
    const end = toDate instanceof Date ? toDate : new Date(toDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return unavailable('Prognos saknas');
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daysAhead = Math.floor((start - today) / 864e5);
    if (daysAhead > MAX_FORECAST_DAYS) {
      return unavailable(`Prognos släpps ca ${MAX_FORECAST_DAYS} dagar innan avresa`);
    }

    const place = await geocode(city, country);
    if (!place) return unavailable('Hittade ingen väderstation för orten');

    const startDate = isoDate(start < today ? today : start);
    const endDate = isoDate(end < start ? start : end);

    const cacheKey = `fc:${place.latitude},${place.longitude},${startDate},${endDate}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    const url = `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}`
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max'
      + `&timezone=auto&start_date=${startDate}&end_date=${endDate}`;

    const data = await getJson(url);
    const daily = data.daily;
    if (!daily || !Array.isArray(daily.time) || !daily.time.length) {
      return unavailable('Prognos saknas');
    }

    const days = daily.time.map((date, i) => {
      const code = daily.weather_code?.[i];
      const [text, icon] = describeCode(code);
      const d = new Date(`${date}T12:00:00`);
      return {
        date,
        label: WEEKDAYS[d.getDay()],
        tempMax: daily.temperature_2m_max?.[i] ?? null,
        tempMin: daily.temperature_2m_min?.[i] ?? null,
        precipitation: daily.precipitation_sum?.[i] ?? null,
        windMax: daily.wind_speed_10m_max?.[i] ?? null,
        code: code ?? null,
        text,
        icon,
      };
    });

    const maxes = days.map((d) => d.tempMax).filter((n) => Number.isFinite(n));
    const rain = days.reduce((sum, d) => sum + (Number(d.precipitation) || 0), 0);
    const topText = days[0]?.text || 'Växlande';
    const summary = maxes.length
      ? `${Math.round(Math.min(...maxes))}–${Math.round(Math.max(...maxes))} °C, ${topText.toLowerCase()}`
        + (rain >= 1 ? `, ca ${Math.round(rain)} mm nederbörd` : ', mest uppehåll')
      : topText;

    const value = {
      available: true,
      summary,
      days,
      place: place.name,
      source: 'Open-Meteo',
      sourceUrl: 'https://open-meteo.com/',
    };
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (err) {
    return unavailable('Väderprognosen kunde inte hämtas just nu');
  }
}

module.exports = { forecastFor, describeCode };
