// Buscador de direcciones (Photon, OpenStreetMap) y ubicaciones guardadas en el móvil.

const LS_PLACES = 'radar.places';
export const PRESETS = [
  { name: 'Casa', icon: '🏠' },
  { name: 'Trabajo', icon: '💼' },
  { name: 'Gimnasio', icon: '🏋️' },
  { name: 'Colegio', icon: '🎓' },
  { name: 'Pareja', icon: '❤️' },
];
const DEFAULT_ICON = '⭐';

export function iconFor(name) {
  return PRESETS.find((p) => p.name.toLowerCase() === name.toLowerCase())?.icon ?? DEFAULT_ICON;
}

export function loadPlaces() {
  try {
    return JSON.parse(localStorage.getItem(LS_PLACES)) || [];
  } catch {
    return [];
  }
}

function storePlaces(list) {
  try {
    localStorage.setItem(LS_PLACES, JSON.stringify(list));
  } catch {}
}

// Guardar con un nombre que ya existe lo sustituye (p. ej. cambiar dónde está "Casa")
export function savePlace(name, pos, address = '') {
  const list = loadPlaces().filter((p) => p.name.toLowerCase() !== name.toLowerCase());
  list.push({ id: `${Date.now()}`, name, icon: iconFor(name), pos, address });
  // Primero los predeterminados en su orden, luego el resto por nombre
  const order = (p) => {
    const i = PRESETS.findIndex((x) => x.name === p.name);
    return i === -1 ? 100 : i;
  };
  list.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  storePlaces(list);
  return list;
}

export function deletePlace(id) {
  const list = loadPlaces().filter((p) => p.id !== id);
  storePlaces(list);
  return list;
}

function describe(props) {
  const street = [props.street, props.housenumber].filter(Boolean).join(' ');
  const parts = [props.name !== street ? street : '', props.district, props.city || props.town || props.village, props.state];
  return [...new Set(parts.filter(Boolean))].filter((p) => p !== props.name).join(', ');
}

// Petición con tiempo máximo: si el servicio no contesta, se pasa al de reserva
async function fetchJson(url, signal, ms = 4000) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), ms);
  const onAbort = () => timeout.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { signal: timeout.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Error ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function searchPhoton(query, near, signal) {
  const params = new URLSearchParams({ q: query, limit: '8', lang: 'default' });
  if (near) {
    params.set('lon', near[0].toFixed(5));
    params.set('lat', near[1].toFixed(5));
  }
  const data = await fetchJson(`https://photon.komoot.io/api/?${params}`, signal);
  return data.features.map((f) => {
    const p = f.properties;
    const title = p.name || [p.street, p.housenumber].filter(Boolean).join(' ') || p.city || 'Sin nombre';
    return { title, subtitle: describe({ ...p, name: title }), pos: f.geometry.coordinates };
  });
}

// Reserva: Nominatim (OpenStreetMap). Prioriza resultados cerca de ti con un recuadro de ~50 km.
async function searchNominatim(query, near, signal) {
  const params = new URLSearchParams({ format: 'jsonv2', q: query, limit: '8', 'accept-language': 'es', addressdetails: '1' });
  if (near) {
    const d = 0.45;
    params.set('viewbox', `${near[0] - d},${near[1] + d},${near[0] + d},${near[1] - d}`);
  }
  const data = await fetchJson(`https://nominatim.openstreetmap.org/search?${params}`, signal, 6000);
  return data.map((r) => {
    const a = r.address ?? {};
    const street = [a.road, a.house_number].filter(Boolean).join(' ');
    const title = r.name || street || r.display_name.split(',')[0];
    const subtitle = [street !== title ? street : '', a.suburb, a.city || a.town || a.village, a.state]
      .filter(Boolean)
      .filter((x, i, arr) => arr.indexOf(x) === i)
      .join(', ');
    return { title, subtitle, pos: [Number(r.lon), Number(r.lat)] };
  });
}

// Busca cerca de donde estás primero; si el buscador principal falla o tarda, usa el de reserva
export async function searchPlaces(query, near, signal) {
  try {
    return await searchPhoton(query, near, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    return searchNominatim(query, near, signal);
  }
}

// Dirección legible de un punto (para guardar un sitio tocado en el mapa)
export async function reverseGeocode(pos) {
  try {
    const f = (await fetchJson(`https://photon.komoot.io/reverse?lon=${pos[0]}&lat=${pos[1]}&limit=1`))?.features?.[0];
    if (!f) return '';
    const p = f.properties;
    const street = [p.street, p.housenumber].filter(Boolean).join(' ');
    return [p.name && p.name !== street ? p.name : '', street, p.city || p.town || p.village].filter(Boolean).join(', ');
  } catch {
    try {
      const r = await fetchJson(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lon=${pos[0]}&lat=${pos[1]}&accept-language=es`,
        null,
        6000,
      );
      const a = r.address ?? {};
      return [r.name, [a.road, a.house_number].filter(Boolean).join(' '), a.city || a.town || a.village].filter(Boolean).join(', ');
    } catch {
      return '';
    }
  }
}

// ---------- Ubicaciones compartidas (WhatsApp, Google Maps, Apple Maps, coordenadas) ----------
const COORD_PATTERNS = [
  /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/, // sitio de Google Maps (más preciso que el @ de la vista)
  /[?&](?:q|ll|query|daddr|destination|sll|center|coordinate|loc)=(?:loc:)?(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/,
  /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
  /geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
  /(?:^|[^\d.])(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/, // "40.4168, -3.7038"
];
const SHORT_LINK_HOSTS = /(?:maps\.app\.goo\.gl|goo\.gl|g\.co|maps\.apple|apple\.co)/i;

function coordsIn(text) {
  let t = text;
  try {
    t = decodeURIComponent(decodeURIComponent(text));
  } catch {}
  for (const re of COORD_PATTERNS) {
    const m = t.match(re);
    if (!m) continue;
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) return [lon, lat];
  }
  return null;
}

// Devuelve [lon, lat] o null. Los enlaces cortos se resuelven con /api/resolve (Vercel).
export async function parseSharedLocation(text) {
  if (!text) return null;
  const direct = coordsIn(text);
  if (direct) return direct;
  const url = text.match(/https?:\/\/\S+/)?.[0];
  if (!url || !SHORT_LINK_HOSTS.test(url)) return null;
  try {
    const base = location.protocol.startsWith('http') ? '' : 'https://map-coral-nine.vercel.app';
    const res = await fetch(`${base}/api/resolve?url=${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    const { url: finalUrl } = await res.json();
    return coordsIn(finalUrl || '');
  } catch {
    return null;
  }
}

export function looksLikeSharedLocation(text) {
  return /https?:\/\/|geo:/.test(text) || !!coordsIn(text);
}
