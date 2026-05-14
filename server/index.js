import express from 'express';
import { readFile, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const RIG_TIMEOUT_MS = 5000;
const CONTENT_TIMEOUT_MS = 15000;
const INTRO_DIR = join(__dirname, 'data', 'intro');
const MAX_INTRO_VIDEO_BYTES = 500 * 1024 * 1024; // 500 MB

const VIDEO_MIME_TO_EXT = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov'
};
const EXT_TO_MIME = Object.fromEntries(Object.entries(VIDEO_MIME_TO_EXT).map(([m, e]) => [e, m]));

const app = express();
// IMPORTANT: express.json only parses application/json, so video uploads
// (Content-Type: video/*) bypass it and we can stream their bodies to disk.
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(__dirname, 'public')));

async function loadJson(relPath) {
  return JSON.parse(await readFile(join(__dirname, relPath), 'utf8'));
}

async function findRig(rigId) {
  const rigs = await loadJson('config/rigs.json');
  return rigs.find(r => r.id === rigId);
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = RIG_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function proxyToRig(rigId, path, opts = {}, timeoutMs = RIG_TIMEOUT_MS) {
  const rig = await findRig(rigId);
  if (!rig) return { status: 404, body: { ok: false, error: `unknown rig: ${rigId}` } };
  try {
    const r = await fetchWithTimeout(`${rig.baseUrl}${path}`, opts, timeoutMs);
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body, rig };
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'rig agent timeout' : err.message;
    return { status: 502, body: { ok: false, error: `failed to reach rig: ${reason}` }, rig };
  }
}

app.get('/api/rigs', async (_req, res) => {
  res.json(await loadJson('config/rigs.json'));
});

app.get('/api/rigs/:id/health', async (req, res) => {
  const { status, body } = await proxyToRig(req.params.id, '/health');
  res.status(status === 502 ? 200 : status).json(status === 502 ? { ok: false, ...body } : body);
});

app.get('/api/rigs/:id/status', async (req, res) => {
  const { status, body } = await proxyToRig(req.params.id, '/status');
  res.status(status).json(body);
});

app.post('/api/rigs/:id/stop', async (req, res) => {
  const { status, body } = await proxyToRig(req.params.id, '/stop', { method: 'POST' });
  res.status(status).json(body);
});

app.post('/api/rigs/:id/clear-cache', async (req, res) => {
  const { status, body } = await proxyToRig(req.params.id, '/clear-cache', { method: 'POST' });
  res.status(status).json(body);
});

// Content is sourced from a rig (defaults to first reachable one in rigs.json).
// Override per-request with ?source=<rigId>. Cached on the server too.
let serverContentCache = { sourceRigId: null, content: null, fetchedAt: 0 };
const SERVER_CACHE_MS = 60_000;

async function pickContentSource(preferredId) {
  const rigs = await loadJson('config/rigs.json');
  if (preferredId) {
    const r = rigs.find(r => r.id === preferredId);
    if (r) return r;
  }
  return rigs[0];
}

app.get('/api/content', async (req, res) => {
  const refresh = req.query.refresh === 'true' || req.query.refresh === '1';
  const preferred = req.query.source;
  const now = Date.now();

  if (!refresh && !preferred && serverContentCache.content && now - serverContentCache.fetchedAt < SERVER_CACHE_MS) {
    return res.json({ ...serverContentCache.content, cached: true });
  }

  const rig = await pickContentSource(preferred);
  if (!rig) return res.status(503).json({ ok: false, error: 'no rigs configured' });

  try {
    const url = `${rig.baseUrl}/content${refresh ? '?refresh=true' : ''}`;
    const r = await fetchWithTimeout(url, {}, CONTENT_TIMEOUT_MS);
    const body = await r.json();
    if (!r.ok) return res.status(r.status).json(body);
    serverContentCache = { sourceRigId: rig.id, content: body, fetchedAt: now };
    res.json({ ...body, source: { rigId: rig.id, rigName: rig.name } });
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'content scan timed out' : err.message;
    res.status(502).json({ ok: false, error: `content fetch failed: ${reason}` });
  }
});

// ---------- Multiplayer ----------

app.get('/api/servers', async (_req, res) => {
  try {
    res.json(await loadJson('config/servers.json'));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Cache server INFO probes briefly so flipping the dropdown doesn't hammer servers.
const serverInfoCache = new Map(); // serverId -> { fetchedAt, body }
const SERVER_INFO_CACHE_MS = 30_000;
const SERVER_INFO_TIMEOUT_MS = 3000;

app.get('/api/servers/:id/info', async (req, res) => {
  const servers = await loadJson('config/servers.json');
  const server = servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ reachable: false, error: 'unknown server' });

  const cached = serverInfoCache.get(server.id);
  if (cached && Date.now() - cached.fetchedAt < SERVER_INFO_CACHE_MS) {
    return res.json(cached.body);
  }

  if (!server.httpPort) {
    return res.json({ reachable: false, reason: 'httpPort not configured' });
  }

  const url = `http://${server.host}:${server.httpPort}/INFO`;
  try {
    const r = await fetchWithTimeout(url, {}, SERVER_INFO_TIMEOUT_MS);
    const body = await r.json();
    const result = { reachable: true, ...body };
    serverInfoCache.set(server.id, { fetchedAt: Date.now(), body: result });
    res.json(result);
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : err.message;
    const result = { reachable: false, reason };
    serverInfoCache.set(server.id, { fetchedAt: Date.now(), body: result });
    res.json(result);
  }
});

app.post('/api/rigs/:id/join', async (req, res) => {
  const { status, body, rig } = await proxyToRig(req.params.id, '/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body ?? {})
  });
  res.status(status).json({ rig: rig ? { id: rig.id, name: rig.name } : null, ...body });
});

