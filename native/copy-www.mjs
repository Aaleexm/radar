// Copia la web (carpeta padre) a native/www, que es lo que Capacitor mete dentro de la app.
import { cpSync, rmSync, mkdirSync } from 'node:fs';

const items = ['index.html', 'manifest.webmanifest', 'css', 'js', 'icons'];
rmSync('www', { recursive: true, force: true });
mkdirSync('www');
for (const item of items) cpSync(`../${item}`, `www/${item}`, { recursive: true });
console.log('www listo');
