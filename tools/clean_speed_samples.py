"""Audit or remove speed samples exceeding the agreed acceleration limit.

Raw GNSS logs are never edited. Only speed JSON (<ID>.json) and catalog
index.json are modified; route maps (<ID>.route.json) are not altered.
Write the detailed audit outside the site.
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
    DEFAULT_ACCEL_LIMIT_MPS2,
    ROOT,
    read_json,
    retained_speed_indices as retained_indices,
    speed_compatible as compatible,
    write_json,
)
from manage_records import rebuild


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--id", help="Audit or clean a single record ID; default: all records in index.json")
    parser.add_argument(
        "--limit",
        type=float,
        default=DEFAULT_ACCEL_LIMIT_MPS2,
        help="Maximum absolute acceleration in m/s² (default: 1.5)",
    )
    parser.add_argument("--apply", action="store_true", help="Apply the reviewed cleanup; default: audit only")
    parser.add_argument("--report", type=Path, required=True, help="Local audit JSON path, outside the public site")
    args = parser.parse_args(argv)
    if args.report.resolve().is_relative_to(ROOT):
        parser.error("Keep the detailed audit report outside the public site directory.")

    entries = read_json(ROOT / "records/index.json")
    if args.id is not None:
        entries = [entry for entry in entries if entry["id"] == args.id]
        if not entries:
            parser.error(f"Record ID {args.id!r} was not found in records/index.json.")

    reports, updates = [], []
    for entry in entries:
        path = ROOT / f"records/{entry['id']}.json"
        trip = read_json(path)
        samples = trip["samples"]
        kept = retained_indices(samples, args.limit)
        kept_set = set(kept)
        removed = [dict(index=index, **sample) for index, sample in enumerate(samples) if index not in kept_set]
        remaining = [samples[index] for index in kept]
        assert all(compatible(a, b, args.limit) for a, b in zip(remaining, remaining[1:]))

        bad_edges = sum(not compatible(a, b, args.limit) for a, b in zip(samples, samples[1:]))
        report = dict(
            id=trip["id"],
            train=trip["train"],
            before=len(samples),
            after=len(remaining),
            violatingPairsBefore=bad_edges,
            removed=removed,
        )
        reports.append(report)
        if removed:
            cleaned_trip = {
                **trip,
                "samples": remaining,
                "speedCleaning": {
                    "maxAbsAccelerationMps2": args.limit,
                    "removedCount": trip.get("speedCleaning", {}).get("removedCount", 0) + len(removed),
                    "method": "longest-feasible-subsequence",
                },
            }
            updates.append((path, cleaned_trip))

    # Complete all input validation before writing any site files.
    if args.apply:
        for path, value in updates:
            write_json(path, value)
        if updates:
            rebuild()

    output = dict(
        applied=args.apply,
        maxAbsAccelerationMps2=args.limit,
        method="longest-feasible-subsequence; ties minimize total reported speed uncertainty",
        recordCount=len(reports),
        before=sum(r["before"] for r in reports),
        removedCount=sum(len(r["removed"]) for r in reports),
        after=sum(r["after"] for r in reports),
        records=reports,
    )
    args.report.parent.mkdir(parents=True, exist_ok=True)
    write_json(args.report, output, pretty=True)
    print(json.dumps({key: value for key, value in output.items() if key != "records"}, ensure_ascii=False))
    for report in reports:
        print(f"{report['id']} {report['train']}: {report['before']} -> {report['after']} (-{len(report['removed'])})")


if __name__ == "__main__":
    main()
