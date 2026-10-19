"""Extrae los radares de un extracto de OpenStreetMap ya filtrado con osmium y los guarda en JSON compacto.

Uso (lo hace GitHub Actions cada semana, ver .github/workflows/osm-data.yml):
    osmium tags-filter spain-latest.osm.pbf n/highway=speed_camera r/type=enforcement -o radares.osm.pbf
    python scripts/build_osm_radars.py radares.osm.pbf data/radares-osm.json

Salida:
    fixed:    [[lon, lat, límite o null], ...]          radares fijos (puntuales)
    sections: [{from, to, maxspeed, name}, ...]          radares de tramo (inicio y fin)
"""
import json
import re
import sys
from datetime import datetime, timezone

import osmium


def parse_speed(v):
    if not v:
        return None
    m = re.match(r"\s*(\d+)", v)
    if not m:
        return None
    n = int(m.group(1))
    return round(n * 1.609) if "mph" in v else n


class Handler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.nodes = {}  # id -> (lon, lat)
        self.cams = {}  # id -> límite
        self.rels = []

    def node(self, n):
        if not n.location.valid():
            return
        self.nodes[n.id] = (round(n.location.lon, 6), round(n.location.lat, 6))
        if n.tags.get("highway") == "speed_camera":
            self.cams[n.id] = parse_speed(n.tags.get("maxspeed"))

    def relation(self, r):
        if r.tags.get("type") != "enforcement" or r.tags.get("enforcement") not in ("maxspeed", "average_speed"):
            return
        self.rels.append(
            {
                "enforcement": r.tags.get("enforcement"),
                "maxspeed": parse_speed(r.tags.get("maxspeed")),
                "name": r.tags.get("name") or r.tags.get("ref") or "",
                "members": [(m.ref, m.role) for m in r.members if m.type == "n"],
            }
        )


def main(src, out):
    h = Handler()
    h.apply_file(src)

    rel_speed = {}
    section_devices = set()
    sections = []
    for r in h.rels:
        members = [(ref, role) for ref, role in r["members"] if ref in h.nodes]
        if r["enforcement"] == "average_speed":
            devices = [ref for ref, role in members if role == "device"]
            section_devices.update(devices)
            frm = next((ref for ref, role in members if role == "from"), devices[0] if devices else None)
            to = next((ref for ref, role in members if role == "to"), devices[-1] if devices else None)
            if frm and to and frm != to:
                sections.append({"from": h.nodes[frm], "to": h.nodes[to], "maxspeed": r["maxspeed"], "name": r["name"]})
        elif r["maxspeed"]:
            for ref, role in members:
                if role == "device":
                    rel_speed[ref] = r["maxspeed"]

    fixed = [
        [*h.nodes[i], speed if speed is not None else rel_speed.get(i)]
        for i, speed in h.cams.items()
        if i in h.nodes and i not in section_devices
    ]

    data = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "© OpenStreetMap contributors (ODbL), extracto de Geofabrik",
        "fixed": fixed,
        "sections": sections,
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(fixed)} fijos ({sum(1 for x in fixed if x[2])} con límite), {len(sections)} tramos -> {out}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
