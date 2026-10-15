import { buildStyle } from './style.js';
import { registerBlipImages, LEGEND, blipDataURL } from './icons.js';
import { Radars, distanceM, bearingDeg, ALERT_NEAR_M } from './radars.js';
import {
  PRESETS,
  loadPlaces,
  savePlace,
  deletePlace,
  searchPlaces,
  reverseGeocode,
  parseSharedLocation,
  looksLikeSharedLocation,
} from './places.js';

const DEMO_POS = [-3.7038, 40.4168]; // Puerta del Sol, Madrid (si no hay GPS)
const $ = (sel) => document.querySelector(sel);

// Dentro de la app nativa (Capacitor): GPS en segundo plano y notificaciones con sonido
const NATIVE = !!window.Capacitor?.isNativePlatform?.();
const BgGeo = NATIVE ? window.Capacitor.registerPlugin('BackgroundGeolocation') : null;
const Notif = NATIVE ? window.Capacitor.registerPlugin('LocalNotifications') : null;
const Tts = NATIVE ? window.Capacitor.registerPlugin('TextToSpeech') : null;

// ---------- Ajustes persistentes ----------
const settings = Object.assign(
  { profile: 'driving', alerts: 'on', sound: 'on', voice: 'on' },
  (() => {
    try {
      return JSON.parse(localStorage.getItem('radar.settings')) || {};
    } catch {
      return {};
    }
  })(),
);
function saveSettings() {
  try {
    localStorage.setItem('radar.settings', JSON.stringify(settings));
  } catch {}
}

// ---------- Estado ----------
const state = {
  mode: 'radar',
  pos: null,
  heading: null, // grados respecto al norte
  compass: null,
  speedKmh: 0,
  accuracy: null,
  demo: false,
  lastFix: null,
  waypoint: null,
  route: null, // { coords: [[lon,lat]...], cum: [m...] }
  routing: false,
  lastReroute: 0,
  sim: null,
  alert: null,
  anim: { from: null, to: null, disp: null, t0: 0, dur: 0, lastFix: 0, heading: null, zoom: null, transitionUntil: 0, force: false },
  follow: true, // la cámara sigue a la flecha
  gesture: false, // el usuario está tocando el mapa
  userZoom: 0, // zoom extra elegido con los dedos o con + / −
  recenterTimer: null,
};

// ---------- Mapa ----------
const map = new maplibregl.Map({
  container: 'map',
  style: buildStyle(),
  center: DEMO_POS,
  zoom: 16,
  pitch: 55,
  attributionControl: false,
  maxPitch: 70,
  fadeDuration: 0,
  pixelRatio: Math.min(window.devicePixelRatio || 1, 2), // en pantallas 3x renderizar a 2x va mucho más suelto
});
registerBlipImages(map);
if (location.hostname === 'localhost') window.__map = map; // solo para pruebas en local
setInteractive(false);
map.setPadding(radarPadding());
window.addEventListener('resize', () => state.mode === 'radar' && map.setPadding(radarPadding()));

function setInteractive(mapMode) {
  for (const h of ['dragPan', 'scrollZoom', 'touchZoomRotate', 'doubleClickZoom']) map[h].enable();
  map.dragRotate.disable();
  map.keyboard.disable();
  map.touchPitch.disable();
  map.boxZoom.disable();
  map.touchZoomRotate.disableRotation();
  // En conducción el zoom se hace alrededor de tu flecha, no de donde pongas los dedos
  const around = mapMode ? undefined : 'center';
  map.scrollZoom.enable(around ? { around } : undefined);
  map.touchZoomRotate.enable(around ? { around } : undefined);
  map.touchZoomRotate.disableRotation();
}

// Jugador: flecha blanca de GTA
const playerEl = document.createElement('div');
playerEl.className = 'player';
playerEl.innerHTML =
  '<svg viewBox="0 0 30 30"><path d="M15 2 L26 27 L15 21 L4 27 Z" fill="#fff" stroke="#000" stroke-width="2" stroke-linejoin="round"/></svg>';
const playerMarker = new maplibregl.Marker({ element: playerEl, rotationAlignment: 'map', pitchAlignment: 'map' })
  .setLngLat(DEMO_POS)
  .addTo(map);

const wpEl = document.createElement('div');
wpEl.className = 'waypoint-marker';
wpEl.addEventListener('click', (e) => {
  e.stopPropagation();
  clearWaypoint();
});
const wpMarker = new maplibregl.Marker({ element: wpEl });

// ---------- Radares ----------
const radars = new Radars(() => {
  const src = map.getSource('cameras');
  if (src) src.setData(radars.geojson());
});
map.on('load', () => {
  map.getSource('cameras').setData(radars.geojson());
  if (state.route) setRouteData();
});

// ---------- UI general ----------
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function splash(big, small) {
  const s = $('#splash');
  s.querySelector('.splash-big').textContent = big;
  s.querySelector('.splash-small').textContent = small;
  s.classList.remove('hidden');
  s.style.animation = 'none';
  void s.offsetWidth;
  s.style.animation = '';
  setTimeout(() => s.classList.add('hidden'), 3300);
}

