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
    // Permit unmuted autoplay so the intro video starts immediately without
    // the browser's "user gesture required" policy blocking it on frame 1.
    '--autoplay-policy=no-user-gesture-required',
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
// The central server owns the intro UI: it serves the HTML page and stores the
// video. The agent only spawns the kiosk browser at the server-provided URL
// and waits for the eventual /intro/done callback (which the server forwards).

app.post('/play-then-launch', async (req, res) => {
  const { payload, jobId, kioskUrl } = req.body ?? {};
  if (!payload?.carId || !payload?.trackId) {
    return res.status(400).json({ ok: false, error: 'payload.carId and payload.trackId are required' });
  }
  if (!jobId || !kioskUrl) {
    return res.status(400).json({ ok: false, error: 'jobId and kioskUrl are required (call via the central server)' });
  }
  try {
    const browserChild = await spawnKioskBrowser(kioskUrl);
    introJobs.set(jobId, { payload, browserChild, createdAt: Date.now() });
    console.log(`[agent] intro job ${jobId} started; will launch ${payload.carId}@${payload.trackId} on completion`);
    res.json({ ok: true, jobId, kioskUrl });
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