app.post('/api/join-all', async (req, res) => {
  const rigs = await loadJson('config/rigs.json');
  const results = await Promise.all(rigs.map(async (rig) => {
    try {
      const r = await fetchWithTimeout(`${rig.baseUrl}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body ?? {})
      });
      const body = await r.json().catch(() => ({}));
      return { rigId: rig.id, rigName: rig.name, ok: r.ok, status: r.status, ...body };
    } catch (err) {
      const reason = err.name === 'AbortError' ? 'rig agent timeout' : err.message;
      return { rigId: rig.id, rigName: rig.name, ok: false, error: reason };
    }
  }));
  res.json({ results });
});

app.post('/api/launch', async (req, res) => {
  const { rigId, ...payload } = req.body ?? {};
  if (!rigId) return res.status(400).json({ ok: false, error: 'rigId is required' });
  if (!payload.carId || !payload.trackId) {
    return res.status(400).json({ ok: false, error: 'carId and trackId are required' });
  }

  const { status, body, rig } = await proxyToRig(rigId, '/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  res.status(status).json({
    rig: rig ? { id: rig.id, name: rig.name } : null,
    ...body
  });
});

// ---------- Intro video (central storage) ----------

async function findIntroFile() {
  try {
    const files = await readdir(INTRO_DIR);
    return files.find(f => f.startsWith('current.')) ?? null;
  } catch {
    return null;
  }
}

app.get('/api/intro/video/status', async (_req, res) => {
  const filename = await findIntroFile();
  if (!filename) return res.json({ exists: false });
  try {
    const s = await stat(join(INTRO_DIR, filename));
    const ext = filename.split('.').pop();
    res.json({
      exists: true,
      filename,
      size: s.size,
      contentType: EXT_TO_MIME[ext] ?? 'application/octet-stream',
      uploadedAt: s.mtime.toISOString()
    });
  } catch (err) {
    res.json({ exists: false, error: err.message });
  }
});

app.get('/api/intro/video', async (_req, res) => {
  const filename = await findIntroFile();
  if (!filename) return res.status(404).end();
  res.sendFile(join(INTRO_DIR, filename));
});

app.put('/api/intro/video', async (req, res) => {
  const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = VIDEO_MIME_TO_EXT[ct];
  if (!ext) {
    return res.status(415).json({
      ok: false,
      error: `unsupported content-type "${ct}"; expected one of ${Object.keys(VIDEO_MIME_TO_EXT).join(', ')}`
    });
  }
  const declaredLen = Number(req.headers['content-length'] || 0);
  if (declaredLen > MAX_INTRO_VIDEO_BYTES) {
    return res.status(413).json({ ok: false, error: `file too large (max ${MAX_INTRO_VIDEO_BYTES} bytes)` });
  }

  await mkdir(INTRO_DIR, { recursive: true });
  // Remove any existing intro before writing the new one.
  for (const f of await readdir(INTRO_DIR).catch(() => [])) {
    if (f.startsWith('current.')) await unlink(join(INTRO_DIR, f)).catch(() => {});
  }

  const target = join(INTRO_DIR, `current.${ext}`);
  let received = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_INTRO_VIDEO_BYTES) {
      aborted = true;
      req.destroy();
    }
  });

  try {
    await pipeline(req, createWriteStream(target));
    if (aborted) {
      await unlink(target).catch(() => {});
      return res.status(413).json({ ok: false, error: 'file exceeded size limit during upload' });
    }
    const s = await stat(target);
    console.log(`[server] intro video saved: ${target} (${s.size} bytes)`);
    res.json({ ok: true, filename: `current.${ext}`, size: s.size, contentType: ct });
  } catch (err) {
    await unlink(target).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/intro/video', async (_req, res) => {
  try {
    for (const f of await readdir(INTRO_DIR).catch(() => [])) {
      if (f.startsWith('current.')) await unlink(join(INTRO_DIR, f));
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Intro orchestration ----------

function randomJobId() {
  return Math.random().toString(36).slice(2, 10);
}

app.post('/api/play-then-launch', async (req, res) => {
  const { rigId, ...payload } = req.body ?? {};
  if (!rigId) return res.status(400).json({ ok: false, error: 'rigId is required' });
  if (!payload.carId || !payload.trackId) {
    return res.status(400).json({ ok: false, error: 'carId and trackId are required' });
  }

  const rig = await findRig(rigId);
  if (!rig) return res.status(404).json({ ok: false, error: `unknown rig: ${rigId}` });

  const jobId = randomJobId();
  const centralBase = `${req.protocol}://${req.get('host')}`;
  const kioskUrl = `${centralBase}/intro.html?job=${jobId}&rig=${encodeURIComponent(rigId)}`;

  const { status, body } = await proxyToRig(rigId, '/play-then-launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, jobId, kioskUrl })
  });

  res.status(status).json({
    rig: { id: rig.id, name: rig.name },
    jobId,
    kioskUrl,
    ...body
  });
});

app.post('/api/intro-done', async (req, res) => {
  const { jobId, rigId, reason } = req.body ?? {};
  if (!jobId || !rigId) {
    return res.status(400).json({ ok: false, error: 'jobId and rigId are required' });
  }
  const { status, body } = await proxyToRig(rigId, '/intro/done', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, reason })
  });
  res.status(status).json(body);
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
