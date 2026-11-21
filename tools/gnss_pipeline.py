"""Shared streaming GNSS log parser, validator, cleaner, and route builder.

Uses only Python's standard library. Raw GNSS logs are never modified.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import statistics
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
ROOT = TOOLS_DIR.parent
RECORDS_DIR = ROOT / "records"
TZ = timezone(timedelta(hours=8))

EPSILON = 1e-9
DEFAULT_ACCEL_LIMIT_MPS2 = 1.5
DEFAULT_MAX_H_ACC_M = 20.0
DEFAULT_BASE_SPEED_ACC_KMH = 6.5
DEFAULT_SPEED_ACC_SLOPE = 0.02
DEFAULT_POS_SLACK_M = 15.0
DEFAULT_MAX_SPEED_MPS = 115.0
DEFAULT_MAX_TURN_DEG = 45.0
DEFAULT_MIN_TURN_STEP_M = 4.0
DEFAULT_MAX_TURN_DT_S = 5.0
DEFAULT_PLATFORM_CLEARANCE_M = 20.0
CORNER_TOLERANCE_DEG = 1e-8

LEGACY_NAME_RE = re.compile(r"gnss_log_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})")
RENAMED_NAME_RE = re.compile(r"^.+?_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.txt$")
NMEA_TIMESTAMP_RE = re.compile(r"\d{13}")
RECORD_ID_RE = re.compile(r"\d{12}")


def read_json(path: Path) -> dict | list:
    """Read UTF-8 (with optional BOM) JSON from disk."""
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_json(path: Path, value: dict | list, *, pretty: bool = False) -> None:
    """Write UTF-8 JSON with consistent trailing newline."""
    options = {"indent": 2} if pretty else {"separators": (",", ":")}
    Path(path).write_text(
        json.dumps(value, ensure_ascii=False, **options) + "\n",
        encoding="utf-8",
    )


def format_ms_iso(timestamp_ms: int) -> str:
    """Format UTC Unix milliseconds in Beijing time (UTC+8)."""
    return datetime.fromtimestamp(timestamp_ms / 1000, TZ).isoformat(timespec="milliseconds")


def sha256_file(path: Path) -> str:
    """Compute SHA-256 hex digest of a file using 1 MiB streaming chunks."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_record_id(sources: Path | list[Path] | tuple[Path, ...], explicit_id: str | None = None) -> str:
    """Resolve and validate the YYMMDDHHMMSS record ID from --id or source filename."""
    if isinstance(sources, (Path, str)):
        paths = [Path(sources)]
    else:
        paths = [Path(item) for item in sources]
    if explicit_id is not None:
        if not RECORD_ID_RE.fullmatch(explicit_id):
            raise ValueError(f"Invalid record ID {explicit_id!r}; expected YYMMDDHHMMSS.")
        datetime.strptime(explicit_id, "%y%m%d%H%M%S")
        return explicit_id
    if not paths:
        raise ValueError("At least one source file is required.")
    name = paths[0].name
    match = LEGACY_NAME_RE.search(name) or RENAMED_NAME_RE.match(name)
    if match:
        return datetime.strptime("".join(match.groups()), "%Y%m%d%H%M%S").strftime("%y%m%d%H%M%S")
    raise ValueError("Use --id YYMMDDHHMMSS when the log filename does not contain its creation time.")


def record_date_from_id(record_id: str) -> str:
    """Return YYYY-MM-DD derived from a YYMMDDHHMMSS record ID."""
    return datetime.strptime(record_id, "%y%m%d%H%M%S").strftime("%Y-%m-%d")


def resolve_source_paths(
    record_id: str,
    train: str,
    source_root: Path,
    definitions: dict | None = None,
) -> list[Path]:
    """Resolve explicit continuation logs or legacy/renamed single source path."""
    source_names = (definitions or {}).get("sourceFiles", {}).get(record_id)
    if source_names:
        return [source_root / name for name in source_names]
    legacy_name = (
        f"gnss_log_20{record_id[:2]}_{record_id[2:4]}_{record_id[4:6]}"
        f"_{record_id[6:8]}_{record_id[8:10]}_{record_id[10:12]}.txt"
    )
    source = source_root / legacy_name
    if not source.exists():
        renamed_name = (
            f"{train}_20{record_id[:2]}-{record_id[2:4]}-{record_id[4:6]}"
            f"_{record_id[6:8]}-{record_id[8:10]}-{record_id[10:12]}.txt"
        )
        source = source_root / renamed_name
    return [source]


