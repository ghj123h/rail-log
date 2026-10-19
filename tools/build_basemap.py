#!/usr/bin/env python3
"""Build the local unlabelled prefecture mesh from DataV GeoAtlas's public API.

Uses only the Python standard library. Source responses are cached outside the
repository. The source manifest records hashes so that the checked-in snapshot
can be identified independently of future upstream boundary updates.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import tempfile
from urllib.request import urlopen


BASE_URL = "https://geo.datav.aliyun.com/areas_v3/bound/"
MAPS = Path(__file__).resolve().parents[1] / "assets" / "maps"
UNDIVIDED = {110000, 120000, 310000, 500000, 710000, 810000, 820000}
PRECISION = 1_000_000


def gcj_offset(lon: float, lat: float) -> tuple[float, float]:
    """GCJ offset formula adapted from wandergis/coordtransform (MIT).

    This is a numerical alignment conversion, not a survey-grade datum transform.
    See ../assets/maps/LICENSE-coordtransform.txt for the original license.
    """
    if not (72.004 < lon < 137.8347 and 0.8293 < lat < 55.8271):
        return 0.0, 0.0
    x, y = lon - 105, lat - 35
    common = (20 * math.sin(6 * x * math.pi) + 20 * math.sin(2 * x * math.pi)) * 2 / 3
    dy = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    dy += common
    dy += (20 * math.sin(y * math.pi) + 40 * math.sin(y * math.pi / 3)) * 2 / 3
    dy += (160 * math.sin(y * math.pi / 12) + 320 * math.sin(y * math.pi / 30)) * 2 / 3
    dx = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    dx += common
    dx += (20 * math.sin(x * math.pi) + 40 * math.sin(x * math.pi / 3)) * 2 / 3
    dx += (150 * math.sin(x * math.pi / 12) + 300 * math.sin(x * math.pi / 30)) * 2 / 3
    rlat = math.radians(lat)
    magic = 1 - 0.006693421622965943 * math.sin(rlat) ** 2
    root = math.sqrt(magic)
    dy *= 180 / ((6378245 * (1 - 0.006693421622965943)) / (magic * root) * math.pi)
    dx *= 180 / (6378245 / root * math.cos(rlat) * math.pi)
    return dx, dy


def gcj_to_wgs(point: tuple[int, int]) -> list[float]:
    lon, lat = point[0] / PRECISION, point[1] / PRECISION
    x, y = lon, lat
    # Invert the forward offset instead of using only a one-step subtraction.
    for _ in range(6):
        dx, dy = gcj_offset(x, y)
        x, y = lon - dx, lat - dy
    return [round(x, 6), round(y, 6)]


def rings(geometry: dict):
    if geometry["type"] == "Polygon":
        yield from geometry["coordinates"]
    elif geometry["type"] == "MultiPolygon":
        for polygon in geometry["coordinates"]:
            yield from polygon
    else:
        raise ValueError(f"Unexpected source geometry: {geometry['type']}")


def edge_counts(features: list[dict]) -> Counter:
    result = Counter()
    for feature in features:
        for ring in rings(feature["geometry"]):
            points = [tuple(round(value * PRECISION) for value in p[:2]) for p in ring]
            for a, b in zip(points, points[1:]):
                if a != b:
                    result[tuple(sorted((a, b)))] += 1
    return result


def chains(edges: set, junctions: set | None = None) -> list:
    """Walk shared edges once, keeping junctions so simplification is consistent."""
    junctions = junctions or set()
    graph = defaultdict(set)
    for a, b in edges:
        graph[a].add(b)
        graph[b].add(a)
    remaining = set(edges)

    def walk(start, following):
        line = [start]
        previous, current = start, following
        while True:
            remaining.discard(tuple(sorted((previous, current))))
            line.append(current)
            if len(graph[current]) != 2 or current in junctions or current == start:
                break
            following = next(p for p in graph[current] if p != previous)
            previous, current = current, following
        return line

    lines = []
    for point in sorted(graph):
        if len(graph[point]) == 2 and point not in junctions:
            continue
        for neighbor in sorted(graph[point]):
            if tuple(sorted((point, neighbor))) in remaining:
                lines.append(walk(point, neighbor))
    while remaining:
        a, b = min(remaining)
        lines.append(walk(a, b))
    return lines


def simplify(points: list, tolerance: float) -> list:
    """Douglas-Peucker; shared junction endpoints never move."""
    if len(points) <= 2:
        return points
    keep = {0, len(points) - 1}
    stack = [(0, len(points) - 1)]
    square_tolerance = tolerance * tolerance
    while stack:
        lo, hi = stack.pop()
        ax, ay = points[lo]
        bx, by = points[hi]
        dx, dy = bx - ax, by - ay
        length = dx * dx + dy * dy
        best, best_index = square_tolerance, None
        for i in range(lo + 1, hi):
            px, py = points[i]
            t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / length)) if length else 0
            distance = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if distance > best:
                best, best_index = distance, i
        if best_index is not None:
            keep.add(best_index)
            stack.extend(((lo, best_index), (best_index, hi)))
    result = [points[i] for i in sorted(keep)]
    # Preserve the outlines of tiny offshore islands rather than collapsing a
    # closed ring to a zero-length line at the display simplification tolerance.
    return points if points[0] == points[-1] and len(result) < 4 else result


def bbox(lines: list) -> list[float]:
    points = [point for line in lines for point in line]
    return [min(p[0] for p in points), min(p[1] for p in points),
            max(p[0] for p in points), max(p[1] for p in points)]


def feature(kind: str, lines: list) -> dict:
    return {"type": "Feature", "bbox": bbox(lines), "properties": {"kind": kind},
            "geometry": {"type": "MultiLineString", "coordinates": lines}}


def build(cache: Path):
    cache.mkdir(parents=True, exist_ok=True)
    sources = {}

    def fetch(name):
        path = cache / name
        if not path.exists():
            with urlopen(BASE_URL + name, timeout=60) as response:
                raw = response.read()
            # Validate before caching, so an error page cannot become a snapshot.
            json.loads(raw)
            path.write_bytes(raw)
        raw = path.read_bytes()
        sources[name] = {"url": BASE_URL + name, "sha256": hashlib.sha256(raw).hexdigest(),
                         "bytes": len(raw)}
        return json.loads(raw)

    provinces = fetch("100000_full.json")["features"]
    # Keep the nationwide source fingerprint for boundary-representation checks.
    fetch("100000.json")
    province_codes = [f["properties"]["adcode"] for f in provinces
                      if isinstance(f["properties"].get("adcode"), int)
                      and f["properties"]["adcode"] not in UNDIVIDED]
    with ThreadPoolExecutor(max_workers=6) as executor:
        children = dict(zip(province_codes, executor.map(lambda code: fetch(f"{code}_full.json"), province_codes)))

    # Province and municipality perimeters must come from one consistent
    # nationwide dataset. Provincial _full files have differently generalized
    # exteriors, and overlaying those produces crossing/doubled province lines.
    province_edges = edge_counts([f for f in provinces
                                 if isinstance(f["properties"].get("adcode"), int)])
    provincial = {edge for edge, count in province_edges.items() if count > 1}
    administrative = set(province_edges) - provincial
    direct_county_groups = []
    prefecture_count = 0
    for province in provinces:
        code = province["properties"].get("adcode")
        if not isinstance(code, int):
            continue
        if code in UNDIVIDED:
            continue
        regions = []
        grouped = []
        for child in children[code]["features"]:
            child_code = child["properties"].get("adcode")
            if not isinstance(child_code, int):
                continue
            if child_code % 100:
                # Counties directly under a province are not prefectures. Merge
                # their collective exterior and suppress county-to-county edges.
                grouped.append(child)
            else:
                regions.append(set(edge_counts([child])))
                prefecture_count += 1
        if grouped:
            merged = {edge for edge, count in edge_counts(grouped).items() if count % 2}
            regions.append(merged)
            direct_county_groups.append({"provinceAdcode": code,
                                         "suppressedCountyAdcodes": [f["properties"]["adcode"] for f in grouped]})
        # Keep internal prefecture borders only; all province/coast/municipality
        # exteriors already come from the nationwide province mesh above.
        owners = Counter(edge for region in regions for edge in region)
        administrative.update(edge for edge, count in owners.items() if count > 1)
    administrative.difference_update(provincial)
    # Keep common layer junctions fixed so separate stroke widths do not create
    # small gaps where prefecture borders join province borders or the coast.
    degrees = Counter(point for edge in administrative | provincial for point in edge)
    junctions = {point for point, degree in degrees.items() if degree != 2}
    admin_lines = [simplify([gcj_to_wgs(p) for p in line], 0.0005)
                   for line in chains(administrative, junctions)]
    provincial_lines = [simplify([gcj_to_wgs(p) for p in line], 0.0005)
                        for line in chains(provincial, junctions)]
    # The standalone national file is coarser than the province mesh. Drawing
    # its perimeter on top would create a second, displaced coastline. Render
    # the source's separate national sea-boundary dashes here; land/coast
    # outlines are already part of the regional mesh above.
    national_features = [f for f in provinces if f["properties"].get("adcode") == "100000_JD"]
    national_lines = []
    seen = set()
    for source_feature in national_features:
        for ring in rings(source_feature["geometry"]):
            line = [gcj_to_wgs(tuple(round(v * PRECISION) for v in p[:2])) for p in ring]
            key = tuple(map(tuple, line))
            if key not in seen:
                seen.add(key)
                national_lines.append(line)

    result = {"type": "FeatureCollection", "properties": {
        "coordinateSystem": "WGS84", "sourceCoordinateSystem": "GCJ-02",
        "source": "Alibaba DataV GeoAtlas / Amap areas_v3",
        "nationalPerimeterLayer": "administrative",
        "administrativeSimplificationDegrees": 0.0005},
        "features": [feature("administrative", admin_lines),
                     feature("provincial", provincial_lines), feature("national", national_lines)]}
    MAPS.mkdir(parents=True, exist_ok=True)
    target = MAPS / "china-prefectures.geojson"
    target.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    manifest = {"retrievedDate": datetime.now(timezone.utc).date().isoformat(),
                "sources": {name: sources[name] for name in sorted(sources)},
                "prefectureCount": prefecture_count, "undividedProvinceAdcodes": sorted(UNDIVIDED),
                "directCountyGroups": direct_county_groups,
                "administrativeLines": len(admin_lines), "provincialLines": len(provincial_lines),
                "nationalLines": len(national_lines),
                "administrativePoints": sum(map(len, admin_lines)),
                "provincialPoints": sum(map(len, provincial_lines)),
                "nationalPoints": sum(map(len, national_lines)),
                "outputSha256": hashlib.sha256(target.read_bytes()).hexdigest()}
    (MAPS / "sources.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in manifest.items() if key != "sources"}, ensure_ascii=False, indent=2))
    print(f"Wrote {target} ({target.stat().st_size:,} bytes)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path,
                        default=Path(tempfile.gettempdir()) / "rail-log-datav-basemap")
    args = parser.parse_args()
    build(args.cache_dir)
