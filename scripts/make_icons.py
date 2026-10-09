"""Genera icons/icon-192.png y icon-512.png (flecha blanca de jugador sobre fondo de radar) sin dependencias."""
import struct, zlib, pathlib

def inside(px, py, tri):
    (x1, y1), (x2, y2), (x3, y3) = tri
    d = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3)
    a = ((y2 - y3) * (px - x3) + (x3 - x2) * (py - y3)) / d
    b = ((y3 - y1) * (px - x3) + (x1 - x3) * (py - y3)) / d
    return a >= 0 and b >= 0 and 1 - a - b >= 0

def icon(n):
    s = n / 30
    # Flecha: dos triángulos (punta-ala izquierda-muesca, punta-muesca-ala derecha), centrada en la zona segura
    def P(x, y): return (n * 0.2 + x * s * 0.6, n * 0.2 + y * s * 0.6)
    tris = [(P(15, 2), P(4, 27), P(15, 21)), (P(15, 2), P(15, 21), P(26, 27))]
    rows = []
    for y in range(n):
        row = bytearray([0])
        for x in range(n):
            cx, cy = x + 0.5, y + 0.5
            r = ((cx - n / 2) ** 2 + (cy - n / 2) ** 2) ** 0.5 / n
            if any(inside(cx, cy, t) for t in tris):
                c = (255, 255, 255)
            elif r < 0.36 and abs(r - 0.33) < 0.012:
                c = (176, 79, 216)  # anillo morado
            else:
                g = int(58 - 30 * min(r * 1.6, 1))
                c = (g, g + 5, g + 10)
            row += bytes(c)
        rows.append(bytes(row))
    raw = b"".join(rows)
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

root = pathlib.Path(__file__).resolve().parent.parent
for n in (192, 512):
    (root / "icons" / f"icon-{n}.png").write_bytes(icon(n))
# Icono de la app de iPhone (1024x1024, sin transparencia)
(root / "native" / "resources" / "icon-1024.png").write_bytes(icon(1024))
print("ok")