function fmtDist(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m / 10) * 10} m`;
}

function updateClock() {
  const d = new Date();
  $('#clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
updateClock();
setInterval(updateClock, 10000);

// Barras de "vida" (batería) y "blindaje" (precisión GPS)
async function initBattery() {
  if (!navigator.getBattery) return;
  try {
    const b = await navigator.getBattery();
    const upd = () => ($('#bar-battery').style.width = `${Math.round(b.level * 100)}%`);
    upd();
    b.addEventListener('levelchange', upd);
  } catch {}
}
// Barra azul: lo que queda de viaje (llena al salir, vacía al llegar). Encima, la hora estimada de llegada.
function updateTripBar(remainingM = null, remainingS = null) {
  const bar = $('#bar-route');
  const eta = $('#eta');
  if (remainingM == null || !state.tripTotal) {
    bar.style.width = '0%';
    eta.textContent = state.waypoint ? 'CALCULANDO RUTA…' : 'SIN DESTINO';
    eta.classList.remove('eta-on');
    return;
  }
  bar.style.width = `${Math.max(0, Math.min(100, (remainingM / state.tripTotal) * 100))}%`;
  const arrive = new Date(Date.now() + remainingS * 1000);
  const hh = String(arrive.getHours()).padStart(2, '0');
  const mm = String(arrive.getMinutes()).padStart(2, '0');
  const mins = Math.max(1, Math.round(remainingS / 60));
  const dur = mins >= 60 ? `${Math.floor(mins / 60)} H ${mins % 60} MIN` : `${mins} MIN`;
  eta.textContent = `LLEGADA ${hh}:${mm} · ${dur}`;
  eta.classList.add('eta-on');
}

// ---------- Sonido / vibración ----------
// Audio sin cortar tu música:
//  - El contexto de audio se desbloquea al pulsar EMPEZAR y se queda activo (en iPhone, si se suspende,
//    no se puede volver a activar sin tocar la pantalla y los avisos dejarían de sonar).
//  - Modo "ambient": suena mezclado con tu música, sin pausarla. Durante el aviso pasa a "transient",
//    que baja el volumen de la música un momento, y luego vuelve a "ambient".
let audioCtx;
let duckTimer;
function setSessionType(type) {
  try {
    if (navigator.audioSession) navigator.audioSession.type = type;
  } catch {}
}

function initAudio() {
  if (!audioCtx) {
    setSessionType('ambient');
    try {
      audioCtx = new AudioContext();
    } catch {
      return null;
    }
    // Si iOS lo interrumpe (llamada, Siri…), se reactiva en cuanto se pueda
    audioCtx.addEventListener('statechange', () => {
      if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
    });
  }
  if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function duckMusicFor(ms) {
  setSessionType('transient');
  clearTimeout(duckTimer);
  duckTimer = setTimeout(() => setSessionType('ambient'), ms);
}

// Devuelve cuánto dura (ms) para que la voz hable justo después del pitido
function beep(times, freq, gap = 0.16) {
  if (settings.sound !== 'on') return 0;
  const ctx = initAudio();
  if (!ctx) return 0;
  try {
    const ms = Math.round(times * gap * 1000) + 60;
    duckMusicFor(ms + 4500); // margen para la voz que viene detrás
    const t0 = ctx.currentTime + 0.03;
    for (let i = 0; i < times; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + i * gap);
      g.gain.exponentialRampToValueAtTime(0.6, t0 + i * gap + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * gap + gap * 0.8);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + i * gap);
      o.stop(t0 + i * gap + gap);
    }
    return ms;
  } catch {
    return 0;
  }
}

// ---------- Voz ----------
function speak(text, delayMs = 0) {
  if (settings.sound !== 'on' || settings.voice !== 'on' || !text) return;
  setTimeout(() => {
    if (NATIVE && Tts) {
      Tts.speak({ text, lang: 'es-ES', rate: 1.0, pitch: 1.0, volume: 1.0, category: 'ambient', queueStrategy: 0 }).catch((e) => {
        console.warn('Voz nativa no disponible, uso la del navegador', e);
        webSpeak(text);
      });
      return;
    }
    webSpeak(text);
  }, delayMs);
}

function webSpeak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'es-ES';
  const voice = speechSynthesis.getVoices().find((v) => v.lang?.startsWith('es'));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

function spokenDist(m) {
  if (m >= 950) return `${(m / 1000).toFixed(1).replace('.', ' coma ').replace(' coma 0', '')} kilómetros`;
  return `${Math.max(50, Math.round(m / 50) * 50)} metros`;
}

// ---------- Posición ----------
function handleFix({ lon, lat, speed, heading, accuracy, t }) {
  if (state.sim) return;
  state.demo = false;
  const pos = [lon, lat];
  if ((speed == null || Number.isNaN(speed)) && state.lastFix) {
    const dt = (t - state.lastFix.t) / 1000;
    if (dt > 0) speed = distanceM(state.lastFix.pos, pos) / dt;
  }
  state.lastFix = { pos, t };
  const h = speed > 1.5 && heading != null && !Number.isNaN(heading) && heading >= 0 ? heading : null;
  onPosition(pos, { heading: h, speed: speed ?? 0, accuracy });
}

function startGeolocation() {
  if (NATIVE) return startNativeGeolocation();
  if (!navigator.geolocation) return enterDemo('Este dispositivo no tiene GPS');
  navigator.geolocation.watchPosition(
    (p) =>
      handleFix({
        lon: p.coords.longitude,
        lat: p.coords.latitude,
        speed: p.coords.speed,
        heading: p.coords.heading,
        accuracy: p.coords.accuracy,
        t: p.timestamp,
      }),
    (err) => enterDemo(err.code === 1 ? 'Permiso de ubicación denegado' : 'No se encuentra señal GPS'),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
  );
}

// App nativa: el GPS sigue funcionando con la pantalla bloqueada o en otra app
function startNativeGeolocation() {
  BgGeo.addWatcher(
    {
      backgroundTitle: 'Radar activo',
      backgroundMessage: 'Avisando de radares',
      requestPermissions: true,
      stale: false,
      distanceFilter: 5,
    },
    (loc, err) => {
      if (err) {
        if (err.code === 'NOT_AUTHORIZED') {
          if (confirm('Radar necesita tu ubicación para avisarte de los radares. ¿Abrir Ajustes?')) BgGeo.openSettings();
          return enterDemo('Permiso de ubicación denegado');
        }
        return console.warn(err);
      }
      handleFix({
        lon: loc.longitude,
        lat: loc.latitude,
        speed: loc.speed,
        heading: loc.bearing,
        accuracy: loc.accuracy,
        t: loc.time ?? Date.now(),
      });
    },
  ).catch((e) => enterDemo(`GPS no disponible (${e.message})`));
}

// Con la app en segundo plano no se puede usar el audio de la web: se avisa con una notificación (suena)
let notifId = 1;
function notifyRadar(title, body) {
  if (!NATIVE || document.visibilityState === 'visible' || settings.sound !== 'on') return;
  Notif.schedule({ notifications: [{ id: notifId++, title, body }] }).catch((e) => console.warn(e));
}

function enterDemo(reason) {
  if (state.pos && !state.demo) return; // ya teníamos GPS; error puntual
  state.demo = true;
  toast(`${reason} · modo demo. En el mapa, mantén pulsado para moverte.`, 5000);
  onPosition(state.pos ?? DEMO_POS, { heading: state.heading, speed: 0, accuracy: null });
  $('#btn-sim').classList.toggle('hidden', !state.route);
}

function startCompass() {
  const handler = (e) => {
    let h = null;
    if (e.webkitCompassHeading != null) h = e.webkitCompassHeading;
    else if (e.absolute && e.alpha != null) h = 360 - e.alpha;
    if (h == null) return;
    h = (h + (screen.orientation?.angle ?? 0)) % 360;
    state.compass = h;
  };
  if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', handler);
  else window.addEventListener('deviceorientation', handler);

  // Parado: la brújula manda (refresco suave)
  setInterval(() => {
    if (state.compass == null || state.speedKmh > 5 || !state.pos) return;
    state.heading = state.compass;
  }, 200);
}

function radarPadding() {
  // Margen arriba: el centro de la cámara (donde va la flecha) baja a ~2/3 de la pantalla y se ve más carretera por delante
  return { top: Math.round(window.innerHeight * 0.3), bottom: 0, left: 0, right: 0 };
}

function radarZoom() {
  const v = state.speedKmh;
  if (v < 20) return 17.3;
  if (v < 60) return 16.6;
  if (v < 100) return 16;
  return 15.4;
}

function onPosition(pos, { heading, speed, accuracy }) {
  state.pos = pos;
  state.speedKmh = Math.max(0, (speed || 0) * 3.6);
  state.accuracy = accuracy;
  if (heading != null) state.heading = heading;

  // La animación (bucle de abajo) desliza la flecha y la cámara desde donde están hasta la nueva posición
  const now = performance.now();
  const anim = state.anim;
  anim.from = anim.disp ? [...anim.disp] : pos;
  anim.to = pos;
  anim.dur = anim.lastFix ? Math.min(Math.max(now - anim.lastFix, 250), 1500) : 0;
  anim.t0 = now;
  anim.lastFix = now;

  $('#speed-val').textContent = Math.round(state.speedKmh);

  radars.ensureLoaded(pos);
  radars.syncMobile(pos);
  checkRadars();
  updateRouteProgress();
  scheduleLocationNames();
}

// ---------- Animación continua (60 fps) de la flecha y la cámara ----------
const TURN_SMOOTH_MS = 700; // cuanto más alto, más suave (y algo más lento) gira la cámara
const MAX_TURN_DEG_S = 90;
let lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const anim = state.anim;
  const dt = Math.min(now - lastFrame, 100);
  lastFrame = now;
  if (!anim.to) return;

  // Posición: interpolación lineal entre el fix anterior y el nuevo (durante lo que tardó en llegar)
  const k = anim.dur ? Math.min((now - anim.t0) / anim.dur, 1) : 1;
  const disp = [anim.from[0] + (anim.to[0] - anim.from[0]) * k, anim.from[1] + (anim.to[1] - anim.from[1]) * k];
  const moved = !anim.disp || disp[0] !== anim.disp[0] || disp[1] !== anim.disp[1];
  anim.disp = disp;

  // Rumbo y zoom: se acercan suavemente al objetivo
  const target = state.heading ?? anim.heading ?? 0;
  const prevHeading = anim.heading;
  // Giro progresivo: se acerca al rumbo objetivo con suavidad y nunca a más de MAX_TURN grados/segundo
  if (anim.heading == null) anim.heading = target;
  else {
    const diff = ((target - anim.heading + 540) % 360) - 180;
    let step = diff * (1 - Math.exp(-dt / TURN_SMOOTH_MS));
    const maxStep = (MAX_TURN_DEG_S * dt) / 1000;
    step = Math.max(-maxStep, Math.min(maxStep, step));
    anim.heading = (anim.heading + step + 360) % 360;
  }
  const zoomTarget = radarZoom() + state.userZoom;
  const prevZoom = anim.zoom;
  anim.zoom = anim.zoom == null ? zoomTarget : anim.zoom + (zoomTarget - anim.zoom) * (1 - Math.exp(-dt / 900));

  const turned = prevHeading == null || Math.abs(((anim.heading - prevHeading + 540) % 360) - 180) > 0.01;
  const zoomed = prevZoom == null || Math.abs(anim.zoom - prevZoom) > 0.0005;
  const inTransition = now < anim.transitionUntil;
  if (anim.wasInTransition && !inTransition) anim.force = true; // al acabar la transición, retomar ya
  anim.wasInTransition = inTransition;
  if (!moved && !turned && !zoomed && !anim.force) return; // nada que mover: no gastar batería

  playerMarker.setLngLat(disp);
  if (state.heading != null) playerMarker.setRotation(anim.heading);
  if (state.mode === 'radar' && state.follow && !state.gesture && !inTransition) {
    map.jumpTo({ center: disp, bearing: anim.heading, zoom: anim.zoom, pitch: 55 });
  }
  anim.force = false;
}
requestAnimationFrame(frame);

// ---------- Avisos de radar ----------
const KIND = {
  fixed: { title: 'RADAR FIJO', say: 'Radar fijo' },
  mobile: { title: 'RADAR MÓVIL', say: 'Radar móvil' },
  section_start: { title: 'INICIO DE TRAMO', say: 'Inicio de radar de tramo' },
  section_end: { title: 'FIN DE TRAMO', say: 'Fin de radar de tramo' },
};

function alertMessage(cam, distance, level, over) {
  const k = KIND[cam.type] ?? KIND.fixed;
  const limit = cam.maxspeed ? ` de ${cam.maxspeed}` : '';
  if (cam.type === 'section_end') return `${k.say} a ${spokenDist(distance)}.`;
  if (level === 2 && over) return `${k.say}${limit} a ${spokenDist(distance)}. Reduce la velocidad.`;
  return `${k.say}${limit} a ${spokenDist(distance)}.`;
}

function checkRadars() {
  updateSection();
  if (settings.alerts !== 'on' || !state.pos) return hideAlert();
  const moving = state.speedKmh > 5;
  // El fin de un tramo solo se avisa si estás dentro de ese tramo (o si no sabemos dónde empezaste)
  const skip = (c) => c.type === 'section_end' && state.section && state.section.id !== c.sectionId;
  const { ahead, level } = radars.check(state.pos, moving ? state.heading : null, skip);
  if (!ahead) return hideAlert();

  const { cam, distance } = ahead;
  const k = KIND[cam.type] ?? KIND.fixed;
  const el = $('#radar-alert');
  el.classList.remove('hidden');
  el.classList.toggle('near', distance <= ALERT_NEAR_M);
  el.classList.toggle('mobile', cam.type === 'mobile');
  el.classList.toggle('section', cam.type === 'section_start' || cam.type === 'section_end');
  el.querySelector('.ra-icon').style.backgroundImage = `url(${icons[cam.type] ?? icons.fixed})`;
  el.querySelector('.ra-title').textContent = k.title + (cam.road ? ` · ${cam.road}` : '');
  el.querySelector('.ra-dist').textContent = fmtDist(distance);
  const lim = el.querySelector('.ra-limit');
  lim.classList.toggle('hidden', !cam.maxspeed);
  lim.textContent = cam.maxspeed ?? '';

  const over = cam.maxspeed && state.speedKmh > cam.maxspeed + 2;
  $('#speed').classList.toggle('over', !!over);

  if (level) {
    const ms = level === 1 ? beep(2, 880) : beep(over ? 5 : 3, over ? 1500 : 1200, 0.11);
    navigator.vibrate?.(level === 1 ? [150, 80, 150] : over ? [300, 100, 300, 100, 300] : [200, 80, 200]);
    const msg = alertMessage(cam, distance, level, over);
    speak(msg, ms);
    notifyRadar(`⚠️ ${k.title.charAt(0) + k.title.slice(1).toLowerCase()} a ${fmtDist(distance)}`, msg);
  }
  state.alert = cam.id;
}

// ---------- Tramo: velocidad media ----------
function updateSection() {
  if (!state.pos) return;
  const now = Date.now();
  const sec = state.section;

  if (!sec) {
    const start = radars.sectionStartAt(state.pos, state.speedKmh > 5 ? state.heading : null);
    if (start && state.lastSectionId !== start.sectionId) {
      state.section = { id: start.sectionId, maxspeed: start.maxspeed, end: start.end, length: start.length, t0: now, dist: 0, last: state.pos, warned: false, minToEnd: Infinity };
      state.lastSectionId = start.sectionId;
      speak(start.maxspeed ? `Entras en el tramo. Límite ${start.maxspeed}.` : 'Entras en el tramo de radar.');
    }
    return renderSection();
  }

  sec.dist += distanceM(sec.last, state.pos);
  sec.last = state.pos;
  const hours = (now - sec.t0) / 3600000;
  sec.avg = hours > 0.0008 ? sec.dist / 1000 / hours : state.speedKmh;

  if (sec.maxspeed && sec.avg > sec.maxspeed + 2 && sec.dist > 300 && !sec.warned) {
    sec.warned = true;
    speak(`Atención: tu velocidad media es ${Math.round(sec.avg)}, por encima de ${sec.maxspeed}.`);
  }
  if (sec.maxspeed && sec.avg <= sec.maxspeed) sec.warned = false;

  // Fin: al pasar por el punto final (o si nos alejamos de él tras acercarnos, o tras recorrer de más)
  const toEnd = sec.end ? distanceM(state.pos, sec.end) : Infinity;
  sec.minToEnd = Math.min(sec.minToEnd, toEnd);
  const passed = toEnd < 40 || (sec.minToEnd < 250 && toEnd > sec.minToEnd + 80);
  if (passed || sec.dist > sec.length * 1.6 + 2000 || now - sec.t0 > 60 * 60000) {
    speak(`Fin del tramo. Velocidad media ${Math.round(sec.avg ?? 0)}.`);
    state.section = null;
  }
  renderSection();
}

function renderSection() {
  const el = $('#section-hud');
  const sec = state.section;
  if (!sec) return el.classList.add('hidden');
  el.classList.remove('hidden');
  const avg = Math.round(sec.avg ?? 0);
  el.classList.toggle('over', !!(sec.maxspeed && avg > sec.maxspeed));
  el.innerHTML = `<span>TRAMO${sec.maxspeed ? ` ${sec.maxspeed}` : ''}</span><b>MEDIA ${avg}</b><small>km/h</small>`;
}

function hideAlert() {
  $('#radar-alert').classList.add('hidden');
  $('#speed').classList.remove('over');
  state.alert = null;
}

const icons = {
  fixed: blipDataURL('b-camera'),
  mobile: blipDataURL('b-camera-mobile'),
  section_start: blipDataURL('b-camera-section'),
  section_end: blipDataURL('b-camera-section'),
};

$('#btn-report').addEventListener('click', async () => {
  if (!state.pos) return;
  const btn = $('#btn-report');
  btn.disabled = true;
  try {
    const existed = await radars.reportMobile(state.pos);
    beep(1, 660);
    toast(existed ? 'Radar móvil confirmado. ¡Gracias!' : 'Radar móvil compartido con todos (caduca en 3 h)');
  } catch (err) {
    toast(`No se pudo reportar: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

