# CLAUDE.md

Orientation for future Claude (or any AI assistant) sessions on this repo. Read this before making changes — it captures the non-obvious decisions and gotchas we discovered building the POC.

## What this is

A **proof-of-concept web app** for centrally controlling Assetto Corsa on a fleet of sim rigs. The operator picks a rig + car + track (or a multiplayer server) in a browser; AC starts on that rig within ~30 seconds. Built as a handoff to a lead dev who will fold the pattern into the sim center's existing racing-AI platform — that's why dependencies are minimal and there's no build step.

The repo has **two Node.js services**:
- `server/` — runs on the operator desktop. Express + plain HTML/JS UI. The orchestrator.
- `rig-agent/` — runs on each sim rig. Express. Receives HTTP launch requests, writes `race.ini`, spawns `acs.exe`.

Both speak HTTP. Default ports: `3000` (server UI/API), `3001` (each rig agent). LAN-only assumption — no auth, no TLS.

## Architecture in one diagram

```
┌──────────────────────────┐         ┌────────────────────────┐
│  Operator desktop         │         │  Sim rig (1..N)         │
│ ────────────────────────  │  HTTP   │  ──────────────────────│
│  server/                  │ ──────► │  rig-agent/            │
│    Express :3000          │         │    Express :3001       │
│    static UI              │         │      │                 │
│    rigs.json              │         │      ▼                 │
│    servers.json           │         │  writes race.ini       │
│                           │         │  + spawns acs.exe      │
└──────────────────────────┘         │      │                 │
                                       │      ▼                 │
                                       │  Assetto Corsa         │
                                       │  (offline OR online)   │
                                       └────────────────────────┘
                                            ↑ if online: TCP to AC dedicated server
```

## Key files (read these first)

| File | Role |
| --- | --- |
| `rig-agent/lib/raceIni.js` | **Load-bearing.** Pure function `buildRaceIni({ carId, trackId, ..., online? })` → ini string. Every feature (mode/weather/AI/time/multiplayer) is a field here. |
| `rig-agent/lib/contentScan.js` | Reads `<acInstallPath>/content/{cars,tracks,weather}` and returns rich JSON with display names, layouts, skins, and `aiSupported` per layout. |
| `rig-agent/agent.js` | The agent's HTTP surface: `/health`, `/content`, `/status`, `/launch`, `/join`, `/stop`, `/clear-cache`, plus the intro-video flow (`/play-then-launch`, `/intro/page`, `/intro/video`, `/intro/done`). Reuses one `writeIniAndSpawn` helper for `/launch`, `/join`, and `/intro/done`. |
| `server/index.js` | Central API. Proxies to rig agents; caches content; probes AC server `/INFO` endpoint; fans out `/api/join-all` to every rig. |
| `server/public/app.js` | Vanilla JS UI. State object at top, render functions, event listeners at the bottom. No framework, no build step. |
| `server/config/rigs.json` | Registry of rigs: `[{ id, name, baseUrl }]`. Manually edited. |
| `server/config/servers.json` | Saved AC dedicated servers: `[{ id, name, host, racePort, httpPort?, password?, defaultCarId? }]`. |
| `rig-agent/config.json` | AC paths + agent port. Committed with Steam defaults. Per-machine overrides go in `rig-agent/config.local.json` (gitignored). |

## How `acs.exe` is launched

We **bypass Content Manager** and write `race.ini` directly to `<USERPROFILE>\Documents\Assetto Corsa\cfg\race.ini`, then spawn `<acInstallPath>\acs.exe`. That's the same engine entry point CM uses internally — just one level lower.

Field names in `race.ini` are derived from `gro-ove/actools` (the Content Manager source). The DEFAULTS block in `raceIni.js` is the source of truth; mode-specific overrides happen in the function body.

**Steam-free launch:** the agent writes `steam_appid.txt` (containing `244210`) next to `acs.exe` on startup and before each launch. With that file present, `acs.exe` runs without a Steam client. Without it, AC tries to talk to Steam and either pops Steam open or fails. The `/health` endpoint reports `steamFree: true/false` so the operator sees if the workaround is in place.

## Gotchas we already hit (don't relearn these)

1. **`SUN_ANGLE`, not `TIME`, controls the actual sun position** in stock AC. The `[LIGHTING].TIME=` field is metadata that only CSP/Pure consumes. We compute `SUN_ANGLE` from the time-of-day slider via `timeToSunAngle()` in `raceIni.js`. Valid range: roughly `-80` (early morning) to `+80` (late afternoon). Slider in the UI is clamped to 07:00–19:00 for this reason.

2. **Weather needs its own `[WEATHER]` section** with `NAME=<id>`. Putting `WEATHER=<id>` inside `[TEMPERATURE]` is silently ignored by AC — the weather dropdown will appear to do nothing.

3. **Track layout IDs must match folder names on disk**, not display names. Different tracks use different conventions: Silverstone has `gp/national/international`, Nürburgring has `layout_gp_a/layout_gp_b/...`, Red Bull Ring has `layout_gp/layout_national`. **Don't hardcode** — `contentScan.js` reads the actual folder names. Crashes show up in `<docs>/Assetto Corsa/logs/log.txt` as `models_<config>.ini file is required`.

