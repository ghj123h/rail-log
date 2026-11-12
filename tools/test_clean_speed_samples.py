"""Check point attribution, gaps, and minimal deletion against exhaustive search."""
import itertools
import random
import unittest

from clean_speed_samples import compatible, filter_route, retained_indices


def samples(speeds, times=None, accuracy=None):
    return [dict(t=t, v=v, a=a) for t, v, a in zip(
        times if times is not None else range(0, len(speeds) * 1000, 1000),
        speeds, accuracy if accuracy is not None else [1] * len(speeds))]


class CleanupTests(unittest.TestCase):
    def test_normal_acceleration_braking_and_boundary(self):
        data = samples([0, 5.4, 10.8, 5.4, 0])
        self.assertEqual(retained_indices(data, 1.5), list(range(5)))

    def test_single_spike_keeps_both_normal_neighbors(self):
        data = samples([100, 101, 180, 102, 103])
        self.assertEqual(retained_indices(data, 1.5), [0, 1, 3, 4])

    def test_bad_initial_fix_does_not_anchor_deletions(self):
        data = samples([180, 100, 101, 102, 103])
        self.assertEqual(retained_indices(data, 1.5), [1, 2, 3, 4])

    def test_use_elapsed_time_across_gap(self):
        data = samples([0, 100, 101], times=[0, 60000, 61000])
        self.assertEqual(retained_indices(data, 1.5), [0, 1, 2])

    def test_equal_count_prefers_lower_speed_uncertainty(self):
        data = samples([100, 110], accuracy=[10, 1])
        self.assertEqual(retained_indices(data, 1.5), [1])

    def test_exhaustive_reference_and_idempotence(self):
        rng = random.Random(20261112)
        for _ in range(50):
            data = samples([rng.randrange(30) for _ in range(8)], accuracy=[rng.randrange(1, 10) for _ in range(8)])
            feasible = []
            for mask in itertools.product((False, True), repeat=len(data)):
                indices = [i for i, keep in enumerate(mask) if keep]
                points = [data[i] for i in indices]
                if all(compatible(a, b, 1.5) for a, b in zip(points, points[1:])):
                    feasible.append((len(indices), -sum(p['a'] for p in points)))
            indices = retained_indices(data, 1.5)
            points = [data[i] for i in indices]
            self.assertEqual((len(indices), -sum(p['a'] for p in points)), max(feasible))
            self.assertEqual(retained_indices(points, 1.5), list(range(len(points))))

    def test_route_deletions_preserve_stations_coordinates_and_breaks(self):
        route = dict(id='test', stations=[dict(name='站', lon=1, lat=2)],
                     segments=[[[1, 2, 0], [2, 3, 1000], [3, 4, 2000]], [[4, 5, 10000]]])
        result = filter_route(route, {0, 2000, 10000}, 1000)
        self.assertEqual(result['segments'], [[[1, 2, 0]], [[3, 4, 2000]], [[4, 5, 10000]]])
        self.assertEqual(result['stations'], route['stations'])
        self.assertEqual(len(route['segments'][0]), 3)


if __name__ == '__main__':
    unittest.main()
