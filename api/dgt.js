// Radares oficiales de la DGT (NAP, DATEX2): fijos y de tramo, convertidos a JSON compacto.
// Fuente: https://nap.dgt.es/dataset/radares-fijos-dgt (no incluye Cataluña ni País Vasco).
// Vercel guarda la respuesta en caché un día, así que la DGT se consulta como mucho una vez al día.
const SOURCE = 'https://nap.dgt.es/datex2/dgt/PredefinedLocationsPublication/radares/content.xml';

function coords(block) {
  const lat = block.match(/<_0:latitude>([-\d.]+)<\/_0:latitude>/);
  const lon = block.match(/<_0:longitude>([-\d.]+)<\/_0:longitude>/);
  return lat && lon ? [Number(lon[1]), Number(lat[1])] : null;
}

function road(block) {
  return block.match(/<_0:value>([^<]+)<\/_0:value>\s*<\/_0:descriptor>\s*<_0:tpegDescriptorType>linkName/)?.[1] ?? '';
}

function setBody(xml, name) {
  const start = xml.indexOf(`id="GUID_Inventario_${name}"`);
  if (start === -1) return '';
  const end = xml.indexOf('</_0:predefinedLocationSet>', start);
  return xml.slice(start, end === -1 ? undefined : end);
}

function locations(body) {
  // Cada radar es un <_0:predefinedLocation id="GUID_..."> de primer nivel
  return body.split(/<_0:predefinedLocation id="GUID_/).slice(1);
}

module.exports = async (req, res) => {
  try {
    const r = await fetch(SOURCE, { headers: { 'User-Agent': 'RadarApp/1.0' } });
    if (!r.ok) throw new Error(`DGT ${r.status}`);
    const xml = await r.text();

    const fixed = [];
    for (const loc of locations(setBody(xml, 'CabinasCinemometro'))) {
      const p = coords(loc);
      if (p) fixed.push([p[0], p[1], road(loc)]);
    }

    const sections = [];
    for (const loc of locations(setBody(xml, 'CinemometrosVelocidadMedia'))) {
      const from = loc.match(/<_0:from[\s\S]*?<\/_0:from>/)?.[0];
      const to = loc.match(/<_0:to[\s\S]*?<\/_0:to>/)?.[0];
      const a = from && coords(from);
      const b = to && coords(to);
      if (a && b) sections.push({ from: a, to: b, road: road(loc) });
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json({ updated: new Date().toISOString(), fixed, sections });
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(502).json({ error: String(err.message || err) });
  }
};
