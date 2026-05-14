import express from 'express';
import { readFile, writeFile, mkdir, access, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawn, exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { buildRaceIni } from './lib/raceIni.js';
import { scanContent } from './lib/contentScan.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadConfig() {
  const base = JSON.parse(await readFile(join(__dirname, 'config.json'), 'utf8'));
  try {
    const overrides = JSON.parse(await readFile(join(__dirname, 'config.local.json'), 'utf8'));
    console.log('[agent] config.local.json overrides applied');
    return { ...base, ...overrides };
  } catch {
    return base;
  }
}

const config = await loadConfig();
const PORT = config.agentPort ?? 3001;
const STEAM_APP_ID = '244210';

function resolveDriverName(override) {
  return override || config.driverName || `Rig ${PORT}`;
}

function resolveAcDocumentsPath() {
  if (config.acDocumentsPath) return config.acDocumentsPath;
  const userProfile = process.env.USERPROFILE;
  if (!userProfile) throw new Error('USERPROFILE not set; configure acDocumentsPath explicitly');
  return join(userProfile, 'Documents', 'Assetto Corsa');
}

async function fileExists(path) {
  try { await access(path, fsConstants.F_OK); return true; } catch { return false; }
}

async function ensureSteamAppId() {
  // Always rewrite to guarantee correct content — required for Steam-free launch.
  await writeFile(join(config.acInstallPath, 'steam_appid.txt'), STEAM_APP_ID, 'utf8');
}

async function steamAppIdOk() {
  try {
    const c = await readFile(join(config.acInstallPath, 'steam_appid.txt'), 'utf8');
    return c.trim() === STEAM_APP_ID;
  } catch { return false; }
}

async function isAcRunning() {
  try {
    const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq acs.exe" /NH');
    return /acs\.exe/i.test(stdout);
  } catch {
    return false;
  }
}

async function killAc() {
  try {
    await execAsync('taskkill /F /IM acs.exe');
    return true;
  } catch {
    return false;
  }
}

// In-memory session state. Resets on agent restart.
let lastSession = null;
let contentCache = null;

// Pending intro-then-launch jobs. jobId -> { payload, browserChild, createdAt }.
// Cleaned up by /intro/done; auto-expired after 10 min.
const introJobs = new Map();
const INTRO_JOB_EXPIRY_MS = 10 * 60 * 1000;

function randomJobId() {
  return Math.random().toString(36).slice(2, 10);
}

function pruneIntroJobs() {
  const cutoff = Date.now() - INTRO_JOB_EXPIRY_MS;
  for (const [id, job] of introJobs) {
    if (job.createdAt < cutoff) {
      try { job.browserChild?.kill(); } catch { /* nothing to do */ }
      introJobs.delete(id);
      console.log(`[agent] intro job ${id} expired`);
    }
  }
}
setInterval(pruneIntroJobs, 60_000).unref();

async function resolveKioskBrowser() {
  if (config.kioskBrowserPath) return config.kioskBrowserPath;
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];
  for (const c of candidates) {
    if (await fileExists(c)) return c;
  }
  return null;
}

