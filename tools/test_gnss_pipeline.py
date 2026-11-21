"""End-to-end tests for gnss_pipeline, manage_records one-step import, and G3681."""
from __future__ import annotations

import json
import math
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from gnss_pipeline import (
    ROOT as SITE_ROOT,
    audit_logs,
    filter_existing_route,
    parse_record_id,
    stream_gnss_logs,
)
import manage_records

TZ = timezone(timedelta(hours=8))


def meters_east_to_lon(meters: float, lat: float = 39.8) -> float:
    return meters / (111320.0 * math.cos(math.radians(lat)))


def ms_at(date_str: str, clock_str: str) -> int:
    return round(datetime.fromisoformat(f"{date_str}T{clock_str}+08:00").timestamp() * 1000)


def fix_line(t_ms: int, lon: float, lat: float, speed_mps: float, h_acc: float = 9.5, v_acc: float = 0.5) -> str:
    return f"Fix,gps,{lat:.7f},{lon:.7f},30,{speed_mps:.3f},{h_acc:.2f},90,{t_ms},{v_acc:.3f}\n"


def inside_geographic_rectangle(lon: float, lat: float, corners: list[list[float]]) -> bool:
    origin = corners[0]
    lon_scale = 111320.0 * math.cos(math.radians(origin[1]))
    polygon = [((c[0] - origin[0]) * lon_scale, (c[1] - origin[1]) * 111320.0) for c in corners]
    target = ((lon - origin[0]) * lon_scale, (lat - origin[1]) * 111320.0)
    crosses = []
    for index, a in enumerate(polygon):
        b = polygon[(index + 1) % len(polygon)]
        crosses.append((b[0] - a[0]) * (target[1] - a[1]) - (b[1] - a[1]) * (target[0] - a[0]))
    return all(val >= -0.01 for val in crosses) or all(val <= 0.01 for val in crosses)


class GnssPipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)

    def make_temp_site(self) -> Path:
        site = self.work / "site"
        (site / "records").mkdir(parents=True)
        (site / "tools").mkdir(parents=True)
        shutil.copy2(SITE_ROOT / "records/collections.json", site / "records/collections.json")
        shutil.copy2(SITE_ROOT / "tools/route_stations.json", site / "tools/route_stations.json")
        shutil.copy2(SITE_ROOT / "tools/station_footprints.json", site / "tools/station_footprints.json")
        return site

    def test_parse_record_id_supports_both_conventions_and_rejects_invalid(self):
        self.assertEqual(parse_record_id(Path("gnss_log_2026_11_15_19_54_37.txt")), "261115195437")
        self.assertEqual(parse_record_id(Path("G3681_2026-10-21_13-16-36.txt")), "261021131636")
        with self.assertRaisesRegex(ValueError, "Use --id YYMMDDHHMMSS"):
            parse_record_id(Path("custom_run.txt"))
        with self.assertRaisesRegex(ValueError, "Invalid record ID"):
            parse_record_id(Path("custom_run.txt"), explicit_id="bad")

    def test_stream_and_audit_handle_incomplete_reversed_invalid_and_duplicates(self):
        log_path = self.work / "C2031_2026-11-18_08-00-00.txt"
        t0 = ms_at("2026-11-18", "08:00:10")
        lines = [
            "# header\n",
            "OrientationDeg,1794988800000,1,2,3,4\n",
            f"NMEA,$GPRMC,,V,,,,,,,,,,N,V*29,{t0 - 5000}\n",
            "NMEA,$GPGGA,truncated,0\n",
            "Fix,network,39.8,116.5,0,1,20,0,1794988810000,1\n",
            "Fix,gps,39.8,116.5\n",  # truncated gps line
            f"Fix,gps,39.8,116.5,0,,9.5,90,{t0 + 500},0.5\n",  # missing speed
            fix_line(t0 + 2000, 116.501, 39.8, 20.0, h_acc=9.9),
            fix_line(t0 + 1000, 116.5005, 39.8, 20.0, h_acc=25.0),  # reversed timestamp
        ]
        log_path.write_text("".join(lines), encoding="utf-8")

        parsed = stream_gnss_logs(log_path, strict=True)
        self.assertEqual([f["t"] for f in parsed["fixes"]], [t0 + 1000, t0 + 2000])
        self.assertEqual(len(parsed["incomplete_rows"]), 2)
        self.assertEqual(parsed["reversed_count"], 1)
        self.assertEqual(parsed["nmea_missing_timestamp"], 1)

        audit = audit_logs(log_path, record_id="261118080000", train="C2031")
        self.assertEqual(audit["usable"], 2)
        self.assertEqual(audit["incomplete"], 2)
        self.assertEqual(audit["reversed"], 1)
        self.assertEqual(audit["horizontalAccuracy"]["overThresholdCount"], 1)

        # Duplicate and invalid fixes fail in strict mode and are reported in non-strict audit.
        bad_log = self.work / "bad.txt"
        bad_log.write_text(
            fix_line(t0, 116.5, 39.8, 10.0)
            + fix_line(t0, 116.5, 39.8, 10.0)
            + f"Fix,gps,95.0,116.5,0,10,9.5,90,{t0 + 1000},0.5\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "Duplicate GPS Fix"):
            stream_gnss_logs(bad_log, strict=True)
        bad_audit = audit_logs(bad_log)
        self.assertEqual(bad_audit["duplicates"], 1)
        self.assertEqual(bad_audit["invalid"], 1)

    def test_one_step_import_continuations_trim_clean_drift_and_atomicity(self):
        site = self.make_temp_site()
        part1 = self.work / "gnss_log_2026_11_18_09_00_00.txt"
        part2 = self.work / "gnss_log_2026_11_18_09_00_10.txt"

        # Route from 北京南 (39.865, 116.378) -> 亦庄 -> 永乐 -> 武清 (synthetic straight segment near 北京南).
        base_lon, base_lat = 116.378, 39.865
        t_start = ms_at("2026-11-18", "09:00:00")
        rows_part1 = [f"NMEA,$GPRMC,,A,{t_start}\n"]
        rows_part2 = []

        # 0..1s before trim boundary, 2..15s inside trim boundary.
        for sec in range(0, 16):
            t_ms = t_start + sec * 1000
            lon = base_lon + meters_east_to_lon(sec * 20.0, base_lat)
            lat = base_lat
            speed_mps = 20.0
            h_acc = 9.5
            if sec == 5:
                # Speed outlier spike (> 1.5 m/s^2 acceleration): dropped from speed JSON ONLY, kept in route JSON.
                speed_mps = 80.0
            elif sec == 7:
                # Poor horizontal accuracy (Method 1): dropped from route JSON ONLY, kept in speed JSON.
                h_acc = 35.0
            elif sec == 9:
                # Teleport with optimistic h_acc (Method 2): dropped from route JSON ONLY.
                lon += meters_east_to_lon(250.0, base_lat)
            elif sec == 11:
                # Lateral spike with plausible step length (Method 3): dropped from route JSON ONLY.
                lat += 15.0 / 110540.0
            line = fix_line(t_ms, lon, lat, speed_mps, h_acc=h_acc)
            (rows_part1 if sec < 10 else rows_part2).append(line)

        part1.write_text("".join(rows_part1), encoding="utf-8")
        part2.write_text("".join(rows_part2), encoding="utf-8")

        events_payload = json.dumps(
            [
                {"name": "亦庄", "type": "pass", "start": "09:00:04", "end": "09:00:08"},
                {"name": "永乐", "type": "pass", "start": "09:00:10", "end": "09:00:12", "source": "inferred"},
            ],
            ensure_ascii=False,
        )

        # Validation failure (e.g. unreviewed station) must leave zero created files.
        with self.assertRaises(SystemExit):
            manage_records.main(
                [
                    "import",
                    str(part1),
                    str(part2),
                    "--site-root",
                    str(site),
                    "--train",
                    "C2031",
                    "--origin",
                    "北京南",
                    "--destination",
                    "未知未审核站",
                    "--stations",
                    "北京南,亦庄,永乐,未知未审核站",
                    "--start",
                    "09:00:02",
                    "--end",
                    "09:00:14",
                ]
            )
        self.assertFalse((site / "records/261118090000.json").exists())
        self.assertFalse((site / "records/261118090000.route.json").exists())
        self.assertFalse((site / "records/index.json").exists())

        # Inferred event with disallowed note must also be rejected atomically.
        bad_events = json.dumps(
            [{"name": "永乐", "type": "pass", "start": "09:00:10", "end": "09:00:12", "source": "inferred", "note": "forbidden"}],
            ensure_ascii=False,
        )
        with self.assertRaises(SystemExit):
            manage_records.main(
                [
                    "import",
                    str(part1),
                    str(part2),
                    "--site-root",
                    str(site),
                    "--train",
                    "C2031",
                    "--origin",
                    "北京南",
                    "--destination",
                    "武清",
                    "--stations",
                    "北京南,亦庄,永乐,武清",
                    "--events",
                    bad_events,
                ]
            )
        self.assertFalse((site / "records/261118090000.json").exists())

        # Successful one-step import.
        manage_records.main(
            [
                "import",
                str(part1),
                str(part2),
                "--site-root",
                str(site),
                "--train",
                "C2031",
                "--origin",
                "北京南",
                "--destination",
                "武清",
                "--start",
                "09:00:02",
                "--end",
                "09:00:14",
                "--events",
                events_payload,
                "--stations",
                "北京南,亦庄,永乐,武清",
                "--collection",
                "jingjin",
            ]
        )

        trip = json.loads((site / "records/261118090000.json").read_text(encoding="utf-8"))
        route = json.loads((site / "records/261118090000.route.json").read_text(encoding="utf-8"))
        index = json.loads((site / "records/index.json").read_text(encoding="utf-8"))
        collections = json.loads((site / "records/collections.json").read_text(encoding="utf-8"))
        definitions = json.loads((site / "tools/route_stations.json").read_text(encoding="utf-8"))

        # Trimmed 2..14s = 13 pts; sec 5 speed spike removed -> 12 speed samples.
        self.assertEqual(trip["logStart"], t_start + 2000)
        self.assertEqual(trip["logEnd"], t_start + 14000)
        self.assertEqual(len(trip["samples"]), 12)
        self.assertNotIn(t_start + 5000, [s["t"] for s in trip["samples"]])
        self.assertEqual(trip["speedCleaning"]["removedCount"], 1)

        # Speed samples retain sec 7, 9, 11; route map keeps sec 5 and drops sec 7 (M1), 9 (M2), 11 (M3) -> 10 route pts.
        sample_times = [s["t"] for s in trip["samples"]]
        for dropped_sec in (7, 9, 11):
            self.assertIn(t_start + dropped_sec * 1000, sample_times)
        route_times = [p[2] for seg in route["segments"] for p in seg]
        self.assertEqual(len(route_times), 10)
        self.assertIn(t_start + 5000, route_times)
        for dropped_sec in (7, 9, 11):
            self.assertNotIn(t_start + dropped_sec * 1000, route_times)
        self.assertEqual([st["name"] for st in route["stations"]], ["北京南", "亦庄", "永乐", "武清"])
        self.assertIn("platform", route["stations"][0])
        self.assertNotIn("platform", route["stations"][2])  # 永乐 stays a point station
        self.assertEqual(index[0]["sampleCount"], 12)
        self.assertEqual(collections[0]["recordIds"][0], "261118090000")
        self.assertEqual(definitions["sourceFiles"]["261118090000"], [part1.name, part2.name])

        # Duplicate import without --overwrite fails; with --overwrite succeeds.
        with self.assertRaises(SystemExit):
            manage_records.main(
                [
                    "import",
                    str(part1),
                    str(part2),
                    "--site-root",
                    str(site),
                    "--train",
                    "C2031",
                    "--origin",
                    "北京南",
                    "--destination",
                    "武清",
                ]
            )
        manage_records.main(
            [
                "import",
                str(part1),
                str(part2),
                "--site-root",
                str(site),
                "--train",
                "C2031",
                "--origin",
                "北京南",
                "--destination",
                "武清",
                "--beta",
                "--overwrite",
            ]
        )
        overwritten = json.loads((site / "records/261118090000.json").read_text(encoding="utf-8"))
        self.assertTrue(overwritten["beta"])

    def test_real_g3681_removes_dezhou_east_outside_box_drift_and_keeps_cangzhou_stop(self):
        raw_log = SITE_ROOT.parent / "G3681_2026-10-21_13-16-36.txt"
        published_trip_path = SITE_ROOT / "records/261021131636.json"
        if not raw_log.exists() or not published_trip_path.exists():
            self.skipTest("Workspace G3681 raw log not available")

        site = self.make_temp_site()
        published_trip = json.loads(published_trip_path.read_text(encoding="utf-8-sig"))
        events_file = self.work / "g3681_events.json"
        events_file.write_text(json.dumps(published_trip["events"], ensure_ascii=False), encoding="utf-8")

        manage_records.main(
            [
                "import",
                str(raw_log),
                "--site-root",
                str(site),
                "--train",
                "G3681",
                "--origin",
                "石家庄",
                "--destination",
                "天津西",
                "--events",
                str(events_file),
            ]
        )

        trip = json.loads((site / "records/261021131636.json").read_text(encoding="utf-8"))
        route = json.loads((site / "records/261021131636.route.json").read_text(encoding="utf-8"))

        # Speed samples and cleaning match the published G3681 record exactly.
        self.assertEqual(len(trip["samples"]), 9717)
        self.assertEqual(trip["speedCleaning"]["removedCount"], 10)
        self.assertEqual(trip["samples"], published_trip["samples"])

        flat_points = [p for segment in route["segments"] for p in segment]
        self.assertLess(len(flat_points), len(trip["samples"]))
        self.assertTrue(all(b[2] > a[2] for a, b in zip(flat_points, flat_points[1:])))

        # Verify Dezhou East stop-8 (15:02:08 - 15:05:01) has 0 points drifting outside its platform box.
        dezhou_station = next(st for st in route["stations"] if st["name"] == "德州东")
        dezhou_corners = dezhou_station["platform"]["corners"]
        stop8 = next(e for e in trip["events"] if e["id"] == "stop-8")
        stop8_points = [p for p in flat_points if stop8["start"] <= p[2] <= stop8["end"]]
        outside_dezhou = [p for p in stop8_points if not inside_geographic_rectangle(p[0], p[1], dezhou_corners)]
        self.assertEqual(len(outside_dezhou), 0)

        # Verify entry/exit points inside Dezhou East box around stop-8 are still present.
        around_stop8 = [p for p in flat_points if stop8["start"] - 45000 <= p[2] <= stop8["end"] + 45000]
        self.assertTrue(any(p[2] < stop8["start"] and inside_geographic_rectangle(p[0], p[1], dezhou_corners) for p in around_stop8))
        self.assertTrue(any(p[2] > stop8["end"] and inside_geographic_rectangle(p[0], p[1], dezhou_corners) for p in around_stop8))

        # Verify all 486 Cangzhou West stop-9 samples remain intact and inside its platform box.
        cangzhou_station = next(st for st in route["stations"] if st["name"] == "沧州西")
        cangzhou_corners = cangzhou_station["platform"]["corners"]
        stop9 = next(e for e in trip["events"] if e["id"] == "stop-9")
        stop9_points = [p for p in flat_points if stop9["start"] <= p[2] <= stop9["end"]]
        self.assertEqual(len(stop9_points), 486)
        self.assertTrue(all(inside_geographic_rectangle(p[0], p[1], cangzhou_corners) for p in stop9_points))

    def test_filter_existing_route_methods_and_idempotence(self):
        base_lon, base_lat = 116.378, 39.865
        t0 = ms_at("2026-11-18", "10:00:00")
        samples = []
        points = []
        for sec in range(0, 10):
            t_ms = t0 + sec * 1000
            lon = base_lon + meters_east_to_lon(sec * 25.0, base_lat)
            lat = base_lat
            a_kmh = 2.5
            if sec == 2:
                # Method 1: high speed uncertainty soft-drift outlier (v=90 km/h -> limit 8.3 km/h).
                a_kmh = 11.0
            elif sec == 5:
                # Method 2: coordinate teleport with normal speed uncertainty.
                lon += meters_east_to_lon(250.0, base_lat)
            elif sec == 7:
                # Method 3: 30 m lateral spike within step bound but > 45 deg turn.
                lat += 30.0 / 110540.0
            samples.append({"t": t_ms, "v": 90.0, "a": a_kmh})
            points.append([round(lon, 7), round(lat, 7), t_ms])

        trip = {"id": "261118100000", "sampleIntervalMs": 1000.0, "samples": samples}
        stations = [{"name": "北京南", "lon": base_lon, "lat": base_lat}]
        route = {"id": "261118100000", "coordinateSystem": "WGS84", "segments": [points], "stations": stations}

        cleaned, stats = filter_existing_route(trip, route)
        self.assertEqual(stats["method1Removed"], 1)
        self.assertEqual(stats["method2Removed"], 1)
        self.assertEqual(stats["method3Removed"], 1)
        self.assertEqual(stats["totalRemoved"], 3)
        self.assertEqual(cleaned["stations"], stations)
        kept_times = [p[2] for seg in cleaned["segments"] for p in seg]
        self.assertEqual(kept_times, [t0 + s * 1000 for s in (0, 1, 3, 4, 6, 8, 9)])

        # Second pass must be strictly idempotent.
        cleaned_again, stats_again = filter_existing_route(trip, cleaned)
        self.assertEqual(stats_again["totalRemoved"], 0)
        self.assertEqual(cleaned_again, cleaned)

    def test_filter_existing_route_uses_extra_samples_for_speed_removed_points(self):
        base_lon, base_lat = 116.378, 39.865
        t0 = ms_at("2026-11-18", "10:00:00")
        samples = [
            {"t": t0 + sec * 1000, "v": 90.0, "a": 2.5}
            for sec in (0, 1, 3, 4)
        ]
        extra = [{"t": t0 + 2000, "v": 250.0, "a": 2.5}]
        points = [
            [round(base_lon + meters_east_to_lon(sec * 25.0, base_lat), 7), base_lat, t0 + sec * 1000]
            for sec in range(5)
        ]
        trip = {"id": "261118100001", "sampleIntervalMs": 1000.0, "samples": samples}
        route = {
            "id": "261118100001",
            "coordinateSystem": "WGS84",
            "segments": [points],
            "stations": [{"name": "北京南", "lon": base_lon, "lat": base_lat}],
        }

        with self.assertRaisesRegex(ValueError, "missing from speed samples and backup samples"):
            filter_existing_route(trip, route)

        cleaned, stats = filter_existing_route(trip, route, extra_samples=extra)
        self.assertEqual(stats["totalRemoved"], 0)
        self.assertEqual([p[2] for seg in cleaned["segments"] for p in seg], [t0 + sec * 1000 for sec in range(5)])


if __name__ == "__main__":
    unittest.main()
