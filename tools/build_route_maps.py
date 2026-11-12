"""Build separate WGS84 route-map files from the original GPS Fix samples.

Only positions belonging to retained published speed samples are included.
The speed chart's 1.5-interval gap rule is reused, including cleanup gaps.
Station lists and public reference positions live in route_stations.json.
Reviewed WGS84 platform envelopes live in station_footprints.json. Stations
without a usable envelope keep the original point-position selection.
"""
import argparse
import json
import math
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def distance(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, [*a, *b])
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 12742017.6 * math.asin(min(1, math.sqrt(h)))


def platform_envelope(corners, center, arrival_tracks, clearance_m):
    """Keep platform length; set lateral edges beyond outer arrival tracks."""
    phi = math.radians(center[1])
    e2 = .0066943799901413165
    n = 6378137 / math.sqrt(1 - e2 * math.sin(phi) ** 2)
    m = 6378137 * (1 - e2) / (1 - e2 * math.sin(phi) ** 2) ** 1.5
    scales = [n * math.cos(phi) * math.pi / 180, m * math.pi / 180]
    xy = [[(p[i] - center[i]) * scales[i] for i in (0, 1)] for p in corners]
    edges = [[q[i] - p[i] for i in (0, 1)] for p, q in zip(xy, xy[1:] + xy[:1])]
    edge = max(edges, key=lambda p: math.hypot(*p))
    length = math.hypot(*edge)
    along = [p / length for p in edge]
    across = [-along[1], along[0]]
    ranges = [[sum(p[i] * axis[i] for i in (0, 1)) for p in xy] for axis in (along, across)]
    bounds = [[min(values), max(values)] for values in ranges]
    track_points = [point for track in arrival_tracks for point in track["coordinates"]]
    if not track_points:
        return corners, round(bounds[0][1] - bounds[0][0], 3), round(bounds[1][1] - bounds[1][0], 3)
    track_cross = [sum((point[i] - center[i]) * scales[i] * across[i] for i in (0, 1)) for point in track_points]
    bounds[1][0] = min(bounds[1][0], min(track_cross) - clearance_m)
    bounds[1][1] = max(bounds[1][1], max(track_cross) + clearance_m)
    envelope = [[round(center[i] + (s * along[i] + v * across[i]) / scales[i], 10) for i in (0, 1)]
              for s, v in [(bounds[0][0], bounds[1][0]), (bounds[0][1], bounds[1][0]),
                           (bounds[0][1], bounds[1][1]), (bounds[0][0], bounds[1][1])]]
    return envelope, round(bounds[0][1] - bounds[0][0], 3), round(bounds[1][1] - bounds[1][0], 3)


def read_positions(path, samples):
    wanted = {sample["t"] for sample in samples}
    positions = {}
    with path.open(encoding="utf-8-sig") as source:
        for line in source:
            if not line.startswith("Fix,gps,"):
                continue
            fields = line.rstrip().split(",")
            timestamp = int(fields[8])
            if timestamp not in wanted:
                continue
            lon, lat = float(fields[3]), float(fields[2])
            if not (math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90):
                raise ValueError(f"Invalid coordinate at {timestamp} in {path.name}")
            if timestamp in positions:
                raise ValueError(f"Duplicate GPS Fix at {timestamp} in {path.name}")
            positions[timestamp] = [lon, lat, timestamp]
    missing = wanted - positions.keys()
    if missing:
        raise ValueError(f"{path.name}: missing {len(missing)} published sample positions")
    return [positions[sample["t"]] for sample in samples]