def stream_gnss_logs(
    paths: Path | list[Path] | tuple[Path, ...],
    *,
    strict: bool = True,
    allowed_timestamps: set[int] | None = None,
) -> dict:
    """Stream one or more GNSS Logger logs and parse NMEA/Fix,gps records."""
    if isinstance(paths, (Path, str)):
        path_list = [Path(paths)]
    else:
        path_list = [Path(item) for item in paths]
    if not path_list:
        raise ValueError("At least one source log path is required.")

    counts: Counter[str] = Counter()
    providers: Counter[str] = Counter()
    nmea_times: list[int] = []
    nmea_missing_timestamp = 0
    incomplete_rows: list[dict] = []
    invalid_rows: list[dict] = []
    duplicate_timestamps: list[dict] = []
    seen_timestamps: dict[int, str] = {}
    fixes: list[dict] = []
    raw_fix_timestamps: list[int] = []
    all_gps_fix_timestamps: list[int] = []

    for path in path_list:
        with path.open(encoding="utf-8-sig") as stream:
            for line_number, raw_line in enumerate(stream, 1):
                line = raw_line.rstrip("\r\n")
                if not line or line.startswith("#"):
                    continue
                if line.startswith("NMEA,"):
                    counts["NMEA"] += 1
                    # Truncated NMEA sentences may end in a short numeric fragment.
                    comma = line.rfind(",")
                    tail = line[comma + 1 :] if comma != -1 else ""
                    if NMEA_TIMESTAMP_RE.fullmatch(tail):
                        nmea_times.append(int(tail))
                    else:
                        nmea_missing_timestamp += 1
                    continue
                if line.startswith("Fix,"):
                    counts["Fix"] += 1
                    fields = line.split(",")
                    provider = fields[1] if len(fields) > 1 else "<missing>"
                    providers[provider] += 1
                    if provider != "gps":
                        continue
                    if len(fields) < 10 or not all(fields[index] for index in (2, 3, 5, 8, 9)):
                        incomplete_rows.append({"file": path.name, "line": line_number})
                        continue
                    try:
                        timestamp = int(fields[8])
                        if timestamp < 0:
                            raise ValueError("negative timestamp")
                        lat, lon = float(fields[2]), float(fields[3])
                        if not (math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
                            raise ValueError("invalid coordinate")
                        speed_mps, speed_acc_mps = float(fields[5]), float(fields[9])
                        if not (
                            math.isfinite(speed_mps)
                            and math.isfinite(speed_acc_mps)
                            and speed_mps >= 0
                            and speed_acc_mps >= 0
                        ):
                            raise ValueError("invalid speed or speed accuracy")
                        if fields[6]:
                            h_acc = float(fields[6])
                            if not (math.isfinite(h_acc) and h_acc >= 0):
                                raise ValueError("invalid horizontal accuracy")
                        else:
                            h_acc = math.inf
                    except ValueError as error:
                        invalid_rows.append({"file": path.name, "line": line_number, "reason": str(error)})
                        if strict:
                            raise ValueError(f"Invalid gps Fix at {path.name}:{line_number}: {error}") from error
                        continue

                    all_gps_fix_timestamps.append(timestamp)
                    if allowed_timestamps is not None and timestamp not in allowed_timestamps:
                        continue
                    if timestamp in seen_timestamps:
                        duplicate_timestamps.append({"file": path.name, "line": line_number, "t": timestamp})
                        if strict:
                            raise ValueError(f"Duplicate GPS Fix at {timestamp} in {path.name}")
                        continue
                    seen_timestamps[timestamp] = path.name
                    raw_fix_timestamps.append(timestamp)
                    fixes.append(
                        {
                            "t": timestamp,
                            "v": speed_mps * 3.6,
                            "a": speed_acc_mps * 3.6,
                            "v_mps": speed_mps,
                            "v_acc": speed_acc_mps,
                            "lon": lon,
                            "lat": lat,
                            "h_acc": h_acc,
                        }
                    )
                    continue
                kind = line.split(",", 1)[0]
                counts[kind] += 1

    reversed_count = sum(b < a for a, b in zip(raw_fix_timestamps, raw_fix_timestamps[1:]))
    fixes.sort(key=lambda item: item["t"])
    return {
        "fixes": fixes,
        "nmea_times": nmea_times,
        "nmea_missing_timestamp": nmea_missing_timestamp,
        "counts": dict(counts),
        "providers": dict(providers),
        "incomplete_rows": incomplete_rows,
        "invalid_rows": invalid_rows,
        "duplicate_timestamps": duplicate_timestamps,
        "reversed_count": reversed_count,
        "gps_fix_time_duplicates": len(all_gps_fix_timestamps) - len(set(all_gps_fix_timestamps)),
        "gps_fix_time_reversed": sum(b < a for a, b in zip(all_gps_fix_timestamps, all_gps_fix_timestamps[1:])),
    }


def _quantile(sorted_values: list[float], fraction: float) -> float | None:
    if not sorted_values:
        return None
    index = min(len(sorted_values) - 1, int(len(sorted_values) * fraction))
    return sorted_values[index]


def audit_logs(
    paths: Path | list[Path] | tuple[Path, ...],
    *,
    record_id: str | None = None,
    train: str | None = None,
    origin: str | None = None,
    destination: str | None = None,
    max_h_acc_m: float = DEFAULT_MAX_H_ACC_M,
) -> dict:
    """Produce a read-only input-check summary matching WORKFLOW.md step 1."""
    if isinstance(paths, (Path, str)):
        path_list = [Path(paths)]
    else:
        path_list = [Path(item) for item in paths]
    parsed = stream_gnss_logs(path_list, strict=False)
    fixes = parsed["fixes"]
    nmea_times = parsed["nmea_times"]
    intervals = [b["t"] - a["t"] for a, b in zip(fixes, fixes[1:])]
    interval = statistics.median(intervals) if intervals else 1000
    boundaries = list(nmea_times)
    if fixes:
        boundaries.extend([fixes[0]["t"], fixes[-1]["t"]])

    finite_h_acc = sorted(fix["h_acc"] for fix in fixes if math.isfinite(fix["h_acc"]))
    max_sample = max(fixes, key=lambda fix: fix["v"]) if fixes else None
    file_entries = [
        {"file": path.name, "size": path.stat().st_size, "sha256": sha256_file(path)}
        for path in path_list
    ]
    return {
        "id": record_id,
        "train": train,
        "origin": origin,
        "destination": destination,
        "files": file_entries,
        "nmea": parsed["counts"].get("NMEA", 0),
        "nmeaMissingTimestamp": parsed["nmea_missing_timestamp"],
        "fixes": parsed["counts"].get("Fix", 0),
        "fixProviders": parsed["providers"],
        "gpsFixes": parsed["providers"].get("gps", 0),
        "usable": len(fixes),
        "incomplete": len(parsed["incomplete_rows"]),
        "incompleteRows": parsed["incomplete_rows"],
        "invalid": len(parsed["invalid_rows"]),
        "invalidRows": parsed["invalid_rows"],
        "duplicates": len(parsed["duplicate_timestamps"]),
        "duplicateRows": parsed["duplicate_timestamps"],
        "reversed": parsed["reversed_count"],
        "intervalMs": interval,
        "logStart": format_ms_iso(min(boundaries)) if boundaries else None,
        "logEnd": format_ms_iso(max(boundaries)) if boundaries else None,
        "logStartMs": min(boundaries) if boundaries else None,
        "logEndMs": max(boundaries) if boundaries else None,
        "sampleStart": format_ms_iso(fixes[0]["t"]) if fixes else None,
        "sampleEnd": format_ms_iso(fixes[-1]["t"]) if fixes else None,
        "sampleStartMs": fixes[0]["t"] if fixes else None,
        "sampleEndMs": fixes[-1]["t"] if fixes else None,
        "minSpeed": min((fix["v"] for fix in fixes), default=None),
        "maxSpeed": max_sample["v"] if max_sample else None,
        "maxSpeedTime": format_ms_iso(max_sample["t"]) if max_sample else None,
        "medianSpeedAccuracy": statistics.median(fix["a"] for fix in fixes) if fixes else None,
        "maxSpeedPlusAccuracy": max((fix["v"] + fix["a"] for fix in fixes), default=None),
        "horizontalAccuracy": {
            "p50": _quantile(finite_h_acc, 0.5),
            "p90": _quantile(finite_h_acc, 0.9),
            "p95": _quantile(finite_h_acc, 0.95),
            "p99": _quantile(finite_h_acc, 0.99),
            "max": finite_h_acc[-1] if finite_h_acc else None,
            "missingCount": sum(not math.isfinite(fix["h_acc"]) for fix in fixes),
            "overThresholdCount": sum(
                not math.isfinite(fix["h_acc"]) or fix["h_acc"] > max_h_acc_m for fix in fixes
            ),
            "thresholdM": max_h_acc_m,
        },
        "gaps": [
            {"start": format_ms_iso(a["t"]), "end": format_ms_iso(b["t"]), "seconds": delta / 1000}
            for a, b, delta in zip(fixes, fixes[1:], intervals)
            if delta > interval * 1.5
        ],
        "lineKinds": {key: value for key, value in parsed["counts"].items() if key},
    }


def parse_time_ms(value: int | str, *, record_date: str | None = None) -> int:
    """Parse Unix ms, HH:MM:SS(.sss), naive datetime, or ISO-8601 into Unix ms."""
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if not isinstance(value, str):
        raise ValueError(f"Unsupported timestamp value: {value!r}")
    text = value.strip()
    if re.fullmatch(r"-?\d+", text):
        return int(text)
    if re.fullmatch(r"\d{2}:\d{2}:\d{2}(?:\.\d+)?", text):
        if not record_date:
            raise ValueError(f"Clock time {text!r} requires a YYYY-MM-DD record date.")
        dt = datetime.fromisoformat(f"{record_date}T{text}+08:00")
        return round(dt.timestamp() * 1000)
    normalized = text.replace(" ", "T", 1) if " " in text and "T" not in text else text
    dt = datetime.fromisoformat(normalized)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ)
    return round(dt.timestamp() * 1000)


