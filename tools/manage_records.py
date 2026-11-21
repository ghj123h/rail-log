"""One-step GNSS Logger importer, read-only inspector, and catalog rebuilder.

Uses only Python's standard library. Emits speed records (<ID>.json), drift-filtered
WGS84 route records (<ID>.route.json), and the homepage catalog (index.json).
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import re
import statistics
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from gnss_pipeline import (
    DEFAULT_ACCEL_LIMIT_MPS2,
    DEFAULT_MAX_H_ACC_M,
    RECORDS_DIR,
    ROOT,
    audit_logs,
    build_route_record,
    normalize_events,
    parse_record_id,
    parse_time_ms,
    read_json,
    record_date_from_id,
    retained_speed_indices,
    stream_gnss_logs,
    write_json,
)


def rebuild(records_dir: Path = RECORDS_DIR) -> list[dict]:
    """Scan speed JSON files in records_dir and rewrite records/index.json."""
    entries: list[dict] = []
    for path in sorted(records_dir.glob("*.json")):
        if path.name in {"index.json", "collections.json"} or path.name.endswith(".route.json"):
            continue
        trip = read_json(path)
        samples = trip["samples"]
        if not re.fullmatch(r"\d{12}", trip["id"]) or path.stem != trip["id"] or not samples:
            raise ValueError(f"Invalid record: {path.name}")
        entries.append(
            {
                "id": trip["id"],
                "title": trip["title"],
                "train": trip["train"],
                "origin": trip["origin"],
                "destination": trip["destination"],
                "partial": bool(trip.get("partial", False)),
                "beta": bool(trip.get("beta", False)),
                **({"railType": trip["railType"]} if trip.get("railType") else {}),
                "start": samples[0]["t"],
                "end": samples[-1]["t"],
                "sampleCount": len(samples),
            }
        )
    entries.sort(key=lambda entry: entry["start"], reverse=True)
    (records_dir / "index.json").write_text(
        json.dumps(entries, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Catalog updated: {len(entries)} record(s).")
    return entries


def _parse_json_or_path(spec: str) -> object:
    candidate = Path(spec)
    if candidate.is_file():
        return read_json(candidate)
    return json.loads(spec)


def _parse_stations_arg(spec: str) -> list[str]:
    stripped = spec.strip()
    if not stripped:
        raise ValueError("--stations must not be empty.")
    if stripped.startswith("[") or Path(spec).is_file():
        payload = _parse_json_or_path(spec)
        if not isinstance(payload, list) or not all(isinstance(item, str) and item.strip() for item in payload):
            raise ValueError("--stations JSON payload must be a non-empty array of station names.")
        return [item.strip() for item in payload]
    names = [part.strip() for part in stripped.split(",") if part.strip()]
    if not names:
        raise ValueError("--stations must list at least one station name.")
    return names


def inspect_logs(args: argparse.Namespace) -> dict:
    """Run read-only WORKFLOW step-1 checks on one or more GNSS log files."""
    if args.report is not None and args.report.resolve().is_relative_to(args.site_root.resolve()):
        raise ValueError("Keep the audit report outside the public site directory.")
    record_id = args.id
    if record_id is None:
        try:
            record_id = parse_record_id(args.sources)
        except ValueError:
            record_id = None
    else:
        record_id = parse_record_id(args.sources, record_id)

    summary = audit_logs(
        args.sources,
        record_id=record_id,
        train=args.train,
        origin=args.origin,
        destination=args.destination,
        max_h_acc_m=args.max_horizontal_accuracy,
    )
    if args.report is not None:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        write_json(args.report, summary, pretty=True)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return summary


def import_log(args: argparse.Namespace) -> dict:
    """Import GNSS log(s) into speed JSON, route JSON, and catalog index."""
    site_root: Path = args.site_root
    records_dir = site_root / "records"
    tools_dir = site_root / "tools"

    record_id = parse_record_id(args.sources, args.id)
    if not args.destination.strip():
        raise ValueError("Destination must not be empty.")
    if not args.partial and not args.origin.strip():
        raise ValueError("Only partial records may have an empty --origin.")
    if not math.isfinite(args.clean_limit) or args.clean_limit < 0:
        raise ValueError("--clean-limit must be finite and >= 0 (use 0 to disable).")

    destination = records_dir / f"{record_id}.json"
    if destination.exists() and not args.overwrite:
        raise ValueError(
            f"{destination.name} already exists. Pass --overwrite if you intend to revise this existing record instead of changing its ID."
        )

    parsed = stream_gnss_logs(args.sources, strict=True)
    all_fixes = parsed["fixes"]
    if not all_fixes:
        raise ValueError("No GPS Fix records with position, speed, and accuracy were found.")

    record_date = record_date_from_id(record_id)
    trim_start = parse_time_ms(args.start, record_date=record_date) if args.start is not None else None
    trim_end = parse_time_ms(args.end, record_date=record_date) if args.end is not None else None
    if trim_start is not None and trim_end is not None and trim_start > trim_end:
        raise ValueError("--start must not be later than --end.")

    trimmed_fixes = [
        fix
        for fix in all_fixes
        if (trim_start is None or fix["t"] >= trim_start) and (trim_end is None or fix["t"] <= trim_end)
    ]
    if not trimmed_fixes:
        raise ValueError("No GPS Fix records remain in the requested time range.")

    nmea_times = parsed["nmea_times"]
    log_start = trim_start if trim_start is not None else min(nmea_times + [trimmed_fixes[0]["t"]])
    log_end = trim_end if trim_end is not None else max(nmea_times + [trimmed_fixes[-1]["t"]])
    intervals = [b["t"] - a["t"] for a, b in zip(trimmed_fixes, trimmed_fixes[1:])]
    sample_interval_ms = statistics.median(intervals) if intervals else 1000

    raw_events = _parse_json_or_path(args.events) if args.events else []
    events = normalize_events(raw_events, record_date=record_date, log_start=log_start, log_end=log_end)

    raw_samples = [{"t": fix["t"], "v": fix["v"], "a": fix["a"]} for fix in trimmed_fixes]
    if args.clean_limit > 0:
        kept_indices = retained_speed_indices(raw_samples, args.clean_limit)
        cleaned_samples = [raw_samples[index] for index in kept_indices]
        speed_removed = len(raw_samples) - len(cleaned_samples)
    else:
        cleaned_samples = raw_samples
        speed_removed = 0

    trip: dict = {
        "id": record_id,
        "title": f"{args.train} 次（{args.origin}—{args.destination}）",
        "train": args.train,
        "origin": args.origin,
        "destination": args.destination,
        "partial": bool(args.partial),
        "beta": bool(args.beta),
        **({"railType": args.rail_type} if args.rail_type else {}),
        "logStart": log_start,
        "logEnd": log_end,
        "sampleIntervalMs": sample_interval_ms,
        "samples": cleaned_samples,
        "events": events,
    }
    if speed_removed:
        trip["speedCleaning"] = {
            "maxAbsAccelerationMps2": args.clean_limit,
            "removedCount": speed_removed,
            "method": "longest-feasible-subsequence",
        }

    stations_path = tools_dir / "route_stations.json"
    platforms_path = tools_dir / "station_footprints.json"
    collections_path = records_dir / "collections.json"

    definitions_changed = False
    next_definitions = None
    if args.stations is not None or not args.skip_route:
        next_definitions = copy.deepcopy(read_json(stations_path))
        if args.stations is not None:
            station_names = _parse_stations_arg(args.stations)
            next_definitions.setdefault("routes", {})[record_id] = station_names
            source_files = next_definitions.setdefault("sourceFiles", {})
            if len(args.sources) > 1:
                source_files[record_id] = [path.name for path in args.sources]
            elif record_id in source_files:
                source_files.pop(record_id)
            definitions_changed = True

    route_result = None
    route_summary = None
    if not args.skip_route:
        if record_id not in next_definitions.get("routes", {}):
            raise ValueError(
                f"{record_id}: missing station list in route_stations.json. Pass --stations or --skip-route."
            )
        footprints = read_json(platforms_path)
        if footprints.get("coordinateSystem") != "WGS84":
            raise ValueError("Station platform envelopes must use WGS84.")
        route_result, route_summary = build_route_record(
            trip,
            trimmed_fixes,
            next_definitions,
            footprints,
            filter_drift=not args.no_filter_drift,
            max_h_acc_m=args.max_horizontal_accuracy,
        )

    collections_changed = False
    next_collections = None
    if args.collection is not None:
        next_collections = copy.deepcopy(read_json(collections_path))
        target = next((item for item in next_collections if item.get("id") == args.collection), None)
        if target is None:
            raise ValueError(f"Collection {args.collection!r} was not found in {collections_path.name}.")
        updated_ids = sorted(set(target.get("recordIds", [])) | {record_id}, reverse=True)
        if updated_ids != target.get("recordIds", []):
            target["recordIds"] = updated_ids
            collections_changed = True

    # Commit output files only after all speed, event, station, and route validations pass.
    records_dir.mkdir(parents=True, exist_ok=True)
    if definitions_changed and next_definitions is not None:
        write_json(stations_path, next_definitions, pretty=True)
    if collections_changed and next_collections is not None:
        write_json(collections_path, next_collections, pretty=True)
    write_json(destination, trip)
    if route_result is not None:
        write_json(records_dir / f"{record_id}.route.json", route_result)
    rebuild(records_dir)

    summary = {
        "id": record_id,
        "train": args.train,
        "sources": [path.name for path in args.sources],
        "incompleteFixesSkipped": len(parsed["incomplete_rows"]),
        "samplesBeforeCleaning": len(raw_samples),
        "speedRemoved": speed_removed,
        "samples": len(cleaned_samples),
        "events": len(events),
        "route": route_summary,
    }
    print(json.dumps(summary, ensure_ascii=False))
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    rebuilder = commands.add_parser("rebuild", help="Update records/index.json from the record JSON files")
    rebuilder.add_argument("--site-root", type=Path, default=ROOT, help=argparse.SUPPRESS)

    inspector = commands.add_parser("inspect", help="Read-only input check for one or more GNSS logs")
    inspector.add_argument("sources", nargs="+", type=Path)
    inspector.add_argument("--id", help="Optional record creation time YYMMDDHHMMSS")
    inspector.add_argument("--train")
    inspector.add_argument("--origin")
    inspector.add_argument("--destination")
    inspector.add_argument("--report", type=Path, help="Optional local audit JSON output outside site root")
    inspector.add_argument("--max-horizontal-accuracy", type=float, default=DEFAULT_MAX_H_ACC_M)
    inspector.add_argument("--site-root", type=Path, default=ROOT, help=argparse.SUPPRESS)

    importer = commands.add_parser("import", help="Import GNSS log(s) into speed JSON, route JSON, and index.json")
    importer.add_argument("sources", nargs="+", type=Path)
    importer.add_argument("--train", required=True)
    importer.add_argument("--origin", required=True)
    importer.add_argument("--destination", required=True)
    importer.add_argument("--id", help="Record creation time YYMMDDHHMMSS, otherwise read from filename")
    importer.add_argument("--partial", action="store_true", help="Mark this as a partial recording")
    importer.add_argument("--beta", action="store_true", help="Mark this record with beta=true")
    importer.add_argument("--rail-type", help="Optional railType metadata (e.g. conventional)")
    importer.add_argument("--start", help="Optional start trim boundary (HH:MM:SS, ISO-8601, or Unix ms)")
    importer.add_argument("--end", help="Optional end trim boundary (HH:MM:SS, ISO-8601, or Unix ms)")
    importer.add_argument("--events", help="Optional JSON array string or JSON file of pass/stop events")
    importer.add_argument("--stations", help="Optional comma-separated along-line station names or JSON file")
    importer.add_argument("--collection", help="Optional collection ID (e.g. jingjin) to enroll this record in")
    importer.add_argument("--clean-limit", type=float, default=DEFAULT_ACCEL_LIMIT_MPS2, help="Max |accel| m/s² (default: 1.5; 0 disables)")
    importer.add_argument("--max-horizontal-accuracy", type=float, default=DEFAULT_MAX_H_ACC_M, help="Max GPS AccuracyMeters for route map (default: 20)")
    importer.add_argument("--no-filter-drift", action="store_true", help="Disable map-only drift filtering")
    importer.add_argument("--skip-route", action="store_true", help="Only write speed JSON and index.json")
    importer.add_argument("--overwrite", action="store_true", help="Explicitly revise an existing record ID")
    importer.add_argument("--site-root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == "rebuild":
            rebuild(arguments.site_root / "records")
        elif arguments.command == "inspect":
            inspect_logs(arguments)
        else:
            import_log(arguments)
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as error:
        parser.exit(1, f"Error: {error}\n")


if __name__ == "__main__":
    main()
