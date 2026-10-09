// Blips dibujados en canvas: silueta blanca/de color con borde negro, como en GTA.

const S = 64; // px del canvas (se registra con pixelRatio 2 -> 32px en pantalla)

function canvas() {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  return [c, ctx];
}

// Dibuja la forma dos veces: primero trazo negro grueso (borde), luego relleno.
function blip(drawPath, fill = '#fff') {
  const [c, ctx] = canvas();
  ctx.save();
  drawPath(ctx);
  ctx.lineWidth = 9;
  ctx.strokeStyle = '#000';
  ctx.stroke();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
  return ctx.getImageData(0, 0, S, S);
}

function textBlip(text, fill, font = '900 40px Arial, sans-serif') {
  const [c, ctx] = canvas();
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#000';
  ctx.strokeText(text, S / 2, S / 2 + 2);
  ctx.fillStyle = fill;
  ctx.fillText(text, S / 2, S / 2 + 2);
  return ctx.getImageData(0, 0, S, S);
}

function rect(ctx, x, y, w, h) {
  ctx.rect(x, y, w, h);
}

// Radar: círculo de color con cámara blanca dentro (destaca sobre el resto de blips)
function cameraBlip(color) {
  const [c, ctx] = canvas();
  ctx.beginPath();
  ctx.arc(32, 32, 27, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#000';
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(14, 24, 26, 18, 3);
  ctx.moveTo(40, 30);
  ctx.lineTo(50, 24);
  ctx.lineTo(50, 42);
  ctx.lineTo(40, 36);
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(27, 33, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  return ctx.getImageData(0, 0, S, S);
}

const DRAW = {
  'b-fuel': () =>
    blip((ctx) => {
      ctx.beginPath();
      rect(ctx, 16, 14, 22, 36); // surtidor
      rect(ctx, 38, 22, 8, 4); // manguera
      rect(ctx, 44, 22, 4, 20);
    }),
  'b-hospital': () =>
    blip((ctx) => {
      ctx.beginPath();
      rect(ctx, 26, 12, 12, 40);
      rect(ctx, 12, 26, 40, 12);
    }, '#e0312b'),
  'b-police': () =>
    blip((ctx) => {
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 9 : 21;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        ctx.lineTo(32 + r * Math.cos(a), 33 + r * Math.sin(a));
      }
      ctx.closePath();
    }, '#4a8ff0'),
  'b-bank': () => textBlip('$', '#5fc35a'),
  'b-clothes': () =>
    blip((ctx) => {
      ctx.beginPath();
      ctx.moveTo(22, 14);
      ctx.lineTo(42, 14);
      ctx.lineTo(54, 24);
      ctx.lineTo(48, 31);
      ctx.lineTo(44, 28);
      ctx.lineTo(44, 50);
      ctx.lineTo(20, 50);
      ctx.lineTo(20, 28);
      ctx.lineTo(16, 31);
      ctx.lineTo(10, 24);
      ctx.closePath();
    }),
  'b-store': () =>
    blip((ctx) => {
      ctx.beginPath();
      ctx.moveTo(14, 24);
      ctx.lineTo(50, 24);
      ctx.lineTo(46, 52);
      ctx.lineTo(18, 52);
      ctx.closePath();
      rect(ctx, 24, 14, 4, 12);
      rect(ctx, 36, 14, 4, 12);
      rect(ctx, 24, 12, 16, 4);
    }),
  'b-food': () =>
    blip((ctx) => {
      ctx.beginPath();
      ctx.moveTo(12, 30);
      ctx.bezierCurveTo(12, 10, 52, 10, 52, 30); // pan de arriba
      ctx.closePath();
      rect(ctx, 10, 34, 44, 6); // carne
      ctx.moveTo(12, 44);
      ctx.lineTo(52, 44);
      ctx.bezierCurveTo(52, 54, 12, 54, 12, 44); // pan de abajo
    }),
  'b-bar': () =>
    blip((ctx) => {
      ctx.beginPath();
      ctx.moveTo(12, 14);
      ctx.lineTo(52, 14);
      ctx.lineTo(34, 34);
      ctx.lineTo(34, 46);
      ctx.lineTo(44, 50);
      ctx.lineTo(20, 50);
      ctx.lineTo(30, 46);
      ctx.lineTo(30, 34);
      ctx.closePath();
    }),
  'b-train': () =>
    blip((ctx) => {
      ctx.beginPath();
      ctx.roundRect(16, 10, 32, 36, 8);
      ctx.moveTo(20, 46);
      ctx.lineTo(14, 56);
      ctx.lineTo(20, 56);
      ctx.lineTo(25, 46);
      ctx.moveTo(44, 46);
      ctx.lineTo(50, 56);
      ctx.lineTo(44, 56);
      ctx.lineTo(39, 46);
    }),
  'b-parking': () => textBlip('P', '#fff'),
  'b-cinema': () =>
    blip((ctx) => {
      ctx.beginPath();
      rect(ctx, 12, 22, 30, 24);
      ctx.moveTo(42, 30);
      ctx.lineTo(54, 22);
      ctx.lineTo(54, 46);
      ctx.lineTo(42, 38);
    }),
  'b-camera': () => cameraBlip('#ff3b30'),
  'b-camera-mobile': () => cameraBlip('#ffb020'),
  'b-pharmacy': () =>
    blip((ctx) => {
      ctx.beginPath();
      rect(ctx, 27, 14, 10, 36);
      rect(ctx, 14, 27, 36, 10);
    }, '#5fc35a'),
};

export const LEGEND = [
  ['b-camera', 'Radar fijo'],
  ['b-camera-mobile', 'Radar móvil (de la comunidad)'],
  ['b-fuel', 'Gasolinera'],
  ['b-hospital', 'Hospital'],
  ['b-police', 'Policía'],
  ['b-bank', 'Banco / cajero'],
  ['b-pharmacy', 'Farmacia'],
  ['b-store', 'Tienda'],
  ['b-clothes', 'Ropa'],
  ['b-food', 'Comida'],
  ['b-bar', 'Bar'],
  ['b-train', 'Estación'],
  ['b-parking', 'Parking'],
  ['b-cinema', 'Cine'],
];

export function registerBlipImages(map) {
  map.on('styleimagemissing', (e) => {
    const draw = DRAW[e.id];
    if (draw && !map.hasImage(e.id)) map.addImage(e.id, draw(), { pixelRatio: 2 });
  });
}

export function blipDataURL(id) {
  const data = DRAW[id]();
  const [c, ctx] = canvas();
  ctx.putImageData(data, 0, 0);
  return c.toDataURL();
}
