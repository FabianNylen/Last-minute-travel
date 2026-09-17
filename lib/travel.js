'use strict';

/**
 * Reselogiken: tvåstegsflödet Researcher -> Travel Editor.
 *
 * Viktig ansvarsfördelning:
 *  - AI:n gör research och den *mänskliga bedömningen* (rangordning, poäng, motivering).
 *  - Koden här äger de HÅRDA KRAVEN (budget, avresetid, hemkomsttid). De filtreras
 *    bort deterministiskt så att en AI-miss aldrig kan visa en resa som bryter dem.
 */

const ai = require('./ai');
const { researchSchema, editorSchema } = require('./schemas');
const weather = require('./weather');
const images = require('./images');

const STYLE_LABELS = {
  city: 'city / storstadspuls',
  mat: 'mat och restauranger',
  nattliv: 'nattliv och barer',
  kultur: 'kultur, museer och arkitektur',
  sol: 'sol och värme',
  natur: 'natur och friluftsliv',
  avkoppling: 'avkoppling, spa och lugn',
  romantiskt: 'romantiskt',
};

const RESEARCH_TIMEOUT_MS = Number(process.env.RESEARCH_TIMEOUT_MS || 11 * 60 * 1000);
const EDITOR_TIMEOUT_MS = Number(process.env.EDITOR_TIMEOUT_MS || 5 * 60 * 1000);

/* ------------------------------------------------------------------ hjälpare */

/**
 * Strikt taltolkning.
 * Number(null) === 0 och Number('') === 0, vilket är livsfarligt här:
 * ett saknat pris skulle då se ut som "0 kr" och glida igenom budgetkontrollen.
 * Den här returnerar NaN för allt som inte är ett riktigt tal.
 */
function num(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

const WEEKDAYS = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];
const MONTHS = ['januari', 'februari', 'mars', 'april', 'maj', 'juni',
  'juli', 'augusti', 'september', 'oktober', 'november', 'december'];

