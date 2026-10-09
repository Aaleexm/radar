// Radares: fijos desde OpenStreetMap (Overpass API) + radares móviles compartidos entre usuarios (Supabase).

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const FETCH_RADIUS_KM = 25;
const REFETCH_KM = 10;
const LS_FIXED = 'radar.fixedCache';
const LS_DEVICE = 'radar.device';
const LS_MINE = 'radar.mine';
const LS_HIDDEN = 'radar.hidden';

// Clave pública (publishable): solo puede llamar a las funciones radars_near / report_radar / dismiss_radar.
const SUPABASE_URL = 'https://xvxpkdnydlfcffppcosb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_NtU2KhDU_hly8egjnEj3mA_FzkCaQL2';
const MOBILE_SYNC_MS = 60 * 1000;
const MOBILE_RADIUS_KM = 25;

export const ALERT_FAR_M = 500;
export const ALERT_NEAR_M = 150;

export function distanceM(a, b) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearingDeg(a, b) {
  const toRad = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * toRad) * Math.cos(b[1] * toRad);
  const x =
    Math.cos(a[1] * toRad) * Math.sin(b[1] * toRad) -
    Math.sin(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.cos((b[0] - a[0]) * toRad);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function parseSpeed(v) {
  if (!v) return null;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return null;
  return /mph/.test(v) ? Math.round(n * 1.609) : n;
}

function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

// Identificador anónimo del dispositivo (para limitar spam y para que puedas quitar tus propios reportes)
function deviceId() {
  let id = loadJSON(LS_DEVICE, null);
  if (!id) {
    id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    saveJSON(LS_DEVICE, id);
  }
  return id;
}

async function rpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.message || `Error ${res.status}`);
  return data;
}

export class Radars {
  constructor(onChange) {
    this.onChange = onChange;
    const cache = loadJSON(LS_FIXED, null);
    this.fixed = cache?.cameras ?? [];
    this.fetchCenter = cache?.center ?? null;
    this.mobile = [];
    this.device = deviceId();
    this.mine = new Set(loadJSON(LS_MINE, []));
    this.hidden = new Set(loadJSON(LS_HIDDEN, []));
    this.mobileSync = { t: 0, pos: null, busy: false };
    this.loading = false;
    this.alerted = new Map(); // id -> nivel de aviso ya emitido (1 = lejos, 2 = cerca)
  }

  all() {
    return [...this.fixed, ...this.mobile];
  }