// Aunque estés parado, refresca los radares móviles de los demás cada minuto
setInterval(() => state.pos && radars.syncMobile(state.pos), 60 * 1000);

// ---------- Nombre de zona y calle ----------
let namesTimer = 0;
function scheduleLocationNames() {
  const now = Date.now();
  if (now - namesTimer < 1500) return;
  namesTimer = now;
  if (!map.isStyleLoaded()) return;

  const p = map.project(state.pos);
  const feats = map.queryRenderedFeatures(
    [
      [p.x - 14, p.y - 14],
      [p.x + 14, p.y + 14],
    ],
    { layers: ['street-hit'] },
  );
  const street = feats.map((f) => f.properties['name:es'] || f.properties.name).find(Boolean);
  if (street) $('#street-name').textContent = street;

  const places = map.querySourceFeatures('omt', { sourceLayer: 'place' });
  const rank = { neighbourhood: 0, quarter: 0, suburb: 1, village: 2, town: 3, city: 4 };
  let best = null;
  for (const f of places) {
    const cls = f.properties.class;
    if (!(cls in rank) || f.geometry.type !== 'Point') continue;
    const d = distanceM(state.pos, f.geometry.coordinates);
    const limit = [1500, 1500, 3000, 4000, 8000, 20000][rank[cls]];
    if (d > limit) continue;
    const score = rank[cls] * 1000 + d / 10;
    if (!best || score < best.score) best = { score, name: f.properties['name:es'] || f.properties.name };
  }
  if (best) $('#area-name').textContent = best.name;
}

