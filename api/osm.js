// Radares de OpenStreetMap (Overpass) por celdas de ~0,25°, con caché en Vercel.
// Los servidores públicos de Overpass se saturan a menudo: así cada zona se pide como mucho una vez al día
// para todos los usuarios, y si Overpass falla se sirve la última copia buena (hasta una semana).
const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const CELL = 0.25;
const MARGIN = 0.35; // grados alrededor de la celda (cubre 25 km desde cualquier punto de ella)

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const lat = Math.round(Number(req.query.lat) / CELL) * CELL;
  const lon = Math.round(Number(req.query.lon) / CELL) * CELL;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
    return res.status(400).json({ error: 'lat/lon no válidos' });
  }
  const bbox = [lat - MARGIN, lon - MARGIN, lat + MARGIN, lon + MARGIN].map((n) => n.toFixed(3)).join(',');
  const query = `[out:json][timeout:25];
(
  node["highway"="speed_camera"](${bbox});
  relation["type"="enforcement"]["enforcement"~"maxspeed|average_speed"](${bbox});
)->.a;
.a out body;
node(r.a);
out skel qt;`;

  for (const url of SERVERS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        headers: { 'User-Agent': 'RadarApp/1.0 (+https://github.com/Aaleexm/radar)', Accept: 'application/json' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) continue;
      const data = await r.json();
      if (!Array.isArray(data.elements)) continue;
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800, stale-if-error=604800');
      return res.status(200).json({ cell: [lon, lat], elements: data.elements });
    } catch {}
  }
  // Sin caché: que la app use la copia guardada o lo reintente más tarde
  res.setHeader('Cache-Control', 'no-store');
  res.status(503).json({ error: 'Overpass saturado' });
};
