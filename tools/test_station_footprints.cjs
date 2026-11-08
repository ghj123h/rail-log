"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {build} = require('../assets/network-map-data.js');

const project = ([lon, lat]) => [lon * Math.PI / 180, -Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
const unproject = ([x, y]) => [x * 180 / Math.PI, (2 * Math.atan(Math.exp(-y)) - Math.PI / 2) * 180 / Math.PI];

class Node {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.attributes = {};
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.style = {};
    this.clientWidth = 1100;
    this.clientHeight = 600;
    this.textContent = '';
    this.classList = {add() {}, remove() {}};
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  getBBox() { return {x: 0, y: -11, width: this.textContent.length * 13, height: 16}; }
  getBoundingClientRect() { return {left: 0, top: 0}; }
  setPointerCapture() {}
  focus() {}
}
const walk = node => [node, ...node.children.flatMap(walk)];
const classed = (node, name) => walk(node).filter(item => (item.getAttribute('class') || '').split(/\s+/).includes(name));
const numbers = value => value.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi).map(Number);
const vertices = polygon => {
  const coordinates = numbers(polygon.getAttribute('points'));
  return Array.from({length: coordinates.length / 2}, (_, index) => coordinates.slice(index * 2, index * 2 + 2));
};
const dimensions = polygon => {
  const points = vertices(polygon);
  const lengths = points.map((point, index) => Math.hypot(point[0] - points[(index + 1) % points.length][0], point[1] - points[(index + 1) % points.length][1]));
  return [Math.max(...lengths), Math.min(...lengths)];
};

