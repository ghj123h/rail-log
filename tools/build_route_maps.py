"""Build separate WGS84 route-map files from the original GPS Fix samples.

Uses all position fixes within the trip's recorded time window; speed cleaning
does not alter routes, and only map-only GNSS position drift filtering
(accuracy, speed consistency, and sharp spikes) is applied.
Station lists and public reference positions live in route_stations.json.
Reviewed WGS84 platform envelopes live in station_footprints.json.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from gnss_pipeline import (
    DEFAULT_MAX_H_ACC_M,
    ROOT,
    build_route_record,
    coords_distance_m as distance,
    platform_envelope,
    read_json,
    resolve_source_paths,
    station_position,
    stream_gnss_logs,
    write_json,
)


def read_route_fixes(paths: Path | list[Path] | tuple[Path, ...], start: int, end: int) -> list[dict]:
    """Read all valid GPS Fix records within [start, end] across one or continuation logs."""
    path_list = [Path(paths)] if isinstance(paths, (Path, str)) else [Path(item) for item in paths]
    parsed = stream_gnss_logs(path_list, strict=True)
    return [fix for fix in parsed["fixes"] if start <= fix["t"] <= end]


def read_retained_fixes(paths: Path | list[Path] | tuple[Path, ...], samples: list[dict]) -> list[dict]:
    """Read retained Fix records across one original log or continuation logs."""
    path_list = [Path(paths)] if isinstance(paths, (Path, str)) else [Path(item) for item in paths]
    wanted = {sample["t"] for sample in samples}
    parsed = stream_gnss_logs(path_list, strict=True, allowed_timestamps=wanted)
    by_timestamp = {fix["t"]: fix for fix in parsed["fixes"]}
    missing = wanted - by_timestamp.keys()
    if missing:
        raise ValueError(
            f"{', '.join(path.name for path in path_list)}: missing {len(missing)} published sample positions"
        )
    return [by_timestamp[sample["t"]] for sample in samples]


def read_positions(paths: Path | list[Path] | tuple[Path, ...], samples: list[dict]) -> list[list]:
    """Read retained [lon, lat, timestamp] coordinates in published sample order."""
    return [[fix["lon"], fix["lat"], fix["t"]] for fix in read_retained_fixes(paths, samples)]


def build(
    trip: dict,
    source_root: Path,
    definitions: dict,
    footprints: dict,
    *,
    filter_drift: bool = True,
    max_h_acc_m: float = DEFAULT_MAX_H_ACC_M,
) -> tuple[dict, dict]:
    """Build a single route-map record from its trip JSON and original GNSS logs."""
    sources = resolve_source_paths(trip["id"], trip["train"], source_root, definitions)
    start = trip["logStart"] if trip.get("logStart") is not None else trip["samples"][0]["t"]
    end = trip["logEnd"] if trip.get("logEnd") is not None else trip["samples"][-1]["t"]
    fixes = read_route_fixes(sources, start, end)
    return build_route_record(
        trip,
        fixes,
        definitions,
        footprints,
        filter_drift=filter_drift,
        max_h_acc_m=max_h_acc_m,
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--id", help="Build one record; default: every record in records/index.json")
    parser.add_argument("--source-root", type=Path, default=ROOT.parent, help="Directory containing original GNSS logs")
    parser.add_argument("--stations", type=Path, default=ROOT / "tools/route_stations.json")
    parser.add_argument(
        "--platforms",
        type=Path,
        default=ROOT / "tools/station_footprints.json",
        help="Reviewed platform envelopes; exempted or documented point stations retain point markers",
    )
    parser.add_argument(
        "--max-horizontal-accuracy",
        type=float,
        default=DEFAULT_MAX_H_ACC_M,
        help="Max GPS AccuracyMeters kept on the map (default: 20)",
    )
    parser.add_argument("--no-filter-drift", action="store_true", help="Disable map-only drift filtering")
    args = parser.parse_args(argv)

    definitions = read_json(args.stations)
    footprints = read_json(args.platforms)
    if footprints["coordinateSystem"] != "WGS84":
        raise ValueError("Station platform envelopes must use WGS84")
    ids = (
        [args.id]
        if args.id
        else [entry["id"] for entry in read_json(ROOT / "records/index.json")]
    )
    for record_id in ids:
        trip = read_json(ROOT / f"records/{record_id}.json")
        result, summary = build(
            trip,
            args.source_root,
            definitions,
            footprints,
            filter_drift=not args.no_filter_drift,
            max_h_acc_m=args.max_horizontal_accuracy,
        )
        destination = ROOT / f"records/{record_id}.route.json"
        write_json(destination, result)
        print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
