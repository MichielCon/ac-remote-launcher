import express from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const RIG_TIMEOUT_MS = 5000;
const CONTENT_TIMEOUT_MS = 15000;

const app = express();
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

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
