const state = {
  rigs: [],
  content: null,
  selectedRigId: null,
  carFilter: '',
  trackFilter: '',
  servers: [],
  selectedServerId: null,
  serverInfo: null
};

const $ = (s) => document.querySelector(s);

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}

function showStatus(text, kind) {
  const el = $('#status');
  el.className = `status${kind ? ' ' + kind : ''}`;
  el.textContent = text;
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

async function loadRigs() {
  state.rigs = await fetch('/api/rigs').then(r => r.json());
  renderRigs();
  pollAllRigs();
  setInterval(pollAllRigs, 5000);
}

function renderRigs() {
  const c = $('#rigs');
  c.innerHTML = '';
  for (const rig of state.rigs) {
    const el = document.createElement('div');
    el.className = 'rig';
    el.dataset.rigId = rig.id;
    el.innerHTML = `
      <span class="dot" data-health></span>
      <span class="rig-name">${rig.name}</span>
      <span class="rig-url">${rig.baseUrl}</span>
    `;
    el.addEventListener('click', () => selectRig(rig.id));
    c.appendChild(el);
  }
}

function selectRig(rigId) {
  state.selectedRigId = rigId;
  document.querySelectorAll('.rig').forEach(el => {
    el.classList.toggle('selected', el.dataset.rigId === rigId);
  });
  updateButtons();
  refreshLiveSession();
}

async function pollAllRigs() {
  for (const rig of state.rigs) {
    try {
      const { body: h } = await api(`/api/rigs/${rig.id}/health`);
      const el = document.querySelector(`.rig[data-rig-id="${rig.id}"]`);
      if (!el) continue;
      const dot = el.querySelector('.dot');
      if (dot) dot.className = `dot ${h.ok ? (h.running ? 'busy' : 'ok') : 'bad'}`;
      setBadge(el, '.rig-warn', warningFromHealth(h));
      setBadge(el, '.rig-running', h.running ? 'in session' : null);
    } catch { /* ignore */ }
  }
  if (state.selectedRigId) refreshLiveSession();
}

function setBadge(parent, className, text) {
  const sel = className.startsWith('.') ? className : '.' + className;
  let badge = parent.querySelector(sel);
  if (text) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = sel.slice(1);
      parent.appendChild(badge);
    }
    badge.textContent = text;
  } else if (badge) {
    badge.remove();
  }
}

function warningFromHealth(h) {
  if (!h.ok) return null;
  if (h.acExists === false) return 'AC not found';
  if (h.steamFree === false) return 'Steam-free mode not active';
  return null;
}

async function loadContent(refresh = false) {
  $('#content-meta').textContent = refresh ? 'Re-scanning content…' : 'Loading content…';
  try {
    const r = await fetch(`/api/content${refresh ? '?refresh=true' : ''}`);
    const body = await r.json();
    if (!r.ok) {
      $('#content-meta').textContent = `Content unavailable: ${body.error ?? 'unknown error'}`;
      return;
    }
    state.content = body;
    const src = body.source ? ` (via ${body.source.rigName})` : '';
    $('#content-meta').textContent = `${body.cars.length} cars · ${body.tracks.length} tracks · ${body.weather.length} weather${src}`;
    renderContent();
  } catch (err) {
    $('#content-meta').textContent = `Content load failed: ${err.message}`;
  }
}

function renderContent() {
  if (!state.content) return;
  renderCarOptions();
  renderTrackOptions();

  const weatherSel = $('#weather');
  weatherSel.innerHTML = state.content.weather
    .map(w => `<option value="${w.id}">${w.name}</option>`)
    .join('');
  const clear = state.content.weather.find(w => /clear/i.test(w.name));
  if (clear) weatherSel.value = clear.id;

  $('#car').addEventListener('change', onCarChange);
  $('#track').addEventListener('change', onTrackChange);
  $('#layout').addEventListener('change', refreshAiAvailability);
  $('#car-filter').addEventListener('input', e => { state.carFilter = e.target.value; renderCarOptions(); });
  $('#track-filter').addEventListener('input', e => { state.trackFilter = e.target.value; renderTrackOptions(); });

  if (state.content.cars.length) {
    $('#car').value = state.content.cars[0].id;
    onCarChange();
  }
  if (state.content.tracks.length) {
    $('#track').value = state.content.tracks[0].id;
    onTrackChange();
  }
  updateButtons();
}