def normalize_events(
    raw_events: list[dict],
    *,
    record_date: str | None = None,
    log_start: int | None = None,
    log_end: int | None = None,
) -> list[dict]:
    """Validate and normalize station pass/stop events, enforcing inferred-tag rules."""
    if not isinstance(raw_events, list):
        raise ValueError("Events payload must be a JSON array.")
    normalized: list[dict] = []
    seen_ids: set[str] = set()
    for item in raw_events:
        if not isinstance(item, dict):
            raise ValueError("Each event entry must be a JSON object.")
        name = str(item.get("name", "")).strip()
        if not name:
            raise ValueError("Event name must not be empty.")
        kind = item.get("type")
        if kind not in {"pass", "stop"}:
            raise ValueError(f"Event {name!r} has invalid type {kind!r}; expected 'pass' or 'stop'.")
        if "start" not in item or "end" not in item:
            raise ValueError(f"Event {name!r} requires both 'start' and 'end'.")
        start = parse_time_ms(item["start"], record_date=record_date)
        end = parse_time_ms(item["end"], record_date=record_date)
        if start > end:
            raise ValueError(f"Event {name!r} has start > end ({start} > {end}).")
        if log_start is not None and start < log_start:
            raise ValueError(f"Event {name!r} starts before logStart ({start} < {log_start}).")
        if log_end is not None and end > log_end:
            raise ValueError(f"Event {name!r} ends after logEnd ({end} > {log_end}).")

        source = item.get("source")
        if source is not None:
            if source != "inferred":
                raise ValueError(f"Event {name!r} has unsupported source {source!r}.")
            disallowed = {"note", "reference"} & set(item)
            if disallowed:
                raise ValueError(
                    f"Inferred event {name!r} must not store explanation fields: {sorted(disallowed)}"
                )
        extra_keys = set(item) - {"id", "name", "type", "start", "end", "source"}
        if extra_keys:
            raise ValueError(f"Event {name!r} has unsupported fields: {sorted(extra_keys)}")

        event = {"id": str(item.get("id", "")).strip(), "name": name, "type": kind, "start": start, "end": end}
        if source == "inferred":
            event["source"] = "inferred"
        normalized.append(event)

    normalized.sort(key=lambda entry: (entry["start"], entry["end"]))
    for index, event in enumerate(normalized, 1):
        if not event["id"]:
            candidate = f"{event['type']}-{index}"
            while candidate in seen_ids:
                index += 1
                candidate = f"{event['type']}-{index}"
            event["id"] = candidate
        if event["id"] in seen_ids:
            raise ValueError(f"Duplicate event id {event['id']!r}.")
        seen_ids.add(event["id"])
    return normalized


