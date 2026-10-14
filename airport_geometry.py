"""Dublin Airport's real airside layout, from OpenStreetMap.

The twin's piers, gates, stands and walking distances come from here:

  OpenStreetMap contributors, (c) ODbL 1.0, https://www.openstreetmap.org/copyright
      aeroway=gate (with refs 102 ... 426, 335A-F), aeroway=parking_position
      (stand lead-in lines), aeroway=terminal, apron, taxiway, runway,
      car parks and the main roads, around EIDW.

The raw extract is cached, trimmed, in reference_data/osm/ and committed:

    python airport_geometry.py            # rebuild flow_demo/js/airport_geo.js from the cache
    python airport_geometry.py --fetch    # refresh the cache from the Overpass API first

Coordinates are metres on a local plane: x east, y south, origin at
53.4264 N, 6.2499 W (between the terminals).

What is traced by hand (from the OSM outlines, not tagged in OSM):
  * pier centrelines, which carry the walking routes;
  * the security exits, which are approximate and from daa's public terminal map;
  * which piers each terminal's flights use.

The twin draws the airside at true scale but turned so that the airside sits
above the terminal section stack. That means real west is up, so T2 is to the
left of T1. Each terminal gets its own offset, because the twin keeps both
terminals' departure levels side by side, as in its schematic. Inside a terminal, every pier,
gate and stand keeps its real shape, length and relative position, so a walk
along a pier in the twin is as long as the real one.
"""

from __future__ import annotations

import argparse
import json
import math
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OSM = ROOT / "reference_data" / "osm" / "eidw_osm.json"
OUT = ROOT / "flow_demo" / "js" / "airport_geo.js"
LAT0, LON0 = 53.4264, -6.2499
BBOX = (53.400, -6.320, 53.442, -6.215)   # south, west, north, east
OVERPASS = ["https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter",
            "https://overpass-api.de/api/interpreter"]
QUERY = """[out:json][timeout:90];
(way["aeroway"~"^(terminal|apron|runway|taxiway|parking_position|hangar)$"]({b});
 node["aeroway"="gate"]({b});
 way["amenity"="parking"]({b});
 way["building"]["name"]({b});
 way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary)$"]({b}););
out body geom;"""
KEEP_TAGS = {"aeroway", "ref", "alt_ref", "name", "level", "description", "building", "amenity", "highway", "parking", "width"}

WALK_SPEED = 1.25        # m/s, an average adult with a carry-on (twin personas vary 0.6-1.45)
INDOOR_DETOUR = 1.2      # walking route / straight line inside the main buildings
BUS_SPEED = 6.0          # m/s on the apron road, about 22 km/h
ROAD_DETOUR = 1.35

# Security exits (after screening), approximate, from daa's terminal map.
SECURITY = {"t1": (388.0, -96.0), "t2": (655.0, 92.0)}
# Arrivals: where pier corridors reach passport control.
IMMIGRATION = {"t1": (420.0, -60.0), "t2": (690.0, 60.0)}

# Piers: branches are centrelines from the pier root outward (real metres).
# Gate refs are matched to OSM gate nodes; bus gates serve remote stands.
PIERS = [
    {"id": "P1", "name": "Pier 1", "term": "t1",
     "branches": [[(292, -248), (360, -300), (376, -355), (352, -408), (300, -442), (210, -451), (-96, -474)]],
     "gates": [str(g) for g in range(102, 120)]},
    {"id": "P2", "name": "Pier 2", "term": "t1",
     "branches": [[(292, -248), (240, -236), (186, -212), (152, -189), (133, -171)],
                  [(292, -248), (266, -276), (254, -320), (270, -382)]],
     "gates": [str(g) for g in range(201, 221)], "busGates": ["221", "222", "223", "224"], "end": 18},
    {"id": "P3", "name": "Pier 3", "term": "t1",
     "branches": [[(346, -36), (305, -6), (266, 24)]],
     "gates": ["301", "302", "303", "304", "305", "305A", "305B", "306", "307", "307A"], "end": 30},
    {"id": "P335", "name": "Gates 332–337", "term": "t1",
     "branches": [[(392, 2), (468, 48), (558, 106)]],
     "gates": [], "busGates": ["332", "333", "334", "335", "336", "337"]},
    {"id": "P4", "name": "Pier 4", "term": "t2",
     "branches": [[(592, 150), (300, 425)]],
     "gates": [str(g) for g in range(401, 427) if g != 425], "us": [str(g) for g in range(401, 407)]},
]
# Stands served by bus. South Gates 335A-F are reached by bus from gate 335; the
# West Apron and north stands are the overflow.
REMOTE = {
    "south": {"name": "South Gates (bus from 335)", "stands": ["412", "413", "414", "415", "416", "417"],
              "gates": ["A", "B", "C", "D", "E", "F"], "busFrom": "335"},
    "west": {"name": "West Apron", "stands": ["614C", "615C", "616C", "617C", "618C", "619C", "620C", "621C"], "busFrom": "335"},
    "north": {"name": "North Apron", "stands": ["137A", "140T", "141T", "142T", "144C", "145"], "busFrom": "221"},
}
# The twin: real (x, y) -> twin (-y + dx, x + dy), i.e. turned so real west is up.
TWIN = {"t1": {"dx": 760.0, "dy": 86.0}, "t2": {"dx": 620.0, "dy": -158.0}}