function renderCarOptions() {
  const sel = $('#car');
  const prev = sel.value;
  const f = state.carFilter.toLowerCase().trim();
  const matches = state.content.cars.filter(c =>
    !f || c.name.toLowerCase().includes(f) || c.id.toLowerCase().includes(f) || (c.brand ?? '').toLowerCase().includes(f)
  );
  sel.innerHTML = matches.map(c => `<option value="${c.id}">${c.name}${c.brand ? ` — ${c.brand}` : ''}</option>`).join('');
  if (matches.some(c => c.id === prev)) sel.value = prev;
  else if (matches[0]) { sel.value = matches[0].id; onCarChange(); }
}

function renderTrackOptions() {
  const sel = $('#track');
  const prev = sel.value;
  const f = state.trackFilter.toLowerCase().trim();
  const matches = state.content.tracks.filter(t =>
    !f || t.name.toLowerCase().includes(f) || t.id.toLowerCase().includes(f)
  );
  sel.innerHTML = matches.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
  if (matches.some(t => t.id === prev)) sel.value = prev;
  else if (matches[0]) { sel.value = matches[0].id; onTrackChange(); }
}

function onCarChange() {
  const car = state.content.cars.find(c => c.id === $('#car').value);
  const sel = $('#skin');
  if (!car || !car.skins?.length) {
    sel.innerHTML = '<option value="">(default)</option>';
    sel.disabled = true;
  } else {
    sel.innerHTML = car.skins.map(s => `<option value="${s}">${s}</option>`).join('');
    sel.disabled = false;
  }
}

function onTrackChange() {
  const track = state.content.tracks.find(t => t.id === $('#track').value);
  const sel = $('#layout');
  if (!track || !track.layouts.length || (track.layouts.length === 1 && track.layouts[0].id === '')) {
    sel.innerHTML = '<option value="">(default)</option>';
    sel.disabled = !track || !track.layouts.length;
  } else {
    sel.innerHTML = track.layouts.map(l => `<option value="${l.id}">${l.name}</option>`).join('');
    sel.disabled = false;
  }
  refreshAiAvailability();
}

function refreshAiAvailability() {
  const track = state.content?.tracks.find(t => t.id === $('#track').value);
  const layoutId = $('#layout').value || '';
  const layout = track?.layouts.find(l => l.id === layoutId);
  const aiOk = !track || !layout || layout.aiSupported !== false;
  const aiInput = $('#ai-count');
  aiInput.disabled = !aiOk;
  if (!aiOk) aiInput.value = 0;
  const warn = $('#ai-warning');
  if (warn) warn.classList.toggle('hidden', aiOk);
}

$('#mode').addEventListener('change', e => {
  const isRace = e.target.value === 'race';
  $('#duration-field').classList.toggle('hidden', isRace);
  $('#laps-field').classList.toggle('hidden', !isRace);
});

$('#time-of-day').addEventListener('input', e => {
  $('#time-of-day-label').textContent = formatTime(Number(e.target.value));
});

function updateButtons() {
  const haveRig = !!state.selectedRigId;
  const haveContent = !!state.content;
  const haveServer = !!state.selectedServerId;
  $('#launch').disabled = !(haveRig && haveContent);
  $('#stop').disabled = !haveRig;
  $('#clear-cache').disabled = !haveRig;
  $('#mp-join').disabled = !(haveRig && haveServer);
  $('#mp-join-all').disabled = !haveServer;
}

function gatherPayload() {
  return {
    rigId: state.selectedRigId,
    carId: $('#car').value,
    carSkin: $('#skin').value || '',
    trackId: $('#track').value,
    trackLayoutId: $('#layout').value || '',
    mode: $('#mode').value,
    durationMinutes: Number($('#duration').value),
    laps: Number($('#laps').value),
    weather: $('#weather').value,
    timeSeconds: Number($('#time-of-day').value),
    ambientTemp: Number($('#ambient-temp').value),
    roadTemp: Number($('#road-temp').value),
    windSpeedMinKmh: Number($('#wind-speed').value),
    windSpeedMaxKmh: Number($('#wind-speed').value),
    windDirectionDeg: Number($('#wind-direction').value),
    aiCount: Number($('#ai-count').value),
    aiLevel: Number($('#ai-level').value),
    aiAggression: Number($('#ai-aggression').value),
    penalties: $('#penalties').checked,
    driverName: $('#driver-name').value.trim() || 'Driver'
  };
}