// ---------- Blips en el borde (norte y destino) ----------
function edgePoint(fromPx, toPx, margin = 20) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const dx = toPx.x - fromPx.x;
  const dy = toPx.y - fromPx.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const tx = ux > 0 ? (W - margin - fromPx.x) / ux : ux < 0 ? (margin - fromPx.x) / ux : Infinity;
  const ty = uy > 0 ? (H - margin - fromPx.y) / uy : uy < 0 ? (margin + 60 - fromPx.y) / uy : Infinity;
  const t = Math.min(tx, ty);
  return { x: fromPx.x + ux * t, y: fromPx.y + uy * t };
}

function offset(pos, bearing, meters) {
  const R = 6371000;
  const b = (bearing * Math.PI) / 180;
  const lat1 = (pos[1] * Math.PI) / 180;
  const lon1 = (pos[0] * Math.PI) / 180;
  const d = meters / R;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI];
}

map.on('render', () => {
  if (state.mode !== 'radar' || !state.pos) return;
  const here = state.anim.disp ?? state.pos;
  const p = map.project(here);

  const n = edgePoint(p, map.project(offset(here, 0, 50)));
  Object.assign($('#edge-north').style, { left: `${n.x}px`, top: `${n.y}px` });

  const wpEdge = $('#edge-waypoint');
  if (!state.waypoint) return wpEdge.classList.add('hidden');
  const wp = map.project(state.waypoint);
  const inView = wp.x > 10 && wp.x < window.innerWidth - 10 && wp.y > 70 && wp.y < window.innerHeight - 10;
  const behind = distanceM(state.pos, state.waypoint) > 3000; // con inclinación, lejos = fiable solo por rumbo
  if (inView && !behind) return wpEdge.classList.add('hidden');
  const e = edgePoint(p, map.project(offset(state.pos, bearingDeg(state.pos, state.waypoint), 50)));
  wpEdge.classList.remove('hidden');
  Object.assign(wpEdge.style, { left: `${e.x}px`, top: `${e.y}px` });
});