def speed_compatible(left: dict, right: dict, limit: float = DEFAULT_ACCEL_LIMIT_MPS2) -> bool:
    """Return True if speed change between samples obeys |Δv/Δt| <= limit (m/s²)."""
    return abs(right["v"] - left["v"]) <= limit * 3.6 * (right["t"] - left["t"]) / 1000 + EPSILON


def retained_speed_indices(samples: list[dict], limit: float = DEFAULT_ACCEL_LIMIT_MPS2) -> list[int]:
    """Keep a longest time-ordered subsequence obeying the acceleration bound.

    Resolve equal-length choices by the lowest total reported speed uncertainty.
    """
    if not samples:
        return []
    if not math.isfinite(limit) or limit <= 0:
        raise ValueError("Acceleration limit must be finite and positive.")
    lengths: list[int] = []
    uncertainties: list[float] = []
    parents: list[int] = []
    prefix_lengths: list[int] = []
    best_end = 0
    for index, sample in enumerate(samples):
        if not all(math.isfinite(sample[key]) for key in ("t", "v", "a")) or sample["v"] < 0 or sample["a"] < 0:
            raise ValueError(f"Invalid sample at index {index}.")
        if index and sample["t"] <= samples[index - 1]["t"]:
            raise ValueError("Sample timestamps must be strictly increasing.")
        count, uncertainty, parent = 1, sample["a"], -1
        for previous in range(index - 1, -1, -1):
            if prefix_lengths[previous] + 1 < count:
                break
            candidate_count = lengths[previous] + 1
            candidate_uncertainty = uncertainties[previous] + sample["a"]
            if (
                candidate_count > count
                or (candidate_count == count and candidate_uncertainty < uncertainty)
            ) and speed_compatible(samples[previous], sample, limit):
                count, uncertainty, parent = candidate_count, candidate_uncertainty, previous
        lengths.append(count)
        uncertainties.append(uncertainty)
        parents.append(parent)
        prefix_lengths.append(max(count, prefix_lengths[-1] if prefix_lengths else 0))
        if count > lengths[best_end] or (count == lengths[best_end] and uncertainty < uncertainties[best_end]):
            best_end = index
    retained: list[int] = []
    while best_end != -1:
        retained.append(best_end)
        best_end = parents[best_end]
    return retained[::-1]


