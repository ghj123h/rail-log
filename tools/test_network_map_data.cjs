"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {build} = require('../assets/network-map-data.js');

function route(id, names, options = {}) {
  const stations = names.map((name, index) => ({name, lon: 110 + index, lat: 30}));
  return {
    record: {id, origin: names[0], destination: names.at(-1), ...options},
    route: {id, coordinateSystem: 'WGS84', segments: [stations.map(station => [station.lon, station.lat])], stations}
  };
}

function network(...fixtures) {
  return build(fixtures.map(item => item.record), fixtures.map(item => item.route));
}

const names = result => result.stations.map(station => station.name);
const junctions = result => result.summary.junctions;

// The user's crossing example: the shared station has four distinct branches.
const changsha = network(
  route('north-south', ['北京西', '武汉', '长沙南', '衡阳东', '广州南']),
  route('east-west', ['杭州东', '南昌西', '长沙南', '怀化南', '贵阳北'])
);
assert.deepEqual(junctions(changsha), ['长沙南']);
assert.deepEqual(names(changsha), ['北京西', '长沙南', '广州南', '杭州东', '贵阳北']);
assert.equal(changsha.stations.find(station => station.name === '长沙南').endpoint, false);

// A shared corridor forks at a station, including the reverse traversal.
const fork = network(
  route('jinghu', ['北京南', '枣庄', '徐州东', '宿州东', '上海虹桥']),
  route('xulan', ['西安北', '商丘', '徐州东', '枣庄', '北京南'])
);
assert.deepEqual(junctions(fork), ['徐州东']);
assert.equal(names(fork).includes('枣庄'), false);

// Repeated and reverse runs only add the same two undirected neighbors.
const overlapping = network(
  route('one', ['北京南', '亦庄', '永乐', '武清']),
  route('two', ['北京南', '亦庄', '永乐', '武清']),
  route('three', ['武清', '永乐', '亦庄', '北京南'])
);
assert.deepEqual(names(overlapping), ['北京南', '武清']);
assert.deepEqual(junctions(overlapping), []);

// Being a real-world hub does not add an uncovered branch.
assert.deepEqual(names(network(route('only', ['北京南', '徐州东', '上海虹桥']))), ['北京南', '上海虹桥']);

// Geometric intersections without a shared station cannot create a junction.
const overpassA = route('overpass-a', ['甲', '乙']);
const overpassB = route('overpass-b', ['丙', '丁']);
overpassA.route.segments = [[[110, 30], [112, 32]]];
overpassB.route.segments = [[[110, 32], [112, 30]]];
assert.deepEqual(junctions(network(overpassA, overpassB)), []);
assert.deepEqual(names(network(overpassA, overpassB)), ['甲', '乙', '丙', '丁']);

// Partial records are drawn in full over their published interval. A shared
// endpoint remains visible, but joining two halves does not turn it into a fork.
const partial = network(
  route('partial', ['曲阜东', '滕州东', '枣庄', '徐州东'], {partial: true}),
  route('continued', ['徐州东', '观音机场', '扬州东'])
);
assert.deepEqual(names(partial), ['曲阜东', '徐州东', '扬州东']);
assert.deepEqual(junctions(partial), []);
const unknownOrigin = network(route('unknown-origin', ['滕州东', '枣庄', '徐州东'], {origin: '', partial: true}));
assert.deepEqual(names(unknownOrigin), ['徐州东']);
assert.equal(unknownOrigin.summary.endpointCount, 1);
assert.equal(names(unknownOrigin).includes('滕州东'), false);
assert.throws(() => network(route('missing-origin', ['甲', '乙'], {origin: ''})), /缺少起止站/);
const sharedEndpoint = network(
  route('through', ['甲', '乙', '丙', '丁']),
  route('start', ['乙', '丙', '丁'])
);
assert.deepEqual(names(sharedEndpoint), ['甲', '乙', '丁']);
assert.deepEqual(junctions(sharedEndpoint), []);

// Position selection is deterministic, uses one supplied candidate, and the
// builder neither mutates inputs nor joins separated GNSS segments.
const candidates = [
  route('candidate-one', ['甲', '乙']),
  route('candidate-two', ['甲', '乙']),
  route('candidate-three', ['甲', '乙'])
];
candidates.forEach((fixture, index) => Object.assign(fixture.route.stations[0], {lon: [110, 110.002, 115][index], lat: 30}));
candidates[0].route.segments = [[[110, 30, 1]], [[110.001, 30, 5], [110.002, 30, 6]]];
const before = JSON.stringify(candidates);
const selected = network(...candidates);
assert.equal(selected.stations[0].lon, 110.002);
assert.equal(network(...candidates.slice().reverse()).stations.find(station => station.name === '甲').lon, 110.002);
assert.deepEqual(selected.segments, candidates.flatMap(fixture => fixture.route.segments));
assert.equal(selected.segments[0].length, 1);
assert.equal(JSON.stringify(candidates), before);

