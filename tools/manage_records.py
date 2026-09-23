"""Import GNSS Logger Fix records and rebuild the static record catalog.

Uses only Python's standard library; original positions are never exported.
"""
import argparse
import json
import math
import re
import statistics
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RECORDS = ROOT / "records"
TZ = timezone(timedelta(hours=8))


def rebuild():
    entries = []
    for path in sorted(RECORDS.glob("*.json")):
        if path.name == "index.json":
            continue
        trip = json.loads(path.read_text(encoding="utf-8-sig"))
        samples = trip["samples"]
        if not re.fullmatch(r"\d{12}", trip["id"]) or path.stem != trip["id"] or not samples:
            raise ValueError(f"Invalid record: {path.name}")
        entries.append({
            "id": trip["id"], "title": trip["title"], "train": trip["train"],
            "origin": trip["origin"], "destination": trip["destination"],
            "partial": bool(trip.get("partial", False)),
            "start": samples[0]["t"], "end": samples[-1]["t"], "sampleCount": len(samples),
        })
    entries.sort(key=lambda entry: entry["start"], reverse=True)
    (RECORDS / "index.json").write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Catalog updated: {len(entries)} record(s).")


def import_log(args):
    match = re.search(r"gnss_log_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})", args.source.name)
    record_id = args.id
    if record_id is None and match:
        record_id = datetime.strptime("".join(match.groups()), "%Y%m%d%H%M%S").strftime("%y%m%d%H%M%S")
    if record_id is None or not re.fullmatch(r"\d{12}", record_id):
        raise ValueError("Use --id YYMMDDHHMMSS when the log filename does not contain its creation time.")
    destination = RECORDS / f"{record_id}.json"
    if destination.exists():
        raise ValueError(f"{destination.name} already exists. Choose a different ID to avoid replacing a record.")
    samples, timestamps = [], []
    skipped = 0
    for line_number, line in enumerate(args.source.read_text(encoding="utf-8-sig").splitlines(), 1):
        fields = line.split(",")
        if fields[0] == "NMEA":
            try:
                timestamps.append(int(fields[-1]))
            except ValueError:
                pass
        elif fields[0] == "Fix" and len(fields) >= 10 and fields[1] == "gps":
            if not fields[5] or not fields[9]:
                skipped += 1
                continue
            speed, accuracy, timestamp = float(fields[5]), float(fields[9]), int(fields[8])
            if not all(math.isfinite(value) and value >= 0 for value in [speed, accuracy]):
                raise ValueError(f"Invalid speed or speed accuracy at line {line_number}.")
            samples.append({"t": timestamp, "v": speed * 3.6, "a": accuracy * 3.6})
    if not samples:
        raise ValueError("No GPS Fix records with both SpeedMps and SpeedAccuracyMps were found.")
    samples.sort(key=lambda sample: sample["t"])
    intervals = [b["t"] - a["t"] for a, b in zip(samples, samples[1:])]
    if any(interval <= 0 for interval in intervals):
        raise ValueError("The source contains duplicate Fix timestamps.")
    timestamps.extend([samples[0]["t"], samples[-1]["t"]])
    trip = {
        "id": record_id, "title": f"{args.train} 次（{args.origin}—{args.destination}）",
        "train": args.train, "origin": args.origin, "destination": args.destination,
        "partial": args.partial, "logStart": min(timestamps), "logEnd": max(timestamps),
        "sampleIntervalMs": statistics.median(intervals) if intervals else 1000,
        "samples": samples, "events": [],
    }
    RECORDS.mkdir(exist_ok=True)
    destination.write_text(json.dumps(trip, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    rebuild()
    print(f"Imported {len(samples)} samples into {destination.name}; {skipped} incomplete fixes skipped.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("rebuild", help="Update records/index.json from the record JSON files")
    importer = commands.add_parser("import", help="Import a GNSS Logger file with Fix speed and accuracy")
    importer.add_argument("source", type=Path)
    importer.add_argument("--train", required=True)
    importer.add_argument("--origin", required=True)
    importer.add_argument("--destination", required=True)
    importer.add_argument("--id", help="Record creation time YYMMDDHHMMSS, otherwise read from filename")
    importer.add_argument("--partial", action="store_true", help="Mark this as a partial recording")
    arguments = parser.parse_args()
    try:
        rebuild() if arguments.command == "rebuild" else import_log(arguments)
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, f"Error: {error}\n")