def coords_distance_m(a: list[float] | tuple[float, float], b: list[float] | tuple[float, float]) -> float:
    """Great-circle distance in metres between two [lon, lat] WGS84 coordinates."""
    lon1, lat1, lon2, lat2 = map(math.radians, [*a, *b])
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 12742017.6 * math.asin(min(1, math.sqrt(h)))


def turn_angle_deg(a: dict, b: dict, c: dict) -> float:
    """Deflection angle in degrees at middle vertex b along a -> b -> c."""
    sx = math.cos(math.radians(b["lat"]))
    v1 = ((b["lon"] - a["lon"]) * sx, b["lat"] - a["lat"])
    v2 = ((c["lon"] - b["lon"]) * sx, c["lat"] - b["lat"])
    n1, n2 = math.hypot(*v1), math.hypot(*v2)
    if n1 < 1e-12 or n2 < 1e-12:
        return 0.0
    cos_theta = max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)))
    return math.degrees(math.acos(cos_theta))


def step_compatible(
    left: dict,
    right: dict,
    *,
    accel_limit: float = DEFAULT_ACCEL_LIMIT_MPS2,
    pos_slack_m: float = DEFAULT_POS_SLACK_M,
    max_speed_mps: float = DEFAULT_MAX_SPEED_MPS,
) -> bool:
    """Return True if coordinate displacement between left and right fits Doppler speed."""
    dt = (right["t"] - left["t"]) / 1000.0
    if dt <= 0:
        return False
    distance = coords_distance_m((left["lon"], left["lat"]), (right["lon"], right["lat"]))
    v1 = left["v_mps"] + left["v_acc"]
    v2 = right["v_mps"] + right["v_acc"]
    v_bound = min(max_speed_mps, max(v1, v2) + 0.5 * accel_limit * dt)
    return distance <= v_bound * dt + pos_slack_m + EPSILON


def _filter_steps_and_turns(
    fixes: list[dict],
    *,
    cost_key: str,
    accel_limit: float = DEFAULT_ACCEL_LIMIT_MPS2,
    pos_slack_m: float = DEFAULT_POS_SLACK_M,
    max_speed_mps: float = DEFAULT_MAX_SPEED_MPS,
    max_turn_deg: float = DEFAULT_MAX_TURN_DEG,
    min_turn_step_m: float = DEFAULT_MIN_TURN_STEP_M,
    max_turn_dt_s: float = DEFAULT_MAX_TURN_DT_S,
) -> tuple[list[dict], int, int]:
    """Run Method 2 (Doppler-consistent DP) and Method 3 (local-max spike removal)."""
    if not fixes:
        return [], 0, 0

    lengths: list[int] = []
    costs: list[float] = []
    parents: list[int] = []
    prefix_lengths: list[int] = []
    best_end = 0
    for index, fix in enumerate(fixes):
        point_cost = fix[cost_key]
        count, cost, parent = 1, point_cost, -1
        for previous in range(index - 1, -1, -1):
            if prefix_lengths[previous] + 1 < count:
                break
            candidate_count = lengths[previous] + 1
            candidate_cost = costs[previous] + point_cost
            if (
                candidate_count > count
                or (candidate_count == count and candidate_cost < cost)
            ) and step_compatible(
                fixes[previous],
                fix,
                accel_limit=accel_limit,
                pos_slack_m=pos_slack_m,
                max_speed_mps=max_speed_mps,
            ):
                count, cost, parent = candidate_count, candidate_cost, previous
        lengths.append(count)
        costs.append(cost)
        parents.append(parent)
        prefix_lengths.append(max(count, prefix_lengths[-1] if prefix_lengths else 0))
        if count > lengths[best_end] or (count == lengths[best_end] and cost < costs[best_end]):
            best_end = index

    kept_indices: list[int] = []
    while best_end != -1:
        kept_indices.append(best_end)
        best_end = parents[best_end]
    m2 = [fixes[index] for index in reversed(kept_indices)]
    m2_removed = len(fixes) - len(m2)

    current = m2
    m3_removed = 0
    while len(current) >= 3:
        angles = [0.0] * len(current)
        for index in range(1, len(current) - 1):
            a, b, c = current[index - 1], current[index], current[index + 1]
            dt1 = (b["t"] - a["t"]) / 1000.0
            dt2 = (c["t"] - b["t"]) / 1000.0
            if dt1 <= max_turn_dt_s and dt2 <= max_turn_dt_s:
                d1 = coords_distance_m((a["lon"], a["lat"]), (b["lon"], b["lat"]))
                d2 = coords_distance_m((b["lon"], b["lat"]), (c["lon"], c["lat"]))
                if d1 >= min_turn_step_m and d2 >= min_turn_step_m:
                    angles[index] = turn_angle_deg(a, b, c)
        keys = [(angles[index], current[index][cost_key], index) for index in range(len(current))]
        drop = {
            index
            for index in range(1, len(current) - 1)
            if angles[index] > max_turn_deg and keys[index] > keys[index - 1] and keys[index] > keys[index + 1]
        }
        if not drop:
            break
        m3_removed += len(drop)
        current = [fix for index, fix in enumerate(current) if index not in drop]

    return current, m2_removed, m3_removed


