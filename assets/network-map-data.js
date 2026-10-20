"use strict";
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RailNetworkData = api;
})(typeof window === 'object' ? window : null, () => {
  function fail(id, message) {
    throw new Error(`${id ? `${id}：` : ''}${message}`);
  }

  function validPosition(lon, lat) {
    return Number.isFinite(lon) && Number.isFinite(lat)
      && lon >= -180 && lon <= 180 && lat > -90 && lat < 90;
  }

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function representative(candidates) {
    const lon = median(candidates.map(station => station.lon));
    const lat = median(candidates.map(station => station.lat));
    const longitudeScale = Math.cos(lat * Math.PI / 180);
    const distance = station => ((station.lon - lon) * longitudeScale) ** 2 + (station.lat - lat) ** 2;
    // Keep one existing position, rather than introducing an interpolated station.
    return candidates.slice().sort((a, b) => distance(a) - distance(b) || a.lon - b.lon || a.lat - b.lat)[0];
  }

  function routeLookup(routes) {
    if (!Array.isArray(routes)) {
      if (!routes || typeof routes !== 'object') fail('', '缺少总线路图所需的线路数据。');
      return routes;
    }
    const lookup = Object.create(null);
    for (const route of routes) {
      if (!route || typeof route.id !== 'string' || Object.hasOwn(lookup, route.id)) {
        fail('', '线路数据缺少记录 ID 或包含重复记录。');
      }
      lookup[route.id] = route;
    }
    return lookup;
  }

  function build(records, routes, {includeIntermediateStations = false} = {}) {
    if (!Array.isArray(records)) fail('', '运行记录目录格式不正确。');
    const byId = routeLookup(routes);
    const seenRecords = new Set();
    const endpoints = new Set();
    const allStations = new Map();
    const segments = [];
    let pointCount = 0;

    for (const record of records) {
      const id = record?.id;
      if (typeof id !== 'string' || !id || seenRecords.has(id)) fail(id, '运行记录 ID 缺失或重复。');
      seenRecords.add(id);
      if (typeof record.origin !== 'string' || (!record.origin && record.partial !== true) || typeof record.destination !== 'string' || !record.destination) {
        fail(id, '运行记录缺少起止站。');
      }
      const route = Object.hasOwn(byId, id) && byId[id];
      if (!route) fail(id, '缺少线路图数据，无法完整绘制总线路图。');
      if (route.id !== id || route.coordinateSystem !== 'WGS84') fail(id, '线路图 ID 或坐标系统不正确。');
      if (!Array.isArray(route.stations) || !route.stations.length) fail(id, '线路图缺少沿途车站。');
      if ((record.origin && route.stations[0]?.name !== record.origin) || route.stations.at(-1)?.name !== record.destination) {
        fail(id, '线路图站序与记录起止站不一致。');
      }
      if (!Array.isArray(route.segments) || !route.segments.length) fail(id, '线路图缺少实测轨迹。');
      for (const segment of route.segments) {
        if (!Array.isArray(segment) || !segment.length || segment.some(point => !Array.isArray(point) || !validPosition(point[0], point[1]))) {
          fail(id, '线路图包含无效的实测轨迹段。');
        }
        // Each original segment remains separate, including isolated samples and gaps.
        segments.push(segment);
        pointCount += segment.length;
      }
      if (record.origin) endpoints.add(record.origin);
      endpoints.add(record.destination);
      for (const station of route.stations) {
        if (!station || typeof station.name !== 'string' || !station.name || !validPosition(station.lon, station.lat)) {
          fail(id, '线路图包含无效的车站。');
        }
        if (!allStations.has(station.name)) {
          allStations.set(station.name, {candidates: [], neighbors: new Set(), recordIds: new Set()});
        }
        const entry = allStations.get(station.name);
        entry.candidates.push(station);
        entry.recordIds.add(id);
      }
      // The published route files contain ALL along-line stations, including
      // non-stops. Do not use record.events (a sparse stopping/passing list).
      for (let index = 1; index < route.stations.length; index++) {
        const before = route.stations[index - 1].name;
        const after = route.stations[index].name;
        if (before === after) continue;
        allStations.get(before).neighbors.add(after);
        allStations.get(after).neighbors.add(before);
      }
    }

    const stations = [];
    for (const [name, entry] of allStations) {
      const endpoint = endpoints.has(name);
      const junction = entry.neighbors.size >= 3;
      if (!includeIntermediateStations && !endpoint && !junction) continue;
      const position = representative(entry.candidates);
      stations.push({
        name, lon: position.lon, lat: position.lat, endpoint, junction,
        neighbors: [...entry.neighbors], recordIds: [...entry.recordIds]
      });
    }

    return {
      id: 'network', coordinateSystem: 'WGS84', segments, stations,
      summary: {
        recordCount: records.length, segmentCount: segments.length, pointCount,
        stationCount: stations.length, endpointCount: endpoints.size,
        junctionCount: stations.filter(station => station.junction).length,
        junctions: stations.filter(station => station.junction).map(station => station.name)
      }
    };
  }

  return {build};
});
