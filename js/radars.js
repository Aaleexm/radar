// Radares de tres fuentes:
//  - OpenStreetMap (Overpass API): fijos y de tramo en todo el mundo, a veces con límite de velocidad.
//  - DGT (datos oficiales, vía /api/dgt): fijos y de tramo de España (sin Cataluña ni País Vasco).
//  - Comunidad (Supabase): radares móviles que reportan los usuarios de la app.
//
// Tipos: 'fixed' (fijo), 'mobile' (móvil), 'section_start' / 'section_end' (inicio / fin de tramo).

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const API_BASE = location.protocol.startsWith('http') ? '' : 'https://map-coral-nine.vercel.app';
const FETCH_RADIUS_KM = 25;
const REFETCH_KM = 10;
const LS_FIXED = 'radar.fixedCache.v2';
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

export function angleDiff(a, b) {
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

// ---------- Fuentes ----------
async function fetchOsm([lon, lat]) {
  const dLat = FETCH_RADIUS_KM / 111;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  const bbox = `${lat - dLat},${lon - dLon},${lat + dLat},${lon + dLon}`;
  // Además de los radares, pedimos las coordenadas de los nodos de las relaciones (inicio/fin de tramo)
  const query = `[out:json][timeout:25];
(
  node["highway"="speed_camera"](${bbox});
  relation["type"="enforcement"]["enforcement"~"maxspeed|average_speed"](${bbox});
)->.a;
.a out body;
node(r.a);
out skel qt;`;

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

  const nodes = new Map();
  for (const el of data.elements) if (el.type === 'node') nodes.set(el.id, el);

  const relSpeed = new Map(); // device -> límite (relaciones de velocidad puntual)
  const sectionDevices = new Set();
  const sections = [];
  for (const el of data.elements) {
    if (el.type !== 'relation') continue;
    const speed = parseSpeed(el.tags?.maxspeed);
    const members = (el.members ?? []).filter((m) => m.type === 'node' && nodes.has(m.ref));
    const pos = (m) => [nodes.get(m.ref).lon, nodes.get(m.ref).lat];
    if (el.tags?.enforcement === 'average_speed') {
      const devices = members.filter((m) => m.role === 'device');
      devices.forEach((m) => sectionDevices.add(m.ref));
      const from = members.find((m) => m.role === 'from') ?? devices[0];
      const to = members.find((m) => m.role === 'to') ?? devices[devices.length - 1];
      if (from && to && from.ref !== to.ref) {
        sections.push({ id: `osm-${el.id}`, from: pos(from), to: pos(to), maxspeed: speed, road: el.tags?.name ?? '' });
      }
    } else {
      for (const m of members) if (m.role === 'device' && speed) relSpeed.set(m.ref, speed);
    }
  }

  const fixed = [];
  for (const el of nodes.values()) {
    if (el.tags?.highway !== 'speed_camera' || sectionDevices.has(el.id)) continue;
    fixed.push({ id: `osm-${el.id}`, pos: [el.lon, el.lat], maxspeed: parseSpeed(el.tags?.maxspeed) ?? relSpeed.get(el.id) ?? null });
  }
  return { fixed, sections };
}

async function fetchDgt(center) {
  const res = await fetch(`${API_BASE}/api/dgt`);
  if (!res.ok) throw new Error(`DGT ${res.status}`);
  const data = await res.json();
  const near = (p) => distanceM(center, p) < FETCH_RADIUS_KM * 1000;
  return {
    fixed: data.fixed
      .filter(([lon, lat]) => near([lon, lat]))
      .map(([lon, lat, road]) => ({ id: `dgt-${lon},${lat}`, pos: [lon, lat], maxspeed: null, road })),
    sections: data.sections
      .filter((s) => near(s.from) || near(s.to))
      .map((s) => ({ id: `dgt-${s.from.join(',')}`, from: s.from, to: s.to, maxspeed: null, road: s.road })),
  };
}

// Junta OSM y DGT sin duplicar: si coinciden en el mismo sitio, se queda uno y se aprovecha el límite de OSM
function merge(osm, dgt) {
  const fixed = [...osm.fixed];
  for (const d of dgt.fixed) {
    const twin = fixed.find((o) => distanceM(o.pos, d.pos) < 120);
    if (twin) twin.road ||= d.road;
    else {
      // Límite: el de un radar de OSM cercano si lo hay
      const nearby = osm.fixed.find((o) => o.maxspeed && distanceM(o.pos, d.pos) < 300);
      fixed.push({ ...d, maxspeed: nearby?.maxspeed ?? null });
    }
  }

  const sections = [...osm.sections];
  for (const d of dgt.sections) {
    const twin = sections.find((o) => distanceM(o.from, d.from) < 400 || distanceM(o.from, d.to) < 400);
    if (twin) twin.road ||= d.road;
    else {
      const nearby = [...osm.sections, ...osm.fixed].find(
        (o) => o.maxspeed && distanceM(o.from ?? o.pos, d.from) < 1000,
      );
      sections.push({ ...d, maxspeed: nearby?.maxspeed ?? null });
    }
  }

  // Cada tramo se convierte en dos puntos de aviso: inicio y fin
  const cams = fixed.map((f) => ({ ...f, type: 'fixed' }));
  for (const s of sections) {
    const dir = bearingDeg(s.from, s.to);
    const length = distanceM(s.from, s.to);
    cams.push({ id: `${s.id}-a`, type: 'section_start', pos: s.from, maxspeed: s.maxspeed, road: s.road, sectionId: s.id, dir, length, end: s.to });
    cams.push({ id: `${s.id}-b`, type: 'section_end', pos: s.to, maxspeed: s.maxspeed, road: s.road, sectionId: s.id, dir, length });
  }
  return cams;
}

export class Radars {
  constructor(onChange) {
    this.onChange = onChange;
    const cache = loadJSON(LS_FIXED, null);
    this.fixed = cache?.cameras ?? [];
    this.fetchCenter = cache?.center ?? null;
    this.sources = cache?.sources ?? [];
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
        properties: {
          id: c.id,
          kind: c.type,
          mobile: c.type === 'mobile',
          label:
            c.type === 'section_start'
              ? `INICIO${c.maxspeed ? ` ${c.maxspeed}` : ''}`
              : c.type === 'section_end'
                ? 'FIN'
                : c.maxspeed
                  ? String(c.maxspeed)
                  : '',
          maxspeed: c.maxspeed ? String(c.maxspeed) : '',
        },
      })),
    };
  }

  async ensureLoaded(pos) {
    if (this.loading) return;
    if (this.fetchCenter && distanceM(pos, this.fetchCenter) < REFETCH_KM * 1000) return;
    this.loading = true;
    try {
      // Las dos fuentes en paralelo; si una falla, se usa la otra
      const [osm, dgt] = await Promise.allSettled([fetchOsm(pos), fetchDgt(pos)]);
      if (osm.status === 'rejected' && dgt.status === 'rejected') throw osm.reason;
      const empty = { fixed: [], sections: [] };
      this.fixed = merge(osm.value ?? empty, dgt.value ?? empty);
      this.sources = [osm.status === 'fulfilled' && 'OpenStreetMap', dgt.status === 'fulfilled' && 'DGT'].filter(Boolean);
      this.fetchCenter = pos;
      saveJSON(LS_FIXED, { center: pos, cameras: this.fixed, sources: this.sources });
      this.onChange();
    } catch (err) {
      console.warn('No se pudieron cargar los radares', err);
    } finally {
      this.loading = false;
    }
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
        .map((r) => ({ id: r.id, type: 'mobile', pos: [r.lon, r.lat], maxspeed: null, confirmations: r.confirmations }));
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
    if (!this.mobile.some((m) => m.id === id)) this.mobile.push({ id, type: 'mobile', pos, maxspeed: null });
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
  // skip: tipos que no deben avisar ahora (p. ej. el fin de un tramo en el que no estás).
  check(pos, heading, skip = () => false) {
    let best = null;
    for (const cam of this.all()) {
      const d = distanceM(pos, cam.pos);
      if (d > ALERT_FAR_M) {
        if (d > ALERT_FAR_M * 1.5) this.alerted.delete(cam.id);
        continue;
      }
      if (skip(cam)) continue;
      if (heading != null) {
        // Solo los que quedan delante
        if (d > 30 && angleDiff(bearingDeg(pos, cam.pos), heading) > 50) continue;
        // Tramos: solo en el sentido del tramo (de inicio a fin)
        if (cam.dir != null && angleDiff(cam.dir, heading) > 75) continue;
      }
      if (!best || d < best.distance) best = { cam, distance: d };
    }
    if (!best) return { ahead: null, level: 0 };

    const want = best.distance <= ALERT_NEAR_M ? 2 : 1;
    const had = this.alerted.get(best.cam.id) ?? 0;
    if (want > had) this.alerted.set(best.cam.id, want);
    return { ahead: best, level: want > had ? want : 0 };
  }

  // Inicio de tramo por el que acabas de pasar (para empezar a medir la velocidad media)
  sectionStartAt(pos, heading) {
    return this.fixed.find(
      (c) =>
        c.type === 'section_start' &&
        distanceM(pos, c.pos) < 45 &&
        (heading == null || angleDiff(c.dir, heading) < 75),
    );
  }
}
