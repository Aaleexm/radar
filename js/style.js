// Estilo de mapa inspirado en el radar de GTA V (tiles vectoriales de OpenFreeMap, sin API key).

export const COLORS = {
  land: '#3a3f44',
  green: '#3e5641',
  greenDark: '#34493a',
  industrial: '#363a3e',
  water: '#2c5276',
  building: '#464c52',
  buildingEdge: '#3c4147',
  roadCasing: '#2a2e32',
  roadMinor: '#686e74',
  roadMid: '#7d8389',
  roadMajor: '#959a9f',
  motorway: '#aeb2b5',
  path: '#575c61',
  rail: '#2d3135',
  route: '#b04fd8',
  routeCasing: '#4a1a63',
  label: '#e4e4e4',
};

const C = COLORS;
const EMPTY = { type: 'FeatureCollection', features: [] };

const roadClasses = {
  minor: ['minor', 'service'],
  mid: ['secondary', 'tertiary'],
  major: ['primary', 'trunk'],
  motorway: ['motorway'],
};

function classFilter(classes) {
  return ['match', ['get', 'class'], classes, true, false];
}

function width(stops) {
  return ['interpolate', ['exponential', 1.6], ['zoom'], ...stops.flat()];
}

function roadLayers(name, classes, color, w) {
  const casing = w.map(([z, v]) => [z, v * 1.35 + 0.6]);
  return [
    {
      id: `road-${name}-casing`,
      type: 'line',
      source: 'omt',
      'source-layer': 'transportation',
      filter: classFilter(classes),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': C.roadCasing, 'line-width': width(casing) },
    },
    {
      id: `road-${name}`,
      type: 'line',
      source: 'omt',
      'source-layer': 'transportation',
      filter: classFilter(classes),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': color, 'line-width': width(w) },
    },
  ];
}

// Clases de POI (esquema OpenMapTiles) -> icono de blip
export const POI_BLIPS = {
  fuel: 'b-fuel',
  hospital: 'b-hospital',
  police: 'b-police',
  bank: 'b-bank',
  clothing_store: 'b-clothes',
  grocery: 'b-store',
  fast_food: 'b-food',
  restaurant: 'b-food',
  bar: 'b-bar',
  beer: 'b-bar',
  railway: 'b-train',
  parking: 'b-parking',
  cinema: 'b-cinema',
  pharmacy: 'b-pharmacy',
};

