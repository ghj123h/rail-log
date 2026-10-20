"use strict";
window.RailNetworkMap = {
  instance: null,
  pending: null,
  init(records, {title = '总线路图', includeIntermediateStations = false} = {}) {
    this.title = title;
    this.includeIntermediateStations = includeIntermediateStations;
    const section = document.getElementById('network-map-section');
    document.getElementById('network-map-summary').textContent = `${records.length} 条记录`;
    section.addEventListener('toggle', () => {
      if (section.open) this.mount(records);
    });
    // The user may expand the section before the record catalog has loaded.
    if (section.open) this.mount(records);
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
        message.textContent = '还没有可显示的运行记录。';
        summary.textContent = '0 条记录';
        return null;
      }
      const routes = await Promise.all(records.map(async record => {
        const response = await fetch(`records/${record.id}.route.json`, {cache: 'no-cache'});
        if (!response.ok) throw new Error(`无法读取 ${record.train} 次的线路图，请刷新重试。`);
        return response.json();
      }));
      const route = window.RailNetworkData.build(records, routes, {includeIntermediateStations: this.includeIntermediateStations});
      const stationDescription = this.includeIntermediateStations ? '沿途' : '起止或交汇';
      const instance = await window.RailRouteMap.mount({id: 'network', title: this.title, routeMap: route}, {
        labelPlacement: 'auto',
        accessibleLabel: `${records.length} 条运行记录的${this.title}，标注 ${route.stations.length} 个${stationDescription}车站。朱红色为运转轨迹，蓝色为黄河和长江。`
      });
      if (instance) {
        this.instance = instance;
        summary.textContent = `${records.length} 条记录 · ${route.stations.length} 个车站`;
      }
      return instance;
    } catch (error) {
      message.hidden = false;
      message.textContent = this.title + '载入失败：' + error.message;
      return null;
    }
  }
};
