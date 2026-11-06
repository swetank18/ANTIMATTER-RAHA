"""Turn raw OSM downloads into compact island packs for the browser.

python scripts/build_packs.py      ->  data/geo/<scenario>.json

Coordinates are projected to local metres around the hub station (x = east, y = north),
clipped to the island radius and rounded to 0.1 m. Every building keeps where its height came from:
0 = OSM height tag (T1), 1 = OSM building:levels x 3.2 m (T2), 2 = default by type (T4).
"""
import json
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw", "osm")
OUT = os.path.join(ROOT, "data", "geo")
R_ISLAND = 780.0

ROAD_CLASS = {
    "motorway": 0, "trunk": 0, "primary": 0, "motorway_link": 0, "trunk_link": 0, "primary_link": 0,
    "secondary": 1, "tertiary": 1, "secondary_link": 1, "tertiary_link": 1,
    "residential": 2, "unclassified": 2, "service": 2, "living_street": 2, "road": 2,
    "footway": 3, "pedestrian": 3, "path": 3, "steps": 3, "cycleway": 3, "track": 3,
}
DEFAULT_H = {"house": 7, "residential": 10, "apartments": 18, "commercial": 14, "retail": 9, "industrial": 9,
             "train_station": 12, "transportation": 10, "warehouse": 9, "office": 22, "hotel": 24, "school": 10,
             "hospital": 18, "church": 14, "temple": 12, "mosque": 12, "roof": 5, "garage": 4, "shed": 3}


def proj(lat0, lon0):
    kx = 111320.0 * math.cos(math.radians(lat0))
    ky = 110574.0
    return lambda lat, lon: ((lon - lon0) * kx, (lat - lat0) * ky)


def parse_h(tags):
    for k in ("height", "building:height"):
        if k in tags:
            try:
                return float(str(tags[k]).replace("m", "").strip().split(";")[0]), 0
            except ValueError:
                pass
    for k in ("building:levels", "levels"):
        if k in tags:
            try:
                return max(3.0, float(str(tags[k]).split(";")[0]) * 3.2), 1
            except ValueError:
                pass
    b = tags.get("building", "yes")
    return float(DEFAULT_H.get(b, 9)), 2


def q(v):
    return round(v, 1)


def clip_line(pts):
    """keep segments inside the island; split where the line leaves it"""
    out, cur = [], []
    for p in pts:
        if math.hypot(*p) <= R_ISLAND:
            cur.append(p)
        else:
            if len(cur) > 1:
                out.append(cur)
            cur = []
    if len(cur) > 1:
        out.append(cur)
    return out


def area(poly):
    s = 0.0
    for i in range(len(poly)):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % len(poly)]
        s += x1 * y2 - x2 * y1
    return s / 2


