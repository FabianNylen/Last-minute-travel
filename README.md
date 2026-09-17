# Weekendkurator

AI-driven sista minuten-reseplattform. Du säger när du kan åka och vad du får spendera —
appen researchar på riktigt och presenterar **de tre resor som faktiskt är värda att boka**.

Billigast vinner inte automatiskt. En dyrare Berlinresa kan rankas över en billigare
Gdańskresa om flygtider, hotell, väder, events och helheten är bättre.

Allt gränssnitt och all text är på svenska.

---

## Kom igång

**Förutsättningar**

- Node.js 20 eller senare (utvecklad på Node 22)
- [Claude Code CLI](https://claude.com/claude-code) installerad och **inloggad**
  (appen använder din befintliga inloggning — ingen API-nyckel behövs)

Kontrollera att CLI:n fungerar:

```bash
claude --version
```

**Starta**

```bash
npm start
```

Öppna sedan <http://127.0.0.1:3000>.

Inga npm-beroenden behöver installeras — projektet använder bara Node:s inbyggda moduler.

---

## Testfall

Prova med:

| Fält | Värde |
| --- | --- |
| Från | Göteborg |
| Tidigaste avresa | närmaste fredag, 16:00 |
| Senast hemma | söndagen efter, 20:00 |
| Budget | 6 000 kr |
| Resestil | City, Mat, Nattliv |
| Land / region | tomt (var som helst) |

En sökning tar **6–12 minuter** och kostar några dollar i API-användning. AI:n gör
riktiga webbsökningar för varje destination — flyg, hotell och events — och du ser
sökningarna live medan de pågår.

I en testkörning från Göteborg (fredag 16:00 → söndag 20:00, 6 000 kr, city/mat/nattliv)
gjorde researchen **67 webbsökningar** på knappt 12 minuter och landade i Riga, Budapest
och Köpenhamn — alla inom budget och tidsfönster, alla med källor och uppskattade priser
tydligt märkta.

---

## Så fungerar det

Två AI-steg, medvetet åtskilda:

**1. Researcher** — söker brett på webben och tar fram 8–15 realistiska alternativ:
flyg och flygtider, direkt eller mellanlandning, restid, användbar tid på plats,
flygpris, hotellpris, hotellkvalitet och läge, väder, restauranger, nattliv, kultur,
aktuella events och matchning mot resestilen.

**2. Travel Editor** — får kandidaterna (inklusive väderprognosen) och väljer ut
exakt tre resor, rangordnar dem efter total reseupplevelse, sätter AI-score 0–100,
en label (t.ex. *Bäst totalt*, *Mest prisvärd*, *Bäst för mat*) och skriver en lätt
weekendplan.

Det finns **ingen deterministisk poängformel**. Rangordningen är AI:ns mänskliga
bedömning — precis som en kunnig reseredaktör hade gjort den.

### Hårda krav ligger i koden, inte i prompten

Budget, tidigaste avresa och senaste hemkomst kontrolleras **deterministiskt i
`lib/travel.js`** (`enforceHardConstraints`) efter att AI:n svarat. En kandidat som
bryter mot något av dem kastas bort innan redaktören ens ser den. En AI-miss kan
alltså aldrig leda till att en resa utanför dina krav visas.

En kandidat vars totalpris inte gick att fastställa kastas också bort — går priset
inte att verifiera kan budgeten inte garanteras.

### Inga påhittade uppgifter

Prompten förbjuder AI:n att hitta på priser, flygtider, hotell eller events.
Går något inte att verifiera ska det märkas, inte gissas. Varje pris bär en
konfidensnivå som visas i gränssnittet:

| Nivå | Visas som |
| --- | --- |
| `verified` | siffran, utan markering |
| `estimated` | siffran + **Uppskattat** |
| `unknown` | **Ej bekräftat** / **Uppgift saknas** |

Saknade värden visas aldrig som `0 kr`. Osäkerheter listas dessutom explicit längst
ned i detaljvyn, och källänkar följer med varje resa.

Genom hela resultatet står:
*Priser och tillgänglighet kan ändras snabbt. Kontrollera alltid slutpriset hos
bokningsleverantören.*

---

## Filstruktur

```text
server.js            HTTP-server, SSE-ström, statiska filer, PAYWALL_ENABLED
lib/ai.js            AI-adapter — enda stället som vet hur vi pratar med modellen
lib/travel.js        Tvåstegsflödet, prompterna och de hårda kraven
lib/schemas.js       JSON Schemas som AI:ns svar valideras mot
lib/weather.js       Open-Meteo
lib/images.js        Destinationsbilder från gratiskällor
public/index.html    Markup
public/styles.css    Design
public/app.js        Frontendlogik
scripts/smoke.js     Tester som inte kräver AI-anrop
```

Sökningen körs som ett jobb med en **SSE-ström** (`/api/search/:id/events`) istället för
ett långt POST-svar — annars hade webbläsaren timeat ut under researchen, och du hade
inte sett något hända på flera minuter.

---

## Byta AI-motor

`lib/ai.js` är den enda filen som känner till Claude CLI. Den exponerar:

```js
runJson({ prompt, schema, tools, timeoutMs, onProgress }) // -> { data, meta }
```

För att byta till Anthropic- eller OpenAI-API senare: skriv en funktion med samma
signatur, registrera den i `PROVIDERS` och sätt `AI_PROVIDER`. Inget annat i projektet
behöver ändras — resten av koden vet inte vilken modell som svarar.

Under huven körs CLI:n headless med `--output-format stream-json` (för live-status),
`--json-schema` (så att svaret alltid är giltig JSON), `--restricted` (den nästlade
processen får inte köra kommandon) och en isolerad arbetskatalog.

---

## Betalning

Inte implementerad. `server.js` har flaggan:

```js
const PAYWALL_ENABLED = false;
```

Sätts den till `true` svarar `/api/search` med `402 Payment Required`, så att
Stripe och Swish senare kan läggas framför sökningen.

---

## Miljövariabler

Alla är frivilliga.

| Variabel | Standard | Beskrivning |
| --- | --- | --- |
| `PORT` | `3000` | Port |
| `HOST` | `127.0.0.1` | Bind-adress |
| `CLAUDE_BIN` | `claude` | Sökväg till Claude CLI |
| `CLAUDE_MODEL` | `sonnet` | Modell |
| `AI_MAX_BUDGET_USD` | `12` | Kostnadstak per AI-anrop |
| `RESEARCH_TIMEOUT_MS` | `660000` | Timeout för researchsteget |
| `EDITOR_TIMEOUT_MS` | `300000` | Timeout för redaktörssteget |
| `UNSPLASH_ACCESS_KEY` | — | Ger snyggare bilder om du har en nyckel |

---

## Datakällor

- **Väder** — [Open-Meteo](https://open-meteo.com/), ingen nyckel. Prognos ges ca 16 dagar
  framåt; ligger resan längre bort visas det tydligt istället för att gissas.
- **Bilder** — Wikipedia, med Openverse som reserv. Ingen nyckel. Hittas ingen bild
  ritas en gradient istället för en trasig bild. Unsplash används om nyckel finns.
- **Allt annat** (flyg, hotell, events) — AI:ns webbsökningar, med källänkar.

---

## Tester

```bash
npm run check   # syntaxkontroll av alla filer
npm run smoke   # validering + hårda krav, utan AI-anrop
```

`smoke.js` testar bland annat att resor över budget, för tidig avresa, för sen hemkomst
och okända priser alla kastas bort.

---

## Kända begränsningar

Det här är en MVP:

- Ingen databas, ingen inloggning, ingen bokning och ingen betalning.
- Flygtider och priser är research, inte bokningsbara offerter. Kontrollera alltid
  hos leverantören innan du bokar.
- En sökning tar 6–12 minuter och kostar några dollar, eftersom AI:n gör riktiga
  webbsökningar per destination. Sätt `AI_MAX_BUDGET_USD` lägre om du vill ha ett
  hårdare kostnadstak — researchen blir då mindre bred.
- Resultatet cachas inte mellan sökningar.
