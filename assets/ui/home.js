"use strict";
(() => {
  const $ = id => document.getElementById(id);

  function dateSpanText(records) {
    if (!records.length) return '—';
    const minT = Math.min(...records.map(r => r.start));
    const maxT = Math.max(...records.map(r => r.end));
    const first = RL.date(minT).replaceAll('-', '.');
    const last = RL.date(maxT).replaceAll('-', '.');
    return first === last ? first : `${first} — ${last}`;
  }

  function setupFilter(grid, records) {
    const input = $('run-search');
    const countEl = $('filter-count');
    const emptyEl = $('empty-filter');
    const total = records.length;

    const apply = () => {
      const q = (input?.value || '').toLowerCase().trim();
      let visible = 0;
      for (const card of grid.querySelectorAll('.run-card')) {
        const match = !q || (card.dataset.search || '').includes(q);
        card.hidden = !match;
        if (match) visible++;
      }
      if (countEl) countEl.textContent = `显示 ${visible} / ${total} 趟`;
      if (emptyEl) emptyEl.hidden = visible > 0 || total === 0;
    };

    if (input) input.addEventListener('input', apply);
    apply();
  }

  function renderCollectionCard(collection, allRecords) {
    const members = allRecords.filter(r => collection.recordIds.includes(r.id));
    const latest = members.slice().sort((a, b) => b.start - a.start)[0];
    const stations = [...new Set(members.flatMap(r => [r.origin, r.destination]).filter(Boolean))];
    const spanText = dateSpanText(members);
    const desc = collection.description ? `<p class="collection-card-desc">${RL.escapeHtml(collection.description)}</p>` : '';
    const latestHtml = latest
      ? `<span>最近 <strong>${RL.date(latest.start).replaceAll('-', '.')} ${RL.escapeHtml(latest.train)}</strong></span>`
      : '';

    return `<a class="collection-card" href="collection.html?id=${encodeURIComponent(collection.id)}">
      <div class="collection-card-body">
        <div class="collection-card-title">
          <h3>${RL.escapeHtml(collection.title)}</h3>
        </div>
        ${desc}
        <div class="collection-card-meta">
          <span><strong>${members.length}</strong> 趟实测</span>
          <span>跨度 <strong>${spanText}</strong></span>
          ${latestHtml}
        </div>
        ${stations.length ? `<div class="collection-card-stations">${stations.map(RL.escapeHtml).join(' · ')}</div>` : ''}
      </div>
      <span class="collection-cta">进入 <span aria-hidden="true">→</span></span>
    </a>`;
  }

  (async () => {
    const page = document.body.dataset.page;
    const [allRecords, collections] = await Promise.all([
      RL.getJSON('records/index.json', '未能载入全站记录清单。'),
      RL.getJSON('records/collections.json', '未能载入合集配置。')
    ]);

    if (page === 'collection') {
      const id = new URLSearchParams(location.search).get('id');
      const collection = collections.find(item => item.id === id);
      if (!collection) {
        const status = $('home-status');
        status.hidden = false;
        status.classList.add('is-error');
        status.innerHTML = '<span>没有这个合集。</span><a class="back-link" href="./">← 返回总览</a>';
        $('collection-view').hidden = true;
        return;
      }

      const navLink = document.querySelector(`.main-nav a[href="collection.html?id=${encodeURIComponent(collection.id)}"]`);
      if (navLink) navLink.setAttribute('aria-current', 'page');

      const members = allRecords.filter(r => collection.recordIds.includes(r.id));
      const totalSamples = members.reduce((sum, r) => sum + r.sampleCount, 0);

      document.title = `${collection.title} · 逐秒行车志`;
      $('collection-title').textContent = collection.title;
      const descEl = $('collection-desc');
      if (collection.description) {
        descEl.textContent = collection.description;
        descEl.hidden = false;
      }
      $('collection-metrics').innerHTML = [
        `<span><strong>${members.length}</strong>趟</span>`,
        `<span><strong>${dateSpanText(members)}</strong></span>`,
        `<span><strong>${totalSamples.toLocaleString('zh-CN')}</strong>个采样</span>`
      ].join('');
      $('network-map-title').textContent = `${collection.title}线路图`;

      const grid = $('run-grid');
      grid.innerHTML = members.map(RL.cardHtml).join('');
      $('collection-empty').hidden = members.length > 0;
      setupFilter(grid, members);
      RL.lazyCards(grid);

      window.RailNetworkMap.init(members, {
        title: `${collection.title}线路图`,
        includeIntermediateStations: true
      });
      return;
    }

    // Home page
    const totalSamples = allRecords.reduce((sum, r) => sum + r.sampleCount, 0);
    $('stat-runs').textContent = String(allRecords.length);
    $('stat-samples').textContent = totalSamples.toLocaleString('zh-CN');
    $('stat-span').textContent = dateSpanText(allRecords);
    $('stat-collections').textContent = String(collections.length);

    const collectedIds = new Set(collections.flatMap(c => c.recordIds));
    const otherRecords = allRecords.filter(r => !collectedIds.has(r.id));

    const colSection = $('collections-section');
    if (collections.length) {
      $('collections-list').innerHTML = collections.map(c => renderCollectionCard(c, allRecords)).join('');
      colSection.hidden = false;
    } else {
      colSection.hidden = true;
    }

    const grid = $('run-grid');
    grid.innerHTML = otherRecords.map(RL.cardHtml).join('');
    $('runs-empty').hidden = otherRecords.length > 0;
    setupFilter(grid, otherRecords);
    RL.lazyCards(grid);

    window.RailNetworkMap.init(allRecords, {title: '总线路图'});
  })().catch(error => {
    const status = $('home-status');
    status.hidden = false;
    status.classList.add('is-error');
    status.textContent = error.message || '页面载入失败，请稍后刷新。';
    const mapMsg = $('map-message');
    if (mapMsg) {
      mapMsg.hidden = false;
      mapMsg.textContent = '线路数据载入失败：' + (error.message || '未知错误');
    }
  });
})();