/** '2026-09-25T16:00' -> Date i lokal tid. Returnerar null om ogiltigt. */
function parseLocal(value) {
  if (!value || typeof value !== 'string') return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const d = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0, 0, 0,
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Slår ihop 'YYYY-MM-DD' + 'HH:MM' till en lokal Date. */
function combine(date, time) {
  if (!date) return null;
  const t = /^\d{1,2}:\d{2}$/.test(String(time || '')) ? time : '00:00';
  return parseLocal(`${date}T${t}`);
}

/**
 * Avgångs- och ankomsttid för en flygsträcka.
 *
 * AI:n anger ett datum och två klockslag. Landar planet efter midnatt blir
 * ankomsttiden tidigare på dygnet än avgångstiden — då tillhör ankomsten
 * NÄSTA dag. Utan den här justeringen skulle ett nattflyg som landar 01:00 på
 * måndagen se ut att landa 01:00 på söndagen och slinka förbi "senast hemma".
 *
 * Inom Europa är tidszonsskillnaden (max ca 2 h) alltid mindre än flygtiden,
 * så ankomst < avgång betyder i praktiken alltid att midnatt passerats.
 */
function legTimes(leg) {
  const dep = combine(leg?.date, leg?.departTime);
  let arr = combine(leg?.date, leg?.arriveTime);
  if (dep && arr && arr < dep) {
    arr = new Date(arr.getTime());
    arr.setDate(arr.getDate() + 1);
  }
  return { dep, arr };
}

function formatSwedishDateTime(d) {
  if (!d) return null;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${hh}:${mm}`;
}

function formatSwedishDate(d) {
  if (!d) return null;
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function toIsoDate(d) {
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ------------------------------------------------------- inkommande kriterier */

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'validation';
  }
}

/** Läser och saniterar formulärdata. Kastar ValidationError med svenskt meddelande. */
function normalizeCriteria(raw = {}) {
  const origin = String(raw.origin || '').trim();
  if (!origin) throw new ValidationError('Fyll i vilken ort du reser från.');
  if (origin.length > 80) throw new ValidationError('Avreseorten är för lång.');

  const earliest = parseLocal(raw.earliestDeparture);
  const latest = parseLocal(raw.latestReturn);
  if (!earliest) throw new ValidationError('Ange tidigaste avresa (datum och tid).');
  if (!latest) throw new ValidationError('Ange när du senast måste vara hemma.');
  if (latest <= earliest) throw new ValidationError('"Senast hemma" måste vara efter "tidigaste avresa".');

  const spanHours = (latest - earliest) / 36e5;
  if (spanHours < 12) throw new ValidationError('Tidsfönstret är för kort för en resa. Ge minst ett dygn.');
  if (spanHours > 24 * 21) throw new ValidationError('Tidsfönstret är för långt. Max tre veckor.');

  const now = new Date();
  if (latest < now) throw new ValidationError('Tidsfönstret ligger bakåt i tiden.');

  const budgetSek = Math.round(Number(raw.budgetSek));
  if (!Number.isFinite(budgetSek) || budgetSek <= 0) throw new ValidationError('Ange en budget i kronor.');
  if (budgetSek < 1000) throw new ValidationError('Budgeten behöver vara minst 1 000 kr för flyg och hotell.');
  if (budgetSek > 200000) throw new ValidationError('Budgeten verkar orimligt hög.');

  const styles = Array.isArray(raw.styles)
    ? raw.styles.filter((s) => Object.prototype.hasOwnProperty.call(STYLE_LABELS, s))
    : [];

  const region = String(raw.region || '').trim().slice(0, 80);
  const preferDirect = Boolean(raw.preferDirect);

  return {
    origin,
    earliestDeparture: earliest,
    latestReturn: latest,
    budgetSek,
    region,
    styles,
    preferDirect,
  };
}

/* -------------------------------------------------------------------- prompts */

function buildResearchPrompt(c) {
  const today = new Date();
  const styleText = c.styles.length
    ? c.styles.map((s) => STYLE_LABELS[s]).join(', ')
    : 'ingen särskild stil angiven – tolka brett';

  return `Du är en erfaren reseresearcher på en svensk sista minuten-resetjänst.
Ditt jobb är att hitta realistiska weekendresor som faktiskt går att boka.

DAGENS DATUM: ${toIsoDate(today)} (${formatSwedishDate(today)})

ANVÄNDARENS KRAV
- Avreseort: ${c.origin}
- Tidigast avresa: ${formatSwedishDateTime(c.earliestDeparture)} (${toIsoDate(c.earliestDeparture)} kl ${String(c.earliestDeparture.getHours()).padStart(2, '0')}:${String(c.earliestDeparture.getMinutes()).padStart(2, '0')})
- Senast hemma igen: ${formatSwedishDateTime(c.latestReturn)} (${toIsoDate(c.latestReturn)} kl ${String(c.latestReturn.getHours()).padStart(2, '0')}:${String(c.latestReturn.getMinutes()).padStart(2, '0')})
- Budget: MAX ${c.budgetSek} kr per person totalt för flyg + hotell
- Land/region: ${c.region || 'var som helst (rimligt flygavstånd)'}
- Resestil: ${styleText}
- Direktflyg: ${c.preferDirect ? 'föredras starkt, men mellanlandning är okej om resan är klart bättre' : 'spelar mindre roll'}

HÅRDA KRAV – FÅR ALDRIG BRYTAS
1. Utresan får INTE lyfta före ${toIsoDate(c.earliestDeparture)} kl ${String(c.earliestDeparture.getHours()).padStart(2, '0')}:${String(c.earliestDeparture.getMinutes()).padStart(2, '0')}.
2. Hemresan måste ha LANDAT i ${c.origin} senast ${toIsoDate(c.latestReturn)} kl ${String(c.latestReturn.getHours()).padStart(2, '0')}:${String(c.latestReturn.getMinutes()).padStart(2, '0')}.
3. totalPriceSek (flyg tur och retur + hotell för alla nätter, per person) får INTE överstiga ${c.budgetSek} kr.
Kandidater som bryter mot något av detta kommer att kastas bort. Ta inte med dem.

RESEARCHREGLER – DETTA ÄR DET VIKTIGASTE
- Du får INTE hitta på priser, flygtider, hotellnamn eller events. Aldrig.
- Använd WebSearch för allt som förändras snabbt: flygpriser, flygtider, hotellpriser och events.
- Hotell ska vara riktiga, existerande hotell. Events ska vara riktiga, annonserade evenemang.
- Hittar du inte en siffra: sätt värdet till null eller ange confidence "estimated"/"unknown"
  och skriv vad som är osäkert i fältet "uncertainties".
- confidence-nivåer: "verified" = du har sett siffran i en källa nu,
  "estimated" = rimlig uppskattning utifrån prisnivå du sett, "unknown" = vet inte.
- En ärlig lucka är alltid bättre än en påhittad siffra. Användaren bokar på riktigt.
- Ange källor (url) i "sources" för varje kandidat.

ARBETSGÅNG
1. Utgå från vilka destinationer som faktiskt har flygförbindelse från ${c.origin}
   (inklusive rimliga närliggande flygplatser om det behövs – nämn det i så fall).
2. Välj ut 8–15 destinationer som passar tidsfönstret, budgeten och resestilen.
3. Websök prisnivå på flyg och hotell för de aktuella datumen. Slå ihop sökningar där det går,
   men gör minst en riktig sökning per destination du tar med.
4. Websök vad som händer på destinationen just den helgen (konserter, matmarknader,
   utställningar, matcher, festivaler).
5. Fyll i flygtider så realistiskt du kan utifrån det du hittar. Om du bara känner till
   typiska avgångstider för rutten: sätt confidence därefter och skriv det i uncertainties.

BEDÖM ÄVEN
- Restid och hur mycket *användbar tid* användaren faktiskt får på plats
  (timeAtDestinationHours = från landning ut till avgång hem).
- Hotellets läge och kvalitet, inte bara priset.
- Hur väl destinationen matchar resestilen (${styleText}).

Billigast är inte målet. Målet är resor som är värda att ta.
Ta med både billiga och lite dyrare alternativ inom budgeten, så att redaktören
efter dig har något att välja mellan.

Svara enligt det angivna JSON-schemat.`;
}

function buildEditorPrompt(c, candidates) {
  const styleText = c.styles.length
    ? c.styles.map((s) => STYLE_LABELS[s]).join(', ')
    : 'ingen särskild stil angiven';

  const slim = candidates.map((x) => ({
    id: x.id,
    destination: x.destination,
    country: x.country,
    nights: x.nights,
    totalPriceSek: x.totalPriceSek,
    flightPriceSek: x.flightPriceSek,
    flightPriceConfidence: x.flightPriceConfidence,
    hotel: x.hotel,
    outbound: x.outbound,
    inbound: x.inbound,
    direct: Boolean(x.outbound?.direct && x.inbound?.direct),
    totalTravelTimeMinutes: x.totalTravelTimeMinutes,
    timeAtDestinationHours: x.timeAtDestinationHours,
    styleMatch: x.styleMatch,
    highlights: x.highlights,
    restaurants: x.restaurants,
    events: x.events,
    uncertainties: x.uncertainties,
    weather: x.weather && x.weather.available
      ? { summary: x.weather.summary, days: x.weather.days }
      : { summary: 'Prognos saknas', days: [] },
  }));

  return `Du är reseredaktör på en svensk sista minuten-resetjänst. Du har en researcher
som redan tagit fram kandidater. Ditt jobb är den mänskliga bedömningen.

ANVÄNDAREN
- Reser från: ${c.origin}
- Tidsfönster: ${formatSwedishDateTime(c.earliestDeparture)} till ${formatSwedishDateTime(c.latestReturn)}
- Budget: max ${c.budgetSek} kr per person (flyg + hotell)
- Resestil: ${styleText}
- Direktflyg: ${c.preferDirect ? 'föredras' : 'spelar mindre roll'}

KANDIDATER (redan kontrollerade mot budget och tider):
${JSON.stringify(slim, null, 1)}

UPPDRAG
Välj EXAKT TRE resor och rangordna dem efter TOTAL RESEUPPLEVELSE.

- Billigast vinner INTE automatiskt. En dyrare resa ska kunna rankas högre än en
  billigare om flygtider, hotell, väder, events, mat och helheten är bättre.
- Använd ingen poängformel. Gör bedömningen som en kunnig människa som själv
  skulle åka. Väg samman: användbar tid på plats, flygtider som inte förstör dagen,
  hotellets läge, väder, vad som händer den helgen, matscen och hur väl det matchar
  resestilen (${styleText}).
- aiScore (0–100) ska spegla din helhetskänsla, inte en uträkning. Resor som är
  riktigt bra får ligga högt, medelmåttiga i mitten. Undvik att ge alla tre samma poäng.
- Sätt en kort label som säger något meningsfullt om just den resan, t.ex.
  "Bäst totalt", "Mest prisvärd", "Bäst för mat", "Bäst väder", "Mest spontan",
  "Bästa splurge". Hitta gärna en egen om den passar bättre. Upprepa inte samma label.
- tagline: kort och lockande, max ca 70 tecken. Ingen klyschig resebroschyrsvenska.
- why: 2–4 meningar om varför just den här resan är värd att ta, för just den här
  användaren. Var konkret. Nämn det som faktiskt skiljer den från de andra.
  Om något är osäkert (t.ex. ett pris) – var ärlig om det istället för att dölja det.
- plan: en lätt weekendplan per dag (Fredag/Lördag/Söndag beroende på resans dagar).
  2–6 punkter per dag. Håll det luftigt, till exempel
  "Ankomst → incheckning → middag i Kreuzberg → drinkar".
  Överplanera INTE varje minut. Det ska kännas som ett tips, inte ett schema.

Använd bara id:n som finns i kandidatlistan. Svara enligt det angivna JSON-schemat.`;
}

/* --------------------------------------------------- hårda krav (kod, ej AI) */

/**
 * Filtrerar bort kandidater som bryter mot hårda krav.
 * Detta är medvetet deterministiskt – AI:n får inte överpröva det här.
 */
function enforceHardConstraints(candidates, c) {
  const kept = [];
  const rejected = [];

  const seen = new Set();

  for (const raw of candidates) {
    const cand = { ...raw };
    const reasons = [];

    const { dep: outDep, arr: outArr } = legTimes(cand.outbound);
    const { dep: inDep, arr: inArr } = legTimes(cand.inbound);

    if (!outDep) reasons.push('saknar utresetid');
    if (!inArr) reasons.push('saknar hemkomsttid');

    if (outDep && outDep < c.earliestDeparture) {
      reasons.push(`utresan lyfter ${formatSwedishDateTime(outDep)}, före tidigaste avresa`);
    }
    if (inArr && inArr > c.latestReturn) {
      reasons.push(`hemresan landar ${formatSwedishDateTime(inArr)}, efter senast hemma`);
    }
    if (outDep && inDep && inDep < outDep) {
      reasons.push('hemresan avgår före utresan');
    }

    const total = num(cand.totalPriceSek);
    if (!Number.isFinite(total)) {
      reasons.push('totalpris kunde inte fastställas, går inte att garantera budgeten');
    } else if (total > c.budgetSek) {
      reasons.push(`totalpris ${total} kr överstiger budgeten ${c.budgetSek} kr`);
    }

    const key = `${String(cand.destination || '').toLowerCase().trim()}|${String(cand.country || '').toLowerCase().trim()}`;
    if (seen.has(key)) reasons.push('dubblett av annan kandidat');

    if (reasons.length) {
      rejected.push({ destination: cand.destination || cand.id || 'okänd', reasons });
      continue;
    }

    seen.add(key);

    // Härled restid och tid på plats om AI:n inte gav dem.
    if (!Number.isFinite(num(cand.totalTravelTimeMinutes))) {
      const outMin = num(cand.outbound?.durationMinutes);
      const inMin = num(cand.inbound?.durationMinutes);
      cand.totalTravelTimeMinutes = Number.isFinite(outMin) && Number.isFinite(inMin)
        ? outMin + inMin
        : null;
    }
    if (!Number.isFinite(num(cand.timeAtDestinationHours)) && outArr && inDep) {
      cand.timeAtDestinationHours = Math.round(((inDep - outArr) / 36e5) * 10) / 10;
    }

    cand.isDirect = Boolean(cand.outbound?.direct && cand.inbound?.direct);
    kept.push(cand);
  }

  return { kept, rejected };
}

/* ------------------------------------------------------------- huvudflödet */

/**
 * Kör hela flödet: research -> hårda krav -> väder -> redaktör -> bilder.
 * @param {object} criteria   Rådata från formuläret.
 * @param {function} onProgress  (step, message) för live-status.
 */
async function findTrips(rawCriteria, onProgress = () => {}) {
  const c = normalizeCriteria(rawCriteria);
  const diagnostics = { rejected: [], webSearches: 0, costUsd: 0 };

  /* 1. Researcher ------------------------------------------------------- */
  onProgress('research', 'Letar efter destinationer som passar dina datum …');

  const research = await ai.runJson({
    prompt: buildResearchPrompt(c),
    schema: researchSchema,
    tools: ['WebSearch', 'WebFetch'],
    timeoutMs: RESEARCH_TIMEOUT_MS,
    onProgress: (msg) => onProgress('research', msg),
  });

  diagnostics.webSearches += research.meta.webSearches || 0;
  diagnostics.costUsd += research.meta.costUsd || 0;
  diagnostics.researchNotes = research.data.researchNotes || null;

  const candidates = Array.isArray(research.data.candidates) ? research.data.candidates : [];
  if (!candidates.length) {
    throw new ValidationError('AI:n hittade inga resor som matchar. Prova ett större tidsfönster eller högre budget.');
  }

  /* 2. Hårda krav ------------------------------------------------------- */
  const { kept, rejected } = enforceHardConstraints(candidates, c);
  diagnostics.rejected = rejected;
  diagnostics.candidatesFound = candidates.length;
  diagnostics.candidatesKept = kept.length;

  if (kept.length < 3) {
    throw new ValidationError(
      kept.length === 0
        ? 'Inga resor klarade dina krav på budget och tider. Prova att höja budgeten eller vidga tidsfönstret.'
        : `Bara ${kept.length} resa/resor klarade dina krav. Prova att höja budgeten eller vidga tidsfönstret.`,
    );
  }

  /* 3. Väder (påverkar redaktörens bedömning) --------------------------- */
  onProgress('weather', `Hämtar väderprognos för ${kept.length} destinationer …`);
  await Promise.all(kept.map(async (cand) => {
    const from = legTimes(cand.outbound).arr || c.earliestDeparture;
    const to = legTimes(cand.inbound).dep || c.latestReturn;
    cand.weather = await weather.forecastFor(cand.destination, cand.country, from, to);
  }));

  /* 4. Travel Editor ---------------------------------------------------- */
  onProgress('editor', 'Väger samman flyg, hotell, väder och events …');

  const editorial = await ai.runJson({
    prompt: buildEditorPrompt(c, kept),
    schema: editorSchema,
    tools: [],
    timeoutMs: EDITOR_TIMEOUT_MS,
    onProgress: (msg) => onProgress('editor', msg),
  });

  diagnostics.costUsd += editorial.meta.costUsd || 0;
  diagnostics.editorNote = editorial.data.editorNote || null;

  const byId = new Map(kept.map((x) => [String(x.id), x]));
  const picks = (editorial.data.trips || [])
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .map((pick) => {
      const base = byId.get(String(pick.id));
      if (!base) return null;
      return { base, pick };
    })
    .filter(Boolean);

  // Om redaktören råkade peka på ett okänt id – fyll på med kvarvarande kandidater.
  if (picks.length < 3) {
    for (const cand of kept) {
      if (picks.length >= 3) break;
      if (picks.some((p) => p.base.id === cand.id)) continue;
      picks.push({
        base: cand,
        pick: {
          id: cand.id,
          rank: picks.length + 1,
          label: 'Också värd att kolla',
          aiScore: null,
          tagline: cand.styleMatch?.comment?.slice(0, 70) || '',
          why: cand.styleMatch?.comment || 'Klarar dina krav på budget och tider.',
          plan: [],
        },
      });
    }
  }

  const trips = picks.slice(0, 3);

  /* 5. Bilder (bara för de tre som visas) ------------------------------- */
  onProgress('images', 'Hämtar destinationsbilder …');
  await Promise.all(trips.map(async (t) => {
    t.image = await images.forDestination(t.base.destination, t.base.country);
  }));

  return {
    criteria: {
      origin: c.origin,
      earliestDeparture: c.earliestDeparture.toISOString(),
      latestReturn: c.latestReturn.toISOString(),
      earliestDepartureText: formatSwedishDateTime(c.earliestDeparture),
      latestReturnText: formatSwedishDateTime(c.latestReturn),
      budgetSek: c.budgetSek,
      region: c.region,
      styles: c.styles,
      preferDirect: c.preferDirect,
    },
    trips: trips.map((t, i) => shapeTrip(t.base, t.pick, i + 1)),
    diagnostics,
  };
}

/** Slår ihop research-fakta och redaktörens bedömning till det frontend visar. */
function shapeTrip(base, pick, rank) {
  const { dep: outDep, arr: outArr } = legTimes(base.outbound);
  const { dep: inDep, arr: inArr } = legTimes(base.inbound);

  return {
    id: base.id,
    rank,
    label: pick.label || null,
    aiScore: Number.isFinite(num(pick.aiScore)) ? Math.round(num(pick.aiScore)) : null,
    tagline: pick.tagline || null,
    why: pick.why || null,
    plan: Array.isArray(pick.plan) ? pick.plan : [],

    destination: base.destination,
    country: base.country,
    airportCode: base.airportCode || null,
    image: base.image || null,

    nights: Number.isFinite(num(base.nights)) ? num(base.nights) : null,
    totalPriceSek: Number.isFinite(num(base.totalPriceSek)) ? num(base.totalPriceSek) : null,
    flightPriceSek: Number.isFinite(num(base.flightPriceSek)) ? num(base.flightPriceSek) : null,
    flightPriceConfidence: base.flightPriceConfidence || 'unknown',
    flightPriceSource: base.flightPriceSource || null,

    hotel: base.hotel || null,

    isDirect: Boolean(base.isDirect),
    totalTravelTimeMinutes: base.totalTravelTimeMinutes ?? null,
    timeAtDestinationHours: base.timeAtDestinationHours ?? null,

    outbound: {
      ...base.outbound,
      departText: formatSwedishDateTime(outDep),
      arriveText: formatSwedishDateTime(outArr),
    },
    inbound: {
      ...base.inbound,
      departText: formatSwedishDateTime(inDep),
      arriveText: formatSwedishDateTime(inArr),
    },

    weather: base.weather || { available: false, summary: 'Prognos saknas', days: [] },
    styleMatch: base.styleMatch || null,
    highlights: base.highlights || [],
    restaurants: base.restaurants || [],
    events: base.events || [],
    sources: base.sources || [],
    uncertainties: base.uncertainties || [],
  };
}

module.exports = {
  findTrips,
  normalizeCriteria,
  enforceHardConstraints,
  buildResearchPrompt,
  buildEditorPrompt,
  ValidationError,
  STYLE_LABELS,
  _internals: { parseLocal, combine, legTimes, formatSwedishDateTime, num },
};