def filter_route_fixes(
    fixes: list[dict],
    *,
    max_h_acc_m: float = DEFAULT_MAX_H_ACC_M,
    accel_limit: float = DEFAULT_ACCEL_LIMIT_MPS2,
    pos_slack_m: float = DEFAULT_POS_SLACK_M,
    max_speed_mps: float = DEFAULT_MAX_SPEED_MPS,
    max_turn_deg: float = DEFAULT_MAX_TURN_DEG,
    min_turn_step_m: float = DEFAULT_MIN_TURN_STEP_M,
    max_turn_dt_s: float = DEFAULT_MAX_TURN_DT_S,
) -> tuple[list[dict], dict]:
    """Filter map-only GNSS position drift via Methods 1, 2, and 3."""
    if not fixes:
        return [], {"method1Removed": 0, "method2Removed": 0, "method3Removed": 0, "totalRemoved": 0}
    if not math.isfinite(max_h_acc_m) or max_h_acc_m <= 0:
        raise ValueError("max_h_acc_m must be finite and positive.")
    for index, fix in enumerate(fixes):
        if index and fix["t"] <= fixes[index - 1]["t"]:
            raise ValueError("Route fix timestamps must be strictly increasing.")

    # Method 1: Horizontal accuracy filter (0 <= h_acc <= max_h_acc_m).
    m1 = [
        fix
        for fix in fixes
        if math.isfinite(fix["h_acc"]) and 0.0 <= fix["h_acc"] <= max_h_acc_m
    ]
    m1_removed = len(fixes) - len(m1)
    if not m1:
        return [], {
            "method1Removed": m1_removed,
            "method2Removed": 0,
            "method3Removed": 0,
            "totalRemoved": m1_removed,
        }

    current, m2_removed, m3_removed = _filter_steps_and_turns(
        m1,
        cost_key="h_acc",
        accel_limit=accel_limit,
        pos_slack_m=pos_slack_m,
        max_speed_mps=max_speed_mps,
        max_turn_deg=max_turn_deg,
        min_turn_step_m=min_turn_step_m,
        max_turn_dt_s=max_turn_dt_s,
    )
    return current, {
        "method1Removed": m1_removed,
        "method2Removed": m2_removed,
        "method3Removed": m3_removed,
        "totalRemoved": m1_removed + m2_removed + m3_removed,
    }


