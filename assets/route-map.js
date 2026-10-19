"use strict";
(() => {
  const SVG = 'http://www.w3.org/2000/svg';
  const project = ([lon, lat]) => [lon * Math.PI / 180, -Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
  function element(name, attributes = {}) {
    const node = document.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  }
  async function readJson(url, message) {
    const response = await fetch(url);
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
  window.RailRouteMap = {
    async mount(trip) {
      const container = document.getElementById('route-map');
      const message = document.getElementById('map-message');
      const buttons = ['map-zoom-in', 'map-zoom-out', 'map-reset'].map(id => document.getElementById(id));
      buttons.forEach(button => { button.disabled = true; });
      try {
        const [route, basemap, rivers] = await Promise.all([
          trip.routeMap || readJson(`records/${trip.id}.route.json`, '无法读取这条记录的线路图数据。'),
          window.ROUTE_BASEMAP || readJson('assets/maps/china-prefectures.geojson', '无法读取线路图底图。'),
          window.ROUTE_RIVERS || readJson('assets/maps/major-rivers.geojson?v=2', '无法读取线路图水道数据。')
        ]);
        if (route.id !== trip.id || route.coordinateSystem !== 'WGS84' || !route.stations.length || !route.segments.length) {
          throw new Error('线路图数据与当前记录不符。');
        }
        const svg = element('svg', {role: 'img', 'aria-label': `${trip.origin}至${trip.destination}的 GNSS 线路图，包含${route.stations.length}个车站。朱红色为运转轨迹，蓝色为黄河和长江。`});
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
        const stations = route.stations.map(station => {
          const group = element('g', {class: 'map-station'});
          const dot = element('circle', {r: 3.4});
          const label = element('text', {x: 7, y: -7});
          label.textContent = station.name;
          group.append(dot, label);
          svg.append(group);
          return {point: project([station.lon, station.lat]), group};
        });
        container.replaceChildren(svg);
        const coordinates = route.segments.flat().map(project).concat(stations.map(station => station.point));
        const extent = coordinates.reduce((box, [x, y]) => [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
        const center = [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2];
        const span = [Math.max(.0003, extent[2] - extent[0]), Math.max(.0003, extent[3] - extent[1])];
        let width, height, fitScale, zoom = 1, offset = [0, 0], frame;
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
          }
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
        return {route, basemap, rivers, getState: () => ({zoom, offset: [...offset], stations: route.stations.length, segments: route.segments.length, width, height})};
      } catch (error) {
        message.hidden = false;
        message.textContent = error.message;
        return null;
      }
    }
  };
})();
