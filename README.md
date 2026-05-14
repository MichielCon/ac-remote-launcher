# AC Remote Launcher

A small web app for centrally controlling **Assetto Corsa** on a fleet of sim rigs. An operator opens a browser, picks a rig + car + track (or a saved multiplayer server), clicks a button — AC starts on the chosen rig with the chosen configuration. Multi-rig "send everyone to this server" is one click.

Built as a proof of concept / reference implementation. Minimal dependencies, no build step, no framework. The intent is for it to be readable end-to-end in an afternoon and easy to fold into a larger platform.

## Highlights

- **Auto-discovers installed content** on each rig (cars, tracks, layouts, skins, weather). No hardcoded lists.
- **Full session config**: practice / hotlap / race / time attack / drift, duration or laps, weather, time of day, ambient + road temp, wind, AI count / level / aggression, penalties, per-rig driver name.
- **Multiplayer auto-join**: saved server list, per-server `/INFO` probe (track + allowed cars + slots), one-click "send all rigs."
- **Live session controls**: stop AC, clear AC's cache directory, see what each rig is running.
- **Steam-free**: the rig agent writes `steam_appid.txt` next to `acs.exe`, so AC launches without a Steam client.
- **Safe by default**: an AI cars request on a track without an AI line gets rejected with a clear message instead of crashing AC.

## How it works

```
┌──────────────────────────┐         ┌────────────────────────┐
│  Operator desktop         │         │  Sim rig (1..N)         │
│ ────────────────────────  │  HTTP   │  ──────────────────────│
│  central server :3000     │ ──────► │  rig-agent :3001       │
│    Express + plain UI     │         │    Express             │
│    rigs.json              │         │      │                 │
│    servers.json           │         │      ▼                 │
│                           │         │  writes race.ini       │
│                           │         │  + spawns acs.exe      │
└──────────────────────────┘         │      │                 │
                                       │      ▼                 │
                                       │  Assetto Corsa         │
                                       └────────────────────────┘
                                            ↑ if multiplayer: connects to AC dedicated server
```