// ---------- Destino y ruta ----------
function setWaypoint(lngLat, label = '') {
  state.waypoint = lngLat;
  state.waypointLabel = label;
  state.tripTotal = null;
  updateTripBar();
  wpMarker.setLngLat(lngLat).addTo(map);
  $('#btn-clear-wp').classList.remove('hidden');
  $('#btn-save-place').classList.remove('hidden');
  // La cámara enseña ya dónde estás y a dónde vas; cuando llegue la ruta se ajusta a ella entera
  showTrip([state.anim.disp ?? state.pos, lngLat].filter(Boolean));
  fetchRoute(true, true);
  scheduleAutoReturn();
}

// Tras elegir destino: se ve la ruta unos segundos y se vuelve sola a la vista de conducción,
// salvo que toques algo del mapa o del menú en ese tiempo
function scheduleAutoReturn() {
  clearTimeout(state.autoReturn);
  if (state.mode !== 'map') return;
  toast('Ruta lista. Volviendo a la conducción… (toca para quedarte)', 3800);
  state.autoReturn = setTimeout(() => {
    if (state.mode === 'map' && $('#save-dialog').classList.contains('hidden')) closeMap();
  }, 4000);
}

function cancelAutoReturn() {
  if (!state.autoReturn) return;
  clearTimeout(state.autoReturn);
  state.autoReturn = null;
  $('#toast').classList.add('hidden');
}

// Encuadra unos puntos en el modo mapa (en el modo radar la cámara sigue a la flecha)
function showTrip(points) {
  if (state.mode !== 'map' || !points.length) return;
  if (points.length === 1) return map.easeTo({ center: points[0], zoom: 15, duration: 600 });
  const b = new maplibregl.LngLatBounds();
  points.forEach((p) => b.extend(p));
  const top = ($('#pause-header')?.offsetHeight ?? 140) + 30;
  const bottom = ($('#pause-footer')?.offsetHeight ?? 120) + 30;
  map.fitBounds(b, { padding: { top, bottom, left: 50, right: 50 }, maxZoom: 16, duration: 700 });
}

function clearWaypoint() {
  state.waypoint = null;
  state.route = null;
  state.tripTotal = null;
  updateTripBar();
  wpMarker.remove();
  stopSim();
  setRouteData();
  $('#btn-clear-wp').classList.add('hidden');
  $('#btn-save-place').classList.add('hidden');
  $('#btn-sim').classList.add('hidden');
  $('#wp-distance').classList.add('hidden');
}

async function fetchRoute(fit = false, force = false) {
  if (!state.pos || !state.waypoint) return;
  // Si ya se está calculando otra ruta, esta se hace justo después (antes se perdía y la cámara no se movía)
  if (state.routing) {
    if (force) state.pendingRoute = { fit };
    return;
  }
  state.routing = true;
  state.lastReroute = Date.now();
  const target = state.waypoint;
  const coords = `${state.pos[0]},${state.pos[1]};${target[0]},${target[1]}`;
  const base = settings.profile === 'foot' ? 'routed-foot' : 'routed-car';
  const urls = [
    `https://routing.openstreetmap.de/${base}/route/v1/driving/${coords}?overview=full&geometries=geojson`,
    ...(settings.profile === 'driving'
      ? [`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`]
      : []),
  ];
  try {
    let route;
    for (const url of urls) {
      try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.routes?.length) {
          route = data.routes[0];
          break;
        }
      } catch {}
    }
    if (!route) throw new Error('sin ruta');
    if (state.waypoint !== target) return; // el destino cambió mientras tanto; la nueva ruta va en camino
    const c = route.geometry.coordinates;
    const cum = [0];
    for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + distanceM(c[i - 1], c[i]));
    state.route = { coords: c, cum, duration: route.duration };
    // La barra se mide respecto al viaje completo; si recalcula por desvío no vuelve a llenarse
    state.tripTotal ??= cum[cum.length - 1];
    state.tripTotal = Math.max(state.tripTotal, cum[cum.length - 1]);
    setRouteData();
    if (state.demo) $('#btn-sim').classList.remove('hidden');
    if (fit) showTrip(c);
    updateRouteProgress();
  } catch {
    toast('No se pudo calcular la ruta');
  } finally {
    state.routing = false;
    const pending = state.pendingRoute;
    state.pendingRoute = null;
    if (pending) fetchRoute(pending.fit, true);
  }
}

function setRouteData() {
  const src = map.getSource('route');
  if (!src) return;
  src.setData(
    state.route
      ? { type: 'Feature', geometry: { type: 'LineString', coordinates: state.route.coords }, properties: {} }
      : { type: 'FeatureCollection', features: [] },
  );
}