def project(lat: float, lon: float) -> tuple[float, float]:
    return ((lon - LON0) * 111320.0 * math.cos(math.radians(LAT0)), -(lat - LAT0) * 110540.0)


def fetch() -> None:
    q = QUERY.replace("{b}", ",".join(str(v) for v in BBOX))
    data = None
    for url in OVERPASS:
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(),
                                         headers={"User-Agent": "dublin-airport-timesfm (research demo)"})
            with urllib.request.urlopen(req, timeout=180) as r:
                data = json.loads(r.read())
            break
        except Exception as e:  # try the next mirror
            print(f"  {url}: {e}")
    if data is None:
        raise SystemExit("No Overpass mirror answered.")
    keep = []
    for e in data["elements"]:
        t = {k: v for k, v in e.get("tags", {}).items() if k in KEEP_TAGS}
        if e["type"] == "node":
            keep.append({"type": "node", "id": e["id"], "lat": round(e["lat"], 6), "lon": round(e["lon"], 6), "tags": t})
        elif e["type"] == "way" and "geometry" in e:
            keep.append({"type": "way", "id": e["id"], "tags": t,
                         "geometry": [[round(p["lat"], 6), round(p["lon"], 6)] for p in e["geometry"]]})
    OSM.parent.mkdir(parents=True, exist_ok=True)
    OSM.write_text(json.dumps({"source": "OpenStreetMap contributors, ODbL 1.0, via the Overpass API",
                               "timestamp": data.get("osm3s", {}).get("timestamp_osm_base"), "bbox": BBOX,
                               "elements": keep}, separators=(",", ":")))
    print(f"Cached {len(keep)} OSM elements in {OSM.relative_to(ROOT)}")


# ---------------------------------------------------------------- geometry
def rdp(pts: list[tuple[float, float]], eps: float) -> list[tuple[float, float]]:
    if len(pts) < 3:
        return pts
    (x0, y0), (x1, y1) = pts[0], pts[-1]
    L = math.hypot(x1 - x0, y1 - y0)
    dmax, idx = 0.0, 0
    for i, (x, y) in enumerate(pts[1:-1], 1):
        # A closed ring starts and ends at the same point: measure from that point.
        d = abs((x1 - x0) * (y0 - y) - (x0 - x) * (y1 - y0)) / L if L > 1e-6 else math.hypot(x - x0, y - y0)
        if d > dmax:
            dmax, idx = d, i
    if dmax <= eps:
        return [pts[0], pts[-1]]
    return rdp(pts[:idx + 1], eps)[:-1] + rdp(pts[idx:], eps)


def plen(pts) -> float:
    return sum(math.dist(pts[i - 1], pts[i]) for i in range(1, len(pts)))


def project_on(pts, p) -> tuple[float, float, tuple[float, float]]:
    """Distance along a polyline to the closest point to p, the lateral distance, and that point."""
    best, acc = (1e18, 0.0, pts[0]), 0.0
    for i in range(1, len(pts)):
        (ax, ay), (bx, by) = pts[i - 1], pts[i]
        L2 = (bx - ax) ** 2 + (by - ay) ** 2 or 1e-9
        f = max(0.0, min(1.0, ((p[0] - ax) * (bx - ax) + (p[1] - ay) * (by - ay)) / L2))
        q = (ax + f * (bx - ax), ay + f * (by - ay))
        d = math.dist(p, q)
        if d < best[0]:
            best = (d, acc + f * math.sqrt(L2), q)
        acc += math.sqrt(L2)
    return best[1], best[0], best[2]


def r1(v: float) -> float:
    return round(v, 1)


