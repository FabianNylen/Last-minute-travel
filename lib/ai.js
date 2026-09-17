'use strict';

/**
 * AI-adapter.
 * ---------------------------------------------------------------------------
 * Detta är det ENDA stället i appen som vet *hur* vi pratar med en AI-modell.
 * Resten av koden anropar bara `runJson()` och får tillbaka validerad JSON.
 *
 * Just nu: lokalt installerad och redan autentiserad Claude Code CLI i
 * headless-läge (`claude -p`).
 *
 * Byta till Anthropic/OpenAI API senare:
 *   Skriv en ny funktion med samma signatur som `runJson()` och peka
 *   `PROVIDERS` på den. Inget annat i projektet behöver ändras.
 *   Se README.md ("Byta AI-motor").
 * ---------------------------------------------------------------------------
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'sonnet';
// En full research kostade ca 5 USD i test (67 webbsökningar). Taket ska ge
// marginal så att researchen inte kapas mitt i och ger färre kandidater.
const MAX_BUDGET_USD = Number(process.env.AI_MAX_BUDGET_USD || 12);
const PROVIDER = process.env.AI_PROVIDER || 'claude-cli';

/**
 * Alla nästlade CLI-processer som är igång just nu.
 * Servern kan leva länge och en research tar minuter — dör servern ska inte
 * en föräldralös CLI-process fortsätta söka (och kosta pengar) i bakgrunden.
 */
const activeChildren = new Set();

/** Dödar en process och hela dess processgrupp (CLI:n startar egna underprocesser). */
function killTree(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');   // hela gruppen
  } catch {
    try { child.kill('SIGKILL'); } catch { /* redan död */ }
  }
}

/** Avbryter alla pågående AI-anrop. Anropas när servern stängs. */
function shutdown() {
  for (const child of activeChildren) killTree(child);
  activeChildren.clear();
}

