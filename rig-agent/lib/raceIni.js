// Builds the race.ini contents that acs.exe reads when launched directly.
// Field names derived from gro-ove/actools' AcTools/Processes/Game.Properties.cs.

const MODE_TYPES = {
  practice: 1,
  qualify: 2,
  race: 3,
  hotlap: 4,
  timeattack: 5,
  drift: 6
};

const DEFAULTS = {
  carSkin: '',
  mode: 'practice',
  durationMinutes: 30,
  laps: 5,
  weather: '3_clear',
  ambientTemp: 22,
  roadTemp: 28,
  timeSeconds: 46800,        // 13:00 = solar noon-ish (sun angle 0)
  windSpeedMinKmh: 0,
  windSpeedMaxKmh: 0,
  windDirectionDeg: 0,
  aiCount: 0,
  aiLevel: 90,
  aiAggression: 50,
  penalties: true,
  damageMultiplier: 100,
  tyreWearRate: 1.0,
  fuelRate: 1.0,
  driverName: 'Driver'
};

// AC uses SUN_ANGLE in [LIGHTING] for the actual sun position; TIME is informational.
// Empirical mapping from gro-ove/actools: each hour ≈ 16°, solar noon ≈ 13:00.
// Valid in-game range is roughly -80 (early morning) to +80 (late afternoon).
function timeToSunAngle(timeSeconds) {
  const hour = timeSeconds / 3600;
  return Math.max(-80, Math.min(80, Math.round((hour - 13) * 16)));
}

function section(name, fields) {
  const body = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'boolean' ? (v ? 1 : 0) : v}`)
    .join('\r\n');
  return `[${name}]\r\n${body}`;
}

export function buildRaceIni(input) {
  if (!input?.carId) throw new Error('carId is required');
  if (!input?.trackId) throw new Error('trackId is required');

  const o = { ...DEFAULTS, ...input };
  const layout = o.trackLayoutId ?? '';
  const modeKey = String(o.mode).toLowerCase();
  const sessionType = MODE_TYPES[modeKey] ?? 1;
  const isRace = modeKey === 'race';
  const isDrift = modeKey === 'drift';
  const totalCars = 1 + Math.max(0, o.aiCount | 0);

  const out = [
    section('RACE', {
      MODEL: o.carId,
      MODEL_CONFIG: '',
      SKIN: o.carSkin,
      TRACK: o.trackId,
      CONFIG_TRACK: layout,
      AI_LEVEL: o.aiLevel,
      CARS: totalCars,
      DRIFT_MODE: isDrift,
      FIXED_SETUP: 0,
      PENALTIES: o.penalties,
      JUMP_START_PENALTY: 0,
      RACE_LAPS: isRace ? o.laps : 0
    }),

    section('CAR_0', {
      SETUP: '',
      SKIN: o.carSkin,
      MODEL: '-',
      MODEL_CONFIG: '',
      BALLAST: 0,
      RESTRICTOR: 0,
      DRIVER_NAME: o.driverName,
      NATION_CODE: '',
      NATIONALITY: ''
    })
  ];

  for (let i = 1; i < totalCars; i++) {
    out.push(section(`CAR_${i}`, {
      SETUP: '',
      SKIN: o.carSkin,
      MODEL: o.carId,
      MODEL_CONFIG: '',
      AI_LEVEL: o.aiLevel,
      AI_AGGRESSION: o.aiAggression,
      BALLAST: 0,
      RESTRICTOR: 0,
      DRIVER_NAME: `AI ${i}`,
      NATION_CODE: '',
      NATIONALITY: ''
    }));
  }

  const sessionFields = {
    NAME: modeKey.charAt(0).toUpperCase() + modeKey.slice(1),
    TYPE: sessionType,
    SPAWN_SET: 'START'
  };
  if (isRace) {
    sessionFields.LAPS = o.laps;
    sessionFields.STARTING_POSITION = totalCars;
  } else {
    sessionFields.DURATION_MINUTES = o.durationMinutes;
  }
  out.push(section('SESSION_0', sessionFields));

  out.push(section('GROOVE', {
    VIRTUAL_LAPS: 10,
    MAX_LAPS: 30,
    STARTING_LAPS: 0
  }));

  out.push(section('GHOST_CAR', {
    RECORDING: 0,
    PLAYING: 0,
    LOAD: 0,
    ENABLED: 0
  }));

  out.push(section('WEATHER', {
    NAME: o.weather
  }));

  out.push(section('TEMPERATURE', {
    AMBIENT: o.ambientTemp,
    ROAD: o.roadTemp
  }));

  out.push(section('LIGHTING', {
    SUN_ANGLE: timeToSunAngle(o.timeSeconds),
    TIME: o.timeSeconds
  }));

  out.push(section('WIND', {
    SPEED_KMH_MIN: o.windSpeedMinKmh,
    SPEED_KMH_MAX: o.windSpeedMaxKmh,
    DIRECTION_DEG: o.windDirectionDeg
  }));

  if (o.online && o.online.serverIp && o.online.serverPort) {
    out.push(section('REMOTE', {
      ACTIVE: 1,
      SERVER_IP: o.online.serverIp,
      SERVER_PORT: o.online.serverPort,
      NAME: o.online.driverName ?? o.driverName,
      TEAM: '',
      PASSWORD: o.online.password ?? '',
      REQUESTED_CAR: o.online.requestedCar ?? o.carId,
      GUID: o.online.guid ?? ''
    }));
  }

  return out.join('\r\n\r\n') + '\r\n';
}