def filter_existing_route(
    trip: dict,
    route: dict,
    *,
    extra_samples: list[dict] | None = None,
    base_speed_acc_kmh: float = DEFAULT_BASE_SPEED_ACC_KMH,
    speed_acc_slope: float = DEFAULT_SPEED_ACC_SLOPE,
    accel_limit: float = DEFAULT_ACCEL_LIMIT_MPS2,
    pos_slack_m: float = DEFAULT_POS_SLACK_M,
    max_speed_mps: float = DEFAULT_MAX_SPEED_MPS,
    max_turn_deg: float = DEFAULT_MAX_TURN_DEG,
    min_turn_step_m: float = DEFAULT_MIN_TURN_STEP_M,
    max_turn_dt_s: float = DEFAULT_MAX_TURN_DT_S,
) -> tuple[dict, dict]:
    """Filter map-only drift from published speed + route JSON without raw logs."""
    if not math.isfinite(base_speed_acc_kmh) or base_speed_acc_kmh <= 0:
        raise ValueError("base_speed_acc_kmh must be finite and positive.")
    if not math.isfinite(speed_acc_slope) or speed_acc_slope < 0:
        raise ValueError("speed_acc_slope must be finite and >= 0.")

    by_timestamp = {sample["t"]: sample for sample in (extra_samples or ())}
    by_timestamp.update({sample["t"]: sample for sample in trip["samples"]})
    fixes: list[dict] = []
    for segment in route["segments"]:
        for lon, lat, timestamp in segment:
            if timestamp not in by_timestamp:
                raise ValueError(
                    f"{trip['id']}: route timestamp {timestamp} missing from speed samples and backup samples."
                )
            if fixes and timestamp <= fixes[-1]["t"]:
                raise ValueError(f"{trip['id']}: route timestamps are not strictly increasing.")
            sample = by_timestamp[timestamp]
            fixes.append(
                {
                    "t": timestamp,
                    "lon": lon,
                    "lat": lat,
                    "v": sample["v"],
                    "a": sample["a"],
                    "v_mps": sample["v"] / 3.6,
                    "v_acc": sample["a"] / 3.6,
                }
            )
    if not fixes:
        raise ValueError(f"{trip['id']}: route has no points before drift filtering.")

    m1 = [
        fix
        for fix in fixes
        if fix["a"] <= base_speed_acc_kmh + speed_acc_slope * fix["v"] + EPSILON
    ]
    m1_removed = len(fixes) - len(m1)
    current, m2_removed, m3_removed = _filter_steps_and_turns(
        m1,
        cost_key="a",
        accel_limit=accel_limit,
        pos_slack_m=pos_slack_m,
        max_speed_mps=max_speed_mps,
        max_turn_deg=max_turn_deg,
        min_turn_step_m=min_turn_step_m,
        max_turn_dt_s=max_turn_dt_s,
    )
    if not current:
        raise ValueError(f"{trip['id']}: no route points remain after JSON drift filtering.")

    segments = build_segments(
        [[fix["lon"], fix["lat"], fix["t"]] for fix in current],
        trip.get("sampleIntervalMs", 1000),
    )
    cleaned_route = {**route, "segments": segments}
    stats = {
        "before": len(fixes),
        "after": len(current),
        "method1Removed": m1_removed,
        "method2Removed": m2_removed,
        "method3Removed": m3_removed,
        "totalRemoved": len(fixes) - len(current),
    }
    return cleaned_route, stats


def build_segments(points: list, sample_interval_ms: float = 1000) -> list[list[list]]:
    """Split coordinates into continuous segments using the 1.5x interval gap rule."""
    segments: list[list[list]] = []
    for index, point in enumerate(points):
        lon, lat, timestamp = (point["lon"], point["lat"], point["t"]) if isinstance(point, dict) else point[:3]
        if not index or timestamp - points[index - 1][2 if not isinstance(points[index - 1], dict) else "t"] > 1.5 * sample_interval_ms:
            segments.append([])
        segments[-1].append([round(lon, 7), round(lat, 7), timestamp])
    return segments


def platform_envelope(
    corners: list[list[float]],
    center: list[float],
    arrival_tracks: list[dict],
    clearance_m: float,
) -> tuple[list[list[float]], float, float]:
    """Keep platform length; set lateral edges beyond outer arrival tracks."""
    phi = math.radians(center[1])
    e2 = 0.0066943799901413165
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
    envelope = [
        [round(center[i] + (s * along[i] + v * across[i]) / scales[i], 10) for i in (0, 1)]
        for s, v in [
            (bounds[0][0], bounds[1][0]),
            (bounds[0][1], bounds[1][0]),
            (bounds[0][1], bounds[1][1]),
            (bounds[0][0], bounds[1][1]),
        ]
    ]
    return envelope, round(bounds[0][1] - bounds[0][0], 3), round(bounds[1][1] - bounds[1][0], 3)


def station_position(
    station: dict,
    points: list[list],
    events: list[dict],
    occurrence: int = 0,
) -> tuple[list[float], str]:
    """Use an actual track point near the station, otherwise its public position."""
    reference = [station["lon"], station["lat"]]
    if not points:
        return reference, "public"
    station_stem = station["name"].removesuffix("站")
    matching_events = sorted(
        (event for event in events if event["name"].removesuffix("站") == station_stem),
        key=lambda event: (event["start"], event["end"]),
    )
    event = (
        matching_events[occurrence]
        if occurrence < len(matching_events)
        else (matching_events[-1] if matching_events else None)
    )
    if event:
        candidates = [point for point in points if event["start"] <= point[2] <= event["end"]]
        if candidates:
            if event["type"] == "stop":
                median = [statistics.median(point[axis] for point in candidates) for axis in (0, 1)]
                representative = min(candidates, key=lambda point: coords_distance_m(point[:2], median))
            else:
                representative = min(
                    candidates,
                    key=lambda point: abs(point[2] - (event["start"] + event["end"]) / 2),
                )
            if coords_distance_m(representative[:2], reference) <= 1000:
                return representative[:2], "gnss"
    nearest = min(points, key=lambda point: coords_distance_m(point[:2], reference))
    if coords_distance_m(nearest[:2], reference) <= 500:
        return nearest[:2], "gnss"
    return reference, "public"


