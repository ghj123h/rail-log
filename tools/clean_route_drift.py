"""Audit or remove map-only GNSS drift points from existing route JSONs.

Speed cleaning does not modify routes. Published speed records (<ID>.json) and
catalog index.json are never modified; optional backup speed samples supply
v/a for points removed from speed JSON when judging route drift.
With --apply, update existing <ID>.route.json segments in place. Write the
detailed audit report outside the public site directory.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from gnss_pipeline import (
    DEFAULT_BASE_SPEED_ACC_KMH,
    DEFAULT_MAX_TURN_DEG,
    DEFAULT_SPEED_ACC_SLOPE,
    ROOT,
    filter_existing_route,
    read_json,
    write_json,
)

# Pre-speed-cleaning commit supplying v/a for points removed from speed JSON when evaluating route drift.
SPEED_BACKUP_REV = "8d8a387"


def backup_samples(record_id: str, rev: str) -> list[dict]:
    """Read pre-speed-cleaning speed samples for record_id from git history."""
    if not rev:
        return []
    result = subprocess.run(
        ["git", "-C", str(ROOT), "show", f"{rev}:records/{record_id}.json"],
        capture_output=True,
    )
    if result.returncode != 0:
        return []
    payload = json.loads(result.stdout.decode("utf-8"))
    return payload.get("samples", [])


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--id", help="Audit or clean a single record ID; default: all records in index.json")
    parser.add_argument(
        "--base-speed-acc",
        type=float,
        default=DEFAULT_BASE_SPEED_ACC_KMH,
        help=f"Base speed uncertainty limit in km/h (default: {DEFAULT_BASE_SPEED_ACC_KMH})",
    )
    parser.add_argument(
        "--speed-acc-slope",
        type=float,
        default=DEFAULT_SPEED_ACC_SLOPE,
        help=f"Speed-adaptive uncertainty slope (default: {DEFAULT_SPEED_ACC_SLOPE})",
    )
    parser.add_argument(
        "--max-turn-deg",
        type=float,
        default=DEFAULT_MAX_TURN_DEG,
        help=f"Maximum deflection angle in degrees for spike removal (default: {DEFAULT_MAX_TURN_DEG})",
    )
    parser.add_argument(
        "--speed-backup-rev",
        default=SPEED_BACKUP_REV,
        help=f"Git revision providing pre-speed-cleaning samples (default: {SPEED_BACKUP_REV})",
    )
    parser.add_argument("--apply", action="store_true", help="Apply route segment cleanup; default: audit only")
    parser.add_argument("--report", type=Path, required=True, help="Local audit JSON path, outside the public site")
    args = parser.parse_args(argv)
    if args.report.resolve().is_relative_to(ROOT):
        parser.error("Keep the detailed audit report outside the public site directory.")

    entries = read_json(ROOT / "records/index.json")
    if args.id is not None:
        entries = [entry for entry in entries if entry["id"] == args.id]
        if not entries:
            parser.error(f"Record ID {args.id!r} was not found in records/index.json.")

    reports: list[dict] = []
    updates: list[tuple[Path, dict]] = []
    for entry in entries:
        record_id = entry["id"]
        trip = read_json(ROOT / f"records/{record_id}.json")
        route_path = ROOT / f"records/{record_id}.route.json"
        route = read_json(route_path)
        cleaned_route, stats = filter_existing_route(
            trip,
            route,
            extra_samples=backup_samples(record_id, args.speed_backup_rev),
            base_speed_acc_kmh=args.base_speed_acc,
            speed_acc_slope=args.speed_acc_slope,
            max_turn_deg=args.max_turn_deg,
        )
        kept_timestamps = {point[2] for segment in cleaned_route["segments"] for point in segment}
        removed = [
            {"lon": point[0], "lat": point[1], "t": point[2]}
            for segment in route["segments"]
            for point in segment
            if point[2] not in kept_timestamps
        ]
        reports.append(
            {
                "id": record_id,
                "train": trip["train"],
                "segmentsBefore": len(route["segments"]),
                "segmentsAfter": len(cleaned_route["segments"]),
                **stats,
                "removed": removed,
            }
        )
        if stats["totalRemoved"]:
            updates.append((route_path, cleaned_route))

    # Validate all records before writing any site files.
    if args.apply:
        for path, value in updates:
            write_json(path, value)

    output = {
        "applied": args.apply,
        "baseSpeedAccuracyKmh": args.base_speed_acc,
        "speedAccuracySlope": args.speed_acc_slope,
        "maxTurnDeg": args.max_turn_deg,
        "recordCount": len(reports),
        "before": sum(item["before"] for item in reports),
        "removedCount": sum(item["totalRemoved"] for item in reports),
        "method1Removed": sum(item["method1Removed"] for item in reports),
        "method2Removed": sum(item["method2Removed"] for item in reports),
        "method3Removed": sum(item["method3Removed"] for item in reports),
        "after": sum(item["after"] for item in reports),
        "records": reports,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    write_json(args.report, output, pretty=True)
    print(json.dumps({key: value for key, value in output.items() if key != "records"}, ensure_ascii=False))
    for report in reports:
        print(
            f"{report['id']} {report['train']}: {report['before']} -> {report['after']} "
            f"(-{report['totalRemoved']}: M1={report['method1Removed']}, "
            f"M2={report['method2Removed']}, M3={report['method3Removed']})"
        )


if __name__ == "__main__":
    main()
