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
const MOBILE_RADIUS_KM = 1500; // toda la Península, Baleares y Canarias
const HOTSPOTS_SYNC_MS = 30 * 60 * 1000;
const LS_HOTSPOTS = 'radar.hotspots';

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
// Primero el intermediario de la app (caché por zonas en Vercel); si no responde, Overpass directamente
async function fetchOsmElements([lon, lat]) {
  try {
    const res = await fetch(`${API_BASE}/api/osm?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`);
    if (res.ok) return (await res.json()).elements;
  } catch {}
  return fetchOverpassDirect([lon, lat]);
}

async function fetchOverpassDirect([lon, lat]) {
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
  return data.elements;
}

// ---------- OpenStreetMap: archivo semanal (España) ----------
// GitHub Actions extrae cada semana todos los radares de España de OpenStreetMap (Geofabrik) a este archivo.
// No depende de Overpass, que a menudo está saturado. Se guarda en el móvil y se renueva una vez al día.
const OSM_FILE_URL = 'https://raw.githubusercontent.com/Aaleexm/radar/main/data/radares-osm.json';
const LS_OSM_FILE = 'radar.osmFile';
const OSM_FILE_AREA = { minLon: -18.5, maxLon: 4.6, minLat: 27.4, maxLat: 44.0 }; // España con Canarias y Baleares
let osmFileMemo = null;

// Archivos de datos del repositorio: se guardan en el móvil y se renuevan una vez al día
const fileMemo = {};
async function loadRepoFile(url, lsKey) {
  const memo = fileMemo[lsKey];
  if (memo && Date.now() - memo.t < 24 * 3600 * 1000) return memo.data;
  const cached = loadJSON(lsKey, null);
  if (cached && Date.now() - cached.t < 24 * 3600 * 1000) {
    fileMemo[lsKey] = cached;
    return cached.data;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} ${res.status}`);
    const data = await res.json();
    fileMemo[lsKey] = { t: Date.now(), data };
    saveJSON(lsKey, fileMemo[lsKey]);
    return data;
  } catch (err) {
    if (cached) return cached.data; // sin conexión: la última copia, aunque sea antigua
    throw err;
  }
}

const loadOsmFile = () => loadRepoFile(OSM_FILE_URL, LS_OSM_FILE);

// ---------- Fuentes oficiales que no están en la lista de la DGT ----------
// Servei Català de Trànsit, Ayuntamiento de Madrid y tramos INVIVE de la DGT (vigilancia intensiva: radares móviles)
const OFFICIAL_FILE_URL = 'https://raw.githubusercontent.com/Aaleexm/radar/main/data/radares-oficiales.json';
const LS_OFFICIAL_FILE = 'radar.officialFile';

async function fetchOfficial() {
  const data = await loadRepoFile(OFFICIAL_FILE_URL, LS_OFFICIAL_FILE);
  return {
    fixed: data.fixed.map(([lon, lat, maxspeed, road, source]) => ({ id: `of-${lon},${lat}`, pos: [lon, lat], maxspeed: maxspeed ?? null, road, source })),
    sections: data.sections.map((x) => ({ id: `of-${x.from.join(',')}`, from: x.from, to: x.to, maxspeed: x.maxspeed ?? null, road: x.road ?? '', source: x.source })),
    zones: data.zones ?? [],
  };
}

function inOsmFileArea([lon, lat]) {
  const a = OSM_FILE_AREA;
  return lon >= a.minLon && lon <= a.maxLon && lat >= a.minLat && lat <= a.maxLat;
}

async function fetchOsm(center) {
  if (inOsmFileArea(center)) {
    try {
      // Todos los radares de España (se ven en todo el mapa; para los avisos se mira la distancia en cada momento)
      const data = await loadOsmFile();
      return {
        fixed: data.fixed.map(([lon, lat, maxspeed]) => ({ id: `osm-${lon},${lat}`, pos: [lon, lat], maxspeed: maxspeed ?? null })),
        sections: data.sections.map((x) => ({
          id: `osm-${x.from.join(',')}`,
          from: x.from,
          to: x.to,
          maxspeed: x.maxspeed ?? null,
          road: x.name ?? '',
        })),
        complete: true,
      };
    } catch (err) {
      console.warn('Archivo de radares OSM no disponible, pruebo Overpass', err);
    }
  }
  return fetchOsmLive(center);
}

// Fuera de España (o si el archivo falla): Overpass en directo, a través del intermediario con caché
async function fetchOsmLive(center) {
  const elements = await fetchOsmElements(center);
  const near = (el) => distanceM(center, [el.lon, el.lat]) < FETCH_RADIUS_KM * 1000 * 1.2;

  const nodes = new Map();
  for (const el of elements) if (el.type === 'node') nodes.set(el.id, el);

  const relSpeed = new Map(); // device -> límite (relaciones de velocidad puntual)
  const sectionDevices = new Set();
  const sections = [];
  for (const el of elements) {
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
    if (el.tags?.highway !== 'speed_camera' || sectionDevices.has(el.id) || !near(el)) continue;
    fixed.push({ id: `osm-${el.id}`, pos: [el.lon, el.lat], maxspeed: parseSpeed(el.tags?.maxspeed) ?? relSpeed.get(el.id) ?? null });
  }
  return { fixed, sections };
}

async function fetchDgt(center) {
  const res = await fetch(`${API_BASE}/api/dgt`);
  if (!res.ok) throw new Error(`DGT ${res.status}`);
  const data = await res.json();
  return {
    fixed: data.fixed.map(([lon, lat, road]) => ({ id: `dgt-${lon},${lat}`, pos: [lon, lat], maxspeed: null, road })),
    sections: data.sections.map((s) => ({ id: `dgt-${s.from.join(',')}`, from: s.from, to: s.to, maxspeed: null, road: s.road })),
  };
}

// Junta OSM y DGT sin duplicar: si coinciden en el mismo sitio, se queda uno y se aprovecha el límite de OSM
// Rejilla de ~1 km para buscar radares cercanos sin comparar todos con todos
function gridIndex(items, posOf) {
  const cells = new Map();
  for (const it of items) {
    const [lon, lat] = posOf(it);
    const k = `${Math.floor(lon * 100)},${Math.floor(lat * 100)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(it);
  }
  return (p) => {
    const out = [];
    const x = Math.floor(p[0] * 100);
    const y = Math.floor(p[1] * 100);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push(...(cells.get(`${x + dx},${y + dy}`) ?? []));
    return out;
  };
}

