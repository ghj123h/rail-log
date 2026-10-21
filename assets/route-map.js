"use strict";
(() => {
  const SVG = 'http://www.w3.org/2000/svg';
  const project = ([lon, lat]) => [lon * Math.PI / 180, -Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
  function element(name, attributes = {}) {
    const node = document.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  }
  async function readJson(url, message, options) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(message);
    return response.json();
  }
  function lines(geometry) {
    if (geometry.type === 'LineString') return [geometry.coordinates];
    if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') return geometry.coordinates;
    if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
    return [];
  }
  function pathData(coordinates) {
    return coordinates.map((point, index) => {
      const [x, y] = project(point);
      return `${index ? 'L' : 'M'}${x.toFixed(9)},${y.toFixed(9)}`;
    }).join('');
  }
  function nearestTrack(point, segments) {
    let nearest, offset = 0;
    for (const segment of segments) {
      for (let index = 0; index + 1 < segment.length; index++) {
        const a = segment[index], b = segment[index + 1];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const lengthSquared = dx * dx + dy * dy;
        if (!lengthSquared) continue;
        const fraction = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
        const closest = [a[0] + dx * fraction, a[1] + dy * fraction];
        const distance = Math.hypot(point[0] - closest[0], point[1] - closest[1]);
        if (!nearest || distance < nearest.distance) nearest = {index: offset + index, point: closest, distance};
      }
      offset += segment.length;
    }
    return nearest;
  }
  function localDirection(points, anchor, radius) {
    function sample(step) {
      let end = anchor.point;
      for (let index = anchor.index + (step > 0 ? 1 : 0); index >= 0 && index < points.length; index += step) {
        end = points[index];
        const dx = end[0] - anchor.point[0], dy = end[1] - anchor.point[1];
        const distance = Math.hypot(dx, dy);
        // Measure net displacement, so stationary GNSS drift cannot consume the window.
        if (distance >= radius) {
          return [anchor.point[0] + dx * radius / distance, anchor.point[1] + dy * radius / distance];
        }
      }
      return end;
    }
    const before = sample(-1), after = sample(1);
    return [after[0] - before[0], after[1] - before[1]];
  }
  function labelNormal(station, track, stationPoints, scale, side) {
    if (station.label.textContent === '石家庄') return [-1, 0];
    const meter = 1 / (6371000 * Math.cos(station.latitude * Math.PI / 180));
    const radius = Math.max(16 / scale, 300 * meter);
    const anchor = station.track;
    // Points across GNSS gaps help estimate direction only; the drawn paths stay separate.
    let direction = anchor && anchor.distance <= Math.max(radius, 1000 * meter)
      ? localDirection(track, anchor, radius) : [0, 0];
    if (Math.hypot(...direction) < radius / 2) {
      direction = localDirection(stationPoints, {point: station.point, index: station.index}, radius);
    }
    const length = Math.hypot(...direction);
    return length ? [-side * direction[1] / length, side * direction[0] / length] : [1, 0];
  }
  function labelOffset(normal, bounds, gap = 9) {
    // Anchor the near edge/corner, blending toward centered alignment near either axis.
    return normal.map((value, axis) => gap * value + [bounds.width, bounds.height][axis] / 2 * Math.max(-1, Math.min(1, value / .35)));
  }
  function placeOverviewLabels(stations, screen, width, height) {
    const placed = [];
    const points = stations.map(station => screen(station.point));
    const spacing = points.map((point, index) => points.reduce((nearest, other, otherIndex) => otherIndex === index ? nearest
      : Math.min(nearest, (point[0] - other[0]) ** 2 + (point[1] - other[1]) ** 2), Infinity));
    const order = stations.map((station, index) => index).sort((a, b) => spacing[a] - spacing[b] || a - b);
    const area = (a, b, padding = 0) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]) + padding)
      * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]) + padding);
    // Reserve positions for dense clusters before placing isolated stations.
    for (const index of order) {
      const station = stations[index];
      const {bounds, label} = station, [x, y] = points[index];
      const horizontal = bounds.width / 2 + (label.textContent === '石家庄' ? 18 : 9), vertical = bounds.height / 2 + 9;
      const candidates = label.textContent === '石家庄' ? [[-horizontal, 0]] : [[horizontal, -vertical], [horizontal, vertical], [-horizontal, -vertical], [-horizontal, vertical],
        [0, -vertical], [0, vertical], [horizontal, 0], [-horizontal, 0]];
      let best, score = Infinity;
      for (const [dx, dy] of candidates) {
        const box = [x + dx - bounds.width / 2, y + dy - bounds.height / 2, x + dx + bounds.width / 2, y + dy + bounds.height / 2];
        const outside = bounds.width * bounds.height - area(box, [0, 0, width, height]);
        const overlaps = placed.reduce((sum, other) => sum + area(box, other, 4), 0);
        const markers = points.reduce((sum, point) => sum + area(box, [point[0] - 5, point[1] - 5, point[0] + 5, point[1] + 5]), 0);
        const cost = outside * 10 + markers * 10 + overlaps;
        if (cost < score) { best = {dx, dy, box}; score = cost; }
        if (!cost) break;
      }
      label.setAttribute('x', best.dx - bounds.x - bounds.width / 2);
      label.setAttribute('y', best.dy - bounds.y - bounds.height / 2);
      placed.push(best.box);
    }
  }
  window.RailRouteMap = {
    async mount(trip, options = {}) {
      const container = document.getElementById('route-map');
      const message = document.getElementById('map-message');
      const overviewLabels = options.labelPlacement === 'auto';
      const followTrack = !overviewLabels;
      const buttons = ['map-zoom-in', 'map-zoom-out', 'map-reset'].map(id => document.getElementById(id));
      buttons.forEach(button => { button.disabled = true; });
      try {
        const [route, basemap, rivers] = await Promise.all([
          trip.routeMap || readJson(`records/${trip.id}.route.json`, '无法读取这条记录的线路图数据。', {cache: 'no-cache'}),
          window.ROUTE_BASEMAP || readJson('assets/maps/china-prefectures.geojson', '无法读取线路图底图。'),
          window.ROUTE_RIVERS || readJson('assets/maps/major-rivers.geojson?v=2', '无法读取线路图水道数据。')
        ]);
        if (route.id !== trip.id || route.coordinateSystem !== 'WGS84' || !route.stations.length || !route.segments.length) {
          throw new Error('线路图数据与当前记录不符。');
        }
        const stationCount = new Set(route.stations.map(station => station.name)).size;
        const svg = element('svg', {role: 'img', 'aria-label': options.accessibleLabel || `${trip.origin}至${trip.destination}的 GNSS 线路图，包含${stationCount}个车站。朱红色为运转轨迹，蓝色为黄河和长江。`});
        const title = element('title');
        title.textContent = `${trip.title} · 线路图`;
        svg.append(title);
        const geometry = element('g', {'aria-hidden': 'true', fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round'});
        for (const feature of basemap.features) {
          geometry.append(element('path', {
            d: lines(feature.geometry).map(pathData).join(''),
            class: feature.properties?.kind === 'provincial' ? 'map-provincial' : feature.properties?.kind === 'national' ? 'map-national' : 'map-administrative',
            'vector-effect': 'non-scaling-stroke'
          }));
        }
        for (const river of rivers.features) {
          const path = element('path', {
            d: lines(river.geometry).map(pathData).join(''), class: 'map-river', 'vector-effect': 'non-scaling-stroke'
          });
          const riverTitle = element('title');
          riverTitle.textContent = river.properties.name;
          path.append(riverTitle);
          geometry.append(path);
        }
        geometry.append(element('path', {
          d: route.segments.map(pathData).join(''), class: 'map-track', 'vector-effect': 'non-scaling-stroke'
        }));
        svg.append(geometry);
        const isolated = route.segments.filter(segment => segment.length === 1).map(segment => ({
          point: project(segment[0]), node: element('circle', {r: 1.5, class: 'map-isolated'})
        }));
        for (const item of isolated) svg.append(item.node);
        const projectedSegments = route.segments.map(segment => segment.map(project));
        const track = projectedSegments.flat();
        const stationPoints = route.stations.map(station => project([station.lon, station.lat]));
        const journey = [stationPoints.at(-1)[0] - stationPoints[0][0], stationPoints.at(-1)[1] - stationPoints[0][1]];
        // Pick one travel side for the whole route, rather than flipping individual normals.
        const side = journey[1] > 0 || (journey[1] === 0 && journey[0] > 0) ? -1 : 1;
        const namedStations = new Set();
        const stations = route.stations.flatMap((station, index) => {
          // Revisited stations share one marker; keep the full sequence for route direction.
          if (namedStations.has(station.name)) return [];
          namedStations.add(station.name);
          const group = element('g', {class: 'map-station'});
          const dot = element('circle', {r: 3.4});
          const label = element('text', {x: 0, y: 0, 'text-anchor': followTrack ? 'middle' : 'start'});
          label.textContent = station.name;
          group.append(dot, label);
          svg.append(group);
          return [{point: stationPoints[index], index, latitude: station.lat, track: followTrack ? nearestTrack(stationPoints[index], projectedSegments) : null, group, label}];
        });
        container.replaceChildren(svg);
        const coordinates = track.concat(stationPoints);
        const extent = coordinates.reduce((box, [x, y]) => [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
        const center = [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2];
        const span = [Math.max(.0003, extent[2] - extent[0]), Math.max(.0003, extent[3] - extent[1])];
        let width, height, fitScale, labelScale, zoom = 1, offset = [0, 0], frame;
        function screen(point) {
          const scale = fitScale * zoom;
          return [width / 2 + offset[0] + (point[0] - center[0]) * scale, height / 2 + offset[1] + (point[1] - center[1]) * scale];
        }
        function render() {
          const scale = fitScale * zoom;
          geometry.setAttribute('transform', `matrix(${scale} 0 0 ${scale} ${width / 2 + offset[0] - center[0] * scale} ${height / 2 + offset[1] - center[1] * scale})`);
          for (const station of stations) {
            const [x, y] = screen(station.point);
            station.group.setAttribute('transform', `translate(${x} ${y})`);
            if (followTrack && scale !== labelScale) {
              const normal = labelNormal(station, track, stationPoints, scale, side);
              const [dx, dy] = labelOffset(normal, station.bounds, station.label.textContent === '石家庄' ? 18 : 9);
              station.label.setAttribute('x', dx - station.bounds.x - station.bounds.width / 2);
              station.label.setAttribute('y', dy - station.bounds.y - station.bounds.height / 2);
            }
          }
          if (overviewLabels) placeOverviewLabels(stations, screen, width, height);
          labelScale = scale;
          for (const item of isolated) {
            const [x, y] = screen(item.point);
            item.node.setAttribute('cx', x);
            item.node.setAttribute('cy', y);
          }
          container.dataset.zoom = String(zoom);
        }
        function schedule() {
          if (!frame) frame = requestAnimationFrame(() => { frame = null; render(); });
        }
        function resize() {
          width = container.clientWidth;
          if (!width) return;
          for (const station of stations) if (!station.bounds) station.bounds = station.label.getBBox();
          const cssHeight = `${Math.ceil(width * span[1] / span[0])}px`;
          if (container.style.height !== cssHeight) container.style.height = cssHeight;
          height = container.clientHeight;
          fitScale = Math.min(Math.max(80, width - 144) / span[0], Math.max(80, height - 100) / span[1]);
          svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
          render();
        }
        function zoomAt(factor, anchor = [width / 2, height / 2]) {
          const next = Math.min(256, Math.max(.25, zoom * factor));
          const ratio = next / zoom;
          offset = [anchor[0] - width / 2 - (anchor[0] - width / 2 - offset[0]) * ratio, anchor[1] - height / 2 - (anchor[1] - height / 2 - offset[1]) * ratio];
          zoom = next;
          schedule();
        }
        function reset() { zoom = 1; offset = [0, 0]; schedule(); }
        function local(event) {
          const rect = container.getBoundingClientRect();
          return [event.clientX - rect.left, event.clientY - rect.top];
        }
        container.addEventListener('wheel', event => {
          event.preventDefault();
          zoomAt(Math.exp(-Math.max(-200, Math.min(200, event.deltaY)) * .004), local(event));
        }, {passive: false});
        const pointers = new Map();
        let gesture;
        function pointerState() {
          const positions = [...pointers.values()];
          return positions.length === 1 ? {center: positions[0], distance: 0} : {
            center: [(positions[0][0] + positions[1][0]) / 2, (positions[0][1] + positions[1][1]) / 2],
            distance: Math.hypot(positions[0][0] - positions[1][0], positions[0][1] - positions[1][1])
          };
        }
        container.addEventListener('pointerdown', event => {
          if (event.button !== 0) return;
          event.preventDefault();
          container.focus({preventScroll: true});
          container.setPointerCapture(event.pointerId);
          pointers.set(event.pointerId, local(event));
          gesture = pointerState();
          container.classList.add('is-dragging');
        });
        container.addEventListener('pointermove', event => {
          if (!pointers.has(event.pointerId)) return;
          pointers.set(event.pointerId, local(event));
          const next = pointerState();
          if (gesture.distance > 0 && next.distance > 0) zoomAt(next.distance / gesture.distance, gesture.center);
          offset[0] += next.center[0] - gesture.center[0];
          offset[1] += next.center[1] - gesture.center[1];
          gesture = next;
          schedule();
        });
        function release(event) {
          pointers.delete(event.pointerId);
          gesture = pointers.size ? pointerState() : null;
          if (!pointers.size) container.classList.remove('is-dragging');
        }
        container.addEventListener('pointerup', release);
        container.addEventListener('pointercancel', release);
        container.addEventListener('lostpointercapture', release);
        container.addEventListener('dblclick', reset);
        container.addEventListener('keydown', event => {
          if (event.key === '+' || event.key === '=') zoomAt(1.5);
          else if (event.key === '-') zoomAt(1 / 1.5);
          else if (event.key === 'Home' || event.key === '0') reset();
          else if (event.key.startsWith('Arrow')) {
            const change = {ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60]}[event.key];
            if (!change) return;
            offset = [offset[0] + change[0], offset[1] + change[1]];
            schedule();
          } else return;
          event.preventDefault();
        });
        buttons[0].onclick = () => zoomAt(1.5);
        buttons[1].onclick = () => zoomAt(1 / 1.5);
        buttons[2].onclick = reset;
        buttons.forEach(button => { button.disabled = false; });
        message.hidden = true;
        new ResizeObserver(resize).observe(container);
        resize();
        return {route, basemap, rivers, getState: () => ({zoom, offset: [...offset], stations: stations.length, segments: route.segments.length, width, height})};
      } catch (error) {
        message.hidden = false;
        message.textContent = error.message;
        return null;
      }
    }
  };
})();