class AiError extends Error {
  constructor(message, { code = 'ai_error', detail = null } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Isolerad arbetskatalog för CLI:n.
 * Gör att den nästlade Claude-processen inte plockar upp projektets egen
 * CLAUDE.md, git-status eller andra filer som skulle förorena prompten.
 */
let cachedWorkdir = null;
function isolatedWorkdir() {
  if (cachedWorkdir && fs.existsSync(cachedWorkdir)) return cachedWorkdir;
  cachedWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekendkurator-ai-'));
  return cachedWorkdir;
}

/**
 * Plockar ut ett JSON-objekt ur en textsträng.
 * Modellen ska tack vare --json-schema svara med ren JSON, men vi är defensiva:
 * kodstaket och omkringliggande prat ska inte krascha appen.
 */
function parseJsonLoose(text) {
  if (text == null) throw new AiError('Tomt svar från AI:n.', { code: 'empty_response' });
  if (typeof text === 'object') return text;

  let s = String(text).trim();
  if (!s) throw new AiError('Tomt svar från AI:n.', { code: 'empty_response' });

  // Ta bort ```json ... ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  try {
    return JSON.parse(s);
  } catch {
    // Sista utvägen: klipp ut största {...} eller [...]
    const start = s.search(/[{[]/);
    const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch { /* faller igenom */ }
    }
    throw new AiError('AI:n svarade inte med giltig JSON.', {
      code: 'invalid_json',
      detail: s.slice(0, 500),
    });
  }
}

/** Kort, mänsklig beskrivning av ett verktygsanrop — används för live-status i UI:t. */
function describeToolUse(name, input) {
  const q = input && (input.query || input.prompt || input.url);
  if (name === 'WebSearch' && q) return `Söker: ${String(q).slice(0, 90)}`;
  if (name === 'WebFetch' && q) return `Läser källa: ${String(q).slice(0, 90)}`;
  if (name === 'StructuredOutput') return 'Sammanställer resultatet';
  return null;
}

/**
 * Kör Claude Code CLI i headless-läge och returnerar parsad JSON.
 *
 * @param {object}   opts
 * @param {string}   opts.prompt      Användarprompten (skickas via stdin).
 * @param {object}  [opts.schema]     JSON Schema som modellen tvingas följa.
 * @param {string}  [opts.system]     Extra systemprompt.
 * @param {string[]}[opts.tools]      Tillåtna verktyg, t.ex. ['WebSearch','WebFetch'].
 * @param {number}  [opts.timeoutMs]  Hård timeout.
 * @param {function}[opts.onProgress] Callback(text) för live-status.
 * @returns {Promise<{data: any, meta: object}>}
 */
function runClaudeCli({
  prompt,
  schema = null,
  system = null,
  tools = [],
  timeoutMs = 6 * 60 * 1000,
  onProgress = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',                       // krävs för stream-json med -p
      '--model', CLAUDE_MODEL,
      '--restricted',                    // ingen Bash/Edit/Write i den nästlade processen
      '--permission-prompts', 'none',    // får aldrig fastna på en behörighetsfråga
      '--no-session-persistence',
      '--max-budget-usd', String(MAX_BUDGET_USD),
    ];
    if (tools.length) args.push('--allowedTools', tools.join(','));
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    if (system) args.push('--append-system-prompt', system);

    let child;
    try {
      child = spawn(CLAUDE_BIN, args, {
        cwd: isolatedWorkdir(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        detached: true,   // egen processgrupp -> går att döda med allt den startat
      });
      activeChildren.add(child);
    } catch (err) {
      return reject(new AiError(
        `Kunde inte starta Claude CLI ("${CLAUDE_BIN}"). Är den installerad och inloggad?`,
        { code: 'cli_missing', detail: err.message },
      ));
    }

    let settled = false;
    let stdoutBuf = '';
    let stderrBuf = '';
    let resultPayload = null;
    let resultIsError = false;
    let lastText = '';
    const meta = { toolCalls: 0, webSearches: 0, costUsd: null, durationMs: null, turns: null };

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const timer = setTimeout(() => {
      killTree(child);
      finish(reject, new AiError(
        `AI-anropet tog för lång tid (över ${Math.round(timeoutMs / 1000)} s).`,
        { code: 'timeout' },
      ));
    }, timeoutMs);

    const handleEvent = (evt) => {
      if (!evt || typeof evt !== 'object') return;

      if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
        for (const block of evt.message.content) {
          if (block.type === 'tool_use') {
            meta.toolCalls += 1;
            if (block.name === 'WebSearch') meta.webSearches += 1;
            const msg = describeToolUse(block.name, block.input);
            if (msg && onProgress) onProgress(msg);
          } else if (block.type === 'text' && block.text && block.text.trim()) {
            lastText = block.text;
          }
        }
        return;
      }

      if (evt.type === 'result') {
        resultIsError = Boolean(evt.is_error);
        resultPayload = evt.result;
        meta.costUsd = evt.total_cost_usd ?? null;
        meta.durationMs = evt.duration_ms ?? null;
        meta.turns = evt.num_turns ?? null;
        // Riktiga websökningar görs av en delmodell — räkna ihop dem.
        const usage = evt.modelUsage || {};
        const counted = Object.values(usage)
          .reduce((sum, m) => sum + (m.webSearchRequests || 0), 0);
        if (counted) meta.webSearches = counted;
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        try { handleEvent(JSON.parse(line)); } catch { /* ofullständig/okänd rad */ }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuf = (stderrBuf + chunk).slice(-4000);
    });

    child.on('error', (err) => {
      activeChildren.delete(child);
      finish(reject, new AiError(
        `Kunde inte köra Claude CLI ("${CLAUDE_BIN}").`,
        { code: 'cli_missing', detail: err.message },
      ));
    });

    child.on('close', (code) => {
      activeChildren.delete(child);
      // Sista raden kan sakna radbrytning.
      const tail = stdoutBuf.trim();
      if (tail) { try { handleEvent(JSON.parse(tail)); } catch { /* ignoreras */ } }

      if (resultIsError) {
        return finish(reject, new AiError('AI:n avbröt anropet.', {
          code: 'ai_refused',
          detail: String(resultPayload || stderrBuf).slice(0, 500),
        }));
      }
      if (code !== 0 && resultPayload == null) {
        return finish(reject, new AiError(
          `Claude CLI avslutades med kod ${code}.`,
          { code: 'cli_failed', detail: stderrBuf.slice(0, 500) },
        ));
      }

      try {
        const data = parseJsonLoose(resultPayload ?? lastText);
        finish(resolve, { data, meta });
      } catch (err) {
        finish(reject, err);
      }
    });

    child.stdin.on('error', () => { /* processen kan ha dött redan */ });
    child.stdin.end(prompt, 'utf8');
  });
}

/** Kollar att CLI:n finns och går att köra. */
function checkClaudeCli(timeoutMs = 15000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(CLAUDE_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve({ ok: false, reason: `Hittade inte "${CLAUDE_BIN}" i PATH.` });
    }
    let out = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      resolve({ ok: false, reason: 'Claude CLI svarade inte.' });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `Hittade inte "${CLAUDE_BIN}" i PATH.` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, version: out.trim() });
      else resolve({ ok: false, reason: `Claude CLI gav felkod ${code}.` });
    });
  });
}

const PROVIDERS = {
  'claude-cli': { runJson: runClaudeCli, health: checkClaudeCli },
  // 'anthropic-api': { runJson: runAnthropicApi, health: ... },   <-- framtid
  // 'openai-api':    { runJson: runOpenAiApi,    health: ... },   <-- framtid
};

function provider() {
  const p = PROVIDERS[PROVIDER];
  if (!p) throw new AiError(`Okänd AI_PROVIDER: "${PROVIDER}".`, { code: 'bad_provider' });
  return p;
}

module.exports = {
  AiError,
  providerName: PROVIDER,
  model: CLAUDE_MODEL,
  runJson: (opts) => provider().runJson(opts),
  health: (ms) => provider().health(ms),
  parseJsonLoose,
  shutdown,
};