The rig agent writes a plain `race.ini` to `Documents\Assetto Corsa\cfg\race.ini` and spawns `acs.exe` directly — the same engine entry point Content Manager uses internally. No CM preset capture, no CM dependency at all. Field names follow `AcTools/Processes/Game.Properties.cs` in the [gro-ove/actools](https://github.com/gro-ove/actools) source.

For multiplayer, the same `race.ini` writer just appends a `[REMOTE]` section with `ACTIVE=1` and the server's `host:port`. Same launch pipeline either way.

## Quick start (single dev machine)

Prerequisites: **Node.js 20+**, Windows, an installed copy of Assetto Corsa.

```powershell
git clone <this-repo>
cd ac-remote-launcher
npm run install:all
```

Point the rig agent at your AC install — create `rig-agent/config.local.json`:

```json
{ "acInstallPath": "C:\\Path\\To\\assettocorsa" }
```

This file overrides `rig-agent/config.json` and is gitignored, so per-machine paths stay out of source control. If your AC is at the default Steam path (`C:\Program Files (x86)\Steam\steamapps\common\assettocorsa`), you can skip this step.

Then run:

```powershell
npm run dev
```

- Server listens on <http://localhost:3000>
- Rig agent listens on <http://localhost:3001>
- A `local` entry in `rigs.json` is pre-wired to `127.0.0.1:3001` for loopback testing

## Deploying to a real fleet

### Central server (operator desktop)

```powershell
npm --prefix server install
npm --prefix server start
```

Edit `server/config/rigs.json` to list your rigs by LAN IP. The rig entries you don't need can be removed.

### Per-rig install (one-time per rig)

1. Install **Node.js 20+** on the rig.
2. Copy the `rig-agent/` folder anywhere on the rig (e.g. `C:\ac-rig-agent\`).
3. `npm install` inside that folder.
4. If AC isn't at the default Steam path, create `rig-agent/config.local.json` and override `acInstallPath`.
5. `npm start` (or wrap as a Windows service / startup task for boot-time launch).
6. Verify from any other machine: `http://<rig-ip>:3001/health` should return
   ```json
   { "ok": true, "acExists": true, "steamFree": true, "running": false, "driverName": "Rig 3001" }
   ```

### Running rigs without Steam

The rig agent writes `steam_appid.txt` (containing `244210`) next to `acs.exe` on every launch. With that file present, AC runs standalone without a Steam client.

To prepare a no-Steam rig:
1. On a PC with AC installed via Steam, copy the entire `assettocorsa\` folder.
2. Drop that folder onto the rig at any path.
3. Point `acInstallPath` (in `config.local.json`) at it.
4. Start the agent. It writes `steam_appid.txt` on boot.
5. Confirm `"steamFree": true` in `/health`.

If you still see Steam appear on a rig, either Steam is configured to auto-start there, or an old wrong-content `steam_appid.txt` was on disk. The agent overwrites it on every launch — self-corrects after one click via the UI.

## Using the UI

Open <http://localhost:3000>. The page has five cards top-to-bottom:

1. **Rig** — click a rig to select it. Each rig shows a status dot (grey/green/blue/red) and badges for warnings ("AC not found", "Steam-free mode not active", "in session").
2. **Car** + **Track** — searchable lists populated from the source rig's installed content. Skin picker per car; layout picker per track (when the track has multiple).
3. **Session** — mode, duration or laps, weather, time of day, temps, wind, AI count/level/aggression, driver name, penalties.
4. **Multiplayer — join a race server** — server picker; if the server's HTTP port is configured and reachable, the card shows track + allowed-cars chips + slot count. Two buttons: **Join on selected rig** and **Send all rigs to this server**.
5. **Live session** — what's running on the selected rig (with car/track/mode/weather/AI breakdown and started-at time). Buttons: **Launch session**, **Stop AC**, **Clear cache**.

The **Refresh content** button in the top bar forces a re-scan on the source rig (useful after installing new mods).

## API reference

All endpoints return JSON. No auth (LAN-only).

### Server (`:3000`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`  | `/api/rigs` | List configured rigs (`rigs.json` content). |
| `GET`  | `/api/rigs/:id/health` | Per-rig health: `acExists`, `steamFree`, `running`, `driverName`. |
| `GET`  | `/api/rigs/:id/status` | What was last launched on this rig + whether `acs.exe` is currently running. |
| `POST` | `/api/rigs/:id/stop` | Kill AC on this rig. |
| `POST` | `/api/rigs/:id/clear-cache` | Delete `Documents\Assetto Corsa\cache` on this rig. |
| `GET`  | `/api/content` | Installed content (cars, tracks, weather), pulled from a rig and cached server-side. `?refresh=true` forces re-scan. `?source=<rigId>` selects a specific rig as the content source. |
| `POST` | `/api/launch` | Launch an offline session. See payload below. |
| `POST` | `/api/play-then-launch` | Same payload as `/api/launch`. Plays an intro video on the rig in a kiosk browser; AC launches when the video ends or the driver skips. |
| `GET`  | `/api/servers` | List saved AC dedicated servers (`servers.json` content). |
| `GET`  | `/api/servers/:id/info` | Probe `http://host:httpPort/INFO` (30 s cache, 3 s timeout). Returns `{ reachable: false, reason }` on failure. |
| `POST` | `/api/rigs/:id/join` | Join an AC dedicated server on this rig. See payload below. |
| `POST` | `/api/join-all` | Fan out a join to every rig in `rigs.json`. Returns per-rig results. |

### `POST /api/launch` body

```json
{
  "rigId": "rig-1",
  "carId": "ks_porsche_911_gt3_rs",
  "carSkin": "00_lava_orange",
  "trackId": "ks_silverstone",
  "trackLayoutId": "gp",
  "mode": "practice",
  "durationMinutes": 30,
  "laps": 5,
  "weather": "3_clear",
  "timeSeconds": 46800,
  "ambientTemp": 22,
  "roadTemp": 28,
  "windSpeedMinKmh": 0,
  "windSpeedMaxKmh": 0,
  "windDirectionDeg": 0,
  "aiCount": 0,
  "aiLevel": 90,
  "aiAggression": 50,
  "penalties": true,
  "driverName": "Driver"
}
```

Only `rigId`, `carId`, `trackId` are required. `mode` is one of `practice`, `hotlap`, `race`, `timeattack`, `drift`. For `race`, `laps` is used; for others, `durationMinutes`.

### `POST /api/rigs/:id/join` / `POST /api/join-all` body

```json
{
  "carId": "ks_porsche_911_gt3_rs",
  "server": {
    "host": "10.0.1.50",
    "racePort": 9600,
    "password": ""
  },
  "driverName": "Optional override"
}
```

The rig's own driver name (from its `config.local.json` or fallback) is used when `driverName` is omitted.

## Intro video before launch (optional)

The **Play intro video first** checkbox (next to the Launch button) makes the rig play a short video before AC starts. The video plays in a fullscreen kiosk browser on the rig; the driver can press Skip / Esc / Space / Enter at any time. When the video ends or is skipped, AC launches normally.

**How it works:** the agent stashes the launch payload, spawns `msedge.exe --kiosk` pointed at its own `/intro/page` URL, and waits. The page is just HTML + a `<video>` element fetching `/intro/video`. Skip click / video-end fires `POST /intro/done`, which kills the kiosk browser and runs the normal launch flow.

**Configure a video on a rig:**
```json
// rig-agent/config.json (or config.local.json)
{
  "introVideoPath": "C:\\path\\to\\intro.mp4",
  "kioskBrowserPath": null
}
```

- `introVideoPath` — absolute path to any HTML5-compatible file (MP4 / WebM / OGV). If unset or missing, the intro page shows a 5-second placeholder ("No intro file configured") and auto-skips. So leaving it `null` is a valid no-op default.
- `kioskBrowserPath` — defaults to Microsoft Edge (`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`) with Chrome fallback. Override if you've installed a browser elsewhere. If no browser is found, `/play-then-launch` returns a 500 with a clear message — uncheck the box to launch without intro.

**Lead-dev path forward:** this is intentionally a placeholder approach. The eventual plan is to **bake this into a bundled client** on each rig (Electron-style) with a local control socket that only accepts loopback commands. At that point, the agent's `/play-then-launch` + `/intro/*` endpoints become an internal call inside that client; the central server's API stays unchanged.

## Configuration reference

### `server/config/rigs.json`

```json
[
  { "id": "rig-1", "name": "Rig 1 (lounge)", "baseUrl": "http://192.168.1.50:3001" }
]
```

### `server/config/servers.json`

```json
[
  {
    "id": "aws-primary",
    "name": "AWS primary race server",
    "host": "10.0.1.50",
    "racePort": 9600,
    "httpPort": 8081,
    "password": "",
    "defaultCarId": "ks_porsche_911_gt3_rs"
  }
]
```

- `racePort` — AC dedicated-server TCP race port (default `9600`).
- `httpPort` — optional. AC servers expose JSON at `http://host:httpPort/INFO`. When set, the UI displays track + allowed cars + slots.
- `password` — `""` for open servers.
- `defaultCarId` — pre-selected in the UI's multiplayer car picker.

### `rig-agent/config.json` (+ `config.local.json` override)

```json
{
  "acInstallPath": "C:\\Program Files (x86)\\Steam\\steamapps\\common\\assettocorsa",
  "acDocumentsPath": null,
  "agentPort": 3001,
  "driverName": null,
  "introVideoPath": null,
  "kioskBrowserPath": null
}
```

- `acDocumentsPath: null` → resolves to `%USERPROFILE%\Documents\Assetto Corsa` at runtime.
- `driverName: null` → falls back to `"Rig <agentPort>"` (e.g. `Rig 3001`).
- Place per-machine overrides in `rig-agent/config.local.json` — it's gitignored and shallow-merged on top of `config.json` at agent startup.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Steam pops up on every launch | `steam_appid.txt` is missing or has wrong content. Agent rewrites it on every launch, but Steam may already be auto-running on the machine. For a clean rig, don't install Steam at all. |
| AC crashes shortly after the loading screen | Almost always a content/path mismatch. Check `Documents\Assetto Corsa\logs\log.txt`. Common: track layout id doesn't match the on-disk folder (the content scanner reads real folder names — don't hardcode). |
| Crash trace in `aispline.cpp` / `aidriver.cpp` | AI was spawned on a track without an AI line (`<layout>/ai/fast_lane.ai`). The UI disables AI on these tracks; the API returns 400 if you try anyway. |
| Weather dropdown does nothing in-game | Confirm `race.ini` has a `[WEATHER]` section with `NAME=<id>` — AC ignores `WEATHER=` inside `[TEMPERATURE]`. |
| Time-of-day slider does nothing | AC reads `[LIGHTING] SUN_ANGLE`, not `TIME`. The agent computes `SUN_ANGLE` from the requested time of day; valid range is roughly 07:00–19:00. |
| "fetch failed" on `/api/servers/:id/info` | Either `httpPort` isn't set or the AC server doesn't expose `/INFO`. UI falls back to listing the full installed car list — multiplayer join still works. |
| Multiplayer join lands the driver in the AC server browser instead of in-pit | Server probably has `entry_list.ini` GUID locking. The agent sends a blank GUID intentionally — extend `[REMOTE].GUID` in `raceIni.js` if you need that. |
| `npm run dev` exits with code 255 right after a restart | That's the `Stop-Process` exit code from killing a previous run. Not an actual error. |

When in doubt about an AC behavior, **read `Documents\Assetto Corsa\logs\log.txt`** before guessing — it captures the parsed race.ini and any engine errors.

## Repo layout

```
ac-remote-launcher/
├─ CLAUDE.md                       Orientation for future AI sessions
├─ README.md                       This file
├─ package.json                    Workspace scripts (install:all, dev)
├─ server/                         Central web app (operator desktop)
│  ├─ index.js                     Express API + static UI
│  ├─ config/
│  │  ├─ rigs.json                 Rig registry
│  │  └─ servers.json              Saved AC dedicated servers
│  └─ public/
│     ├─ index.html
│     ├─ app.js                    Vanilla JS, ~400 lines
│     └─ style.css
└─ rig-agent/                      Per-rig HTTP service
   ├─ agent.js                     Endpoints + spawn pipeline
   ├─ config.json                  Public defaults
   ├─ config.local.json            (gitignored) per-machine overrides
   └─ lib/
      ├─ raceIni.js                race.ini builder (offline + [REMOTE])
      └─ contentScan.js            Reads installed content
```

## Extending / handing off

- **Add a session option** (fuel rate, damage, etc.) — touch `rig-agent/lib/raceIni.js` (DEFAULTS + emit), then `server/public/index.html` (input), then `server/public/app.js` (`gatherPayload`).
- **Add a new rig endpoint** — implement in `rig-agent/agent.js`; add the proxy in `server/index.js` using the existing `proxyToRig` helper; call from `app.js`.
- **Multi-rig bulk operations** — pattern is in `POST /api/join-all` in `server/index.js`. `Promise.all` over `rigs.json` with per-rig results.
- **Content Manager / CSP / Sol** — swap the spawn target in `agent.js` from `acs.exe` to `Content Manager.exe` with `acmanager://race/quick?preset=<base64>`. The rest of the architecture is unchanged.
- **Telemetry / lap times** — AC writes `race_out.json` to the user's Documents folder after each session. Agent can poll and expose.
- **AWS-spun servers** — when that lands, have the central server call AWS to provision a fresh dedicated server, then push a row into `servers.json` (or replace the static file with a dynamic registry).

For a deeper tour of the code — including the gotchas we already hit — see [CLAUDE.md](./CLAUDE.md).

## Known limits

- **No auth, no TLS.** LAN-only assumption.
- **No live in-game telemetry.** `/status` only reports whether `acs.exe` is running, not lap/position.
- **Mid-session changes are restart-based.** Vanilla AC bakes session config at start; clicking **Launch** kicks the active session and starts a new one (~30 s interrupt). CSP + Pure/Sol can do mid-session weather transitions, but require those mods.
- **One concurrent session per rig.** New launches kill any running `acs.exe` first.
- **AI cars use the same model as the player.** A small extension in `raceIni.js` can pick from a pool.
- **GUID-locked multiplayer servers** are rejected. Sending a blank GUID works on open servers.

## License

MIT. See [LICENSE](./LICENSE) if present, otherwise treat as MIT.
