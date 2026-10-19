"""Junta los radares de fuentes oficiales que no están en la lista de la DGT y los guarda en JSON.

    python scripts/build_official_radars.py data/radares-oficiales.json

Fuentes:
  - Servei Català de Trànsit (Cataluña): radares fijos con límite (coordenadas UTM ETRS89 huso 31).
  - Ayuntamiento de Madrid: radares fijos y de tramo de la ciudad, con límite.
  - DGT, tramos INVIVE: tramos de vigilancia intensiva de velocidad (donde suele haber radares móviles).

Salida:
  fixed:    [[lon, lat, límite, carretera, fuente], ...]
  sections: [{from, to, maxspeed, road, source}, ...]
  zones:    [{from, to, road}, ...]                      tramos INVIVE
"""
import csv
import io
import json
import re
import sys
import math
import urllib.request
from datetime import datetime, timezone

CATALONIA = "https://transit.gencat.cat/web/.content/documents/seguretat_viaria/radars.txt"
MADRID = "https://datos.madrid.es/dataset/300049-0-radares-fijos-moviles/resource/300049-1-radares-fijos-moviles-csv/download/300049-1-radares-fijos-moviles-csv.csv"
INVIVE = "https://infocar.dgt.es/datex2/dgt/PredefinedLocationsPublication/tramos_invive/content.xml"


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "RadarApp/1.0 (+https://github.com/Aaleexm/radar)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def text(raw):
    for enc in ("utf-8-sig", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            pass
    return raw.decode("latin-1", "replace")


def num(s):
    s = (s or "").strip().replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def utm_to_lonlat(x, y, zone):
    """UTM (hemisferio norte, elipsoide GRS80/ETRS89) a longitud/latitud. Fórmula estándar (USGS, Snyder)."""
    a, f, k0 = 6378137.0, 1 / 298.257222101, 0.9996
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    x -= 500000.0
    m = y / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu) + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
            + (151 * e1**3 / 96) * math.sin(6 * mu) + (1097 * e1**4 / 512) * math.sin(8 * mu))
    n1 = a / math.sqrt(1 - e2 * math.sin(phi1) ** 2)
    t1 = math.tan(phi1) ** 2
    c1 = ep2 * math.cos(phi1) ** 2
    r1 = a * (1 - e2) / (1 - e2 * math.sin(phi1) ** 2) ** 1.5
    d = x / (n1 * k0)
    lat = phi1 - (n1 * math.tan(phi1) / r1) * (
        d**2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * ep2) * d**4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * ep2 - 3 * c1**2) * d**6 / 720)
    lon = (d - (1 + 2 * t1 + c1) * d**3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * ep2 + 24 * t1**2) * d**5 / 120) / math.cos(phi1)
    return math.degrees(lon) + (zone - 1) * 6 - 180 + 3, math.degrees(lat)


def catalonia():
    fixed = []
    for line in text(get(CATALONIA)).splitlines():
        parts = line.split()
        # Via  PK  Velocitat  X  Y
        if len(parts) < 5 or not re.match(r"^\d+$", parts[2]):
            continue
        x, y = num(parts[3]), num(parts[4])
        if not x or not y:
            continue
        lon, lat = utm_to_lonlat(x, y, 31)
        fixed.append([round(lon, 6), round(lat, 6), int(parts[2]), parts[0], "SCT"])
    return fixed


def madrid():
    rows = list(csv.reader(io.StringIO(text(get(MADRID))), delimiter=";"))
    fixed, sections = [], []
    for r in rows[1:]:
        if len(r) < 15:
            continue
        kind = r[6].strip().lower()
        lon, lat, speed = num(r[12]), num(r[13]), num(r[14])
        road = r[2].strip()
        if not lon or not lat:
            continue
        if kind == "fijo":
            # Un registro por carril: se juntan los que están en el mismo sitio
            if any(abs(f[0] - lon) < 0.0004 and abs(f[1] - lat) < 0.0004 for f in fixed):
                continue
            fixed.append([round(lon, 6), round(lat, 6), int(speed) if speed else None, road, "Ayto. Madrid"])
        elif "tramo" in kind:
            slon, slat = num(r[8]), num(r[9])
            if slon and slat:
                sections.append(
                    {"from": [round(slon, 6), round(slat, 6)], "to": [round(lon, 6), round(lat, 6)],
                     "maxspeed": int(speed) if speed else None, "road": road, "source": "Ayto. Madrid"}
                )
    return fixed, sections


def invive():
    xml = text(get(INVIVE))
    zones = []
    for loc in xml.split('<_0:predefinedLocation id="GUID_Tramo_Invive_')[1:]:
        def point(tag):
            m = re.search(rf"<_0:{tag}[\s\S]*?<_0:latitude>([-\d.]+)</_0:latitude>\s*<_0:longitude>([-\d.]+)</_0:longitude>", loc)
            return [round(float(m.group(2)), 6), round(float(m.group(1)), 6)] if m else None

        a, b = point("from"), point("to")
        road = re.search(r"<_0:value>([^<]+)</_0:value>\s*</_0:descriptor>\s*<_0:tpegDescriptorType>linkName", loc)
        if a and b and a != b:
            zones.append({"from": a, "to": b, "road": road.group(1) if road else ""})
    return zones


def main(out):
    data = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "fixed": [], "sections": [], "zones": []}
    report = []
    for name, fn in (("Cataluña", catalonia), ("Madrid", madrid), ("INVIVE", invive)):
        try:
            res = fn()
        except Exception as e:  # una fuente caída no debe tumbar las demás
            report.append(f"{name}: ERROR {e}")
            continue
        if name == "Cataluña":
            data["fixed"] += res
            report.append(f"Cataluña: {len(res)} fijos")
        elif name == "Madrid":
            data["fixed"] += res[0]
            data["sections"] += res[1]
            report.append(f"Madrid: {len(res[0])} fijos, {len(res[1])} tramos")
        else:
            data["zones"] = res
            report.append(f"INVIVE: {len(res)} tramos de vigilancia")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(" | ".join(report))


if __name__ == "__main__":
    main(sys.argv[1])