export function buildStyle() {
  const poiMatch = ['match', ['get', 'class']];
  for (const [cls, icon] of Object.entries(POI_BLIPS)) poiMatch.push(cls, icon);
  poiMatch.push('');

  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      route: { type: 'geojson', data: EMPTY },
      cameras: { type: 'geojson', data: EMPTY },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': C.land } },
      {
        id: 'landcover',
        type: 'fill',
        source: 'omt',
        'source-layer': 'landcover',
        filter: classFilter(['wood', 'grass', 'farmland', 'wetland']),
        paint: { 'fill-color': C.greenDark, 'fill-opacity': 0.7 },
      },
      {
        id: 'landuse-green',
        type: 'fill',
        source: 'omt',
        'source-layer': 'landuse',
        filter: classFilter(['cemetery', 'stadium', 'pitch', 'playground', 'garden']),
        paint: { 'fill-color': C.green },
      },
      {
        id: 'landuse-industrial',
        type: 'fill',
        source: 'omt',
        'source-layer': 'landuse',
        filter: classFilter(['industrial', 'railway', 'commercial']),
        paint: { 'fill-color': C.industrial },
      },
      { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': C.green } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': C.water } },
      {
        id: 'waterway',
        type: 'line',
        source: 'omt',
        'source-layer': 'waterway',
        paint: { 'line-color': C.water, 'line-width': width([[10, 0.5], [18, 8]]) },
      },
      {
        id: 'building',
        type: 'fill',
        source: 'omt',
        'source-layer': 'building',
        minzoom: 14,
        paint: { 'fill-color': C.building, 'fill-outline-color': C.buildingEdge },
      },
      {
        id: 'path',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        minzoom: 15,
        filter: classFilter(['path', 'track']),
        paint: { 'line-color': C.path, 'line-width': width([[15, 0.6], [19, 3]]), 'line-dasharray': [2, 1.5] },
      },
      {
        id: 'rail',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        filter: classFilter(['rail', 'transit']),
        paint: { 'line-color': C.rail, 'line-width': width([[12, 1], [18, 5]]) },
      },
      ...roadLayers('minor', roadClasses.minor, C.roadMinor, [[13, 0.5], [16, 4], [19, 22]]),
      ...roadLayers('mid', roadClasses.mid, C.roadMid, [[10, 0.6], [16, 6], [19, 30]]),
      ...roadLayers('major', roadClasses.major, C.roadMajor, [[8, 0.8], [16, 8], [19, 36]]),
      ...roadLayers('motorway', roadClasses.motorway, C.motorway, [[6, 0.8], [16, 9], [19, 40]]),
      // Capa invisible solo para saber el nombre de la calle bajo el jugador
      {
        id: 'street-hit',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation_name',
        paint: { 'line-opacity': 0, 'line-width': 24 },
      },
      {
        id: 'route-casing',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.routeCasing, 'line-width': width([[10, 5], [16, 11], [19, 30]]) },
      },
      {
        id: 'route',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.route, 'line-width': width([[10, 3], [16, 7], [19, 22]]) },
      },
      {
        id: 'place-label',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        filter: classFilter(['city', 'town', 'suburb', 'quarter', 'neighbourhood']),
        layout: {
          visibility: 'none',
          'text-field': ['upcase', ['coalesce', ['get', 'name:es'], ['get', 'name']]],
          'text-font': ['Noto Sans Bold'],
          'text-size': ['match', ['get', 'class'], ['city', 'town'], 16, 11],
          'text-letter-spacing': 0.12,
          'text-max-width': 8,
        },
        paint: { 'text-color': C.label, 'text-halo-color': '#000', 'text-halo-width': 1.4, 'text-opacity': 0.85 },
      },
      {
        id: 'poi-blips',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'poi',
        minzoom: 15,
        filter: ['all', ['!=', poiMatch, ''], ['<=', ['coalesce', ['get', 'rank'], 99], 30]],
        layout: {
          'icon-image': poiMatch,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.55, 18, 0.85],
          'icon-padding': 14,
          'icon-rotation-alignment': 'viewport',
          'icon-pitch-alignment': 'viewport',
        },
      },
      {
        id: 'cameras-far',
        type: 'symbol',
        source: 'cameras',
        minzoom: 5,
        maxzoom: 11,
        filter: ['match', ['get', 'kind'], ['zone', 'hotspot'], false, true],
        layout: {
          'icon-image': ['match', ['get', 'kind'], 'mobile', 'b-camera-mobile', 'section_start', 'b-camera-section', 'section_end', 'b-camera-section', 'zone', 'b-zone', 'hotspot', 'b-hotspot', 'b-camera'],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.3, 9, 0.45, 14, 0.75, 18, 1],
          'icon-allow-overlap': false,
          'icon-ignore-placement': false,
          'icon-padding': 1,
          'symbol-sort-key': ['match', ['get', 'kind'], 'mobile', 0, 'section_start', 1, 'section_end', 1, 'zone', 3, 2],
          'icon-rotation-alignment': 'viewport',
          'icon-pitch-alignment': 'viewport',
          'text-field': '', // de lejos solo iconos; el límite se ve al acercarse
          'text-font': ['Noto Sans Bold'],
          'text-size': 11,
          'text-offset': [0, 1.5],
          'text-optional': true,
        },
        paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 1.5 },
      },
      {
        id: 'cameras',
        type: 'symbol',
        source: 'cameras',
        minzoom: 11,
        layout: {
          'icon-image': ['match', ['get', 'kind'], 'mobile', 'b-camera-mobile', 'section_start', 'b-camera-section', 'section_end', 'b-camera-section', 'zone', 'b-zone', 'hotspot', 'b-hotspot', 'b-camera'],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.3, 9, 0.45, 14, 0.75, 18, 1],
          'icon-allow-overlap': true,
          'icon-ignore-placement': false,
          'icon-padding': 1,
          'symbol-sort-key': ['match', ['get', 'kind'], 'mobile', 0, 'section_start', 1, 'section_end', 1, 'zone', 3, 2],
          'icon-rotation-alignment': 'viewport',
          'icon-pitch-alignment': 'viewport',
          'text-field': ['coalesce', ['get', 'label'], ''],
          'text-font': ['Noto Sans Bold'],
          'text-size': 11,
          'text-offset': [0, 1.5],
          'text-optional': true,
        },
        paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 1.5 },
      },
    ],
  };
}
