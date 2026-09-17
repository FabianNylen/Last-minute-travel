'use strict';

/**
 * Bevisar att väder- och bildmodulerna gör rätt av riktiga API-svar.
 *
 * Testmiljön får inte nå api.open-meteo.com eller wikipedia.org (utgående
 * trafik blockeras), så fetch stubbas med svar i exakt det format tjänsterna
 * returnerar. Det testar allt utom själva nätverkshoppet: URL:er, parsning,
 * svensk text, fallback-ordning och felhantering.
 */

const assert = require('node:assert');

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

const realFetch = global.fetch;
const calls = [];
function stub(routes) {
  global.fetch = async (url) => {
    calls.push(String(url));
    for (const [pattern, body] of routes) {
      if (String(url).includes(pattern)) {
        if (body === 'ERROR') throw new Error('nätverksfel');
        if (body === '404') return { ok: false, status: 404 };
        return { ok: true, status: 200, json: async () => body };
      }
    }
    return { ok: false, status: 404 };
  };
}
const restore = () => { global.fetch = realFetch; calls.length = 0; };

// Svar i Open-Meteos riktiga format
const GEO = { results: [{ name: 'Riga', country: 'Lettland', country_code: 'LV', latitude: 56.946, longitude: 24.105 }] };
const FORECAST = {
  daily: {
    time: ['2026-09-18', '2026-09-19', '2026-09-20'],
    weather_code: [3, 61, 1],
    temperature_2m_max: [17.4, 15.2, 18.9],
    temperature_2m_min: [11.1, 10.4, 12.0],
    precipitation_sum: [0, 4.2, 0.1],
    wind_speed_10m_max: [18.5, 22.1, 14.3],
  },
};