4. **AI cars crash AC if the track layout has no AI line** (`<layout>/ai/fast_lane.ai`). Drift maps, drag strips, and many mod tracks omit this. `contentScan.js` records `layout.aiSupported`; the agent's `/launch` returns 400 if `aiCount > 0` on an unsupported layout; the UI disables the AI input on those tracks.

5. **The agent only writes `race.ini`, doesn't poll AC state.** `/launch` returns immediately after `spawn`. To check if AC is actually running, `/status` uses `tasklist /FI "IMAGENAME eq acs.exe"`. There's no in-process API into a running AC instance — see "live changes" below.

6. **Live mid-session changes don't exist in vanilla AC.** Weather/time/track/car/AI are all baked at session start. Clicking **Launch** while a session is running `taskkill`s `acs.exe` and starts a fresh one (~30s interrupt). CSP + Pure/Sol can do mid-session weather transitions, but require those mods installed and a different config path.

7. **Multiplayer `[REMOTE]` section** is appended to the same `race.ini`. When `[REMOTE].ACTIVE=1` is present, AC ignores SESSION/AI fields and connects to the server. So `/launch` and `/join` share the same writer (`writeIniAndSpawn`) — the only difference is whether `buildRaceIni` got an `online: {...}` block.

8. **GUID is intentionally blank** in `[REMOTE]`. Open servers accept this. Servers using `entry_list.ini` with locked Steam64 GUIDs will reject it — that's a known limitation, documented in the README.

9. **`config.local.json` is the override pattern.** `rig-agent/config.json` ships with the Steam default AC path; per-machine paths live in `rig-agent/config.local.json` (gitignored). `agent.js` does a shallow merge — local on top of base.

10. **The intro-video flow is deliberately a placeholder.** Today: `/play-then-launch` stashes the payload in `introJobs`, spawns `msedge.exe --kiosk` pointing at the agent's own `/intro/page`, and waits for the browser to POST `/intro/done`. The eventual plan (per the lead dev) is to bake this into a bundled client on each rig with a local-only control socket — at which point the kiosk-browser dance goes away and `/play-then-launch` becomes an internal call inside that client. The central server's API doesn't need to change. Job state lives in a `Map<jobId, {payload, browserChild, createdAt}>` and auto-expires after 10 minutes via a 1-minute janitor interval.

## Repo conventions

- **No framework, no bundler.** Frontend is a single `index.html` + `app.js` + `style.css`. The whole UI re-renders by manipulating DOM directly. If you find yourself wanting React, ask first — POC scope.
- **ESM everywhere** (`"type": "module"` in both subpackages). Top-level `await` is fine on Node 20+.
- **Built-in `fetch`** in both server-to-agent calls and agent-to-AC-server probes. No `node-fetch` / `axios`.
- **Path-style file names** in tool calls (`Documents\Assetto Corsa\cfg\race.ini`) — Windows-first, the whole stack assumes Windows rigs.
- **State lives in plain objects.** UI keeps everything in a `state` object at the top of `app.js`. Agent keeps `lastSession` + `contentCache` as module-level `let`s. Persistence isn't needed for the POC.

## Extending

| Want to add… | Touch these files |
| --- | --- |
| A new session option (e.g. fuel rate, damage) | `rig-agent/lib/raceIni.js` (add to DEFAULTS + emit in appropriate section) → `server/public/index.html` (input control) → `server/public/app.js` (`gatherPayload`). |
| Scanning a richer slice of installed content | `rig-agent/lib/contentScan.js`. Don't read `.acd` files — they're encrypted. Stick to `ui_*.json` and folder existence checks. |
| A new agent endpoint | Add to `rig-agent/agent.js`; add the matching proxy to `server/index.js` (use `proxyToRig` helper); call from `app.js`. |
| Multi-rig bulk operations | Pattern is in `POST /api/join-all` in `server/index.js` — `Promise.all` over `rigs.json`, return per-rig results. |
| Content Manager integration (CSP, Sol, mods) | Swap the spawn target in `agent.js`'s `writeIniAndSpawn` from `acs.exe` to `Content Manager.exe` with `acmanager://race/quick?preset=<base64>`. The preset is a serialized Quick Drive JSON; would need capturing from a real CM install. Everything else stays. |

## Testing approach

- **Don't trigger `/launch` or `/join` on a dev box where AC is installed and you don't want it to actually start.** The current race.ini and a real `acs.exe` will obediently boot AC.
- For verifying race.ini output, call `buildRaceIni()` directly from a small `mjs` file — see git history for examples we used.
- For verifying the HTTP surface, hit endpoints via `Invoke-RestMethod` or curl. `/health`, `/content`, `/status`, `/api/servers`, `/api/servers/:id/info` are all safe to call freely.
- **`Documents\Assetto Corsa\logs\log.txt`** is your friend for diagnosing AC crashes after a launch. Always check it before guessing.

## Out of scope (don't add unless asked)

- Auth / TLS / multi-tenant
- Server provisioning (AWS or otherwise) — eventually a separate concern
- Public-lobby server browser
- Persistent telemetry storage (lap times, etc.) — AC writes `race_out.json` after each session; agent could poll, but it's a follow-up
- Steam workshop / mod management
- Mobile / responsive design beyond the basic media query

## When the user asks for "live X"

Be honest: AC's engine doesn't have a runtime config API. Vanilla AC = restart with new params. CSP/Pure = some weather transitions while keeping the car on track. Both options live in the README so you can quote.
