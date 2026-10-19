#!/usr/bin/env python3
"""Build Yellow/Yangtze mainstem lines from Natural Earth and OpenStreetMap.

Uses only Python's standard library. The complete source archive is cached in
the system temporary directory; only the two selected rivers are published.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import tempfile
from urllib.request import urlopen
import xml.etree.ElementTree as ET
from zipfile import ZipFile


SOURCE_URL = "https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_rivers_lake_centerlines.zip"
SOURCE_SHA256 = "ded71b01870855ccfe19b51f2ec14c9bb48fae23c0e9f3c11974d426433b5c38"
OSM_URL = "https://api.openstreetmap.org/api/0.6/relation/9392345/full.json"
OSM_SHA256 = "c4b9c087cad03342733277cfa26c6f030ca429f2384a051d83e272e42b391ad1"
YELLOW_MOUTH_URL = "https://api.openstreetmap.org/api/0.6/way/29544745/full"
YELLOW_MOUTH_SHA256 = "ddb301d5348667dd7196f56436afe3b4c53f460b2d542a639463090bc809d408"
STEM = "ne_10m_rivers_lake_centerlines"
MAPS = Path(__file__).resolve().parents[1] / "assets" / "maps"
# Explicit source identifiers avoid selecting similarly named tributaries.
# Lake Centerline 1159124945 is the Yellow River's own headwater lake passage.
RIVERS = {
    "黄河": {1159124945, 1159124959, 1159128895},
    "长江": {1159112047, 1159112343, 1159112733, 1159113509},
}


def dbf_records(data: bytes) -> list[dict]:
    count = struct.unpack_from("<I", data, 4)[0]
    header_size, record_size = struct.unpack_from("<HH", data, 8)
    fields = []
    offset = 32
    while data[offset] != 13:
        descriptor = data[offset:offset + 32]
        fields.append((descriptor[:11].split(b"\0")[0].decode("ascii"), descriptor[16]))
        offset += 32
    result = []
    for index in range(count):
        row = data[header_size + index * record_size:header_size + (index + 1) * record_size]
        cursor = 1
        record = {}
        for name, size in fields:
            record[name] = row[cursor:cursor + size].decode("utf-8").strip("\0 ")
            cursor += size
        result.append(record)
    return result


def shapefile_lines(data: bytes) -> list[list]:
    result = []
    offset = 100
    while offset < len(data):
        _, words = struct.unpack_from(">II", data, offset)
        shape = data[offset + 8:offset + 8 + words * 2]
        shape_type = struct.unpack_from("<I", shape)[0]
        if shape_type == 0:
            result.append([])
        elif shape_type == 3:
            part_count, point_count = struct.unpack_from("<II", shape, 36)
            starts = list(struct.unpack_from(f"<{part_count}I", shape, 44)) + [point_count]
            point_offset = 44 + 4 * part_count
            points = [[round(x, 6), round(y, 6)]
                      for x, y in struct.iter_unpack("<dd", shape[point_offset:point_offset + point_count * 16])]
            result.append([points[a:b] for a, b in zip(starts, starts[1:])])
        else:
            raise ValueError(f"Expected a 2D polyline shapefile, got shape type {shape_type}")
        offset += 8 + words * 2
    return result


def join_touching_lines(lines: list) -> list:
    """Join existing coincident endpoints only; never draw across a source gap."""
    pending = [line[:] for line in lines if len(line) > 1]
    changed = True
    while changed:
        changed = False
        for i, a in enumerate(pending):
            for j in range(i + 1, len(pending)):
                b = pending[j]
                if a[-1] == b[0]:
                    merged = a + b[1:]
                elif a[-1] == b[-1]:
                    merged = a + b[-2::-1]
                elif a[0] == b[-1]:
                    merged = b + a[1:]
                elif a[0] == b[0]:
                    merged = a[::-1] + b[1:]
                else:
                    continue
                pending[i] = merged
                pending.pop(j)
                changed = True
                break
            if changed:
                break
    return pending


def bounds(lines: list) -> list[float]:
    points = [point for line in lines for point in line]
    return [min(p[0] for p in points), min(p[1] for p in points),
            max(p[0] for p in points), max(p[1] for p in points)]


def segment_crossing(a, b, c, d):
    dx, dy = b[0] - a[0], b[1] - a[1]
    ex, ey = d[0] - c[0], d[1] - c[1]
    denominator = dx * ey - dy * ex
    if abs(denominator) < 1e-15:
        return None
    u = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / denominator
    v = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / denominator
    return u, v, [a[0] + u * dx, a[1] + u * dy]


def yellow_mouth(cache_dir: Path):
    path = cache_dir / "way-29544745-full.osm"
    if not path.exists():
        with urlopen(YELLOW_MOUTH_URL, timeout=60) as response:
            path.write_bytes(response.read())
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != YELLOW_MOUTH_SHA256:
        raise ValueError("Yellow River mouth source differs from its documented snapshot")
    root = ET.fromstring(raw)
    nodes = {node.get("id"): [float(node.get("lon")), float(node.get("lat"))]
             for node in root.findall("node")}
    way = next(way for way in root.findall("way") if way.get("id") == "29544745")
    return [nodes[node.get("ref")] for node in way.findall("nd")], {
        "name": "OpenStreetMap Yellow River mouth", "url": YELLOW_MOUTH_URL,
        "sha256": YELLOW_MOUTH_SHA256, "way": 29544745, "parentRelation": 171843,
        "wayVersion": int(way.get("version")), "wayTimestamp": way.get("timestamp"),
        "license": "ODbL-1.0", "attribution": "© OpenStreetMap contributors",
        "licenseUrl": "https://opendatacommons.org/licenses/odbl/1-0/"}


def align_mouths(features: list, mouth: list) -> dict:
    basemap_path = MAPS / "china-prefectures.geojson"
    basemap_raw = basemap_path.read_bytes()
    basemap = json.loads(basemap_raw)
    coast = next(f for f in basemap["features"] if f["properties"]["kind"] == "administrative")["geometry"]["coordinates"]
    yellow_shore = [[119.234278, 37.877331], [119.285998, 37.868805]]
    yangtze_gate = [[121.973208, 31.018505], [122.093033, 31.257335]]
    if not any((a == yellow_shore[0] and b == yellow_shore[1])
               or (b == yellow_shore[0] and a == yellow_shore[1])
               for line in coast for a, b in zip(line, line[1:])):
        raise ValueError("The displayed Yellow River shoreline segment has changed")
    if not all(any(point in line for line in coast) for point in yangtze_gate):
        raise ValueError("The displayed Yangtze outer-mouth shoreline vertices have changed")
    metadata = {"basemapSha256": hashlib.sha256(basemap_raw).hexdigest()}
    for feature in features:
        lines = feature["geometry"]["coordinates"]
        index = max(range(len(lines)), key=lambda i: max(p[0] for p in lines[i]))
        line = lines[index]
        if feature["properties"]["name"] == "黄河":
            # Replace only the smallest downstream tail: splice at the last
            # existing intersection of NE's old channel and the actual OSM way.
            crossings = []
            for ni, (a, b) in enumerate(zip(line, line[1:])):
                for oi, (c, d) in enumerate(zip(mouth, mouth[1:])):
                    hit = segment_crossing(a, b, c, d)
                    if hit and 0 <= hit[0] <= 1 and 0 <= hit[1] <= 1:
                        crossings.append((oi + hit[1], ni, oi, hit[2]))
            _, ni, oi, splice = max(crossings)
            line = line[:ni + 1] + [splice] + mouth[oi + 1:]
            # The present OSM mouth is about 0.7 km inside the older displayed
            # delta coastline. Extend its final tangent only to that shoreline.
            endpoint, previous = line[-1], line[-2]
            ray = [2 * endpoint[0] - previous[0], 2 * endpoint[1] - previous[1]]
            hit = segment_crossing(endpoint, ray, *yellow_shore)
            if not hit or hit[0] < 0 or not 0 <= hit[1] <= 1:
                raise ValueError("Yellow River mouth tangent does not meet the displayed shoreline")
            point = hit[2]
            distance = 111195 * math.hypot((point[0] - endpoint[0]) * math.cos(math.radians(endpoint[1])),
                                          point[1] - endpoint[1])
            lines[index] = [[round(p[0], 6), round(p[1], 6)] for p in line + [point]]
            metadata["黄河"] = {"method": "actual OSM tail, then final tangent to displayed shoreline",
                                 "sourceSplice": splice, "sourceEndpoint": endpoint,
                                 "coastlineSegment": yellow_shore, "endpoint": lines[index][-1],
                                 "extensionMeters": round(distance, 3)}
        else:
            # River centerlines pass between two shores. Clip at the outer
            # mouth gate, rather than an upstream administrative-water closure.
            crossings = []
            for i, (a, b) in enumerate(zip(line, line[1:])):
                hit = segment_crossing(a, b, *yangtze_gate)
                if hit and 0 <= hit[0] <= 1 and 0 <= hit[1] <= 1:
                    crossings.append((i, hit[2]))
            i, point = crossings[-1]
            lines[index] = line[:i + 1] + [[round(point[0], 6), round(point[1], 6)]]
            metadata["长江"] = {"method": "clip actual mainstem at displayed outer-mouth gate",
                                 "mouthGate": yangtze_gate, "endpoint": lines[index][-1]}
        feature["bbox"] = bounds(lines)
    return metadata


def osm_yangtze(cache_dir: Path) -> tuple[list, dict]:
    path = cache_dir / "osm-relation-9392345-full.json"
    if not path.exists():
        with urlopen(OSM_URL, timeout=60) as response:
            path.write_bytes(response.read())
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != OSM_SHA256:
        raise ValueError("OSM source differs from the documented relation 9392345 snapshot")
    data = json.loads(raw.decode("utf-8-sig"))
    nodes = {element["id"]: element for element in data["elements"] if element["type"] == "node"}
    ways = {element["id"]: element for element in data["elements"] if element["type"] == "way"}
    relation = next(element for element in data["elements"]
                    if element["type"] == "relation" and element["id"] == 9392345)
    members = [member for member in relation["members"]
               if member["type"] == "way" and member["role"] == "main_stream"]
    # The relation explicitly distinguishes the main channel from side channels.
    # Preserve its existing nodes; join only identical member endpoints.
    lines = [[[round(nodes[node]["lon"], 6), round(nodes[node]["lat"], 6)]
              for node in ways[member["ref"]]["nodes"]] for member in members]
    return join_touching_lines(lines), {
        "name": "OpenStreetMap", "url": OSM_URL, "sha256": OSM_SHA256,
        "relation": 9392345, "relationVersion": relation["version"],
        "relationTimestamp": relation["timestamp"], "mainStreamWays": len(members),
        "license": "ODbL-1.0", "attribution": "© OpenStreetMap contributors",
        "licenseUrl": "https://opendatacommons.org/licenses/odbl/1-0/"}


def yangtze_headwaters(selected: list, downstream_start: list) -> list:
    # NE's 'Chang Jiang' also includes the last upstream stretch before Yibin.
    # Retain only its source vertices up to the nearest vertex to OSM's Yibin
    # confluence. Drop all its downstream geometry to prevent doubled channels.
    # The two source endpoints remain separate: no artificial connector is added.
    upper = [line for record, parts in selected if int(record["ne_id"]) != 1159113509
             for line in parts]
    endpoints = {tuple(point) for line in upper for point in (line[0], line[-1])}
    connecting = [line for record, parts in selected if int(record["ne_id"]) == 1159113509
                  for line in parts if tuple(line[0]) in endpoints or tuple(line[-1]) in endpoints]
    if len(connecting) != 1:
        raise ValueError("Expected one NE Chang Jiang segment connected to the Jinsha mainstem")
    line = connecting[0]
    latitude_scale = math.cos(math.radians(downstream_start[1]))
    index = min(range(len(line)), key=lambda i:
                ((line[i][0] - downstream_start[0]) * latitude_scale) ** 2
                + (line[i][1] - downstream_start[1]) ** 2)
    clipped = line[:index + 1] if tuple(line[0]) in endpoints else line[index:]
    return join_touching_lines(upper + [clipped])


def build(cache_dir: Path):
    cache_dir.mkdir(parents=True, exist_ok=True)
    archive_path = cache_dir / f"{STEM}.zip"
    if not archive_path.exists():
        with urlopen(SOURCE_URL, timeout=60) as response:
            archive_path.write_bytes(response.read())
    archive_bytes = archive_path.read_bytes()
    digest = hashlib.sha256(archive_bytes).hexdigest()
    if digest != SOURCE_SHA256:
        raise ValueError(f"Source snapshot differs from the documented v5.0.0 archive: {digest}")
    with ZipFile(archive_path) as archive:
        version = archive.read(f"{STEM}.VERSION.txt").decode().strip()
        crs = archive.read(f"{STEM}.prj").decode()
        if "GCS_WGS_1984" not in crs:
            raise ValueError("Source is not the documented WGS84 dataset")
        records = dbf_records(archive.read(f"{STEM}.dbf"))
        geometries = shapefile_lines(archive.read(f"{STEM}.shp"))
    osm_lines, osm_source = osm_yangtze(cache_dir)
    yellow_mouth_line, yellow_source = yellow_mouth(cache_dir)
    features = []
    for name, identifiers in RIVERS.items():
        selected = [(record, lines) for record, lines in zip(records, geometries)
                    if record["ne_id"] and int(record["ne_id"]) in identifiers]
        if len(selected) != len(identifiers):
            raise ValueError(f"Missing a documented {name} mainstem source record")
        lines = (yangtze_headwaters(selected, osm_lines[0][0]) + osm_lines if name == "长江"
                 else join_touching_lines([line for _, parts in selected for line in parts]))
        features.append({"type": "Feature", "bbox": bounds(lines),
                         "properties": {"kind": "river", "name": name},
                         "geometry": {"type": "MultiLineString", "coordinates": lines}})
        print(json.dumps({"name": name, "parts": len(lines), "points": sum(map(len, lines)),
                          "bbox": bounds(lines),
                          "sourceRecords": [{"ne_id": record["ne_id"], "name": record["name"],
                                             "class": record["featurecla"]} for record, _ in selected]},
                         ensure_ascii=False))
    alignment = align_mouths(features, yellow_mouth_line)
    result = {"type": "FeatureCollection", "properties": {
        "coordinateSystem": "WGS84", "source": "Natural Earth / OpenStreetMap",
        "sources": [{"name": "Natural Earth", "version": version, "url": SOURCE_URL,
                     "sha256": digest, "license": "Public Domain",
                     "licenseUrl": "https://www.naturalearthdata.com/about/terms-of-use/"}, osm_source, yellow_source],
        "mouthAlignment": alignment,
        "license": "ODbL-1.0", "attribution": "© OpenStreetMap contributors",
        "licenseUrl": "https://opendatacommons.org/licenses/odbl/1-0/"},
        "features": features}
    output = MAPS / "major-rivers.geojson"
    output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"mouthAlignment": alignment,
                      "counts": [{"name": f["properties"]["name"], "points": sum(map(len, f["geometry"]["coordinates"]))}
                                 for f in features]}, ensure_ascii=False))
    print(f"Wrote {output} ({output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path,
                        default=Path(tempfile.gettempdir()) / "rail-log-rivers")
    args = parser.parse_args()
    build(args.cache_dir)
