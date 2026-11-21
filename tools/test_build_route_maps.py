"""Route source selection, continuation-log, drift filtering, and footprint checks."""
import math
import tempfile
import unittest
from pathlib import Path

from build_route_maps import build, read_positions
from gnss_pipeline import build_route_record, filter_route_fixes


def fix(timestamp, lon=116.3, lat=39.9, speed_mps=1.0, h_acc=0.0, v_acc=0.1):
    h_acc_str = "" if h_acc is None else str(h_acc)
    return f"Fix,gps,{lat},{lon},0,{speed_mps},{h_acc_str},1,{timestamp},{v_acc}\n"


def make_fix(t, lon, lat, v_mps=0.0, h_acc=10.0, v_acc=0.5):
    return {
        "t": t,
        "lon": lon,
        "lat": lat,
        "v": v_mps * 3.6,
        "a": v_acc * 3.6,
        "v_mps": v_mps,
        "v_acc": v_acc,
        "h_acc": h_acc,
    }


def meters_east_to_lon(meters, lat=39.9):
    return meters / (111320.0 * math.cos(math.radians(lat)))


class RouteSourcesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def log(self, name, *timestamps, rows=None):
        path = self.root / name
        content = rows if rows is not None else [fix(t) for t in timestamps]
        path.write_text("".join(content), encoding="utf-8")
        return path

    def test_single_path_still_reads_only_retained_samples(self):
        source = self.log("single.txt", 1000, 2000, 3000)
        self.assertEqual(
            read_positions(source, [{"t": 1000}, {"t": 3000}]),
            [[116.3, 39.9, 1000], [116.3, 39.9, 3000]],
        )

    def test_continuations_follow_sample_order(self):
        first = self.log("first.txt", 1000, 2000)
        second = self.log("second.txt", 4000)
        samples = [{"t": t} for t in (1000, 2000, 4000)]
        self.assertEqual(
            [p[2] for p in read_positions([second, first], samples)],
            [1000, 2000, 4000],
        )

    def test_duplicate_retained_timestamp_across_sources_is_rejected(self):
        first = self.log("first.txt", 1000, 2000)
        second = self.log("second.txt", 2000, 3000)
        with self.assertRaisesRegex(ValueError, "Duplicate GPS Fix at 2000"):
            read_positions([first, second], [{"t": 1000}, {"t": 2000}])

    def test_missing_timestamp_is_checked_across_all_sources(self):
        first = self.log("first.txt", 1000)
        second = self.log("second.txt", 3000)
        with self.assertRaisesRegex(ValueError, "missing 1 published sample positions"):
            read_positions([first, second], [{"t": t} for t in (1000, 2000, 3000)])

    def inputs(self):
        record_id = "261115195437"
        trip = {
            "id": record_id,
            "train": "G8857",
            "origin": "起点",
            "destination": "终点",
            "samples": [{"t": t} for t in (1000, 2000, 4000)],
            "events": [],
            "sampleIntervalMs": 1000,
        }
        definitions = {
            "routes": {record_id: ["起点", "终点"]},
            "stations": {name: {"lon": 116.3, "lat": 39.9} for name in ("起点", "终点")},
        }
        return trip, definitions, {"stations": {}}

    def test_build_selects_explicit_continuations_and_preserves_gap(self):
        self.log("first.txt", 1000, 2000)
        self.log("second.txt", 4000)
        trip, definitions, footprints = self.inputs()
        definitions["sourceFiles"] = {trip["id"]: ["first.txt", "second.txt"]}
        route, summary = build(trip, self.root, definitions, footprints)
        self.assertEqual([[p[2] for p in segment] for segment in route["segments"]], [[1000, 2000], [4000]])
        self.assertEqual(summary["points"], 3)

    def test_build_keeps_both_existing_filename_conventions(self):
        trip, definitions, footprints = self.inputs()
        for filename in ("gnss_log_2026_11_15_19_54_37.txt", "G8857_2026-11-15_19-54-37.txt"):
            with self.subTest(filename=filename):
                path = self.log(filename, 1000, 2000, 4000)
                route, _ = build(trip, self.root, definitions, footprints)
                self.assertEqual(
                    [p[2] for segment in route["segments"] for p in segment],
                    [1000, 2000, 4000],
                )
                path.unlink()

    def test_build_retains_positions_removed_from_speed_samples(self):
        self.log("gnss_log_2026_11_15_19_54_37.txt", 1000, 2000, 3000)
        trip, definitions, footprints = self.inputs()
        trip["samples"] = [{"t": 1000}, {"t": 3000}]
        route, summary = build(trip, self.root, definitions, footprints)
        self.assertEqual(
            [p[2] for segment in route["segments"] for p in segment],
            [1000, 2000, 3000],
        )
        self.assertEqual(summary["points"], 3)

    def test_method1_filters_high_and_missing_horizontal_accuracy(self):
        fixes = [
            make_fix(1000, 116.3, 39.9, v_mps=0.0, h_acc=9.9),
            make_fix(2000, 116.3005, 39.9, v_mps=0.0, h_acc=20.1),
            make_fix(3000, 116.3006, 39.9, v_mps=0.0, h_acc=math.inf),
            make_fix(4000, 116.30002, 39.9, v_mps=0.0, h_acc=20.0),
        ]
        kept, stats = filter_route_fixes(fixes)
        self.assertEqual([f["t"] for f in kept], [1000, 4000])
        self.assertEqual(stats["method1Removed"], 2)

    def test_method2_drops_teleport_and_bad_initial_anchor(self):
        # First point is displaced by 300 m, followed by a steady 25 m/s eastward run.
        fixes = [
            make_fix(1000, 116.3 + meters_east_to_lon(-300), 39.9, v_mps=25.0, h_acc=10.0),
            make_fix(2000, 116.3 + meters_east_to_lon(25), 39.9, v_mps=25.0, h_acc=10.0),
            make_fix(3000, 116.3 + meters_east_to_lon(50), 39.9, v_mps=25.0, h_acc=10.0),
            make_fix(4000, 116.3 + meters_east_to_lon(250), 39.9, v_mps=25.0, h_acc=10.0),
            make_fix(5000, 116.3 + meters_east_to_lon(100), 39.9, v_mps=25.0, h_acc=10.0),
        ]
        kept, stats = filter_route_fixes(fixes)
        self.assertEqual([f["t"] for f in kept], [2000, 3000, 5000])
        self.assertEqual(stats["method2Removed"], 2)

    def test_method3_removes_only_local_max_spike_and_preserves_jitter_and_stop_reversal(self):
        # Collinear 25 m/s path with one 30 m lateral spike (step <= 39.1 m, so M2 keeps it, M3 catches 100 deg turn).
        lat_spike = 30.0 / 110540.0
        spike_fixes = [
            make_fix(1000, 116.3 + meters_east_to_lon(0), 39.9, v_mps=25.0),
            make_fix(2000, 116.3 + meters_east_to_lon(25), 39.9, v_mps=25.0),
            make_fix(3000, 116.3 + meters_east_to_lon(50), 39.9 + lat_spike, v_mps=25.0),
            make_fix(4000, 116.3 + meters_east_to_lon(75), 39.9, v_mps=25.0),
            make_fix(5000, 116.3 + meters_east_to_lon(100), 39.9, v_mps=25.0),
        ]
        kept, stats = filter_route_fixes(spike_fixes)
        self.assertEqual([f["t"] for f in kept], [1000, 2000, 4000, 5000])
        self.assertEqual(stats["method2Removed"], 0)
        self.assertEqual(stats["method3Removed"], 1)

        # Stationary small jitter (< 4 m steps) is preserved.
        jitter = [
            make_fix(1000, 116.3, 39.9, v_mps=0.0),
            make_fix(2000, 116.3 + meters_east_to_lon(2.0), 39.9, v_mps=0.0),
            make_fix(3000, 116.3, 39.9, v_mps=0.0),
        ]
        kept_jitter, stats_jitter = filter_route_fixes(jitter)
        self.assertEqual(len(kept_jitter), 3)
        self.assertEqual(stats_jitter["method3Removed"], 0)

        # True reversal separated by a stop (> 5 s gap) is preserved.
        reversal = [
            make_fix(1000, 116.3, 39.9, v_mps=10.0),
            make_fix(2000, 116.3 + meters_east_to_lon(10.0), 39.9, v_mps=10.0),
            make_fix(12000, 116.3, 39.9, v_mps=10.0),
        ]
        kept_rev, stats_rev = filter_route_fixes(reversal)
        self.assertEqual(len(kept_rev), 3)
        self.assertEqual(stats_rev["method3Removed"], 0)

    def test_footprints_policy_handles_exemptions_and_unreviewed_stations(self):
        trip, definitions, _ = self.inputs()
        fixes = [make_fix(t, 116.3, 39.9, v_mps=1.0) for t in (1000, 2000, 4000)]
        platform_entry = {
            "center": [116.3, 39.9],
            "corners": [
                [116.299, 39.899],
                [116.301, 39.899],
                [116.301, 39.901],
                [116.299, 39.901],
            ],
            "platformCorners": [
                [116.299, 39.899],
                [116.301, 39.899],
                [116.301, 39.901],
                [116.299, 39.901],
            ],
            "arrivalTracks": [],
        }
        # Missing from both stations and pointStations when pointStations registry exists -> reject.
        footprints = {
            "coordinateSystem": "WGS84",
            "arrivalClearanceM": 20,
            "stations": {"起点": platform_entry},
            "pointStations": {},
        }
        with self.assertRaisesRegex(ValueError, "终点.*lacks a reviewed platform footprint"):
            build_route_record(trip, fixes, definitions, footprints)

        # Record-level exemption forces point representation even if station exists in footprints["stations"].
        footprints_exempt = {
            **footprints,
            "pointStations": {"终点": {}},
            "recordExceptions": {
                trip["id"]: {"scope": "record", "status": "exempt", "stations": ["起点"]}
            },
        }
        route, summary = build_route_record(trip, fixes, definitions, footprints_exempt)
        self.assertNotIn("platform", route["stations"][0])
        self.assertEqual(summary["platformStations"], 0)


if __name__ == "__main__":
    unittest.main()
