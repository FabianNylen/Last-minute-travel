'use strict';

/**
 * Weekendkurator – liten Node-backend utan externa beroenden.
 *
 *   POST /api/search              -> startar en sökning, returnerar { jobId }
 *   GET  /api/search/:id/events   -> SSE med live-status och slutresultat
 *   GET  /api/health              -> kollar att Claude CLI finns
 *   GET  /*                       -> statiska filer från /public
 *
 * Sökningen tar flera minuter (AI:n gör riktig webbresearch), därför
 * körs den som ett jobb med en SSE-ström istället för ett långt POST-svar.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const travel = require('./lib/travel');
const ai = require('./lib/ai');

/** Betalning är inte implementerad ännu. Sätts till true när Stripe/Swish läggs framför sökningen. */
const PAYWALL_ENABLED = false;

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 16 * 1024;
const JOB_TTL_MS = 30 * 60 * 1000;

/* ------------------------------------------------------------------- jobb */

const jobs = new Map();

function createJob() {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: 'pending',      // pending | running | done | error
    events: [],
    result: null,
    error: null,
    createdAt: Date.now(),
    listeners: new Set(),
  };
  jobs.set(id, job);
  return job;
}

function emit(job, type, data) {
  const event = { type, data, at: Date.now() };
  job.events.push(event);
  for (const res of job.listeners) {
    writeEvent(res, event);
  }
}

function writeEvent(res, event) {
  try {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  } catch {
    // Klienten har kopplat ner.
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS && job.listeners.size === 0) jobs.delete(id);
  }
}, 5 * 60 * 1000).unref();

/* --------------------------------------------------------------- hjälpare */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Förfrågan är för stor.'), { code: 'too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Ogiltig JSON i förfrågan.'), { code: 'bad_json' }));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);

  // Ingen katalogtraversering.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403).end('Förbjudet');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Sidan finns inte.');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ------------------------------------------------------------ route: sök */

async function handleSearch(req, res) {
  if (PAYWALL_ENABLED) {
    return sendJson(res, 402, {
      error: 'payment_required',
      message: 'Sökningen kräver betalning.',
    });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.code || 'bad_request', message: err.message });
  }

  // Validera direkt så att användaren får formulärfel omedelbart, inte via SSE.
  // findTrips normaliserar igen internt — det här steget finns för snabb återkoppling.
  try {
    travel.normalizeCriteria(body);
  } catch (err) {
    if (err instanceof travel.ValidationError) {
      return sendJson(res, 400, { error: 'validation', message: err.message });
    }
    throw err;
  }

  const job = createJob();
  sendJson(res, 202, { jobId: job.id });

  // Kör i bakgrunden – klienten följer förloppet via SSE.
  job.status = 'running';
  travel.findTrips(body, (step, message) => {
    emit(job, 'progress', { step, message });
  })
    .then((result) => {
      job.status = 'done';
      job.result = result;
      emit(job, 'done', result);
      for (const r of job.listeners) { try { r.end(); } catch { /* noop */ } }
      job.listeners.clear();
    })
    .catch((err) => {
      job.status = 'error';
      const payload = friendlyError(err);
      job.error = payload;
      emit(job, 'failed', payload);
      for (const r of job.listeners) { try { r.end(); } catch { /* noop */ } }
      job.listeners.clear();
    });

}

/** Översätter interna fel till något en användare kan förstå. */
function friendlyError(err) {
  if (err instanceof travel.ValidationError) {
    return { error: 'validation', message: err.message };
  }
  if (err && err.name === 'AiError') {
    const map = {
      cli_missing: 'Hittar inte Claude Code CLI. Kontrollera att "claude" finns i din PATH och att du är inloggad.',
      cli_failed: 'Claude CLI avslutades med ett fel. Testa att köra "claude --version" i terminalen.',
      timeout: 'Researchen tog för lång tid. Prova igen, eller smalna av sökningen med ett land/region.',
      invalid_json: 'AI:n svarade i fel format. Prova att söka igen.',
      empty_response: 'AI:n gav inget svar. Prova att söka igen.',
      ai_refused: 'AI:n kunde inte slutföra researchen. Prova att söka igen.',
      bad_provider: 'AI-motorn är felkonfigurerad.',
    };
    return {
      error: err.code || 'ai_error',
      message: map[err.code] || 'Något gick fel i AI-researchen. Prova igen.',
      detail: err.detail || null,
    };
  }
  return {
    error: 'internal',
    message: 'Något gick fel. Prova igen om en liten stund.',
    detail: err && err.message ? String(err.message).slice(0, 300) : null,
  };
}

/* ----------------------------------------------------------- route: SSE */

function handleEvents(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job) {
    return sendJson(res, 404, { error: 'not_found', message: 'Sökningen hittades inte. Prova att söka igen.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': ansluten\n\n');

  // Spela upp det som redan hänt (klienten kan ha anslutit någon millisekund sent).
  for (const event of job.events) writeEvent(res, event);

  if (job.status === 'done' || job.status === 'error') {
    return res.end();
  }

  job.listeners.add(res);

  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* noop */ }
  }, 20000);

  const cleanup = () => {
    clearInterval(keepAlive);
    job.listeners.delete(res);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

/* --------------------------------------------------------------- server */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/api/search' && req.method === 'POST') {
    return handleSearch(req, res).catch((err) => {
      sendJson(res, 500, friendlyError(err));
    });
  }

  const eventsMatch = pathname.match(/^\/api\/search\/([\w-]+)\/events$/);
  if (eventsMatch && req.method === 'GET') {
    return handleEvents(req, res, eventsMatch[1]);
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    return ai.health().then((status) => {
      sendJson(res, 200, {
        ok: status.ok,
        provider: ai.providerName,
        model: ai.model,
        paywallEnabled: PAYWALL_ENABLED,
        ...(status.ok ? { version: status.version } : { reason: status.reason }),
      });
    }).catch(() => sendJson(res, 500, { ok: false }));
  }

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'not_found', message: 'Okänd endpoint.' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'method_not_allowed', message: 'Metoden stöds inte.' });
  }

  return serveStatic(req, res, pathname);
});

server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 65000;

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  Weekendkurator  ·  AI-driven sista minuten-research');
    console.log(`  Körs på        http://${HOST}:${PORT}`);
    console.log(`  AI-motor       ${ai.providerName} (${ai.model})`);
    console.log(`  Betalvägg      ${PAYWALL_ENABLED ? 'på' : 'av'}`);
    console.log('');
    ai.health().then((s) => {
      if (!s.ok) {
        console.warn(`  ⚠ Claude CLI verkar inte fungera: ${s.reason}`);
        console.warn('    Kör "claude --version" i terminalen för att felsöka.\n');
      } else {
        console.log(`  ✓ Claude CLI hittad: ${s.version}\n`);
      }
    });
  });
}

module.exports = { server, PAYWALL_ENABLED };