function updateRouteProgress() {
  if (!state.waypoint || !state.pos) return;
  const toWp = distanceM(state.pos, state.waypoint);
  if (toWp < 30) {
    clearWaypoint();
    beep(3, 990, 0.12);
    splash('DESTINO ALCANZADO', 'Has llegado');
    return;
  }
  if (!state.route) return;

  // Punto de la ruta más cercano -> distancia restante y desvío
  const { coords, cum } = state.route;
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = distanceM(state.pos, coords[i]);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  const remaining = cum[cum.length - 1] - cum[bi] + bd;
  const el = $('#wp-distance');
  el.textContent = fmtDist(remaining);
  el.classList.remove('hidden');

  // Tiempo restante: la parte proporcional de lo que estima el servidor de rutas para el trayecto
  const routeLen = cum[cum.length - 1] || 1;
  updateTripBar(remaining, (state.route.duration ?? 0) * Math.min(1, remaining / routeLen));

  if (bd > 60 && Date.now() - state.lastReroute > 12000 && !state.sim) fetchRoute();
}

// ---------- Simulación (modo demo) ----------
function startSim() {
  if (!state.route) return;
  stopSim();
  const kmh = settings.profile === 'foot' ? 6 : 50;
  const step = kmh / 3.6; // metros por segundo
  const { coords, cum } = state.route;
  let dist = 0;
  state.sim = setInterval(() => {
    dist += step;
    if (dist >= cum[cum.length - 1]) {
      onPosition(coords[coords.length - 1], { heading: state.heading, speed: 0, accuracy: 5 });
      return stopSim();
    }
    let i = cum.findIndex((c) => c > dist) - 1;
    i = Math.max(0, i);
    const t = (dist - cum[i]) / (cum[i + 1] - cum[i] || 1);
    const a = coords[i];
    const b = coords[i + 1];
    const pos = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    onPosition(pos, { heading: bearingDeg(a, b), speed: step, accuracy: 5 });
  }, 1000);
  closeMap();
}

function stopSim() {
  if (state.sim) clearInterval(state.sim);
  state.sim = null;
}

$('#btn-sim').addEventListener('click', startSim);

// ---------- Modo mapa (menú de pausa) ----------
// Nombres de barrios solo en el modo mapa (si el mapa aún está cargando, se aplica al terminar)
function setPlaceLabels(visible) {
  const apply = () => map.setLayoutProperty('place-label', 'visibility', state.mode === 'map' ? 'visible' : 'none');
  try {
    apply();
  } catch {
    map.once('load', apply);
  }
}

function openMap() {
  state.mode = 'map';
  document.body.classList.replace('mode-radar', 'mode-map');
  setInteractive(true);
  setPlaceLabels(true);
  map.easeTo({
    center: state.anim.disp ?? state.pos ?? map.getCenter(),
    zoom: 14,
    pitch: 0,
    bearing: 0,
    padding: { top: 0, bottom: 0, left: 0, right: 0 },
    duration: 600,
  });
  selectTab('map');
}

function closeMap() {
  state.mode = 'radar';
  document.body.classList.replace('mode-map', 'mode-radar');
  setInteractive(false);
  setPlaceLabels(false);
  recenter();
}

function recenter() {
  state.follow = true;
  state.gesture = false;
  clearTimeout(state.recenterTimer);
  $('#btn-recenter').classList.add('hidden');
  const anim = state.anim;
  if (!anim.disp || state.mode !== 'radar') return;
  // Transición suave de vuelta a la vista de radar; pasado ese tiempo el bucle de animación retoma el control
  // pase lo que pase (antes esperaba un evento que, si la animación se cortaba, no llegaba nunca)
  clearTimeout(state.autoReturn);
  map.stop();
  anim.transitionUntil = performance.now() + 650;
  map.easeTo({
    center: anim.disp,
    bearing: anim.heading ?? 0,
    zoom: anim.zoom ?? radarZoom(),
    pitch: 55,
    padding: radarPadding(),
    duration: 600,
  });
}

$('#btn-open-map').addEventListener('click', openMap);

// ---------- Zoom y "mirar alrededor" en conducción ----------
const MIN_USER_ZOOM = -5;
const MAX_USER_ZOOM = 3;
function setUserZoom(z) {
  state.userZoom = Math.max(MIN_USER_ZOOM, Math.min(MAX_USER_ZOOM, z));
  state.anim.force = true;
}

function stopFollowing() {
  if (state.mode !== 'radar') return;
  state.follow = false;
  $('#btn-recenter').classList.remove('hidden');
  armAutoRecenter();
}

// Si no tocas nada en 15 s, la cámara vuelve sola a seguirte
function armAutoRecenter() {
  clearTimeout(state.recenterTimer);
  state.recenterTimer = setTimeout(() => !state.follow && state.mode === 'radar' && recenter(), 15000);
}

map.on('zoomstart', (e) => {
  if (e.originalEvent && state.mode === 'radar') state.gesture = true;
});
map.on('zoomend', (e) => {
  if (!e.originalEvent || state.mode !== 'radar') return;
  state.gesture = false;
  // Lo que el usuario ha ampliado o alejado se guarda como zoom extra
  setUserZoom(map.getZoom() - radarZoom());
  state.anim.zoom = map.getZoom();
  if (!state.follow) armAutoRecenter();
});
map.on('dragstart', (e) => {
  if (e.originalEvent && state.mode === 'radar') stopFollowing();
});
map.on('dragend', () => !state.follow && armAutoRecenter());

$('#btn-zoom-in').addEventListener('click', () => {
  setUserZoom(state.userZoom + 1);
  if (!state.follow) map.zoomIn();
});
$('#btn-zoom-out').addEventListener('click', () => {
  setUserZoom(state.userZoom - 1);
  if (!state.follow) map.zoomOut();
});
$('#btn-recenter').addEventListener('click', recenter);
$('#pause').addEventListener('pointerdown', cancelAutoReturn);
['dragstart', 'zoomstart'].forEach((ev) => map.on(ev, (e) => e.originalEvent && cancelAutoReturn()));
$('#btn-close-map').addEventListener('click', closeMap);
$('#btn-center').addEventListener('click', () => state.pos && map.easeTo({ center: state.pos, zoom: 15.5, duration: 500 }));
$('#btn-clear-wp').addEventListener('click', clearWaypoint);