function merge(osm, dgt, official = { fixed: [], sections: [], zones: [] }) {
  // Primero los oficiales (Cataluña, Madrid), luego OSM sin repetir; si el oficial no trae límite, se usa el de OSM
  const fixed = [...official.fixed];
  const nearOfficial = gridIndex(official.fixed, (o) => o.pos);
  for (const o of osm.fixed) {
    const twin = nearOfficial(o.pos).find((f) => distanceM(f.pos, o.pos) < 80);
    if (twin) twin.maxspeed ??= o.maxspeed;
    else fixed.push(o);
  }
  osm = { ...osm, fixed, sections: [...official.sections, ...osm.sections.filter((s) => !official.sections.some((x) => distanceM(x.from, s.from) < 300))] };
  const nearOsm = gridIndex(osm.fixed, (o) => o.pos);
  for (const d of dgt.fixed) {
    const around = nearOsm(d.pos);
    const twin = around.find((o) => distanceM(o.pos, d.pos) < 120);
    if (twin) twin.road ||= d.road;
    else {
      // Límite: el de un radar de OSM cercano si lo hay
      const nearby = around.find((o) => o.maxspeed && distanceM(o.pos, d.pos) < 300);
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
  // Zonas INVIVE: se avisa al entrar por cualquiera de sus dos extremos (en ambos sentidos)
  official.zones.forEach((z, i) => {
    cams.push({ id: `zone-${i}-a`, type: 'zone', pos: z.from, road: z.road, dir: bearingDeg(z.from, z.to), maxspeed: null });
    cams.push({ id: `zone-${i}-b`, type: 'zone', pos: z.to, road: z.road, dir: bearingDeg(z.to, z.from), maxspeed: null });
  });
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
    this.hotspots = loadJSON(LS_HOTSPOTS, { t: 0, list: [] }).list;
    this.hotspotsAt = 0;
    this.device = deviceId();
    this.mine = new Set(loadJSON(LS_MINE, []));
    this.hidden = new Set(loadJSON(LS_HIDDEN, []));
    this.mobileSync = { t: 0, pos: null, busy: false };
    this.loading = false;
    this.alerted = new Map(); // id -> nivel de aviso ya emitido (1 = lejos, 2 = cerca)
  }

  all() {
    return [...this.fixed, ...this.mobile, ...this.hotspots];
  }

  // Puntos habituales de radar móvil: sitios reportados muchas veces por la comunidad (historial)
  async syncHotspots(pos) {
    if (Date.now() - this.hotspotsAt < HOTSPOTS_SYNC_MS) return;
    this.hotspotsAt = Date.now();
    try {
      const rows = await rpc('radar_hotspots', { p_lon: pos[0], p_lat: pos[1], p_radius_km: MOBILE_RADIUS_KM });
      this.hotspots = rows.map((r) => ({
        id: `hot-${r.lon.toFixed(4)},${r.lat.toFixed(4)}`,
        type: 'hotspot',
        pos: [r.lon, r.lat],
        maxspeed: null,
        reports: r.reports,
        days: r.days,
      }));
      saveJSON(LS_HOTSPOTS, { t: Date.now(), list: this.hotspots });
      this.onChange();
    } catch (err) {
      this.hotspotsAt = Date.now() - HOTSPOTS_SYNC_MS + 2 * 60 * 1000; // reintentar en 2 minutos
      console.warn('No se pudieron cargar los puntos habituales', err);
    }
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
                : c.type === 'zone'
                  ? 'VIGILANCIA'
                  : c.type === 'hotspot'
                    ? `HABITUAL ×${c.reports}`
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
    const retryDue = this.retryAt && Date.now() > this.retryAt;
    const fresh = this.complete && Date.now() - (this.loadedAt ?? 0) < 24 * 3600 * 1000;
    if (!retryDue && this.fetchCenter && (fresh || distanceM(pos, this.fetchCenter) < REFETCH_KM * 1000)) return;
    this.loading = true;
    try {
      // Las dos fuentes en paralelo; si una falla, se usa la otra
      const [osm, dgt, official] = await Promise.allSettled([fetchOsm(pos), fetchDgt(pos), fetchOfficial()]);
      if (osm.status === 'rejected' && dgt.status === 'rejected' && official.status === 'rejected') throw osm.reason;
      const empty = { fixed: [], sections: [], zones: [] };
      this.fixed = merge(osm.value ?? empty, dgt.value ?? empty, official.value ?? empty);
      this.complete = !!osm.value?.complete && dgt.status === 'fulfilled' && official.status === 'fulfilled';
      this.loadedAt = Date.now();
      this.sources = [
        osm.status === 'fulfilled' && 'OpenStreetMap',
        dgt.status === 'fulfilled' && 'DGT',
        official.status === 'fulfilled' && 'Oficiales (SCT, Madrid, INVIVE)',
      ].filter(Boolean);
      // Si una fuente falló, se vuelve a intentar en 2 minutos aunque no te hayas movido
      this.retryAt = this.sources.length < 3 ? Date.now() + 2 * 60 * 1000 : null;
      this.fetchCenter = pos;
      saveJSON(LS_FIXED, { center: pos, cameras: this.fixed, sources: this.sources });
      this.onChange();
    } catch (err) {
      console.warn('No se pudieron cargar los radares', err);
      this.retryAt = Date.now() + 60 * 1000;
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
      if (cam.type === 'hotspot' && this.mobile.some((m) => distanceM(m.pos, cam.pos) < 200)) continue;
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
