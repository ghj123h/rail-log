"use strict";
window.RailNetworkMap = {
  instance: null,
  pending: null,
  init(records, options = {}) {
    const {title = '总线路图', includeIntermediateStations = false, onReady = null} = options;
    if (!includeIntermediateStations) records = records.filter(record => record.railType !== 'conventional');
    this.title = title;
    this.includeIntermediateStations = includeIntermediateStations;
    this.onReady = onReady;
    const section = document.getElementById('network-map-section');
    const summary = document.getElementById('network-map-summary');
    if (summary) summary.textContent = `${records.length} 条记录`;
    if (section && 'open' in section) {
      section.addEventListener('toggle', () => {
        if (section.open) this.mount(records);
      });
      if (section.open) this.mount(records);
    } else if (section) {
      this.mount(records);
    }
  },
  mount(records) {
    if (this.instance) return Promise.resolve(this.instance);
    if (this.pending) return this.pending;
    this.pending = this.load(records).finally(() => { this.pending = null; });
    return this.pending;
  },
  async load(records) {
    const message = document.getElementById('map-message');
    const summary = document.getElementById('network-map-summary');
    try {
      if (!records.length) {
        if (message) {
          message.hidden = false;
          message.textContent = '暂无可供绘制的实测记录。';
        }
        if (summary) summary.textContent = '0 趟';
        return null;
      }
      const routes = await Promise.all(records.map(async record => {
        const response = await fetch(`records/${record.id}.route.json`, {cache: 'no-cache'});
        if (!response.ok) throw new Error(`未能载入 ${record.train} 次线路数据，请刷新后再试。`);
        return response.json();
      }));
      const route = window.RailNetworkData.build(records, routes, {includeIntermediateStations: this.includeIntermediateStations});
      const stationScope = this.includeIntermediateStations ? '沿途各站' : '起止与交汇站';
      const instance = await window.RailRouteMap.mount({id: 'network', title: this.title, routeMap: route}, {
        labelPlacement: 'auto',
        accessibleLabel: `${records.length} 趟运行实测汇总的${this.title}，共标注 ${route.stations.length} 座${stationScope}。琥珀色为 GNSS 实测轨迹，蓝色为黄河与长江。`
      });
      if (instance) {
        this.instance = instance;
        if (summary) summary.textContent = `${records.length} 趟 · ${route.stations.length} 站`;
        this.onReady?.(instance, route);
      }
      return instance;
    } catch (error) {
      if (message) {
        message.hidden = false;
        message.textContent = `${this.title}未能绘制：${error.message}`;
      }
      return null;
    }
  }
};