map.on('click', (e) => {
  if (state.mode !== 'map' || $('#pause .panel:not(.hidden)')) return;
  if (!$('#search-results').classList.contains('hidden')) return closeSearch();
  const cam = map.queryRenderedFeatures(
    [
      [e.point.x - 14, e.point.y - 14],
      [e.point.x + 14, e.point.y + 14],
    ],
    { layers: ['cameras'] },
  )[0];
  if (cam) {
    const { id, mobile, maxspeed, kind } = cam.properties;
    if (mobile) {
      const mine = radars.isMine(id);
      const msg = mine ? '¿Quitar tu radar móvil para todos?' : '¿Este radar móvil ya no está? (con 3 avisos se quita para todos)';
      if (confirm(msg)) {
        radars
          .removeMobile(id)
          .then(() => toast(mine ? 'Radar quitado' : 'Gracias, aviso enviado'))
          .catch((err) => toast(`No se pudo enviar: ${err.message}`));
      }
    } else {
      const name = { section_start: 'Inicio de tramo', section_end: 'Fin de tramo' }[kind] ?? 'Radar fijo';
      toast(`${name}${maxspeed ? ` · límite ${maxspeed} km/h` : ' · límite desconocido'}`);
    }
    return;
  }
  setWaypoint([e.lngLat.lng, e.lngLat.lat]);
});

// Mantener pulsado (o clic derecho) en modo demo: mover al jugador
function teleport(lngLat) {
  if (!state.demo || state.mode !== 'map') return;
  stopSim();
  onPosition([lngLat.lng, lngLat.lat], { heading: state.heading, speed: 0, accuracy: null });
  toast('Te has movido aquí');
  if (state.waypoint) fetchRoute();
}
map.on('contextmenu', (e) => teleport(e.lngLat));
let pressTimer;
map.on('touchstart', (e) => {
  if (e.originalEvent.touches.length !== 1) return;
  pressTimer = setTimeout(() => teleport(e.lngLat), 650);
});
['touchend', 'touchmove', 'touchcancel', 'movestart'].forEach((ev) => map.on(ev, () => clearTimeout(pressTimer)));

// Pestañas
function selectTab(tab) {
  document.body.classList.toggle('panel-open', tab !== 'map');
  if (tab !== 'map') closeSearch();
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('#panel-legend').classList.toggle('hidden', tab !== 'legend');
  $('#panel-settings').classList.toggle('hidden', tab !== 'settings');
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

$('#legend-list').innerHTML =
  LEGEND.map(([id, label]) => `<li><img src="${blipDataURL(id)}" alt="" />${label}</li>`).join('') +
  '<li><span class="legend-bar" style="background:var(--health)"></span>Barra verde: batería del móvil</li>' +
  '<li><span class="legend-bar" style="background:var(--armor)"></span>Barra azul: lo que queda hasta el destino (encima, hora de llegada)</li>' +
  '<li><span class="legend-bar" style="background:var(--accent)"></span>Línea morada: ruta al destino</li>';

// ---------- Buscador ----------
const searchInput = $('#search');
const resultsEl = $('#search-results');
let searchTimer;
let searchAbort;

function escapeHtml(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function showResults(html) {
  resultsEl.innerHTML = html;
  resultsEl.classList.remove('hidden');
}

function closeSearch() {
  resultsEl.classList.add('hidden');
  searchInput.blur();
}

function goTo(pos, label) {
  closeSearch();
  searchInput.value = '';
  setWaypoint(pos, label);
}

// Con la caja vacía se ven los sitios guardados
function showSaved() {
  const places = loadPlaces();
  if (!places.length) {
    return showResults('<li class="sr-msg">Aún no tienes sitios guardados. Toca 🏠 Casa + para guardar donde estás, o busca una dirección y pulsa ★ GUARDAR DESTINO.</li>');
  }
  showResults(
    '<li class="sr-head">GUARDADOS</li>' +
      places
        .map(
          (p) =>
            `<li data-place="${p.id}"><span class="sr-icon">${p.icon}</span><span class="sr-text"><div class="sr-title">${escapeHtml(p.name)}</div><div class="sr-sub">${escapeHtml(p.address || '')}</div></span><button class="sr-del" data-del="${p.id}" aria-label="Borrar">✕</button></li>`,
        )
        .join(''),
  );
}

let lastResults = [];
async function runSearch(q) {
  searchAbort?.abort();
  searchAbort = new AbortController();
  showResults('<li class="sr-msg">Buscando…</li>');
  try {
    lastResults = await searchPlaces(q, state.pos, searchAbort.signal);
    if (!lastResults.length) return showResults('<li class="sr-msg">Sin resultados</li>');
    showResults(
      lastResults
        .map(
          (r, i) =>
            `<li data-result="${i}"><span class="sr-icon">📍</span><span class="sr-text"><div class="sr-title">${escapeHtml(r.title)}</div><div class="sr-sub">${escapeHtml(r.subtitle)}</div></span></li>`,
        )
        .join(''),
    );
  } catch (err) {
    if (err.name !== 'AbortError') showResults('<li class="sr-msg">No se pudo buscar. ¿Tienes conexión?</li>');
  }
}

// Ubicación copiada de WhatsApp / Google Maps / Apple Maps, o coordenadas: va directa como destino
async function openShared(text) {
  showResults('<li class="sr-msg">Leyendo ubicación…</li>');
  const pos = await parseSharedLocation(text);
  if (!pos) return showResults('<li class="sr-msg">No encuentro una ubicación en ese texto. Copia el enlace de la ubicación y vuelve a probar.</li>');
  goTo(pos, '');
  toast('Ubicación compartida marcada como destino');
}

function handleQuery(q) {
  if (looksLikeSharedLocation(q)) return openShared(q);
  runSearch(q);
}

searchInput.addEventListener('focus', () => !searchInput.value.trim() && showSaved());
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 3) return q ? resultsEl.classList.add('hidden') : showSaved();
  searchTimer = setTimeout(() => handleQuery(q), 350);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && searchInput.value.trim().length >= 2) {
    clearTimeout(searchTimer);
    handleQuery(searchInput.value.trim());
  }
});

$('#btn-paste').addEventListener('click', async () => {
  let text = '';
  try {
    text = (await navigator.clipboard.readText()).trim();
  } catch {
    searchInput.focus();
    return toast('Mantén pulsado el buscador y elige "Pegar"', 3500);
  }
  if (!text) return toast('No hay nada copiado');
  searchInput.value = text;
  handleQuery(text);
});