async function mount(route, options) {
  const nodes = new Map();
  ['route-map', 'map-message', 'map-zoom-in', 'map-zoom-out', 'map-reset'].forEach(id => nodes.set(id, new Node()));
  const frames = [], resizeCallbacks = [];
  const context = vm.createContext({
    window: {ROUTE_BASEMAP: {features: []}, ROUTE_RIVERS: {features: []}},
    document: {getElementById: id => nodes.get(id), createElementNS: (_, tag) => new Node(tag)},
    ResizeObserver: class {constructor(callback) { resizeCallbacks.push(callback); } observe() {}},
    requestAnimationFrame: callback => (frames.push(callback), frames.length)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/route-map.js'), 'utf8'), context);
  const instance = await context.window.RailRouteMap.mount({id: route.id, title: '站台绘制检查', routeMap: route}, options);
  assert.ok(instance, nodes.get('map-message').textContent || 'map mounted');
  return {instance, root: nodes.get('route-map'), nodes,
    flush() { while (frames.length) frames.shift()(); },
    resize(width, height) {
      nodes.get('route-map').clientWidth = width;
      nodes.get('route-map').clientHeight = height;
      resizeCallbacks.forEach(callback => callback());
    }
  };
}

function platformAt(center, length, width, angle) {
  const origin = project(center);
  const meter = 1 / (6371000 * Math.cos(center[1] * Math.PI / 180));
  const along = [Math.cos(angle), Math.sin(angle)], across = [-along[1], along[0]];
  return {corners: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => unproject(origin.map((value, axis) => value + (along[axis] * s * length / 2 + across[axis] * t * width / 2) * meter)))};
}

function assertEncloses(polygon, expected, message) {
  const actual = vertices(polygon);
  for (const point of expected) {
    const crosses = actual.map((a, index) => {
      const b = actual[(index + 1) % actual.length];
      return (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
    });
    assert.ok(crosses.every(value => value >= -1) || crosses.every(value => value <= 1), message);
  }
}

function insideGeographicRectangle(point, corners) {
  const origin = corners[0];
  const longitudeScale = 111320 * Math.cos(origin[1] * Math.PI / 180);
  const local = position => [(position[0] - origin[0]) * longitudeScale, (position[1] - origin[1]) * 111320];
  const polygon = corners.map(local), target = local(point);
  const crosses = polygon.map((a, index) => {
    const b = polygon[(index + 1) % polygon.length];
    return (b[0] - a[0]) * (target[1] - a[1]) - (b[1] - a[1]) * (target[0] - a[0]);
  });
  return crosses.every(value => value >= -.01) || crosses.every(value => value <= .01);
}

function geographicCenter(corners) {
  const ring = corners.length === 5 ? corners.slice(0, 4) : corners;
  return [0, 1].map(axis => ring.reduce((sum, point) => sum + point[axis], 0) / ring.length);
}

function footprintFrame(footprint) {
  const latitude = footprint.center[1] * Math.PI / 180;
  const eccentricitySquared = .0066943799901413165;
  const denominator = 1 - eccentricitySquared * Math.sin(latitude) ** 2;
  const scale = [6378137 / Math.sqrt(denominator) * Math.cos(latitude), 6378137 * (1 - eccentricitySquared) / denominator ** 1.5].map(value => value * Math.PI / 180);
  const local = point => point.map((value, axis) => (value - footprint.center[axis]) * scale[axis]);
  const points = footprint.platformCorners.slice(0, 4).map(local);
  const edges = points.map((point, index) => points[(index + 1) % points.length].map((value, axis) => value - point[axis]));
  const longest = edges.reduce((best, edge) => Math.hypot(...edge) > Math.hypot(...best) ? edge : best);
  const length = Math.hypot(...longest), along = longest.map(value => value / length), across = [-along[1], along[0]];
  const coordinate = point => {
    const p = local(point);
    return [p[0] * along[0] + p[1] * along[1], p[0] * across[0] + p[1] * across[1]];
  };
  const extent = corners => {
    const values = corners.map(coordinate);
    return [0, 1].map(axis => [Math.min(...values.map(point => point[axis])), Math.max(...values.map(point => point[axis]))]);
  };
  return {coordinate, extent};
}

(async () => {
  // The sparse station stays at its supplied original position while the
  // detailed station uses its real, rotated geographic platform extent.
  const center = [118.25, 37.56];
  const platform = platformAt([center[0] + .0002, center[1]], 450, 20, Math.PI / 3);
  const route = {
    id: 'footprint-fixture', coordinateSystem: 'WGS84',
    segments: [[[...center, 1]], [[119.25, 38.1, 5]]],
    stations: [{name: '德州东', lon: center[0], lat: center[1], platform}, {name: '石家庄', lon: 119.25, lat: 38.1}]
  };
  const before = JSON.stringify(route);
  const env = await mount(route);
  const groups = classed(env.root, 'map-station');
  const polygon = classed(env.root, 'map-station-platform')[0];
  const circle = classed(env.root, 'map-station-point')[0];
  assert.equal(groups.length, 2);
  assert.equal(classed(env.root, 'map-station-platform').length, 1);
  assert.equal(classed(env.root, 'map-station-point').length, 1);
  assert.equal(circle.tagName, 'circle');
  assert.equal(Number(circle.getAttribute('r')), 3.4);
  const sourcePoints = platform.corners.map(project);
  const sourceEdges = sourcePoints.map((point, index) => Math.hypot(point[0] - sourcePoints[(index + 1) % sourcePoints.length][0], point[1] - sourcePoints[(index + 1) % sourcePoints.length][1]));
  const sourceDimensions = [Math.max(...sourceEdges), Math.min(...sourceEdges)];
  const sourceRatio = sourceDimensions[0] / sourceDimensions[1];
  const origin = project(center);
  const sourceRelativeCenter = [0, 1].map(axis => sourcePoints.reduce((sum, point) => sum + point[axis], 0) / sourcePoints.length - origin[axis]);
  const geometry = env.root.children[0].children.find(node => node.getAttribute('fill') === 'none');
  const mapScale = () => numbers(geometry.getAttribute('transform'))[0];
  const assertRatio = (size, phase) => assert.ok(Math.abs(size[0] / size[1] - sourceRatio) < 1e-5, `${phase}: displayed rectangle retains the source aspect ratio`);
  const assertPosition = phase => {
    const points = vertices(polygon);
    const actualCenter = [0, 1].map(axis => points.reduce((sum, point) => sum + point[axis], 0) / points.length);
    assert.ok(actualCenter.every((value, axis) => Math.abs(value - sourceRelativeCenter[axis] * mapScale()) < .001), `${phase}: minimum sizing preserves the rectangle's geographic center even when offset from the station anchor`);
  };
  assert.ok(Math.abs(sourceRatio - 22.5) < 1e-5, 'rotated source fixture has the intended 450m to 20m ratio');
  const initial = dimensions(polygon);
  assert.ok(sourceDimensions[0] * mapScale() < 16 && sourceDimensions[1] * mapScale() < 8, 'initial fixture is below both independent minimum-size thresholds');
  assert.ok(Math.abs(initial[0] - 16) < .01 && Math.abs(initial[1] - 8) < .01, 'small platform rectangles use a 16px by 8px minimum');
  assertPosition('initial zoom');
  for (let index = 0; index < 4; index++) env.nodes.get('map-zoom-out').onclick();
  env.flush();
  assert.equal(env.instance.getState().zoom, .25);
  const minimum = dimensions(polygon);
  assert.ok(Math.abs(minimum[0] - 16) < .01 && Math.abs(minimum[1] - 8) < .01, 'rectangle remains 16px by 8px at minimum zoom');
  assertPosition('minimum zoom');
  assert.ok(minimum.every((value, axis) => Math.abs(value - initial[axis]) < .01), 'minimum-size rectangle remains stable while map zoom stays below the threshold');
  assert.ok(minimum[1] > Number(circle.getAttribute('r')) * 2, 'minimum rectangle short edge is larger than the original circle diameter');
  env.nodes.get('map-reset').onclick(); env.flush();
  const initialCircle = groups[1].getAttribute('transform');
  for (let index = 0; index < 20 && sourceDimensions[0] * mapScale() <= 16; index++) {
    env.nodes.get('map-zoom-in').onclick(); env.flush();
  }
  const intermediate = dimensions(polygon);
  const intermediateGeographic = sourceDimensions.map(value => value * mapScale());
  assert.ok(intermediateGeographic[0] > 16 && intermediateGeographic[1] < 8, 'intermediate zoom crosses only the long-edge threshold');
  assert.ok(Math.abs(intermediate[0] - intermediateGeographic[0]) < .01 && Math.abs(intermediate[1] - 8) < .01, 'long edge grows at actual geographic scale while short edge keeps its own minimum');
  assertPosition('intermediate zoom');
  for (let index = 0; index < 20; index++) env.nodes.get('map-zoom-in').onclick();
  env.flush();
  assert.equal(env.instance.getState().zoom, 256);
  const enlarged = dimensions(polygon);
  assertRatio(enlarged, 'high zoom');
  assertPosition('high zoom');
  const scale = mapScale();
  const geographicDimensions = sourceDimensions.map(value => value * scale);
  assert.ok(geographicDimensions[0] > 16 && geographicDimensions[1] > 8, 'high-zoom fixture crosses both minimum-size thresholds');
  assert.ok(enlarged.every((value, axis) => Math.abs(value - geographicDimensions[axis]) < .01), 'above the minimum-size threshold both dimensions follow geographic map scale');
  assert.notEqual(groups[1].getAttribute('transform'), initialCircle, 'original circle follows geographic map zoom');
  assert.equal(Number(circle.getAttribute('r')), 3.4, 'circle keeps its original screen radius');
  assertEncloses(polygon, platform.corners.map(point => project(point).map((value, axis) => (value - origin[axis]) * scale)), 'high-zoom marker encloses every supplied platform corner');
  const label = groups[1].children.find(node => node.tagName === 'text');
  assert.ok(Math.abs(Number(label.getAttribute('x')) + label.getBBox().width + 18) < .01, 'Shijiazhuang label right edge stays exactly 18px to the left of its anchor');
  assert.equal(JSON.stringify(route), before, 'renderer preserves route and separated GNSS samples');
  env.nodes.get('map-reset').onclick(); env.flush();
  assert.equal(groups[1].getAttribute('transform'), initialCircle);

  // The full platform rectangle affects the initial fit even when the GNSS
  // route itself is one isolated point and provides no useful extent.
  const broad = platformAt(center, 4500, 400, Math.PI / 4);
  const fitted = await mount({id: 'extent-fixture', coordinateSystem: 'WGS84', segments: [[center]], stations: [{name: '大站', lon: center[0], lat: center[1], platform: broad}]});
  const fittedGroup = classed(fitted.root, 'map-station')[0];
  const translation = numbers(fittedGroup.getAttribute('transform'));
  for (const [x, y] of vertices(classed(fitted.root, 'map-station-platform')[0])) {
    assert.ok(x + translation[0] >= 0 && x + translation[0] <= 1100 && y + translation[1] >= 0 && y + translation[1] <= 600, 'fit includes the whole station footprint');
  }

  const fixtureRecord = {id: route.id, origin: '德州东', destination: '石家庄'};
  const network = build([fixtureRecord], [route], {includeIntermediateStations: true});
  assert.deepEqual(network.stations[0].platform, platform, 'network and collection aggregation preserve the footprint');
  assert.equal(Object.hasOwn(network.stations[1], 'platform'), false, 'aggregation keeps sparse stations as circles');
  const overview = await mount(network, {labelPlacement: 'auto'});
  assert.equal(classed(overview.root, 'map-station-platform').length, 1);
  assert.equal(classed(overview.root, 'map-station-point').length, 1);

  const recordsRoot = path.join(__dirname, '../records');
  const routes = fs.readdirSync(recordsRoot).filter(name => name.endsWith('.route.json')).map(name => JSON.parse(fs.readFileSync(path.join(recordsRoot, name), 'utf8')));
  const footprints = JSON.parse(fs.readFileSync(path.join(__dirname, 'station_footprints.json'), 'utf8'));
  const sparse = new Set(Object.keys(footprints.pointStations));
  const seen = new Set();
  for (const route of routes) for (const station of route.stations) {
    seen.add(station.name);
    const exception = footprints.recordExceptions?.[route.id];
    if (exception?.status === 'exempt' && exception.scope === 'record' && exception.stations.includes(station.name)) continue;
    assert.ok(sparse.has(station.name) || Object.hasOwn(footprints.stations, station.name), `${station.name}: new stations must have a reviewed footprint or a documented point decision`);
    assert.equal(Boolean(station.platform), !sparse.has(station.name), `${station.name}: uses the selected station geometry policy`);
    if (station.platform) assert.ok([4, 5].includes(station.platform.corners.length));
  }
  assert.equal(seen.size, 96);

  // The display boundary uses clearance from the outer arrival/departure track,
  // keeping the source platform extent and longitudinal endpoints unchanged.
  assert.equal(footprints.arrivalClearanceM, 20, 'station clearance is measured from the outer arrival/departure tracks');
  assert.deepEqual(Object.keys(footprints.recordExceptions), ['261105164159'], 'the S206 exemption applies only to this run');
  const jingzhang = routes.find(route => route.id === '261105122850');
  assert.equal(jingzhang.stations.filter(station => station.platform).length, 5, 'all five G7883 stations use reviewed rectangles');
  assert.deepEqual(footprints.stations['昌平'].railWayIds, [787858184, 787858186, 1132067956, 1132067957], 'Changping uses direct platform-facing tracks, excluding freight sidings and the non-platform main pair');
  assert.deepEqual(footprints.stations['沙河'].railWayIds, [787919273], 'Shahe uses the track adjoining its mapped side platform');
  assert.equal(footprints.stations['北京北'].osmPlatforms.length, 6, 'Beijingbei includes all six national-rail platforms');
  assert.equal(footprints.stations['清河'].osmPlatforms.length, 4, 'Qinghe excludes subway platforms');
  const xuzhou = footprints.stations['徐州东'];
  assert.equal(xuzhou.osmPlatforms.includes('way/1455925727'), false, 'Xuzhou East excludes the underground metro platform');
  const xuzhouArrivalTracks = new Map(xuzhou.arrivalTracks.map(track => [track.wayId, track]));
  for (const [yard, outerTracks] of [['京沪场', [675279284, 675216538]], ['徐兰场', [818445933, 818445920]]]) {
    for (const wayId of outerTracks) {
      const track = xuzhouArrivalTracks.get(wayId);
      assert.ok(track, `Xuzhou East ${yard} includes outer arrival track ${wayId}`);
      assert.equal(track.tags.railway, 'rail', `Xuzhou East ${yard} outer track ${wayId} is national railway geometry`);
      assert.equal(track.tags.service, 'siding', `Xuzhou East ${yard} outer track ${wayId} is an arrival/departure siding`);
    }
  }
  const cangzhou = routes.find(route => route.id === '261021131636');
  const trip = JSON.parse(fs.readFileSync(path.join(recordsRoot, `${cangzhou.id}.json`), 'utf8'));
  const stop = trip.events.find(event => event.id === 'stop-9' && event.name === '沧州西');
  const samples = cangzhou.segments.flat().filter(point => point[2] >= stop.start && point[2] <= stop.end);
  const cangzhouStation = cangzhou.stations.find(station => station.name === '沧州西');
  const cangzhouFootprint = footprints.stations['沧州西'];
  assert.equal(samples.length, 486, 'Cangzhou regression uses all recorded outer-platform stop samples');
  assert.ok(samples.some(point => !insideGeographicRectangle(point, cangzhouFootprint.platformCorners)), 'the raw platform envelope reproduces the reported stop outside its boundary');
  assert.ok(samples.every(point => insideGeographicRectangle(point, cangzhouStation.platform.corners)), 'display envelope includes all 486 Cangzhou stop samples');
  let stationsWithArrivalTracks = 0, stationsWithoutArrivalTracks = 0;
  for (const [name, footprint] of Object.entries(footprints.stations)) {
    const originalCenter = geographicCenter(footprint.platformCorners);
    for (const axis of [0, 1]) {
      assert.ok(Math.abs(originalCenter[axis] - footprint.center[axis]) < 1e-8, `${name}: source envelope retains its center`);
    }
    assert.ok(footprint.platformCorners.every(point => insideGeographicRectangle(point, footprint.corners)), `${name}: displayed rectangle retains all original platform corners`);
    const {coordinate, extent} = footprintFrame(footprint);
    const [originalAlong, originalAcross] = extent(footprint.platformCorners);
    const [displayAlong, displayAcross] = extent(footprint.corners);
    assert.ok(Math.abs(originalAlong[1] - originalAlong[0] - footprint.platformLengthM) < .02, `${name}: longitudinal axis follows the actual platform long edge`);
    assert.ok(Math.abs(originalAcross[1] - originalAcross[0] - footprint.platformWidthM) < .02, `${name}: platform width uses the transverse axis`);
    for (const end of [0, 1]) assert.ok(Math.abs(displayAlong[end] - originalAlong[end]) < .05, `${name}: track clearance does not extend the longitudinal platform boundary`);
    if (footprint.arrivalTracks.length) {
      stationsWithArrivalTracks++;
      const tracks = footprint.arrivalTracks.flatMap(track => track.coordinates).map(coordinate);
      assert.ok(tracks.length >= 2, `${name}: arrival-track clearance has actual geometry evidence`);
      assert.ok(tracks.every(point => point[0] >= originalAlong[0] - .05 && point[0] <= originalAlong[1] + .05), `${name}: only the platform-length portion of arrival tracks determines lateral clearance`);
      const outer = [Math.min(...tracks.map(point => point[1])), Math.max(...tracks.map(point => point[1]))];
      assert.ok(outer[0] - displayAcross[0] >= 19.95 && displayAcross[1] - outer[1] >= 19.95, `${name}: both lateral boundaries clear the outer arrival tracks by at least 20m`);
      const expected = [Math.min(originalAcross[0], outer[0] - 20), Math.max(originalAcross[1], outer[1] + 20)];
      for (const side of [0, 1]) assert.ok(Math.abs(displayAcross[side] - expected[side]) < .05, `${name}: adds only the clearance needed beyond the original platform extent`);
    } else {
      stationsWithoutArrivalTracks++;
      assert.deepEqual(footprint.corners, footprint.platformCorners, `${name}: no arrival-track geometry means no automatic 20m expansion`);
    }
  }
  assert.ok(stationsWithArrivalTracks > 0, 'real data exercises the arrival-track clearance policy');
  const lumiaoTracks = new Set(footprints.stations['芦庙'].arrivalTracks.map(track => track.wayId));
  assert.ok(lumiaoTracks.has(1041360060) && lumiaoTracks.has(1041360061), 'Lumiao includes both known arrival tracks even when platformCorners starts with the short edge');
  for (const route of routes) for (const station of route.stations) {
    if (station.platform) {
      const footprint = footprints.stations[station.name];
      const center = footprint.center;
      assert.deepEqual(station.platform.corners, footprint.corners, `${station.name}: generated routes use the reviewed arrival-track boundary`);
      assert.equal(station.lon, Number(center[0].toFixed(7)), `${station.name}: route longitude remains at the unpadded center`);
      assert.equal(station.lat, Number(center[1].toFixed(7)), `${station.name}: route latitude remains at the unpadded center`);
    }
  }
  const originalCircles = {
    '260930090532': [['寿县', 116.8006794, 32.5947452], ['颍上北', 116.2061142, 32.6816679], ['衡水南', 115.6336712, 37.6978378], ['任丘西', 116.0217947, 38.7037908], ['广安门', 116.3382711, 39.8802331]],
    '261010211508': [['永乐', 116.7887112, 39.6529799]],
    '261012141302': [['永乐', 116.7881691, 39.653455]],
    '261017113104': [['永乐', 116.7892581, 39.6524566]],
    '261018184017': [['永乐', 116.7887907, 39.6529622]]
  };
  for (const route of routes) {
    if (route.id >= '261105000000') continue; // Later records have no pre-padding baseline.
    assert.deepEqual(route.stations.filter(station => !station.platform).map(station => [station.name, station.lon, station.lat]), originalCircles[route.id] || [], `${route.id}: arrival-track clearance leaves all original circles unchanged`);
  }
  const realRecords = JSON.parse(fs.readFileSync(path.join(recordsRoot, 'index.json'), 'utf8'));
  const realOverview = build(realRecords, routes);
  for (const fixture of [{name: 'trip', route: cangzhou}, {name: 'overview', route: realOverview, options: {labelPlacement: 'auto'}}]) {
    const actual = await mount(fixture.route, fixture.options);
    const group = classed(actual.root, 'map-station').find(node => node.children.some(child => child.tagName === 'text' && child.textContent === '石家庄'));
    assert.ok(group.children.some(node => (node.getAttribute('class') || '').includes('map-station-platform')), `${fixture.name}: real Shijiazhuang fixture uses its rectangle`);
    const text = group.children.find(node => node.tagName === 'text');
    for (const zoom of [.25, 1, 256]) {
      actual.nodes.get('map-reset').onclick(); actual.flush();
      const button = zoom < 1 ? 'map-zoom-out' : 'map-zoom-in';
      for (let index = 0; index < (zoom < 1 ? 4 : zoom > 1 ? 20 : 0); index++) actual.nodes.get(button).onclick();
      actual.flush();
      assert.equal(actual.instance.getState().zoom, zoom);
      for (const [width, height] of [[1100, 600], [420, 480]]) {
        actual.resize(width, height); actual.flush();
        const bounds = text.getBBox();
        const right = Number(text.getAttribute('x')) + bounds.x + bounds.width;
        const middle = Number(text.getAttribute('y')) + bounds.y + bounds.height / 2;
        assert.ok(Math.abs(right + 18) < .01, `${fixture.name}: Shijiazhuang right edge is 18px left of anchor at zoom ${zoom}, width ${width}`);
        assert.ok(Math.abs(middle) < .01, `${fixture.name}: Shijiazhuang stays horizontally left of anchor at zoom ${zoom}, width ${width}`);
      }
    }
  }
  console.log(`Station footprint checks passed: visibility, zoom, coverage, initial fit, aggregation, ${seen.size} station policies, outer-track clearance at ${stationsWithArrivalTracks} stations, original platform extent at ${stationsWithoutArrivalTracks} stations, all 486 Cangzhou samples and unchanged anchor centers/circles.`);
})().catch(error => {console.error(error); process.exitCode = 1;});