def build() -> dict:
    raw = json.loads(OSM.read_text())
    gates, stands, layers = {}, {}, {k: [] for k in ("runway", "taxiway", "apron", "terminal", "stand", "hangar", "building", "parking", "road")}
    for e in raw["elements"]:
        t = e["tags"]
        if e["type"] == "node":
            if t.get("aeroway") == "gate" and t.get("ref"):
                gates[t["ref"]] = {"xy": project(e["lat"], e["lon"]), "level": t.get("level"), "bus": "Bus" in t.get("description", "")}
            continue
        pts = [project(a, b) for a, b in e["geometry"]]
        a = t.get("aeroway")
        if a == "parking_position":
            if t.get("ref"):
                stands.setdefault(t["ref"], pts)
            layers["stand"].append([[r1(x), r1(y)] for x, y in rdp(pts, 1.0)])
        elif a in ("runway", "taxiway", "apron", "terminal", "hangar"):
            item = {"pts": [[r1(x), r1(y)] for x, y in rdp(pts, 1.5)]}
            if a == "runway":
                item.update(ref=t.get("ref"), w=float(t.get("width", 45) or 45))
            if t.get("name"):
                item["name"] = t["name"]
            layers[a].append(item)
        elif t.get("amenity") == "parking":
            if math.dist(pts[0], (500, 0)) < 1400:
                layers["parking"].append({"pts": [[r1(x), r1(y)] for x, y in rdp(pts, 2)], "name": t.get("name")})
        elif "building" in t:
            layers["building"].append({"pts": [[r1(x), r1(y)] for x, y in rdp(pts, 1.5)], "name": t.get("name")})
        elif "highway" in t:
            layers["road"].append({"pts": [[r1(x), r1(y)] for x, y in rdp(pts, 3)], "kind": t["highway"]})

    # Contact stand for each gate: the nearest lead-in line whose end is within reach.
    def stand_for(xy, taken):
        best = None
        for ref, pts in stands.items():
            if ref in taken:
                continue
            for end, other in ((pts[0], pts[-1]), (pts[-1], pts[0])):
                d = math.dist(end, xy)
                if d < 75 and (best is None or d < best[0]):
                    best = (d, ref, end, other)
        return best

    taken: set[str] = set()
    remote_refs = {s for r in REMOTE.values() for s in r["stands"]}
    taken |= remote_refs
    piers_out, walk_check = [], []
    for P in PIERS:
        branches = P["branches"]
        root = branches[0][0]
        sec = SECURITY[P["term"]]
        lead = math.dist(sec, root) * INDOOR_DETOUR
        out_gates = []
        for ref in P["gates"] + P.get("busGates", []):
            if ref not in gates:
                print(f"  gate {ref} missing in OSM")
                continue
            g = gates[ref]
            # Nearest branch; along-distance; lateral offset.
            bi, (along, lat, q) = min(((i, project_on(b, g["xy"])) for i, b in enumerate(branches)), key=lambda z: z[1][1])
            st = None if ref in P.get("busGates", []) else stand_for(g["xy"], taken)
            item = {"id": ref, "x": r1(g["xy"][0]), "y": r1(g["xy"][1]), "branch": bi, "along": r1(along), "level": g["level"]}
            if ref in P.get("us", []):
                item["us"] = True
            if ref in P.get("busGates", []):
                item["bus"] = True
            if st:
                taken.add(st[1])
                (ex, ey), (ox, oy) = st[2], st[3]
                L = math.hypot(ox - ex, oy - ey) or 1
                # Aircraft centre about 24 m in from the nose position, nose towards the gate.
                cx, cy = ex + (ox - ex) / L * 24, ey + (oy - ey) / L * 24
                item["stand"] = {"ref": st[1], "door": [r1(ex), r1(ey)], "plane": [r1(cx), r1(cy)], "ang": round(math.atan2(ey - cy, ex - cx), 3)}
            real = lead + along + lat
            item["walkM"] = round(real)
            out_gates.append(item)
            walk_check.append((ref, P["id"], round(real), round(real / WALK_SPEED / 60, 1)))
        piers_out.append({"id": P["id"], "name": P["name"], "term": P["term"], "end": P.get("end", 0),
                          "branches": [[[r1(x), r1(y)] for x, y in b] for b in branches],
                          "securityToRootM": round(lead), "gates": out_gates})

    remote_out = []
    for key, R in REMOTE.items():
        bus_from = gates[R["busFrom"]]["xy"]
        for i, ref in enumerate(R["stands"]):
            if ref not in stands:
                print(f"  stand {ref} missing in OSM")
                continue
            pts = stands[ref]
            # Nose end: the end nearer the stand's gate (South Gates) or the apron edge.
            near = gates[R["gates"][i]]["xy"] if "gates" in R else bus_from
            e0, e1 = (pts[0], pts[-1]) if math.dist(pts[0], near) < math.dist(pts[-1], near) else (pts[-1], pts[0])
            L = math.hypot(e1[0] - e0[0], e1[1] - e0[1]) or 1
            c = (e0[0] + (e1[0] - e0[0]) / L * 24, e0[1] + (e1[1] - e0[1]) / L * 24)
            busM = math.dist(bus_from, c) * ROAD_DETOUR
            remote_out.append({"id": ref, "area": key, "areaName": R["name"], "gate": R["gates"][i] if "gates" in R else None,
                               "busFrom": R["busFrom"], "plane": [r1(c[0]), r1(c[1])], "ang": round(math.atan2(e0[1] - c[1], e0[0] - c[0]), 3),
                               "busM": round(busM), "busMin": round(busM / BUS_SPEED / 60 + (3 if key == "south" else 1), 1)})

    # Terminal interiors for the site view: the oriented box around each main
    # hall (terminal outline within 170 m of security), corners ordered like the
    # twin's terminal blocks: [airside-south, airside-north, landside-south].
    halls = {}
    for term, name in (("t1", "Terminal 1"), ("t2", "Terminal 2")):
        poly = next((t["pts"] for t in layers["terminal"] if t.get("name") == name), None)
        if not poly:
            continue
        dense = []
        for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1]):
            n = max(1, int(math.dist((x0, y0), (x1, y1)) / 4))
            dense += [(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(n)]
        pts = [p for p in dense if math.dist(p, SECURITY[term]) < 170]
        best = None
        for deg in range(0, 180, 2):
            a = math.radians(deg); ux, uy = math.cos(a), math.sin(a)
            us = [x * ux + y * uy for x, y in pts]; vs = [-x * uy + y * ux for x, y in pts]
            area = (max(us) - min(us)) * (max(vs) - min(vs))
            if best is None or area < best[0]:
                best = (area, ux, uy, min(us), max(us), min(vs), max(vs))
        _, ux, uy, u0, u1, v0, v1 = best
        cs = [(u * ux - v * uy, u * uy + v * ux) for u in (u0, u1) for v in (v0, v1)]
        tw = lambda c: (-c[1], c[0])   # the twin's turn: x right = real north, y down = real east
        a_s = min(cs, key=lambda c: tw(c)[0] + tw(c)[1])
        a_n = max(cs, key=lambda c: tw(c)[0] - tw(c)[1])
        l_s = max(cs, key=lambda c: tw(c)[1] - tw(c)[0])
        halls[term] = [[r1(x), r1(y)] for x, y in (a_s, a_n, l_s)]

    lay = {k: v for k, v in layers.items()}
    return {
        "source": "© OpenStreetMap contributors (ODbL 1.0)",
        "osmTimestamp": raw.get("timestamp"),
        "origin": [LAT0, LON0],
        "walkSpeed": WALK_SPEED,
        "security": {k: list(v) for k, v in SECURITY.items()},
        "immigration": {k: list(v) for k, v in IMMIGRATION.items()},
        "twin": TWIN,
        "piers": piers_out,
        "remote": remote_out,
        "halls": halls,
        "site": lay,
    }, walk_check


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--fetch", action="store_true", help="refresh the OSM cache from the Overpass API")
    args = ap.parse_args()
    if args.fetch or not OSM.exists():
        fetch()
    geo, check = build()
    OUT.write_text("/* Generated by airport_geometry.py from OpenStreetMap (ODbL). Do not edit. */\n"
                   "window.AIRPORT_GEO = " + json.dumps(geo, separators=(",", ":"), ensure_ascii=False) + ";\n")
    print(f"Wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.0f} KB): "
          f"{sum(len(p['gates']) for p in geo['piers'])} gates on {len(geo['piers'])} piers, {len(geo['remote'])} remote stands")
    by_pier: dict[str, list] = {}
    for ref, pier, m, mins in check:
        by_pier.setdefault(pier, []).append((m, mins, ref))
    for pier, rows in by_pier.items():
        lo, hi = min(rows), max(rows)
        print(f"  {pier}: security to gate {lo[0]}-{hi[0]} m, {lo[1]}-{hi[1]} min at {WALK_SPEED} m/s ({lo[2]} .. {hi[2]})")


if __name__ == "__main__":
    main()
