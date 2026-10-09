# Radar

Mapa GPS para el móvil con estilo de radar de GTA V y avisos de radares de tráfico (tipo Radarbot).
Es una web app instalable (PWA): sin compilación, sin claves de API.

## Qué hace
- **Modo radar**: el mapa te sigue, gira con tu rumbo y se aleja según la velocidad. Muestra la zona, la calle, la velocidad, la hora, el blip del norte y la barra verde/azul (batería / señal GPS).
- **Modo mapa** (botón MAPA): toca para marcar destino → ruta morada (coche o a pie). Leyenda y ajustes.
- **Radares**: los fijos se descargan de OpenStreetMap en 25 km a tu alrededor. Avisa a 500 m y a 150 m (pitido + vibración) si el radar está por delante, y pone la velocidad en rojo si superas el límite.
- **+ RADAR**: reporta un radar móvil en tu posición y **se comparte con todos los usuarios** (Supabase, proyecto `radar`). Caduca a las 3 h; si otro usuario lo reporta a menos de 100 m se confirma y se alarga. En el mapa, tócalo para decir «ya no está»: si es tuyo desaparece al momento; si no, con 3 avisos de dispositivos distintos.
- Límite anti-spam: 10 reportes por dispositivo y hora. Las tablas no son accesibles desde fuera, solo las funciones `radars_near`, `report_radar` y `dismiss_radar`.
- **Modo demo** (sin GPS): mantén pulsado en el mapa para moverte y usa SIMULAR para recorrer la ruta.

## Probar en el ordenador
```bash
python -m http.server 5173
```
Abre http://localhost:5173

## Usar en el móvil
El GPS solo funciona con HTTPS, así que hay que publicarla (Vercel, Netlify o GitHub Pages sirven tal cual esta carpeta).
Después, en el móvil: abrir la URL → menú del navegador → «Añadir a pantalla de inicio».

## Archivos
- `js/app.js` — GPS, HUD, modos, rutas, avisos
- `js/style.js` — colores y capas del mapa
- `js/radars.js` — descarga de radares (Overpass) y lógica de avisos
- `js/icons.js` — iconos de blips dibujados en canvas
- `scripts/make_icons.py` — regenera los iconos de la app

Datos: © OpenStreetMap, tiles de OpenFreeMap, rutas de routing.openstreetmap.de / OSRM.

## App nativa de iPhone (segundo plano)
`native/` envuelve la web con Capacitor y añade GPS en segundo plano y avisos por notificación.
GitHub Actions (`.github/workflows/ios.yml`) la compila en un Mac y deja **Radar.ipa** (sin firmar) en la pestaña *Actions*.

Instalar desde Windows con [Sideloadly](https://sideloadly.io): arrastra Radar.ipa, pon tu Apple ID, activa el refresco automático y pulsa Start.
Con un Apple ID gratis la firma dura 7 días; el refresco automático de Sideloadly la renueva por wifi si el PC está encendido.