  geojson() {
    return {
      type: 'FeatureCollection',
      features: this.all().map((c) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: c.pos },
        properties: { id: c.id, mobile: !!c.mobile, maxspeed: c.maxspeed ? String(c.maxspeed) : '' },
      })),
    };
  }

  async ensureLoaded(pos) {
    if (this.loading) return;
    if (this.fetchCenter && distanceM(pos, this.fetchCenter) < REFETCH_KM * 1000) return;
    this.loading = true;
    try {
      this.fixed = await this.fetchFixed(pos);
      this.fetchCenter = pos;
      saveJSON(LS_FIXED, { center: pos, cameras: this.fixed });
      this.onChange();
    } catch (err) {
      console.warn('No se pudieron cargar los radares', err);
    } finally {
      this.loading = false;
    }
  }

  async fetchFixed([lon, lat]) {
    const dLat = FETCH_RADIUS_KM / 111;
    const dLon = dLat / Math.cos((lat * Math.PI) / 180);
    const bbox = `${lat - dLat},${lon - dLon},${lat + dLat},${lon + dLon}`;
    const query = `[out:json][timeout:25];
(
  node["highway"="speed_camera"](${bbox});
  relation["type"="enforcement"]["enforcement"~"maxspeed|average_speed"](${bbox});
);
out body;`;

    let data;
    for (const url of OVERPASS) {
      try {
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }) });
        if (res.ok) {
          data = await res.json();
          break;
        }
      } catch {}
    }
    if (!data) throw new Error('Overpass no responde');

    // Las relaciones "enforcement" suelen llevar el límite; se lo pasamos a su nodo "device".
    const relSpeed = new Map();
    for (const el of data.elements) {
      if (el.type !== 'relation') continue;
      const speed = parseSpeed(el.tags?.maxspeed);
      for (const m of el.members ?? []) {
        if (m.type === 'node' && m.role === 'device' && speed) relSpeed.set(m.ref, speed);
      }
    }

    return data.elements
      .filter((el) => el.type === 'node')
      .map((el) => ({
        id: `osm-${el.id}`,
        pos: [el.lon, el.lat],
        maxspeed: parseSpeed(el.tags?.maxspeed) ?? relSpeed.get(el.id) ?? null,
      }));
  }

  // Descarga los radares móviles de todos los usuarios (cada minuto o al moverse 5 km)
  async syncMobile(pos, force = false) {
    const s = this.mobileSync;
    if (s.busy) return;
    const moved = !s.pos || distanceM(pos, s.pos) > 5000;
    if (!force && !moved && Date.now() - s.t < MOBILE_SYNC_MS) return;
    s.busy = true;
    try {
      const rows = await rpc('radars_near', { p_lon: pos[0], p_lat: pos[1], p_radius_km: MOBILE_RADIUS_KM });
      this.mobile = rows
        .filter((r) => !this.hidden.has(r.id))
        .map((r) => ({ id: r.id, pos: [r.lon, r.lat], mobile: true, maxspeed: null, confirmations: r.confirmations }));
      s.t = Date.now();
      s.pos = pos;
      this.onChange();
    } catch (err) {
      console.warn('No se pudieron cargar los radares móviles', err);
    } finally {
      s.busy = false;
    }
  }

  // Devuelve true si el radar ya existía (se ha sumado una confirmación)
  async reportMobile(pos) {
    const known = new Set(this.mobile.map((m) => m.id));
    const id = await rpc('report_radar', { p_lon: pos[0], p_lat: pos[1], p_reporter: this.device });
    const existed = known.has(id);
    if (!existed) {
      this.mine.add(id);
      saveJSON(LS_MINE, [...this.mine].slice(-200));
    }
    this.hidden.delete(id);
    await this.syncMobile(pos, true);
    if (!this.mobile.some((m) => m.id === id)) this.mobile.push({ id, pos, mobile: true, maxspeed: null });
    this.onChange();
    return existed;
  }

  isMine(id) {
    return this.mine.has(id);
  }

  // "Ya no está": si es tuyo desaparece para todos; si no, cuenta como voto (3 votos lo quitan)
  async removeMobile(id) {
    await rpc('dismiss_radar', { p_id: id, p_reporter: this.device });
    this.hidden.add(id);
    saveJSON(LS_HIDDEN, [...this.hidden].slice(-500));
    this.mobile = this.mobile.filter((m) => m.id !== id);
    this.onChange();
  }

  // Devuelve el radar más cercano por delante (o null) y qué aviso toca emitir.
  check(pos, heading) {
    let best = null;
    for (const cam of this.all()) {
      const d = distanceM(pos, cam.pos);
      if (d > ALERT_FAR_M) {
        if (d > ALERT_FAR_M * 1.5) this.alerted.delete(cam.id);
        continue;
      }
      // Si sabemos hacia dónde vamos, solo cuentan los radares que quedan delante.
      if (heading != null && d > 30 && angleDiff(bearingDeg(pos, cam.pos), heading) > 50) continue;
      if (!best || d < best.distance) best = { cam, distance: d };
    }
    if (!best) return { ahead: null, level: 0 };

    const want = best.distance <= ALERT_NEAR_M ? 2 : 1;
    const had = this.alerted.get(best.cam.id) ?? 0;
    if (want > had) this.alerted.set(best.cam.id, want);
    return { ahead: best, level: want > had ? want : 0 };
  }
}
