// Sigue las redirecciones de un enlace corto de mapas (p. ej. maps.app.goo.gl/...) y devuelve la URL final.
// Solo acepta dominios de mapas para no servir de proxy abierto.
const ALLOWED = /^(maps\.app\.goo\.gl|goo\.gl|g\.co|maps\.google\.[a-z.]+|www\.google\.[a-z.]+|google\.[a-z.]+|consent\.google\.[a-z.]+|maps\.apple|maps\.apple\.com|apple\.co)$/i;

module.exports = async (req, res) => {
  let current = String(req.query.url || '');
  try {
    for (let hop = 0; hop < 6; hop++) {
      const u = new URL(current);
      if (u.protocol !== 'https:' || !ALLOWED.test(u.hostname)) break;
      const r = await fetch(current, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 RadarApp' } });
      const next = r.headers.get('location');
      if (!next || r.status < 300 || r.status >= 400) break;
      current = new URL(next, current).toString();
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=86400');
    res.status(200).json({ url: current });
  } catch {
    res.status(400).json({ error: 'URL no válida' });
  }
};
