import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function readJsonLoose(path) {
  try {
    let text = await readFile(path, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function dirsIn(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

function humanize(id) {
  return id
    .replace(/^ks_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

async function scanCar(carsRoot, id) {
  const carDir = join(carsRoot, id);
  const ui = await readJsonLoose(join(carDir, 'ui', 'ui_car.json')) ?? {};
  const skins = await dirsIn(join(carDir, 'skins'));
  return {
    id,
    name: ui.name ?? humanize(id),
    brand: ui.brand ?? null,
    carClass: ui.class ?? null,
    tags: Array.isArray(ui.tags) ? ui.tags : [],
    skins
  };
}

async function scanTrack(tracksRoot, id) {
  const trackDir = join(tracksRoot, id);
  const uiDir = join(trackDir, 'ui');

  const uiSubdirs = await dirsIn(uiDir);
  const layouts = [];
  for (const layoutId of uiSubdirs) {
    const ui = await readJsonLoose(join(uiDir, layoutId, 'ui_track.json'));
    if (!ui) continue;
    if (!(await exists(join(trackDir, layoutId)))) continue;
    layouts.push({
      id: layoutId,
      name: ui.name ?? layoutId,
      length: ui.length ?? null,
      pitboxes: ui.pitboxes ?? null,
      country: ui.country ?? null,
      aiSupported: await exists(join(trackDir, layoutId, 'ai', 'fast_lane.ai'))
    });
  }

  if (layouts.length === 0) {
    const ui = await readJsonLoose(join(uiDir, 'ui_track.json'));
    if (ui) {
      layouts.push({
        id: '',
        name: ui.name ?? id,
        length: ui.length ?? null,
        pitboxes: ui.pitboxes ?? null,
        country: ui.country ?? null,
        aiSupported: await exists(join(trackDir, 'ai', 'fast_lane.ai'))
      });
    }
  }

  if (layouts.length === 0) return null;

  return {
    id,
    name: humanize(id),
    layouts
  };
}

function prettifyWeather(folderName) {
  return folderName
    .replace(/^\d+_/, '')
    .split('_')
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

async function scanWeather(weatherRoot) {
  const ids = await dirsIn(weatherRoot);
  return ids.sort().map(id => ({ id, name: prettifyWeather(id) }));
}

export async function scanContent(acInstallPath) {
  const carsRoot = join(acInstallPath, 'content', 'cars');
  const tracksRoot = join(acInstallPath, 'content', 'tracks');
  const weatherRoot = join(acInstallPath, 'content', 'weather');

  const [carIds, trackIds, weather] = await Promise.all([
    dirsIn(carsRoot),
    dirsIn(tracksRoot),
    scanWeather(weatherRoot)
  ]);

  const cars = (await Promise.all(carIds.map(id => scanCar(carsRoot, id))))
    .sort((a, b) => a.name.localeCompare(b.name));

  const tracks = (await Promise.all(trackIds.map(id => scanTrack(tracksRoot, id))))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    scannedAt: new Date().toISOString(),
    acInstallPath,
    cars,
    tracks,
    weather
  };
}
