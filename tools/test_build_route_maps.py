"""Route source selection and continuation-log regression checks."""
import tempfile
import unittest
from pathlib import Path

from build_route_maps import build, read_positions


def fix(timestamp, lon=116.3, lat=39.9):
    return f"Fix,gps,{lat},{lon},0,1,0,1,{timestamp},0.1\n"


class RouteSourcesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def log(self, name, *timestamps):
        path = self.root / name
        path.write_text("".join(fix(t) for t in timestamps), encoding="utf-8")
        return path

    def test_single_path_still_reads_only_retained_samples(self):
        source = self.log("single.txt", 1000, 2000, 3000)
        self.assertEqual(read_positions(source, [{"t": 1000}, {"t": 3000}]),
                         [[116.3, 39.9, 1000], [116.3, 39.9, 3000]])

    def test_continuations_follow_sample_order(self):
        first = self.log("first.txt", 1000, 2000)
        second = self.log("second.txt", 4000)
        samples = [{"t": t} for t in (1000, 2000, 4000)]
        self.assertEqual([p[2] for p in read_positions([second, first], samples)],
                         [1000, 2000, 4000])

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
        trip = {"id": record_id, "train": "G8857", "origin": "起点", "destination": "终点",
                "samples": [{"t": t} for t in (1000, 2000, 4000)], "events": [], "sampleIntervalMs": 1000}
        definitions = {"routes": {record_id: ["起点", "终点"]},
                       "stations": {name: {"lon": 116.3, "lat": 39.9} for name in ("起点", "终点")}}
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
                self.assertEqual([p[2] for segment in route["segments"] for p in segment], [1000, 2000, 4000])
                path.unlink()


if __name__ == "__main__":
    unittest.main()