(async () => {
  console.log('\nVäder (Open-Meteo)');
  const soon = new Date(Date.now() + 3 * 864e5);
  const later = new Date(Date.now() + 5 * 864e5);

  delete require.cache[require.resolve('../lib/weather')];
  stub([['geocoding-api', GEO], ['api.open-meteo.com', FORECAST]]);
  const weather = require('../lib/weather');

  await test('prognos parsas till svenska dagar', async () => {
    const w = await weather.forecastFor('Riga', 'Lettland', soon, later);
    assert.strictEqual(w.available, true, 'prognosen kom inte igenom');
    assert.strictEqual(w.days.length, 3);
    assert.strictEqual(w.days[0].text, 'Mulet');
    assert.strictEqual(w.days[1].text, 'Lätt regn');
    assert.strictEqual(w.days[2].text, 'Mest klart');
    assert.strictEqual(w.days[0].tempMax, 17.4);
    assert.ok(['Fredag','Lördag','Söndag','Måndag','Tisdag','Onsdag','Torsdag'].includes(w.days[0].label));
  });

  await test('sammanfattningen är svensk och innehåller temperaturspann', async () => {
    const w = await weather.forecastFor('Riga', 'Lettland', soon, later);
    assert.match(w.summary, /15–19 °C/, `fick: ${w.summary}`);
    assert.match(w.summary, /mulet/);
    assert.match(w.summary, /mm nederbörd/);
  });

  await test('rätt URL:er anropas', async () => {
    // Färsk modul: annars svarar modulens egen cache och inget nätanrop sker.
    delete require.cache[require.resolve('../lib/weather')];
    stub([['geocoding-api', GEO], ['api.open-meteo.com', FORECAST]]);
    const fresh = require('../lib/weather');
    calls.length = 0;
    await fresh.forecastFor('Vilnius', 'Litauen', soon, later);
    assert.ok(calls.some((u) => u.includes('geocoding-api.open-meteo.com') && u.includes('Vilnius')), 'geokodning');
    assert.ok(calls.some((u) => u.includes('api.open-meteo.com/v1/forecast') && u.includes('latitude=')), 'prognos');
    assert.ok(calls.some((u) => u.includes('weather_code')), 'väderkod begärs');
  });

  await test('resa längre bort än 16 dagar ger ärligt besked, inte gissning', async () => {
    const far = new Date(Date.now() + 40 * 864e5);
    const w = await weather.forecastFor('Riga', 'Lettland', far, far);
    assert.strictEqual(w.available, false);
    assert.match(w.summary, /16 dagar/);
  });

  await test('nätverksfel kraschar inte, ger svenskt meddelande', async () => {
    stub([['geocoding-api', 'ERROR']]);
    delete require.cache[require.resolve('../lib/weather')];
    const w2 = require('../lib/weather');
    const w = await w2.forecastFor('Riga', 'Lettland', soon, later);
    assert.strictEqual(w.available, false);
    assert.match(w.summary, /kunde inte hämtas/);
  });

  console.log('\nBilder (Wikipedia → Openverse)');
  const WIKI = { query: { pages: [{ title: 'Riga', thumbnail: { source: 'https://upload.wikimedia.org/riga.jpg', width: 1600, height: 1067 } }] } };
  const WIKI_MISSING = { query: { pages: [{ title: 'Xyz', missing: true }] } };
  const OPENVERSE = { results: [{ url: 'https://live.staticflickr.com/riga.jpg', creator: 'Foto Andersson', foreign_landing_url: 'https://flickr.com/x', license: 'cc-by', width: 1200, height: 800 }] };

  await test('hämtar svensk Wikipedia-bild i stort format', async () => {
    delete require.cache[require.resolve('../lib/images')];
    stub([['sv.wikipedia.org', WIKI]]);
    const images = require('../lib/images');
    const img = await images.forDestination('Riga', 'Lettland');
    assert.strictEqual(img.url, 'https://upload.wikimedia.org/riga.jpg');
    assert.strictEqual(img.source, 'wikipedia');
    assert.ok(img.creditUrl.includes('wikipedia.org'), 'bildkredit länkar till källan');
    assert.ok(calls.some((u) => u.includes('pithumbsize=1600')), 'begär stor bild');
  });

  await test('faller tillbaka sv → en → Openverse', async () => {
    delete require.cache[require.resolve('../lib/images')];
    stub([['sv.wikipedia.org', WIKI_MISSING], ['en.wikipedia.org', WIKI_MISSING], ['api.openverse.org', OPENVERSE]]);
    const images = require('../lib/images');
    const img = await images.forDestination('Riga', 'Lettland');
    assert.strictEqual(img.source, 'openverse');
    assert.match(img.credit, /Foto Andersson/);
  });

  await test('ingen källa svarar → null, aldrig trasig bild', async () => {
    delete require.cache[require.resolve('../lib/images')];
    stub([['wikipedia.org', 'ERROR'], ['openverse', 'ERROR']]);
    const images = require('../lib/images');
    const img = await images.forDestination('Nowhereville', 'Ingenstans');
    assert.strictEqual(img, null);
  });

  console.log('\nBokningslänkar');
  const booking = require('../lib/booking');
  await test('flyglänk bär rätt flygplatser och datum', async () => {
    const l = booking.linksFor({ origin: 'Göteborg', destination: 'Riga', destinationCode: 'RIX',
      outDate: '2026-09-18', inDate: '2026-09-20', hotelName: 'Radisson', nights: 2 });
    assert.ok(l.flights[0].url.includes('GOT'), 'avreseflygplats');
    assert.ok(l.flights[0].url.includes('RIX'), 'ankomstflygplats');
    assert.ok(l.flights[0].url.includes('2026-09-18'), 'utresedatum');
    assert.ok(l.flights[1].url.includes('/got/rix/260918/260920/'), `Skyscanner-format: ${l.flights[1].url}`);
  });
  await test('hotellänk bär hotellnamn och in/utcheckning', async () => {
    const l = booking.linksFor({ origin: 'Göteborg', destination: 'Riga', outDate: '2026-09-18',
      inDate: '2026-09-20', hotelName: 'Radisson Hotel Old Town', nights: 2 });
    assert.ok(l.hotel[0].url.includes('checkin=2026-09-18'), 'incheckning');
    assert.ok(l.hotel[0].url.includes('checkout=2026-09-20'), 'utcheckning');
    const decoded = decodeURIComponent(l.hotel[0].url).replace(/\+/g, ' ');
    assert.ok(decoded.includes('Radisson Hotel Old Town'), `hotellnamn, fick: ${decoded}`);
  });
  await test('utan hotellnamn ges ändå en sökning på orten', async () => {
    const l = booking.linksFor({ origin: 'Göteborg', destination: 'Riga', outDate: '2026-09-18', inDate: '2026-09-20' });
    assert.strictEqual(l.hotel.length, 1);
    assert.match(l.hotel[0].label, /Sök hotell/);
  });

  restore();
  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} godkända, ${failed} misslyckade\n`);
  process.exit(failed ? 1 : 0);
})();