assert.deepEqual(build([], []), {
  id: 'network', coordinateSystem: 'WGS84', segments: [], stations: [],
  summary: {recordCount: 0, segmentCount: 0, pointCount: 0, stationCount: 0, endpointCount: 0, junctionCount: 0, junctions: []}
});
assert.throws(() => build([route('missing', ['甲', '乙']).record], []), /missing.*缺少线路图数据/);
const wrongEndpoint = route('wrong-endpoint', ['甲', '乙']);
wrongEndpoint.record.destination = '丙';
assert.throws(() => network(wrongEndpoint), /wrong-endpoint.*起止站不一致/);
const noSamples = route('no-samples', ['甲', '乙']);
noSamples.route.segments = [];
assert.throws(() => network(noSamples), /no-samples.*缺少实测轨迹/);

// Real published routes use the complete station catalog, not sparse stopping
// events. This invariant prevents skipped stops from becoming false branches.
const recordsRoot = path.resolve(__dirname, '../records');
const records = JSON.parse(fs.readFileSync(path.join(recordsRoot, 'index.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'route_stations.json'), 'utf8'));
const routes = records.map(record => JSON.parse(fs.readFileSync(path.join(recordsRoot, `${record.id}.route.json`), 'utf8')));
for (const item of routes) {
  assert.deepEqual(item.stations.map(station => station.name), catalog.routes[item.id], `${item.id}: use the complete along-line catalog`);
}
const real = build(records, Object.fromEntries(routes.map(item => [item.id, item])));
const endpoints = [...new Set(records.flatMap(record => [record.origin, record.destination]).filter(Boolean))].sort();
assert.deepEqual(real.stations.filter(station => station.endpoint).map(station => station.name).sort(), endpoints);
assert.equal(real.summary.recordCount, records.length);
assert.equal(real.summary.endpointCount, endpoints.length);
assert.ok(real.stations.every(station => station.endpoint || station.junction && station.neighbors.length >= 3));
assert.equal(real.summary.segmentCount, routes.reduce((sum, item) => sum + item.segments.length, 0));
assert.equal(real.summary.pointCount, records.reduce((sum, record) => sum + record.sampleCount, 0));

// A collection receives only its own records and shows all along-line stations.
// Its bounds come from those records, so later recorded coverage extends it.
const collections = JSON.parse(fs.readFileSync(path.join(recordsRoot, 'collections.json'), 'utf8'));
const jingjin = collections.find(collection => collection.id === 'jingjin');
const collectionRecords = records.filter(record => jingjin.recordIds.includes(record.id));
const collectionRoutes = routes.filter(item => jingjin.recordIds.includes(item.id));
const collection = build(collectionRecords, collectionRoutes, {includeIntermediateStations: true});
const collectionStationNames = [...new Set(collectionRoutes.flatMap(item => item.stations.map(station => station.name)))];
assert.equal(collection.summary.recordCount, jingjin.recordIds.length);
assert.deepEqual(names(collection), collectionStationNames);
assert.ok(['北京南', '亦庄', '永乐', '武清'].every(name => names(collection).includes(name)));
assert.equal(collection.summary.stationCount, collectionStationNames.length);
assert.equal(collection.summary.segmentCount, collectionRoutes.reduce((sum, item) => sum + item.segments.length, 0));
assert.equal(collection.summary.pointCount, collectionRecords.reduce((sum, record) => sum + record.sampleCount, 0));
assert.deepEqual(collection.segments, collectionRoutes.flatMap(item => item.segments));
assert.deepEqual(names(build(collectionRecords, collectionRoutes)), collection.stations.filter(station => station.endpoint || station.junction).map(station => station.name));

const eastward = route('future-jingjin-east', ['武清', '东侧新增站']);
const wuqing = collection.stations.find(station => station.name === '武清');
const oldEast = Math.max(...collection.segments.flat().map(point => point[0]));
eastward.route.stations[0] = {name: '武清', lon: wuqing.lon, lat: wuqing.lat};
eastward.route.stations[1] = {name: '东侧新增站', lon: oldEast + .25, lat: wuqing.lat - .2};
eastward.route.segments = [[[wuqing.lon, wuqing.lat], [oldEast + .25, wuqing.lat - .2]]];
const extended = build([...collectionRecords, eastward.record], [...collectionRoutes, eastward.route], {includeIntermediateStations: true});
assert.deepEqual(names(extended), [...collectionStationNames, '东侧新增站']);
assert.deepEqual(extended.segments, [...collection.segments, ...eastward.route.segments]);
assert.equal(extended.summary.recordCount, collection.summary.recordCount + 1);
assert.equal(extended.summary.segmentCount, collection.summary.segmentCount + 1);
assert.equal(extended.summary.pointCount, collection.summary.pointCount + 2);
assert.ok(Math.max(...extended.segments.flat().map(point => point[0])) > oldEast);

// The browser global offers the same API without CommonJS.
const browser = {window: {}};
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../assets/network-map-data.js'), 'utf8'), browser);
assert.equal(typeof browser.window.RailNetworkData.build, 'function');

console.log(`Network map data checks passed: ${real.summary.recordCount} records, ${real.summary.segmentCount} original segments, ${real.summary.pointCount} measured points, ${real.summary.endpointCount} endpoints, ${real.summary.junctionCount} junctions.`);