def centroid(poly):
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def haversine(a, b):
    R = 6371.0
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def bearing(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    y = math.sin(lo2 - lo1) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(lo2 - lo1)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def build(sid):
    with open(os.path.join(RAW, f"{sid}.json"), encoding="utf-8") as f:
        d = json.load(f)
    hub = d["omnistrand_hub"]
    P = proj(hub["lat"], hub["lon"])
    pack = {"id": sid, "hub": {"name": hub["name"], "lat": hub["lat"], "lon": hub["lon"], "osm": hub["osm"]},
            "radius": R_ISLAND, "buildings": [], "roads": [[], [], [], []], "rail": [], "platforms": [],
            "water": [], "green": [], "busStops": [], "stations": [], "footbridges": [], "places": [],
            "fetched": d.get("omnistrand_fetched"), "license": "(c) OpenStreetMap contributors, ODbL 1.0"}
    hsrc = [0, 0, 0]
    for el in d.get("elements", []):
        t = el.get("tags", {})
        if el["type"] == "node":
            x, y = P(el["lat"], el["lon"])
            if math.hypot(x, y) > R_ISLAND:
                continue
            if t.get("highway") == "bus_stop" or (t.get("public_transport") == "platform" and t.get("bus") == "yes"):
                pack["busStops"].append([q(x), q(y), t.get("name", "")])
            elif t.get("railway") in ("station", "halt") or t.get("public_transport") == "station":
                pack["stations"].append([q(x), q(y), t.get("name", "")])
            continue
        geoms = []
        if el["type"] == "way" and "geometry" in el:
            geoms = [[P(g["lat"], g["lon"]) for g in el["geometry"] if g]]
        elif el["type"] == "relation":
            for m in el.get("members", []):
                if m.get("role") == "outer" and "geometry" in m:
                    geoms.append([P(g["lat"], g["lon"]) for g in m["geometry"] if g])
        for pts in geoms:
            if len(pts) < 2:
                continue
            closed = len(pts) > 3 and abs(pts[0][0] - pts[-1][0]) < 0.01 and abs(pts[0][1] - pts[-1][1]) < 0.01
            if "building" in t or "building:part" in t:
                if not closed:
                    continue
                c = centroid(pts)
                if math.hypot(*c) > R_ISLAND - 8:
                    continue
                poly = pts[:-1]
                if abs(area(poly)) < 6:
                    continue
                h, src = parse_h(t)
                hsrc[src] += 1
                flat = [src, q(min(h, 320))]
                for p in poly:
                    flat += [q(p[0]), q(p[1])]
                pack["buildings"].append(flat)
            elif "highway" in t:
                cls = ROAD_CLASS.get(t["highway"])
                if cls is None:
                    continue
                if t.get("bridge") == "yes" and t["highway"] in ("footway", "steps", "pedestrian", "path"):
                    for seg in clip_line(pts):
                        pack["footbridges"].append([[q(a), q(b)] for a, b in seg])
                for seg in clip_line(pts):
                    pack["roads"][cls].append([[q(a), q(b)] for a, b in seg])
            elif t.get("railway") in ("rail", "subway", "light_rail", "monorail", "narrow_gauge"):
                for seg in clip_line(pts):
                    pack["rail"].append([[q(a), q(b)] for a, b in seg])
            elif t.get("railway") == "platform" or t.get("public_transport") == "platform":
                for seg in clip_line(pts):
                    pack["platforms"].append([[q(a), q(b)] for a, b in seg])
            elif t.get("natural") == "water" or t.get("waterway") or t.get("landuse") in ("reservoir", "basin"):
                for seg in clip_line(pts):
                    pack["water"].append([[q(a), q(b)] for a, b in seg])
            elif t.get("leisure") in ("park", "garden", "pitch", "playground") or t.get("landuse") in ("grass", "forest", "meadow", "recreation_ground", "village_green") or t.get("natural") in ("wood", "scrub", "grassland"):
                if closed:
                    poly = [p for p in pts if math.hypot(*p) <= R_ISLAND]
                    if len(poly) > 2:
                        pack["green"].append([[q(a), q(b)] for a, b in poly])
    # destination places (real station coordinates)
    pf = os.path.join(RAW, f"{sid}_places.json")
    if os.path.exists(pf):
        with open(pf, encoding="utf-8") as f:
            for p in json.load(f):
                hb = (hub["lat"], hub["lon"])
                pt = (p["lat"], p["lon"])
                pack["places"].append({"key": p["name"], "name": p["name"], "lat": p["lat"], "lon": p["lon"],
                                       "distKm": round(haversine(hb, pt), 3), "bearing": round(bearing(hb, pt), 1)})
    pack["stats"] = {"buildings": len(pack["buildings"]), "heightFromTag": hsrc[0], "heightFromLevels": hsrc[1],
                     "heightDefault": hsrc[2], "roads": sum(len(r) for r in pack["roads"]), "rail": len(pack["rail"]),
                     "busStops": len(pack["busStops"]), "footbridges": len(pack["footbridges"])}
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f"{sid}.json"), "w", encoding="utf-8") as f:
        json.dump(pack, f, ensure_ascii=False, separators=(",", ":"))
    print(sid, pack["stats"], [(p["name"], p["distKm"]) for p in pack["places"]])


if __name__ == "__main__":
    for fn in sorted(os.listdir(RAW)):
        if fn.endswith(".json") and not fn.endswith("_places.json"):
            build(fn[:-5])