async function spawnKioskBrowser(url) {
  const browserPath = await resolveKioskBrowser();
  if (!browserPath) throw new Error('no kiosk-capable browser found (set kioskBrowserPath in config)');
  const tempProfile = join(process.env.TEMP || process.env.USERPROFILE || __dirname, 'ac-intro-profile');
  const child = spawn(browserPath, [
    '--kiosk',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${tempProfile}`,
    url
  ], { detached: true, stdio: 'ignore' });
  child.on('error', (err) => console.error(`[agent] kiosk browser spawn error: ${err.message}`));
  child.unref();
  return child;
}

function killBrowserTree(pid) {
  if (!pid) return;
  exec(`taskkill /F /T /PID ${pid}`, () => { /* best effort */ });
}

async function getContent({ refresh } = {}) {
  if (!contentCache || refresh) {
    contentCache = await scanContent(config.acInstallPath);
    console.log(`[agent] content scanned: ${contentCache.cars.length} cars, ${contentCache.tracks.length} tracks`);
  }
  return contentCache;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (_req, res) => {
  const [acExists, steamFree, running] = await Promise.all([
    fileExists(join(config.acInstallPath, 'acs.exe')),
    steamAppIdOk(),
    isAcRunning()
  ]);
  res.json({
    ok: true,
    acInstallPath: config.acInstallPath,
    acExists,
    steamFree,
    running,
    driverName: resolveDriverName()
  });
});

app.get('/content', async (req, res) => {
  try {
    const refresh = req.query.refresh === 'true' || req.query.refresh === '1';
    const content = await getContent({ refresh });
    res.json(content);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/status', async (_req, res) => {
  const running = await isAcRunning();
  res.json({ ok: true, running, lastSession });
});

app.post('/stop', async (_req, res) => {
  const wasRunning = await isAcRunning();
  const killed = wasRunning ? await killAc() : false;
  res.json({ ok: true, wasRunning, killed });
});

app.post('/clear-cache', async (_req, res) => {
  try {
    const docsPath = resolveAcDocumentsPath();
    const cacheDir = join(docsPath, 'cache');
    const existed = await fileExists(cacheDir);
    if (existed) {
      await rm(cacheDir, { recursive: true, force: true });
      console.log(`[agent] cleared ${cacheDir}`);
    }
    res.json({ ok: true, cacheDir, cleared: existed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

async function writeIniAndSpawn(payload, logLabel) {
  const docsPath = resolveAcDocumentsPath();
  const cfgDir = join(docsPath, 'cfg');
  await mkdir(cfgDir, { recursive: true });

  const iniPath = join(cfgDir, 'race.ini');
  const iniContents = buildRaceIni(payload);
  await writeFile(iniPath, iniContents, 'utf8');
  console.log(`[agent] ${logLabel}`);

  await ensureSteamAppId();
  await killAc();

  const child = spawn(join(config.acInstallPath, 'acs.exe'), [], {
    cwd: config.acInstallPath,
    detached: true,
    stdio: 'ignore'
  });
  child.on('error', (err) => console.error(`[agent] spawn error: ${err.message}`));
  child.unref();

  lastSession = { ...payload, startedAt: new Date().toISOString(), raceIniPath: iniPath };
  return lastSession;
}

app.post('/launch', async (req, res) => {
  const payload = req.body ?? {};
  if (!payload.carId || !payload.trackId) {
    return res.status(400).json({ ok: false, error: 'carId and trackId are required' });
  }

  if ((payload.aiCount | 0) > 0) {
    try {
      const content = await getContent();
      const track = content.tracks.find(t => t.id === payload.trackId);
      const layout = track?.layouts.find(l => l.id === (payload.trackLayoutId ?? ''));
      if (track && layout && layout.aiSupported === false) {
        return res.status(400).json({
          ok: false,
          error: `Track "${track.name}${layout.id ? ' / ' + layout.name : ''}" has no AI line (ai/fast_lane.ai is missing). AC will crash if AI cars are spawned here. Set aiCount=0 or pick a different track.`
        });
      }
    } catch { /* fall through; agent will still try to launch */ }
  }

  try {
    const launched = await writeIniAndSpawn(payload,
      `launch: ${payload.carId} @ ${payload.trackId}${payload.trackLayoutId ? '/' + payload.trackLayoutId : ''} (${payload.mode ?? 'practice'})`);
    res.json({ ok: true, launched });
  } catch (err) {
    console.error(`[agent] launch failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Intro video flow ----------

const INTRO_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Loading…</title>
<style>
  html, body { margin:0; padding:0; background:#000; color:#fff; height:100vh; width:100vw; overflow:hidden; font-family:system-ui,sans-serif; cursor:none; }
  video { width:100%; height:100%; object-fit:contain; background:#000; }
  .placeholder {
    display:flex; align-items:center; justify-content:center; flex-direction:column;
    height:100vh; gap:24px;
  }
  .placeholder h1 { font-size:48px; margin:0; letter-spacing:0.06em; }
  .placeholder p { color:#888; margin:0; }
  .skip {
    position:fixed; top:24px; right:24px;
    padding:12px 22px;
    background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.25);
    color:#fff; font:14px system-ui; border-radius:8px;
    cursor:pointer; letter-spacing:0.05em;
  }
  .skip:hover { background:rgba(255,255,255,0.18); }
  .countdown { position:fixed; bottom:24px; left:24px; color:#666; font:12px ui-monospace,monospace; }
</style>
</head>
<body>
  <div id="root"></div>
  <button class="skip" onclick="finish('skip')">Skip ›</button>
  <div id="countdown" class="countdown"></div>
<script>
const params = new URLSearchParams(location.search);
const jobId = params.get('job');
let finished = false;

async function finish(reason) {
  if (finished) return;
  finished = true;
  try {
    await fetch('/intro/done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, reason })
    });
  } catch (err) {
    document.body.innerHTML = '<p style="padding:24px;color:#f87">Failed to notify agent: ' + err.message + '</p>';
  }
}

async function init() {
  const probe = await fetch('/intro/video', { method: 'HEAD' });
  const root = document.getElementById('root');
  if (probe.ok) {
    root.innerHTML = '<video id="v" src="/intro/video" autoplay></video>';
    const v = document.getElementById('v');
    v.addEventListener('ended', () => finish('ended'));
    v.addEventListener('error', () => placeholder());
    document.body.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') finish('skip');
    });
  } else {
    placeholder();
  }
}

function placeholder() {
  let remaining = 5;
  document.getElementById('root').innerHTML = \`
    <div class="placeholder">
      <h1>Intro video</h1>
      <p>No intro file configured on this rig.</p>
      <p style="font-size:12px;color:#555">Configure <code>introVideoPath</code> in the rig agent.</p>
    </div>\`;
  const tick = setInterval(() => {
    remaining--;
    document.getElementById('countdown').textContent = remaining > 0 ? \`auto-skip in \${remaining}s\` : '';
    if (remaining <= 0) {
      clearInterval(tick);
      finish('placeholder-timeout');
    }
  }, 1000);
}

init();
</script>
</body>
</html>`;

app.get('/intro/page', (_req, res) => {
  res.type('html').send(INTRO_HTML);
});

app.get('/intro/video', async (req, res) => {
  if (!config.introVideoPath || !(await fileExists(config.introVideoPath))) {
    return res.status(404).end();
  }
  res.sendFile(config.introVideoPath);
});

app.post('/play-then-launch', async (req, res) => {
  const payload = req.body ?? {};
  if (!payload.carId || !payload.trackId) {
    return res.status(400).json({ ok: false, error: 'carId and trackId are required' });
  }
  const jobId = randomJobId();
  try {
    const browserChild = await spawnKioskBrowser(`http://localhost:${PORT}/intro/page?job=${jobId}`);
    introJobs.set(jobId, { payload, browserChild, createdAt: Date.now() });
    console.log(`[agent] intro job ${jobId} started; will launch ${payload.carId}@${payload.trackId} on completion`);
    res.json({ ok: true, jobId });
  } catch (err) {
    console.error(`[agent] play-then-launch failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/intro/done', async (req, res) => {
  const { jobId, reason } = req.body ?? {};
  const job = introJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ ok: false, error: 'unknown or expired job' });
  }
  introJobs.delete(jobId);
  console.log(`[agent] intro job ${jobId} done (${reason ?? 'unknown'}); launching AC`);
  killBrowserTree(job.browserChild?.pid);

  try {
    const launched = await writeIniAndSpawn(job.payload,
      `launch (post-intro): ${job.payload.carId} @ ${job.payload.trackId}`);
    res.json({ ok: true, launched, reason });
  } catch (err) {
    console.error(`[agent] post-intro launch failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/join', async (req, res) => {
  const { carId, server, driverName } = req.body ?? {};
  if (!carId) return res.status(400).json({ ok: false, error: 'carId is required' });
  if (!server?.host || !server?.racePort) {
    return res.status(400).json({ ok: false, error: 'server.host and server.racePort are required' });
  }

  const finalDriverName = resolveDriverName(driverName);
  // AC needs a valid track in race.ini even for online, but the server overrides it
  // on connection. Use a stock track as a safe placeholder.
  const payload = {
    carId,
    trackId: 'magione',
    trackLayoutId: '',
    driverName: finalDriverName,
    online: {
      serverIp: server.host,
      serverPort: server.racePort,
      password: server.password ?? '',
      driverName: finalDriverName,
      requestedCar: carId,
      guid: ''
    }
  };

  try {
    const launched = await writeIniAndSpawn(payload,
      `join: ${finalDriverName} → ${server.host}:${server.racePort} as ${carId}`);
    res.json({ ok: true, launched });
  } catch (err) {
    console.error(`[agent] join failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`[agent] listening on http://localhost:${PORT}`);
  console.log(`[agent] AC install path: ${config.acInstallPath}`);
  try {
    await ensureSteamAppId();
    console.log(`[agent] steam_appid.txt in place — AC will launch without Steam`);
  } catch (err) {
    console.error(`[agent] WARNING: could not write steam_appid.txt: ${err.message}`);
  }
  // Warm the content cache in the background.
  getContent().catch(err => console.error(`[agent] initial scan failed: ${err.message}`));
});
