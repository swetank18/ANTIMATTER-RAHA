"""Download real OpenStreetMap geometry for every OmniStrand Atlas island.

Run once while online:   python scripts/fetch_osm.py
Output:                  raw/osm/<scenario>.json  (+ raw/osm/<scenario>_places.json)

Data (c) OpenStreetMap contributors, ODbL 1.0. Attribution is shown in the app.
"""
import json
import os
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "raw", "osm")
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
HEADERS = {"User-Agent": "omnistrand-atlas-data-fetch/1.0 (hackathon research tool)"}
RADIUS_M = 820  # island radius plus a small margin for clipping

# station: OSM name regex for the hub station; bbox = (south, west, north, east) search window
SCENARIOS = {
    "tambaram": {
        "station": "^Tambaram$",
        "bbox": (12.85, 80.05, 13.12, 80.30),
        "places": ["^Pallavaram$", "^Tirusulam$", "^Guindy$", "^Mambalam$", "^Chennai Egmore$"],
    },
    "ndls": {
        "station": "^New Delhi$",
        "bbox": (28.60, 77.19, 28.67, 77.25),
        "places": [],
    },
    "kurla": {
        "station": "^Kurla$",
        "bbox": (19.03, 72.84, 19.24, 73.02),
        "places": ["^Ghatkopar$", "^Thane$", "^Dadar$", "^Bandra$", "^Chembur$"],
    },
    "jurong": {
        "station": "^Jurong East$",
        "bbox": (1.27, 103.70, 1.36, 103.83),
        "places": ["^Clementi$", "^Dover$", "^Buona Vista$", "^Queenstown$"],
    },
    "atocha": {
        "station": "Atocha",
        "bbox": (40.37, -3.75, 40.50, -3.55),
        "places": ["Chamart", "^Aeropuerto T4$", "^Sol$", "^Méndez Álvaro$", "^Getafe Centro$"],
    },
}


def overpass(query):
    last = None
    for attempt in range(4):
        for url in ENDPOINTS:
            try:
                r = requests.post(url, data={"data": query}, headers=HEADERS, timeout=240)
                if r.status_code == 200:
                    return r.json()
                last = f"{url} -> HTTP {r.status_code}"
            except Exception as exc:  # network hiccup: try the next endpoint
                last = f"{url} -> {exc}"
        time.sleep(8 * (attempt + 1))
    raise RuntimeError(f"Overpass failed: {last}")


def center_of(el):
    if el.get("type") == "node":
        return el["lat"], el["lon"]
    c = el.get("center")
    return (c["lat"], c["lon"]) if c else None


def find_stations(name_regex, bbox):
    s, w, n, e = bbox
    q = f"""[out:json][timeout:90];
(
  node["railway"~"^(station|halt)$"]["name"~"{name_regex}",i]({s},{w},{n},{e});
  way["railway"="station"]["name"~"{name_regex}",i]({s},{w},{n},{e});
  node["public_transport"="station"]["name"~"{name_regex}",i]({s},{w},{n},{e});
  node["station"="subway"]["name"~"{name_regex}",i]({s},{w},{n},{e});
);
out center tags;"""
    data = overpass(q)
    found = []
    for el in data.get("elements", []):
        c = center_of(el)
        if c:
            found.append({"name": el.get("tags", {}).get("name"), "lat": c[0], "lon": c[1],
                          "tags": el.get("tags", {}), "osm": f"{el['type']}/{el['id']}"})
    return found


def features_around(lat, lon, r=RADIUS_M):
    a = f"(around:{r},{lat},{lon})"
    q = f"""[out:json][timeout:240];
(
  way["highway"]{a};
  way["railway"~"^(rail|platform|subway|light_rail|monorail|narrow_gauge|station)$"]{a};
  way["public_transport"~"^(platform|station)$"]{a};
  way["building"]{a};
  relation["building"]{a};
  way["building:part"]{a};
  way["natural"~"^(water|wood|scrub|grassland)$"]{a};
  relation["natural"="water"]{a};
  way["waterway"]{a};
  way["landuse"]{a};
  way["leisure"~"^(park|garden|pitch|playground)$"]{a};
  way["amenity"~"^(parking|bus_station)$"]{a};
  node["highway"="bus_stop"]{a};
  node["public_transport"="platform"]{a};
  node["railway"~"^(station|halt|subway_entrance)$"]{a};
  node["amenity"="bus_station"]{a};
);
out body geom qt;"""
    return overpass(q)


def main(only=None):
    os.makedirs(OUT, exist_ok=True)
    for sid, cfg in SCENARIOS.items():
        if only and sid not in only:
            continue
        print(f"[{sid}] locating hub station {cfg['station']!r} ...", flush=True)
        stations = find_stations(cfg["station"], cfg["bbox"])
        if not stations:
            print(f"  !! no station found for {sid}")
            continue
        # prefer mainline railway stations, then the one with the most tags
        stations.sort(key=lambda s: (s["tags"].get("railway") != "station", -len(s["tags"])))
        hub = stations[0]
        print(f"  hub = {hub['name']} @ {hub['lat']:.5f},{hub['lon']:.5f} ({hub['osm']}); {len(stations)} candidates")
        places = []
        for rx in cfg["places"]:
            time.sleep(2)
            res = find_stations(rx, cfg["bbox"])
            res.sort(key=lambda s: (s["tags"].get("railway") != "station", -len(s["tags"])))
            if res:
                places.append(res[0])
                print(f"  place {rx!r} -> {res[0]['name']} @ {res[0]['lat']:.5f},{res[0]['lon']:.5f}")
            else:
                print(f"  place {rx!r} -> not found")
        time.sleep(3)
        print(f"  downloading features within {RADIUS_M} m ...", flush=True)
        data = features_around(hub["lat"], hub["lon"])
        data["omnistrand_hub"] = hub
        data["omnistrand_candidates"] = stations[:8]
        data["omnistrand_radius_m"] = RADIUS_M
        data["omnistrand_fetched"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        with open(os.path.join(OUT, f"{sid}.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        with open(os.path.join(OUT, f"{sid}_places.json"), "w", encoding="utf-8") as f:
            json.dump(places, f, ensure_ascii=False, indent=1)
        n = len(data.get("elements", []))
        print(f"  saved {n} elements", flush=True)
        time.sleep(5)


if __name__ == "__main__":
    main(sys.argv[1:] or None)