def station_position(station, points, events):
    """Use an actual track point near the station, otherwise its public position.

    A marked station's time window is preferred: its representative sample must
    be within 1 km of the station POI (which can be the station building rather
    than the platform). Without usable window samples, only snap to the whole
    trip's nearest sample within 500 m. No trajectory or event is interpolated.
    """
    reference = [station["lon"], station["lat"]]
    event = next((event for event in events if event["name"].removesuffix("站") == station["name"].removesuffix("站")), None)
    if event:
        candidates = [point for point in points if event["start"] <= point[2] <= event["end"]]
        if candidates:
            if event["type"] == "stop":
                median = [statistics.median(point[axis] for point in candidates) for axis in (0, 1)]
                representative = min(candidates, key=lambda point: distance(point[:2], median))
            else:
                representative = min(candidates, key=lambda point: abs(point[2] - (event["start"] + event["end"]) / 2))
            if distance(representative[:2], reference) <= 1000:
                return representative[:2], "gnss"
    nearest = min(points, key=lambda point: distance(point[:2], reference))
    if distance(nearest[:2], reference) <= 500:
        return nearest[:2], "gnss"
    return reference, "public"


def build(trip, source_root, definitions, footprints):
    record_id = trip["id"]
    source_name = f"gnss_log_20{record_id[:2]}_{record_id[2:4]}_{record_id[4:6]}_{record_id[6:8]}_{record_id[8:10]}_{record_id[10:12]}.txt"
    source = source_root / source_name
    if not source.exists():
        source = source_root / f"{trip['train']}_20{record_id[:2]}-{record_id[2:4]}-{record_id[4:6]}_{record_id[6:8]}-{record_id[8:10]}-{record_id[10:12]}.txt"
    points = read_positions(source, trip["samples"])
    segments = []
    for index, point in enumerate(points):
        if not index or point[2] - points[index - 1][2] > 1.5 * trip.get("sampleIntervalMs", 1000):
            segments.append([])
        segments[-1].append([round(point[0], 7), round(point[1], 7), point[2]])
    names = definitions["routes"][record_id]
    if not trip["origin"] and not trip.get("partial"):
        raise ValueError(f"{record_id}: only partial records may have an unknown origin")
    if (trip["origin"] and names[0] != trip["origin"]) or names[-1] != trip["destination"]:
        raise ValueError(f"{record_id}: station list endpoints disagree with the published record")
    stations, sources = [], {}
    for name in names:
        footprint = footprints["stations"].get(name)
        if footprint:
            position, source = footprint["center"], "platform"
        else:
            position, source = station_position({"name": name, **definitions["stations"][name]}, points, trip["events"])
        station = {"name": name, "lon": round(position[0], 7), "lat": round(position[1], 7)}
        if footprint:
            display_corners, _, _ = platform_envelope(footprint["platformCorners"], position, footprint["arrivalTracks"], footprints["arrivalClearanceM"])
            station["platform"] = {"corners": display_corners}
        stations.append(station)
        sources[name] = source
    result = {"id": record_id, "coordinateSystem": "WGS84", "segments": segments, "stations": stations}
    return result, {"id": record_id, "points": len(points), "segments": len(segments), "stations": len(stations), "platformStations": sum("platform" in station for station in stations), "publicStations": [name for name, source in sources.items() if source == "public"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--id", help="Build one record; default: every record in records/index.json")
    parser.add_argument("--source-root", type=Path, default=ROOT.parent, help="Directory containing original GNSS logs")
    parser.add_argument("--stations", type=Path, default=ROOT / "tools/route_stations.json")
    parser.add_argument("--platforms", type=Path, default=ROOT / "tools/station_footprints.json", help="Reviewed platform envelopes; missing stations retain their original point markers")
    args = parser.parse_args()
    definitions = json.loads(args.stations.read_text(encoding="utf-8-sig"))
    footprints = json.loads(args.platforms.read_text(encoding="utf-8-sig"))
    if footprints["coordinateSystem"] != "WGS84":
        raise ValueError("Station platform envelopes must use WGS84")
    ids = [args.id] if args.id else [entry["id"] for entry in json.loads((ROOT / "records/index.json").read_text(encoding="utf-8-sig"))]
    for record_id in ids:
        trip = json.loads((ROOT / f"records/{record_id}.json").read_text(encoding="utf-8-sig"))
        result, summary = build(trip, args.source_root, definitions, footprints)
        destination = ROOT / f"records/{record_id}.route.json"
        destination.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
        print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