def build_route_record(
    trip: dict,
    fixes: list[dict],
    definitions: dict,
    footprints: dict,
    *,
    filter_drift: bool = True,
    max_h_acc_m: float = DEFAULT_MAX_H_ACC_M,
    accel_limit: float = DEFAULT_ACCEL_LIMIT_MPS2,
    pos_slack_m: float = DEFAULT_POS_SLACK_M,
    max_speed_mps: float = DEFAULT_MAX_SPEED_MPS,
    max_turn_deg: float = DEFAULT_MAX_TURN_DEG,
    min_turn_step_m: float = DEFAULT_MIN_TURN_STEP_M,
    max_turn_dt_s: float = DEFAULT_MAX_TURN_DT_S,
) -> tuple[dict, dict]:
    """Build a .route.json payload and summary from retained fixes and station configs."""
    record_id = trip["id"]
    if not trip.get("origin") and not trip.get("partial"):
        raise ValueError(f"{record_id}: only partial records may have an unknown origin")
    names = definitions["routes"][record_id]
    if (trip.get("origin") and names[0] != trip["origin"]) or names[-1] != trip["destination"]:
        raise ValueError(f"{record_id}: station list endpoints disagree with the published record")

    if filter_drift:
        route_fixes, filter_stats = filter_route_fixes(
            fixes,
            max_h_acc_m=max_h_acc_m,
            accel_limit=accel_limit,
            pos_slack_m=pos_slack_m,
            max_speed_mps=max_speed_mps,
            max_turn_deg=max_turn_deg,
            min_turn_step_m=min_turn_step_m,
            max_turn_dt_s=max_turn_dt_s,
        )
    else:
        route_fixes = list(fixes)
        filter_stats = {"method1Removed": 0, "method2Removed": 0, "method3Removed": 0, "totalRemoved": 0}
    if not route_fixes:
        raise ValueError(f"{record_id}: no route fixes remain after drift filtering")

    raw_points = [[fix["lon"], fix["lat"], fix["t"]] for fix in route_fixes]
    segments = build_segments(raw_points, trip.get("sampleIntervalMs", 1000))

    exception = footprints.get("recordExceptions", {}).get(record_id)
    exempt_stations = (
        set(exception.get("stations", []))
        if exception and exception.get("scope") == "record" and exception.get("status") == "exempt"
        else set()
    )
    has_point_registry = isinstance(footprints.get("pointStations"), dict)
    point_stations = footprints.get("pointStations", {})
    clearance = footprints.get("arrivalClearanceM", DEFAULT_PLATFORM_CLEARANCE_M)

    stations: list[dict] = []
    sources: dict[str, str] = {}
    seen_occurrences: Counter[str] = Counter()
    for name in names:
        occurrence = seen_occurrences[name]
        seen_occurrences[name] += 1
        is_exempt = name in exempt_stations
        footprint = None if is_exempt else footprints.get("stations", {}).get(name)
        if footprint:
            position, source = footprint["center"], "platform"
            display_corners, _, _ = platform_envelope(
                footprint["platformCorners"],
                position,
                footprint["arrivalTracks"],
                clearance,
            )
            if "corners" in footprint and clearance == footprints.get("arrivalClearanceM", clearance):
                max_delta = max(
                    abs(a[axis] - b[axis])
                    for a, b in zip(display_corners, footprint["corners"])
                    for axis in (0, 1)
                )
                if max_delta >= CORNER_TOLERANCE_DEG:
                    raise ValueError(
                        f"{record_id}: station '{name}' computed platform envelope differs from stored corners by {max_delta:.2e}"
                    )
            station = {
                "name": name,
                "lon": round(position[0], 7),
                "lat": round(position[1], 7),
                "platform": {"corners": display_corners},
            }
        else:
            if not is_exempt and has_point_registry and name not in point_stations:
                raise ValueError(
                    f"{record_id}: station '{name}' lacks a reviewed platform footprint or pointStations decision."
                )
            if name not in definitions.get("stations", {}):
                raise ValueError(f"{record_id}: station '{name}' is missing from route_stations.json stations.")
            position, source = station_position(
                {"name": name, **definitions["stations"][name]},
                raw_points,
                trip.get("events", []),
                occurrence=occurrence,
            )
            station = {"name": name, "lon": round(position[0], 7), "lat": round(position[1], 7)}
        stations.append(station)
        sources[name] = source

    result = {
        "id": record_id,
        "coordinateSystem": "WGS84",
        "segments": segments,
        "stations": stations,
    }
    summary = {
        "id": record_id,
        "points": len(raw_points),
        "segments": len(segments),
        "stations": len(stations),
        "platformStations": sum("platform" in station for station in stations),
        "publicStations": [name for name, src in sources.items() if src == "public"],
        "driftRemoved": filter_stats["totalRemoved"],
        "driftBreakdown": filter_stats,
    }
    return result, summary
