'use strict';

/* ============================================================
   Weekendkurator — frontend.
   Vanilla JS. Ingen router, inget ramverk.
   ============================================================ */

const $ = (sel) => document.querySelector(sel);

const stages = {
  search:  $('#stage-search'),
  loading: $('#stage-loading'),
  results: $('#stage-results'),
  error:   $('#stage-error'),
};

let currentSource = null;   // EventSource
let lastTrips = [];
let lastFocus = null;

/* ------------------------------------------------------- hjälpare */

/** All AI-genererad text escapas innan den sätts som HTML. */
function h(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Släpper bara igenom http/https-länkar. */
function safeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url), window.location.origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Strikt taltolkning — Number(null) === 0, vilket annars gör att ett
 * saknat pris visas som "0 kr" istället för "Uppgift saknas".
 */
function num(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function formatPrice(n) {
  const v = num(n);
  if (!Number.isFinite(v)) return null;
  return `${Math.round(v).toLocaleString('sv-SE')}\u00a0kr`;
}

function formatDuration(minutes) {
  const m = num(minutes);
  if (!Number.isFinite(m) || m <= 0) return null;
  const hrs = Math.floor(m / 60);
  const min = Math.round(m % 60);
  if (!hrs) return `${min} min`;
  return min ? `${hrs} h ${min} min` : `${hrs} h`;
}

/** Badge för osäkra uppgifter — vi låtsas aldrig att en siffra är verifierad. */
function confidenceFlag(confidence) {
  if (confidence === 'estimated') return '<span class="flag flag--est">Uppskattat</span>';
  if (confidence === 'unknown') return '<span class="flag flag--unk">Ej bekräftat</span>';
  return '';
}

function priceOrMissing(value, confidence) {
  const price = formatPrice(value);
  if (!price) return '<span class="flag flag--unk">Uppgift saknas</span>';
  return `${h(price)}${confidenceFlag(confidence)}`;
}

function showStage(name) {
  Object.entries(stages).forEach(([key, el]) => { el.hidden = key !== name; });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ------------------------------------------------ standarddatum */

function pad(n) { return String(n).padStart(2, '0'); }
function toDateInput(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function setDefaultDates() {
  const now = new Date();
  const friday = new Date(now);
  // Närmaste kommande fredag. Är det redan fredag–söndag: ta nästa helg.
  const day = now.getDay();               // 0 = sön
  let delta = (5 - day + 7) % 7;
  if (day === 5 || day === 6 || day === 0) delta = (5 - day + 7) % 7 || 7;
  friday.setDate(now.getDate() + delta);

  const sunday = new Date(friday);
  sunday.setDate(friday.getDate() + 2);

  $('#departDate').value = toDateInput(friday);
  $('#returnDate').value = toDateInput(sunday);
  $('#departDate').min = toDateInput(now);
  $('#returnDate').min = toDateInput(now);
}

/* ------------------------------------------------------ sökning */

function readForm() {
  const styles = Array.from(document.querySelectorAll('input[name="styles"]:checked'))
    .map((el) => el.value);

  return {
    origin: $('#origin').value.trim(),
    earliestDeparture: `${$('#departDate').value}T${$('#departTime').value || '00:00'}`,
    latestReturn: `${$('#returnDate').value}T${$('#returnTime').value || '23:59'}`,
    budgetSek: Number($('#budget').value),
    region: $('#region').value.trim(),
    styles,
    preferDirect: $('#preferDirect').checked,
  };
}

function showFormError(message) {
  const el = $('#form-error');
  el.textContent = message;
  el.hidden = false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearFormError() {
  $('#form-error').hidden = true;
}

async function startSearch(event) {
  event.preventDefault();
  clearFormError();

  const payload = readForm();

  if (!payload.origin) return showFormError('Fyll i vilken ort du reser från.');
  if (!$('#departDate').value) return showFormError('Välj tidigaste avresa.');
  if (!$('#returnDate').value) return showFormError('Välj när du senast måste vara hemma.');
  if (!Number.isFinite(payload.budgetSek) || payload.budgetSek <= 0) {
    return showFormError('Ange en budget i kronor.');
  }

  const btn = $('#submit-btn');
  btn.disabled = true;

  let res;
  try {
    res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    btn.disabled = false;
    return showFormError('Kunde inte nå servern. Är den igång?');
  }

  const data = await res.json().catch(() => ({}));
  btn.disabled = false;

  if (!res.ok) {
    return showFormError(data.message || 'Något gick fel. Prova igen.');
  }

  resetLoading();
  showStage('loading');
  listen(data.jobId);
}

function resetLoading() {
  $('#log').innerHTML = '';
  $('#loading-sub').textContent = 'Startar research …';
  document.querySelectorAll('.steps li').forEach((li) => li.classList.remove('active', 'done'));
}

const STEP_ORDER = ['research', 'weather', 'editor', 'images'];

function markStep(step) {
  const index = STEP_ORDER.indexOf(step);
  if (index === -1) return;
  document.querySelectorAll('.steps li').forEach((li) => {
    const i = STEP_ORDER.indexOf(li.dataset.step);
    li.classList.toggle('active', i === index);
    li.classList.toggle('done', i < index);
  });
}

function addLogLine(text) {
  const log = $('#log');
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = text;
  log.appendChild(line);
  while (log.children.length > 8) log.removeChild(log.firstChild);
}

function listen(jobId) {
  closeSource();
  const source = new EventSource(`/api/search/${encodeURIComponent(jobId)}/events`);
  currentSource = source;

  source.addEventListener('progress', (e) => {
    let payload;
    try { payload = JSON.parse(e.data); } catch { return; }
    markStep(payload.step);
    $('#loading-sub').textContent = payload.message;
    addLogLine(payload.message);
  });

  source.addEventListener('done', (e) => {
    closeSource();
    let payload;
    try { payload = JSON.parse(e.data); } catch {
      return showError({ message: 'Kunde inte läsa resultatet. Prova igen.' });
    }
    renderResults(payload);
  });

  source.addEventListener('failed', (e) => {
    closeSource();
    let payload = {};
    try { payload = JSON.parse(e.data); } catch { /* ignoreras */ }
    showError(payload);
  });

  source.onerror = () => {
    // Servern stänger strömmen när jobbet är klart — bara ett fel om vi inte fått svar.
    if (currentSource === source && stages.loading.hidden === false) {
      closeSource();
      showError({ message: 'Tappade kontakten med servern under sökningen. Prova igen.' });
    }
  };
}

function closeSource() {
  if (currentSource) {
    try { currentSource.close(); } catch { /* noop */ }
    currentSource = null;
  }
}

function showError(payload) {
  $('#error-message').textContent = payload.message || 'Något gick fel. Prova igen.';
  const detail = $('#error-detail');
  if (payload.detail) {
    $('#error-detail-text').textContent = payload.detail;
    detail.hidden = false;
  } else {
    detail.hidden = true;
  }
  showStage('error');
}

/* ----------------------------------------------------- resultat */

function mediaHtml(trip, variant) {
  const url = safeUrl(trip.image && trip.image.url);
  const credit = trip.image && trip.image.credit;
  const creditUrl = safeUrl(trip.image && trip.image.creditUrl);

  const label = trip.label
    ? `<span class="label-badge">${h(trip.label)}</span>` : '';
  const rank = `<span class="rank-badge">#${trip.rank}</span>`;

  const inner = url
    ? `<img src="${h(url)}" alt="${h(trip.destination)}" loading="${variant === 'hero' ? 'eager' : 'lazy'}"
            onerror="this.remove()">`
    : `<span class="trip-media-fallback">${h(trip.destination)}</span>`;

  const creditHtml = (url && credit)
    ? `<a class="img-credit" href="${h(creditUrl || url)}" target="_blank" rel="noopener noreferrer"
          onclick="event.stopPropagation()">Foto: ${h(credit)}</a>`
    : '';

  return `<div class="trip-media">${inner}${rank}${label}${creditHtml}</div>`;
}

function factsHtml(trip) {
  const total = formatPrice(trip.totalPriceSek);
  const travel = formatDuration(trip.totalTravelTimeMinutes);
  const atDest = Number.isFinite(num(trip.timeAtDestinationHours))
    ? `${Math.round(num(trip.timeAtDestinationHours))} h` : null;

  const facts = [
    {
      label: 'Totalpris',
      value: total
        ? `<span class="price-main">${h(total)}</span>`
        : '<span class="flag flag--unk">Uppgift saknas</span>',
      sub: trip.nights ? `${trip.nights} ${trip.nights === 1 ? 'natt' : 'nätter'}` : null,
    },
    {
      label: 'Flyg',
      value: priceOrMissing(trip.flightPriceSek, trip.flightPriceConfidence),
      sub: trip.isDirect ? 'Direktflyg' : 'Med mellanlandning',
    },
    {
      label: 'Hotell',
      value: priceOrMissing(trip.hotel && trip.hotel.totalSek, trip.hotel && trip.hotel.priceConfidence),
      sub: trip.hotel && trip.hotel.name ? trip.hotel.name : null,
    },
    {
      label: 'Väder',
      value: h(trip.weather && trip.weather.summary ? trip.weather.summary : 'Prognos saknas'),
      sub: null,
    },
    {
      label: 'Tid på plats',
      value: atDest ? h(atDest) : '<span class="flag flag--unk">Okänt</span>',
      sub: travel ? `${travel} restid` : null,
    },
  ];

  return `<div class="facts">${facts.map((f) => `
    <div class="fact">
      <div class="fact-label">${h(f.label)}</div>
      <div class="fact-value">${f.value}${f.sub ? `<small>${h(f.sub)}</small>` : ''}</div>
    </div>`).join('')}</div>`;
}

function tripCardHtml(trip, variant) {
  const score = Number.isFinite(num(trip.aiScore))
    ? `<div class="score">
         <div class="score-value">${h(trip.aiScore)}</div>
         <div class="score-label">AI-score</div>
       </div>` : '';

  return `
    <button type="button" class="trip-card trip-card--${variant}" data-trip="${h(trip.id)}"
            aria-label="Visa detaljer för ${h(trip.destination)}">
      ${mediaHtml(trip, variant)}
      <div class="trip-body">
        <div class="trip-head">
          <div class="trip-place">
            <h3 class="trip-name">${h(trip.destination)}</h3>
            <div class="trip-country">${h(trip.country)}</div>
          </div>
          ${score}
        </div>
        ${trip.tagline ? `<p class="trip-tagline">${h(trip.tagline)}</p>` : ''}
        ${variant === 'hero' && trip.why ? `<p class="trip-why">${h(trip.why)}</p>` : ''}
        ${factsHtml(trip)}
        <span class="trip-cta">Se hela resan</span>
      </div>
    </button>`;
}

function renderResults(payload) {
  lastTrips = Array.isArray(payload.trips) ? payload.trips : [];

  if (!lastTrips.length) {
    return showError({ message: 'Inga resor kunde tas fram. Prova ett större tidsfönster eller högre budget.' });
  }

  const c = payload.criteria || {};
  $('#results-title').textContent = c.origin ? `Från ${c.origin}` : 'Din weekend';

  const styleText = Array.isArray(c.styles) && c.styles.length ? c.styles.join(', ') : null;
  $('#results-meta').textContent = [
    c.earliestDepartureText && c.latestReturnText
      ? `${c.earliestDepartureText} – ${c.latestReturnText}`
      : null,
    Number.isFinite(num(c.budgetSek)) ? `max ${formatPrice(c.budgetSek)}` : null,
    styleText,
    c.preferDirect ? 'helst direktflyg' : null,
  ].filter(Boolean).join(' · ');

  const [first, ...rest] = lastTrips;
  $('#results-list').innerHTML =
    tripCardHtml(first, 'hero')
    + (rest.length ? `<div class="pair">${rest.map((t) => tripCardHtml(t, 'small')).join('')}</div>` : '');

  const note = payload.diagnostics && payload.diagnostics.editorNote;
  $('#editor-note').textContent = note ? `”${note}”` : '';

  document.querySelectorAll('.trip-card').forEach((card) => {
    card.addEventListener('click', () => openDetail(card.dataset.trip));
  });

  showStage('results');
}

/* ----------------------------------------------------- detaljvy */

function legHtml(title, leg, place) {
  if (!leg) return '';
  const route = [leg.fromAirport, leg.toAirport].filter(Boolean).join(' → ');
  const meta = [
    leg.airline,
    leg.direct ? 'Direkt' : (Number.isFinite(num(leg.stops)) ? `${num(leg.stops)} mellanlandning(ar)` : 'Med mellanlandning'),
    formatDuration(leg.durationMinutes),
  ].filter(Boolean).join(' · ');

  return `
    <div class="leg">
      <div class="leg-title">${h(title)}</div>
      <div class="leg-route">${h(leg.departText || '—')} → ${h(leg.arriveText || '—')}</div>
      ${route ? `<div class="leg-meta">${h(route)}${place ? ` · ${h(place)}` : ''}</div>` : ''}
      ${meta ? `<div class="leg-meta">${h(meta)}</div>` : ''}
    </div>`;
}

function weatherHtml(weather) {
  if (!weather || !weather.available || !weather.days || !weather.days.length) {
    return `<p class="empty-note">${h((weather && weather.summary) || 'Prognos saknas')}</p>`;
  }
  const days = weather.days.map((d) => `
    <div class="weather-day">
      <div class="wd-day">${h(d.label)}</div>
      <div class="wd-icon">${h(d.icon)}</div>
      <div class="wd-temp">${Number.isFinite(num(d.tempMax)) ? `${Math.round(num(d.tempMax))}°` : '—'}</div>
      <div class="wd-text">${Number.isFinite(num(d.tempMin)) ? `min ${Math.round(num(d.tempMin))}° · ` : ''}${h(d.text)}</div>
    </div>`).join('');

  return `<div class="weather-strip">${days}</div>
          <p class="leg-meta" style="margin-top:.9rem">${h(weather.summary)} · Källa: Open-Meteo</p>`;
}

function listSection(items, renderItem, emptyText) {
  if (!Array.isArray(items) || !items.length) {
    return `<p class="empty-note">${h(emptyText)}</p>`;
  }
  return `<ul class="list-plain">${items.map(renderItem).join('')}</ul>`;
}

function detailHtml(trip) {
  const imgUrl = safeUrl(trip.image && trip.image.url);

  const hero = `
    <div class="detail-hero">
      ${imgUrl ? `<img src="${h(imgUrl)}" alt="${h(trip.destination)}" onerror="this.remove()">` : ''}
      <div class="detail-hero-overlay">
        ${trip.label ? `<span class="label-badge" style="position:static;display:inline-block;margin-bottom:.7rem">${h(trip.label)}</span>` : ''}
        <h2 id="detail-title">${h(trip.destination)}</h2>
        <div class="trip-country">${h(trip.country)}${Number.isFinite(num(trip.aiScore)) ? ` · AI-score ${h(trip.aiScore)}/100` : ''}</div>
      </div>
    </div>`;

  const hotel = trip.hotel || {};
  const hotelRows = [
    ['Hotell', hotel.name ? h(hotel.name) : '<span class="flag flag--unk">Ej bokat förslag</span>'],
    ['Betyg', Number.isFinite(num(hotel.rating)) ? `${h(num(hotel.rating))} / 10` : '<span class="flag flag--unk">Okänt</span>'],
    ['Område', hotel.area ? h(hotel.area) : '<span class="flag flag--unk">Okänt</span>'],
    ['Pris totalt', priceOrMissing(hotel.totalSek, hotel.priceConfidence)],
    ['Per natt', priceOrMissing(hotel.pricePerNightSek, hotel.priceConfidence)],
    ['Nätter', trip.nights ? h(trip.nights) : '—'],
  ];

  const sources = (trip.sources || [])
    .map((s) => ({ label: s.label, url: safeUrl(s.url) }))
    .filter((s) => s.url);

  return `
    ${hero}
    <div class="detail-body">
      ${trip.tagline ? `<p class="detail-lede">${h(trip.tagline)}</p>` : ''}

      <section class="detail-section">
        <h3>Resan</h3>
        ${legHtml('Utresa', trip.outbound, trip.destination)}
        ${legHtml('Hemresa', trip.inbound, null)}
        <div class="kv" style="margin-top:1.35rem">
          <div><div class="fact-label">Totalpris</div><div class="fact-value"><span class="price-main">${formatPrice(trip.totalPriceSek) ? h(formatPrice(trip.totalPriceSek)) : '—'}</span></div></div>
          <div><div class="fact-label">Flygpris</div><div class="fact-value">${priceOrMissing(trip.flightPriceSek, trip.flightPriceConfidence)}</div></div>
          <div><div class="fact-label">Total restid</div><div class="fact-value">${h(formatDuration(trip.totalTravelTimeMinutes) || 'Okänt')}</div></div>
          <div><div class="fact-label">Tid på plats</div><div class="fact-value">${Number.isFinite(num(trip.timeAtDestinationHours)) ? `${h(Math.round(num(trip.timeAtDestinationHours)))} h` : 'Okänt'}</div></div>
        </div>
      </section>

      <section class="detail-section">
        <h3>Boendet</h3>
        <div class="kv">
          ${hotelRows.map(([k, v]) => `<div><div class="fact-label">${h(k)}</div><div class="fact-value">${v}</div></div>`).join('')}
        </div>
        ${hotel.note ? `<p class="leg-meta" style="margin-top:1rem">${h(hotel.note)}</p>` : ''}
      </section>

      <section class="detail-section">
        <h3>Väder</h3>
        ${weatherHtml(trip.weather)}
      </section>

      <section class="detail-section">
        <h3>Varför denna resa</h3>
        <p style="color:var(--ink-soft);font-weight:300">${h(trip.why || 'Ingen motivering angavs.')}</p>
        ${trip.styleMatch && trip.styleMatch.comment
          ? `<p style="color:var(--ink-faint);font-size:.9rem;margin-top:.9rem">${h(trip.styleMatch.comment)}</p>` : ''}
      </section>

      <section class="detail-section">
        <h3>Highlights</h3>
        ${listSection(trip.highlights,
          (x) => `<li><h4>${h(x.title)}</h4><p>${h(x.description)}</p></li>`,
          'Inga highlights angavs.')}
      </section>

      <section class="detail-section">
        <h3>Mat</h3>
        ${listSection(trip.restaurants,
          (x) => `<li><h4>${h(x.name)}${x.type ? ` <span style="font-weight:400;color:var(--ink-faint)">· ${h(x.type)}</span>` : ''}</h4><p>${h(x.why)}${x.priceLevel ? ` (${h(x.priceLevel)})` : ''}</p></li>`,
          'Inga restaurangtips angavs.')}
      </section>

      <section class="detail-section">
        <h3>Vad händer i helgen?</h3>
        ${listSection(trip.events,
          (x) => `<li><h4>${h(x.title)}${x.confidence && x.confidence !== 'verified' ? confidenceFlag(x.confidence) : ''}</h4>
                   <p>${[x.date, x.venue].filter(Boolean).map(h).join(' · ')}${x.description ? `<br>${h(x.description)}` : ''}</p></li>`,
          'Inga bekräftade events hittades för den här helgen.')}
      </section>

      <section class="detail-section">
        <h3>Din weekend</h3>
        ${Array.isArray(trip.plan) && trip.plan.length
          ? trip.plan.map((day) => `
              <div class="plan-day">
                <div class="plan-day-name">${h(day.day)}</div>
                <ul class="plan-items">${(day.items || []).map((i) => `<li>${h(i)}</li>`).join('')}</ul>
              </div>`).join('')
          : '<p class="empty-note">Ingen plan genererades.</p>'}
      </section>

      ${sources.length ? `
      <section class="detail-section">
        <h3>Källor</h3>
        <div class="sources-list">
          ${sources.map((s) => `<a href="${h(s.url)}" target="_blank" rel="noopener noreferrer">${h(s.label || s.url)}</a>`).join('')}
        </div>
      </section>` : ''}

      ${(trip.uncertainties || []).length ? `
        <div class="uncertainty">
          <strong>Osäkert i den här researchen</strong>
          <ul>${trip.uncertainties.map((u) => `<li>${h(u)}</li>`).join('')}</ul>
        </div>` : ''}

      <p class="disclaimer">
        Priser och tillgänglighet kan ändras snabbt.
        Kontrollera alltid slutpriset hos bokningsleverantören.
      </p>
    </div>`;
}

function openDetail(tripId) {
  const trip = lastTrips.find((t) => String(t.id) === String(tripId));
  if (!trip) return;

  lastFocus = document.activeElement;
  $('#detail-content').innerHTML = detailHtml(trip);

  const overlay = $('#detail-overlay');
  overlay.hidden = false;
  document.body.classList.add('detail-open');
  overlay.scrollTop = 0;
  overlay.querySelector('.detail-panel').focus();
}

function closeDetail() {
  const overlay = $('#detail-overlay');
  if (overlay.hidden) return;
  overlay.hidden = true;
  document.body.classList.remove('detail-open');
  $('#detail-content').innerHTML = '';
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}

/* -------------------------------------------------------- init */

function init() {
  setDefaultDates();

  $('#search-form').addEventListener('submit', startSearch);

  $('#cancel-btn').addEventListener('click', () => {
    closeSource();
    showStage('search');
  });

  $('#new-search-btn').addEventListener('click', () => showStage('search'));
  $('#retry-btn').addEventListener('click', () => showStage('search'));

  $('#detail-close').addEventListener('click', closeDetail);
  $('#detail-overlay').addEventListener('click', (e) => {
    if (e.target === $('#detail-overlay')) closeDetail();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDetail();
  });

  window.addEventListener('beforeunload', closeSource);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