$('#launch').addEventListener('click', async () => {
  showStatus('Launching…');
  const payload = gatherPayload();
  const r = await api('/api/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  showStatus(JSON.stringify(r.body, null, 2), r.ok ? 'ok' : 'bad');
  refreshLiveSession();
});

$('#stop').addEventListener('click', async () => {
  if (!state.selectedRigId) return;
  showStatus('Stopping AC…');
  const r = await api(`/api/rigs/${state.selectedRigId}/stop`, { method: 'POST' });
  showStatus(JSON.stringify(r.body, null, 2), r.ok ? 'ok' : 'bad');
  refreshLiveSession();
});

$('#clear-cache').addEventListener('click', async () => {
  if (!state.selectedRigId) return;
  showStatus('Clearing cache…');
  const r = await api(`/api/rigs/${state.selectedRigId}/clear-cache`, { method: 'POST' });
  showStatus(JSON.stringify(r.body, null, 2), r.ok ? 'ok' : 'bad');
});

$('#refresh-content').addEventListener('click', () => loadContent(true));

async function refreshLiveSession() {
  const el = $('#live-session');
  if (!state.selectedRigId) {
    el.className = 'live-session idle';
    el.textContent = 'No rig selected.';
    return;
  }
  try {
    const { body } = await api(`/api/rigs/${state.selectedRigId}/status`);
    const ls = body.lastSession;
    el.className = `live-session ${body.running ? 'running' : 'idle'}`;
    if (!ls) {
      el.textContent = body.running ? 'AC is running (no session metadata).' : 'Idle. No session launched yet.';
      return;
    }
    el.innerHTML = `
      <div class="row"><span class="key">Status</span><span class="val">${body.running ? '🟢 Running' : '⚪ Stopped'}</span></div>
      <div class="row"><span class="key">Car</span><span class="val">${ls.carId}${ls.carSkin ? ` (${ls.carSkin})` : ''}</span></div>
      <div class="row"><span class="key">Track</span><span class="val">${ls.trackId}${ls.trackLayoutId ? ` / ${ls.trackLayoutId}` : ''}</span></div>
      <div class="row"><span class="key">Mode</span><span class="val">${ls.mode ?? 'practice'} ${ls.mode === 'race' ? `· ${ls.laps} laps` : `· ${ls.durationMinutes} min`}</span></div>
      <div class="row"><span class="key">Weather</span><span class="val">${ls.weather ?? '?'} · ${ls.ambientTemp ?? '?'}°C ambient · ${ls.roadTemp ?? '?'}°C road</span></div>
      <div class="row"><span class="key">Time</span><span class="val">${ls.timeSeconds != null ? formatTime(ls.timeSeconds) : '?'}</span></div>
      <div class="row"><span class="key">AI</span><span class="val">${ls.aiCount ?? 0} opponents${ls.aiCount > 0 ? ` · level ${ls.aiLevel} · aggression ${ls.aiAggression}` : ''}</span></div>
      <div class="row"><span class="key">Started</span><span class="val">${new Date(ls.startedAt).toLocaleTimeString()}</span></div>
    `;
  } catch (err) {
    el.className = 'live-session idle';
    el.textContent = `Status fetch failed: ${err.message}`;
  }
}

// ---------- Multiplayer ----------

async function loadServers() {
  try {
    state.servers = await fetch('/api/servers').then(r => r.json());
  } catch {
    state.servers = [];
  }
  const sel = $('#mp-server');
  if (!state.servers.length) {
    sel.innerHTML = '<option value="">(no servers configured)</option>';
    sel.disabled = true;
    return;
  }
  sel.innerHTML = state.servers.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  sel.disabled = false;
  sel.addEventListener('change', onServerChange);
  onServerChange();
}

async function onServerChange() {
  state.selectedServerId = $('#mp-server').value || null;
  state.serverInfo = null;
  const info = $('#mp-server-info');
  info.className = 'server-info';
  info.textContent = 'Probing server…';
  populateMpCars();
  updateButtons();

  if (!state.selectedServerId) {
    info.textContent = 'Pick a server.';
    return;
  }

  try {
    const r = await fetch(`/api/servers/${state.selectedServerId}/info`);
    const body = await r.json();
    state.serverInfo = body;
    renderServerInfo(body);
    populateMpCars();
  } catch (err) {
    info.className = 'server-info unreachable';
    info.textContent = `Info probe failed: ${err.message}`;
  }
}

function renderServerInfo(body) {
  const info = $('#mp-server-info');
  if (!body.reachable) {
    info.className = 'server-info unreachable';
    info.innerHTML = `<div class="row"><span class="key">Status</span><span>Unreachable${body.reason ? ` (${body.reason})` : ''}. Car list defaults to all installed.</span></div>`;
    return;
  }
  info.className = 'server-info reachable';
  const cars = Array.isArray(body.cars) ? body.cars : [];
  info.innerHTML = `
    <div class="row"><span class="key">Status</span><span>🟢 Reachable</span></div>
    ${body.track ? `<div class="row"><span class="key">Track</span><span>${body.track}${body.track_config ? ` / ${body.track_config}` : ''}</span></div>` : ''}
    ${body.session ? `<div class="row"><span class="key">Session</span><span>${body.session.type ?? ''}</span></div>` : ''}
    ${body.maxclients != null ? `<div class="row"><span class="key">Slots</span><span>${body.clients ?? '?'} / ${body.maxclients}</span></div>` : ''}
    ${cars.length ? `<div class="row"><span class="key">Cars</span><span>${cars.map(c => `<span class="car-chip">${c}</span>`).join('')}</span></div>` : ''}
  `;
}

function populateMpCars() {
  const sel = $('#mp-car');
  const server = state.servers.find(s => s.id === state.selectedServerId);
  const info = state.serverInfo;
  let carIds;

  if (info?.reachable && Array.isArray(info.cars) && info.cars.length) {
    carIds = info.cars;
  } else if (state.content?.cars) {
    carIds = state.content.cars.map(c => c.id);
  } else {
    carIds = [];
  }

  const nameFor = (id) => state.content?.cars.find(c => c.id === id)?.name || id;
  sel.innerHTML = carIds.map(id => `<option value="${id}">${nameFor(id)}</option>`).join('');
  if (server?.defaultCarId && carIds.includes(server.defaultCarId)) {
    sel.value = server.defaultCarId;
  }
}

function gatherJoinPayload() {
  const server = state.servers.find(s => s.id === state.selectedServerId);
  return {
    carId: $('#mp-car').value,
    server: {
      host: server.host,
      racePort: server.racePort,
      password: server.password ?? ''
    }
  };
}

function renderJoinResults(results) {
  const wrap = document.createElement('div');
  wrap.className = 'join-results';
  for (const r of results) {
    const row = document.createElement('div');
    row.className = `join-row ${r.ok ? 'ok' : 'bad'}`;
    row.textContent = `${r.rigName ?? r.rigId}: ${r.ok ? 'launched' : (r.error || `HTTP ${r.status}`)}`;
    wrap.appendChild(row);
  }
  const status = $('#status');
  status.className = 'status';
  status.innerHTML = '';
  status.appendChild(wrap);
}

$('#mp-join').addEventListener('click', async () => {
  if (!state.selectedRigId || !state.selectedServerId) return;
  showStatus('Joining…');
  const r = await api(`/api/rigs/${state.selectedRigId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(gatherJoinPayload())
  });
  showStatus(JSON.stringify(r.body, null, 2), r.ok ? 'ok' : 'bad');
  refreshLiveSession();
});

$('#mp-join-all').addEventListener('click', async () => {
  if (!state.selectedServerId) return;
  showStatus('Sending all rigs…');
  const r = await api('/api/join-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(gatherJoinPayload())
  });
  if (r.ok && Array.isArray(r.body.results)) {
    renderJoinResults(r.body.results);
  } else {
    showStatus(JSON.stringify(r.body, null, 2), r.ok ? 'ok' : 'bad');
  }
  refreshLiveSession();
});

(async function init() {
  await loadRigs();
  await loadContent();
  await loadServers();
})();