resultsEl.addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    const place = loadPlaces().find((p) => p.id === del.dataset.del);
    if (place && confirm(`¿Borrar "${place.name}"?`)) {
      deletePlace(place.id);
      renderPlaces();
      showSaved();
    }
    return;
  }
  const li = e.target.closest('li');
  if (li?.dataset.place) {
    const place = loadPlaces().find((p) => p.id === li.dataset.place);
    if (place) goTo(place.pos, place.address || place.name);
  } else if (li?.dataset.result) {
    const r = lastResults[+li.dataset.result];
    if (r) goTo(r.pos, [r.title, r.subtitle].filter(Boolean).join(', '));
  }
});

// ---------- Sitios guardados: accesos rápidos y marcas en el mapa ----------
let placeMarkers = [];
function renderPlaces() {
  const places = loadPlaces();
  const saved = new Set(places.map((p) => p.name));
  const chips = [
    ...places.map((p) => `<button class="chip" data-chip="${p.id}">${p.icon} ${escapeHtml(p.name)}</button>`),
    ...PRESETS.filter((p) => !saved.has(p.name)).map((p) => `<button class="chip empty" data-preset="${p.name}">${p.icon} ${p.name} +</button>`),
  ];
  $('#places-chips').innerHTML = chips.join('');

  placeMarkers.forEach((m) => m.remove());
  placeMarkers = places.map((p) => {
    const el = document.createElement('div');
    el.className = 'place-marker';
    el.textContent = p.icon;
    el.title = p.name;
    return new maplibregl.Marker({ element: el }).setLngLat(p.pos).addTo(map);
  });
}

$('#places-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  if (chip.dataset.chip) {
    const place = loadPlaces().find((p) => p.id === chip.dataset.chip);
    if (place) goTo(place.pos, place.address || place.name);
  } else if (chip.dataset.preset) {
    saveHere(chip.dataset.preset);
  }
});

// ---------- Diálogo de guardar ----------
let saveName = '';
let saveTarget = null; // { pos, label }

async function openSaveDialog({ pos = state.waypoint, label = state.waypointLabel, name = '', here = false } = {}) {
  if (!pos) return;
  const target = { pos, label: label || '' };
  saveTarget = target;
  saveName = name;
  $('#sd-name').value = '';
  $('#save-dialog .sd-title').textContent = here ? 'GUARDAR DONDE ESTÁS' : 'GUARDAR UBICACIÓN';
  $('#sd-presets').innerHTML = PRESETS.map(
    (p) => `<button class="chip${p.name === name ? ' on' : ''}" data-name="${p.name}">${p.icon} ${p.name}</button>`,
  ).join('');
  $('#sd-address').textContent = target.label || (here ? 'Tu ubicación actual · buscando dirección…' : 'Buscando dirección…');
  $('#save-dialog').classList.remove('hidden');
  if (!target.label) {
    const address = await reverseGeocode(pos);
    if (saveTarget === target) {
      target.label = address;
      $('#sd-address').textContent = here ? `Tu ubicación actual · ${address || 'sin dirección'}` : address || 'Punto del mapa';
    }
  }
}

function saveHere(name = '') {
  const pos = state.anim.disp ?? state.pos;
  if (!pos) return toast('Aún no sé dónde estás. Espera a que haya señal GPS.');
  if (state.demo) toast('Sin GPS: se guardará la posición de prueba', 3000);
  openSaveDialog({ pos: [...pos], label: '', name, here: true });
}

$('#sd-presets').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  saveName = chip.dataset.name;
  $('#sd-name').value = '';
  $('#sd-presets').querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === chip));
});
$('#sd-name').addEventListener('input', () => {
  saveName = $('#sd-name').value.trim();
  $('#sd-presets').querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
});
$('#sd-cancel').addEventListener('click', () => $('#save-dialog').classList.add('hidden'));
$('#sd-ok').addEventListener('click', () => {
  if (!saveName) return toast('Elige o escribe un nombre');
  const replacing = loadPlaces().some((p) => p.name.toLowerCase() === saveName.toLowerCase());
  savePlace(saveName, saveTarget.pos, saveTarget.label || '');
  renderPlaces();
  $('#save-dialog').classList.add('hidden');
  toast(replacing ? `"${saveName}" actualizado` : `"${saveName}" guardado`);
});
$('#btn-save-place').addEventListener('click', () => openSaveDialog());
$('#btn-save-here').addEventListener('click', () => saveHere());

renderPlaces();

updateTripBar();

// La hora de llegada cambia aunque estés parado (atasco, semáforo): se recalcula cada 20 s
setInterval(() => state.waypoint && updateRouteProgress(), 20000);

// Ajustes (botones segmentados)
function bindSeg(id, key, onChange) {
  const seg = $(id);
  const paint = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings[key]));
  seg.addEventListener('click', (e) => {
    const v = e.target.dataset?.v;
    if (!v || v === settings[key]) return;
    settings[key] = v;
    saveSettings();
    paint();
    onChange?.();
  });
  paint();
}
bindSeg('#seg-profile', 'profile', () => state.waypoint && fetchRoute());
bindSeg('#seg-alerts', 'alerts', checkRadars);
bindSeg('#seg-sound', 'sound');
$('#btn-test-sound').addEventListener('click', () => {
  if (settings.sound !== 'on') return toast('Activa el sonido primero');
  const ms = beep(3, 1200, 0.11);
  navigator.vibrate?.([200, 80, 200]);
  speak('Inicio de radar de tramo de 100 a 500 metros.', ms);
});
bindSeg('#seg-voice', 'voice');

// ---------- Mantener la pantalla encendida ----------
let wakeLock;
async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {}
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && keepAwake());

// ---------- Arranque ----------
$('#btn-start').addEventListener('click', async () => {
  try {
    if (typeof DeviceOrientationEvent?.requestPermission === 'function') await DeviceOrientationEvent.requestPermission();
  } catch {}
  try {
    // iOS solo deja sonar audio web si se "desbloquea" con un toque; se suelta enseguida para no tocar tu música
    const ctx = initAudio();
    if (ctx) {
      await ctx.resume();
      const b = ctx.createBufferSource();
      b.buffer = ctx.createBuffer(1, 1, 22050);
      b.connect(ctx.destination);
      b.start();
    }
    // iPhone solo deja hablar al navegador si la primera frase sale de un toque: una frase vacía basta
    if ('speechSynthesis' in window) {
      speechSynthesis.getVoices();
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  } catch {}
  $('#start').remove();
  if (NATIVE) Notif.requestPermissions().catch(() => {});
  keepAwake();
  initBattery();
  startCompass();
  startGeolocation();
});

if (!NATIVE && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
