"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Mount the shared component, so this checks the paths used by both detail
// pages and the network map without exporting a separate test implementation.
class Node {
  constructor(tagName = 'div') {
    Object.assign(this, {tagName, attributes: {}, children: [], dataset: {},
      style: {}, textContent: '', clientWidth: 1100, clientHeight: 600});
    this.classList = {add() {}, remove() {}};
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener() {}
  getBBox() { return {x: 0, y: -11, width: this.textContent.length * 13, height: 16}; }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const component = fs.readFileSync(path.join(__dirname, '../assets/route-map.js'), 'utf8');
const serialized = ([lon, lat]) => [lon * Math.PI / 180,
  -Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))].map(value => value.toFixed(9)).join(',');

async function renderedSubpaths(route) {
  const before = JSON.stringify(route);
  const nodes = new Map(['route-map', 'map-message', 'map-zoom-in', 'map-zoom-out', 'map-reset']
    .map(id => [id, new Node()]));
  const context = vm.createContext({
    window: {ROUTE_BASEMAP: {features: []}, ROUTE_RIVERS: {features: []}},
    document: {getElementById: id => nodes.get(id), createElementNS: (_, tag) => new Node(tag)},
    ResizeObserver: class {observe() {}},
    requestAnimationFrame() {}
  });
  vm.runInContext(component, context);
  assert.ok(await context.window.RailRouteMap.mount({id: route.id, title: 'Path regression', routeMap: route}),
    nodes.get('map-message').textContent || 'map mounted');
  assert.equal(JSON.stringify(route), before, 'rendering leaves measured data unchanged');
  const track = walk(nodes.get('route-map')).find(node => node.getAttribute('class') === 'map-track');
  assert.ok(track, 'the shared map creates a track path');
  const commands = [...track.getAttribute('d').matchAll(/([ML])(-?\d+\.\d+,-?\d+\.\d+)/g)];
  assert.equal(commands.map(match => match[0]).join(''), track.getAttribute('d'), 'parse the complete track');
  const subpaths = [];
  for (const [, command, coordinate] of commands) {
    if (command === 'M') subpaths.push([]);
    assert.ok(subpaths.length, 'each subpath starts with M');
    const points = subpaths.at(-1);
    if (command === 'L') assert.notEqual(coordinate, points.at(-1), 'no zero-length L command');
    points.push(coordinate);
  }
  assert.equal(subpaths.length, route.segments.length, 'retain an M for every measured segment, including gaps');
  return subpaths;
}

(async () => {
  const fixture = {
    id: 'path-regression', coordinateSystem: 'WGS84',
    stations: [{name: 'Start', lon: 117.1, lat: 39.1}],
    segments: [
      [[117.1, 39.1], [117.1, 39.1], [117.2, 39.1], [117.2, 39.1], [117.1, 39.1]],
      [[0, 0], [1e-9, 0], [.000001, 0]],
      Array.from({length: 12}, () => [117.1573401, 39.1571162]),
      [[114, 38], [115, 39], [116, 40]]
    ]
  };
  assert.equal(serialized(fixture.segments[1][0]), serialized(fixture.segments[1][1]),
    'fixture includes distinct coordinates that become equal at SVG precision');
  assert.deepEqual(await renderedSubpaths(fixture), [
    [serialized([117.1, 39.1]), serialized([117.2, 39.1]), serialized([117.1, 39.1])],
    ['0.000000000,0.000000000', '0.000000017,0.000000000'],
    [serialized([117.1573401, 39.1571162])],
    fixture.segments[3].map(serialized)
  ], 'retain subsequent movement, returns, normal geometry, and zero-length segments as M only');

  const real = JSON.parse(fs.readFileSync(path.join(__dirname, '../records/261021131636.route.json'), 'utf8'));
  const subpaths = await renderedSubpaths(real);
  for (let index = 0; index < real.segments.length; index++) {
    const original = real.segments[index].map(serialized);
    const drawn = subpaths[index];
    assert.equal(drawn[0], original[0], `G3681 segment ${index}: keep start`);
    assert.equal(drawn.at(-1), original.at(-1), `G3681 segment ${index}: keep end`);
    const changes = original.filter((point, i) => !i || point !== original[i - 1]);
    assert.deepEqual(drawn, changes, `G3681 segment ${index}: preserve all nonzero edges in order`);
  }
  const stationary = real.segments.map((segment, index) => ({segment, index}))
    .filter(({segment}) => segment.length > 1 && new Set(segment.map(serialized)).size === 1);
  for (const {index} of stationary) assert.equal(subpaths[index].length, 1, 'stationary subpaths contain only M');
  console.log(`Route path checks passed: rounding/repeated-point fixtures and G3681 (${real.segments.length} segments, ${stationary.length} stationary subpaths).`);
})().catch(error => { console.error(error); process.exitCode = 1; });
