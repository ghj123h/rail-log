"""Audit or remove speed samples exceeding the agreed acceleration limit.

Raw GNSS logs are never edited. With --apply, update existing speed/route
records and rebuild the catalog. Write the detailed audit outside the site.
"""
import argparse
import json
import math
from pathlib import Path

from manage_records import rebuild

ROOT = Path(__file__).resolve().parents[1]
EPSILON = 1e-9


def compatible(left, right, limit):
    """v is km/h; sample a is speed uncertainty, not acceleration."""
    return abs(right['v'] - left['v']) <= limit * 3.6 * (right['t'] - left['t']) / 1000 + EPSILON


def retained_indices(samples, limit):
    """Keep a longest time-ordered subsequence obeying the acceleration bound.

    Resolve equal-length choices by the lowest total reported speed uncertainty.
    Prefix length bounds prune predecessors that cannot improve the result;
    this avoids scanning an entire normal run for each new sample. Unlike a
    forward-only filter, an early bad fix cannot anchor a chain of deletions.
    Comparisons across missing time use the actual elapsed time.
    """
    if not samples:
        return []
    if not math.isfinite(limit) or limit <= 0:
        raise ValueError('Acceleration limit must be finite and positive.')
    lengths, uncertainties, parents, prefix_lengths = [], [], [], []
    best_end = 0
    for index, sample in enumerate(samples):
        if not all(math.isfinite(sample[key]) for key in ('t', 'v', 'a')) or sample['v'] < 0 or sample['a'] < 0:
            raise ValueError(f'Invalid sample at index {index}.')
        if index and sample['t'] <= samples[index - 1]['t']:
            raise ValueError('Sample timestamps must be strictly increasing.')
        count, uncertainty, parent = 1, sample['a'], -1
        for previous in range(index - 1, -1, -1):
            if prefix_lengths[previous] + 1 < count:
                break
            candidate_count = lengths[previous] + 1
            candidate_uncertainty = uncertainties[previous] + sample['a']
            if (candidate_count > count or (candidate_count == count and candidate_uncertainty < uncertainty)) and compatible(samples[previous], sample, limit):
                count, uncertainty, parent = candidate_count, candidate_uncertainty, previous
        lengths.append(count)
        uncertainties.append(uncertainty)
        parents.append(parent)
        prefix_lengths.append(max(count, prefix_lengths[-1] if prefix_lengths else 0))
        if count > lengths[best_end] or (count == lengths[best_end] and uncertainty < uncertainties[best_end]):
            best_end = index
    retained = []
    while best_end != -1:
        retained.append(best_end)
        best_end = parents[best_end]
    return retained[::-1]


def filter_route(route, retained_times, interval):
    """Remove matching route points, preserving original breaks and stations."""
    segments = []
    for original in route['segments']:
        segment = []
        for point in original:
            if point[2] not in retained_times:
                if segment:
                    segments.append(segment)
                    segment = []
                continue
            if segment and point[2] - segment[-1][2] > interval * 1.5:
                segments.append(segment)
                segment = []
            segment.append(point)
        if segment:
            segments.append(segment)
    return {**route, 'segments': segments}


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--limit', type=float, default=1.5, help='Maximum absolute acceleration in m/s² (default: 1.5)')
    parser.add_argument('--apply', action='store_true', help='Apply the reviewed cleanup; default: audit only')
    parser.add_argument('--report', type=Path, required=True, help='Local audit JSON path, outside the public site')
    args = parser.parse_args()
    if args.report.resolve().is_relative_to(ROOT):
        parser.error('Keep the detailed audit report outside the public site directory.')
    entries = json.loads((ROOT / 'records/index.json').read_text(encoding='utf-8-sig'))
    reports, updates = [], []
    for entry in entries:
        path = ROOT / f"records/{entry['id']}.json"
        trip = json.loads(path.read_text(encoding='utf-8-sig'))
        samples = trip['samples']
        kept = retained_indices(samples, args.limit)
        kept_set = set(kept)
        removed = [dict(index=index, **sample) for index, sample in enumerate(samples) if index not in kept_set]
        remaining = [samples[index] for index in kept]
        assert all(compatible(a, b, args.limit) for a, b in zip(remaining, remaining[1:]))
        route_path = ROOT / f"records/{trip['id']}.route.json"
        route = json.loads(route_path.read_text(encoding='utf-8-sig'))
        route_times = [point[2] for segment in route['segments'] for point in segment]
        if route_times != [sample['t'] for sample in samples]:
            raise ValueError(f"{trip['id']}: route and speed timestamps differ before cleanup.")
        bad_edges = sum(not compatible(a, b, args.limit) for a, b in zip(samples, samples[1:]))
        report = dict(id=trip['id'], train=trip['train'], before=len(samples), after=len(remaining),
                      violatingPairsBefore=bad_edges, removed=removed)
        reports.append(report)
        if removed:
            cleaned_trip = {**trip, 'samples': remaining, 'speedCleaning': {
                'maxAbsAccelerationMps2': args.limit,
                'removedCount': trip.get('speedCleaning', {}).get('removedCount', 0) + len(removed),
                'method': 'longest-feasible-subsequence',
            }}
            cleaned_route = filter_route(route, {s['t'] for s in remaining}, trip['sampleIntervalMs'])
            updates.extend([(path, cleaned_trip), (route_path, cleaned_route)])
    # Complete all input validation before writing any site files.
    if args.apply:
        for path, value in updates:
            write_json(path, value)
        if updates:
            rebuild()
    output = dict(applied=args.apply, maxAbsAccelerationMps2=args.limit,
                  method='longest-feasible-subsequence; ties minimize total reported speed uncertainty',
                  recordCount=len(reports), before=sum(r['before'] for r in reports),
                  removedCount=sum(len(r['removed']) for r in reports),
                  after=sum(r['after'] for r in reports), records=reports)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: value for key, value in output.items() if key != 'records'}, ensure_ascii=False))
    for report in reports:
        print(f"{report['id']} {report['train']}: {report['before']} -> {report['after']} (-{len(report['removed'])})")


if __name__ == '__main__':
    main()
