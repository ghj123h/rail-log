"use strict";
(() => {
  const TIERS = [
    {min: 0, max: 200, label: '< 200', color: '#7c8db5'},
    {min: 200, max: 250, label: '200–250', color: '#3fc1c9'},
    {min: 250, max: 300, label: '250–300', color: '#9be564'},
    {min: 300, max: 340, label: '300–340', color: '#ffd166'},
    {min: 340, max: Infinity, label: '≥ 340', color: '#ff5c8a'}
  ];

  const dateFmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const timeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  function tierIndex(v) {
    if (!Number.isFinite(v) || v < 0) return 0;
    const index = TIERS.findIndex(tier => v < tier.max);
    return index === -1 ? TIERS.length - 1 : index;
  }

  function tierColor(v) {
    return TIERS[tierIndex(v)].color;
  }

  function date(t) {
    return dateFmt.format(t);
  }

  function time(t) {
    return timeFmt.format(t);
  }

  function span(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    if (total < 60) return `${total} 秒`;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (!hours) return `${minutes}:${String(seconds).padStart(2, '0')}`;
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function speed(v) {
    return Number(v).toFixed(1);
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  async function getJSON(url, message) {
    const response = await fetch(url, {cache: 'no-cache'});
    if (!response.ok) throw new Error(message || `无法读取 ${url}`);
    return response.json();
  }

  function gapLimit(trip) {
    return 1.5 * (trip.sampleIntervalMs || 1000);
  }

  function distanceInRange(samples, start, end, limit) {
    if (!samples || samples.length < 2 || end <= start) return 0;
    let km = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      const dt = b.t - a.t;
      if (dt <= 0 || dt > limit) continue;
      const lo = Math.max(a.t, start);
      const hi = Math.min(b.t, end);
      if (hi > lo) {
        const va = a.v + (b.v - a.v) * ((lo - a.t) / dt);
        const vb = a.v + (b.v - a.v) * ((hi - a.t) / dt);
        km += ((va + vb) / 2) * (hi - lo) / 3600000;
      }
    }
    return km;
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function stats(trip) {
    const samples = trip.samples || [];
    const limit = gapLimit(trip);
    let peak = {v: 0, t: trip.logStart ?? 0};
    if (samples.length) {
      peak = {v: samples[0].v, t: samples[0].t};
      for (let i = 1; i < samples.length; i++) {
        if (samples[i].v > peak.v) peak = {v: samples[i].v, t: samples[i].t};
      }
    }
    let distanceKm = 0;
    const tierMs = [0, 0, 0, 0, 0];
    const gaps = [];
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      const dt = b.t - a.t;
      if (dt <= 0) continue;
      if (dt > limit) {
        gaps.push([a.t, b.t]);
      } else {
        distanceKm += ((a.v + b.v) / 2) * dt / 3600000;
        tierMs[tierIndex(a.v)] += dt;
      }
    }
    const acc = samples.map(s => s.a).filter(Number.isFinite);
    return {
      peak,
      distanceKm,
      tierMs,
      medianAccuracy: median(acc),
      gaps,
      first: samples[0]?.t ?? trip.logStart,
      last: samples.at(-1)?.t ?? trip.logEnd
    };
  }

  function rangeMean(samples, start, end, interval = 1000) {
    const points = samples.filter(s => s.t >= start && s.t <= end);
    if (!points.length) return null;
    const step = interval || 1000;
    const limit = 1.5 * step;
    const incomplete = points[0].t - start > step
      || end - points.at(-1).t > step
      || points.some((s, i) => i > 0 && s.t - points[i - 1].t > limit);
    const mean = points.reduce((sum, s) => sum + s.v, 0) / points.length;
    return {mean, incomplete};
  }

  let gradSeq = 0;
  function sparkline(svg, samples, intervalMs = 1000) {
    const SVG = 'http://www.w3.org/2000/svg';
    svg.setAttribute('viewBox', '0 0 160 40');
    if (!samples || !samples.length) {
      svg.replaceChildren();
      return;
    }
    const width = 160;
    const padY = 3;
    const plotH = 34;
    const baseY = padY + plotH;
    const speedMax = Math.max(50, Math.ceil(samples.reduce((m, s) => Math.max(m, s.v + (s.a || 0)), 0) / 50) * 50);
    const bucketCount = 120;
    const t0 = samples[0].t;
    const t1 = samples.at(-1).t;
    const totalMs = Math.max(1, t1 - t0);
    const limit = 1.5 * (intervalMs || 1000);
    const buckets = new Array(bucketCount).fill(null);

    let runId = 0;
    for (let i = 0; i < samples.length; i++) {
      if (i > 0 && samples[i].t - samples[i - 1].t > limit) runId++;
      const idx = Math.min(bucketCount - 1, Math.floor(((samples[i].t - t0) / totalMs) * bucketCount));
      const b = buckets[idx];
      if (!b) {
        buckets[idx] = {vMax: samples[i].v, runStart: runId, runEnd: runId};
      } else {
        if (samples[i].v > b.vMax) b.vMax = samples[i].v;
        b.runEnd = runId;
      }
    }

    const parts = [];
    let activeRun = -1;
    let runPoints = [];
    const flushRun = () => {
      if (!runPoints.length) return;
      if (runPoints.length === 1) {
        const [x, y] = runPoints[0];
        parts.push(`M${Math.max(0, x - 0.8).toFixed(2)},${y.toFixed(2)}L${Math.min(width, x + 0.8).toFixed(2)},${y.toFixed(2)}`);
      } else {
        parts.push(runPoints.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(''));
      }
      runPoints = [];
    };

    for (let i = 0; i < bucketCount; i++) {
      const b = buckets[i];
      if (!b) {
        flushRun();
        activeRun = -1;
        continue;
      }
      if (activeRun !== -1 && b.runStart !== activeRun) {
        flushRun();
      }
      const x = ((i + 0.5) / bucketCount) * width;
      const y = padY + plotH * (1 - Math.max(0, Math.min(1, b.vMax / speedMax)));
      runPoints.push([x, y]);
      activeRun = b.runEnd;
    }
    flushRun();

    const gradId = `rl-sg-${++gradSeq}`;
    const defs = document.createElementNS(SVG, 'defs');
    const grad = document.createElementNS(SVG, 'linearGradient');
    grad.setAttribute('id', gradId);
    grad.setAttribute('x1', '0');
    grad.setAttribute('y1', String(baseY));
    grad.setAttribute('x2', '0');
    grad.setAttribute('y2', String(padY));
    grad.setAttribute('gradientUnits', 'userSpaceOnUse');

    for (const tier of TIERS) {
      const startOff = Math.min(1, tier.min / speedMax);
      const endOff = Math.min(1, tier.max / speedMax);
      if (endOff <= startOff) continue;
      const s1 = document.createElementNS(SVG, 'stop');
      s1.setAttribute('offset', startOff.toFixed(4));
      s1.setAttribute('stop-color', tier.color);
      const s2 = document.createElementNS(SVG, 'stop');
      s2.setAttribute('offset', endOff.toFixed(4));
      s2.setAttribute('stop-color', tier.color);
      grad.append(s1, s2);
    }
    defs.append(grad);

    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', parts.join(''));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', `url(#${gradId})`);
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');

    svg.replaceChildren(defs, path);
  }

  function cardHtml(record) {
    const startDate = date(record.start);
    const endDate = date(record.end);
    const crossDate = startDate !== endDate;
    const endText = `${crossDate ? `${endDate} ` : ''}${time(record.end)}`;
    const originHtml = record.origin
      ? `<span>${escapeHtml(record.origin)}</span>`
      : '<span class="origin-unknown" title="起点未录入">…</span>';
    const badges = [
      record.partial ? '<span class="tag tag-partial">部分记录</span>' : '',
      record.beta === true ? '<span class="tag tag-beta">Beta</span>' : ''
    ].filter(Boolean).join('');
    const search = `${record.train} ${record.origin || ''} ${record.destination} ${startDate}`.toLowerCase();

    return `<a class="run-card" href="viewer.html?id=${encodeURIComponent(record.id)}" data-id="${escapeHtml(record.id)}" data-search="${escapeHtml(search)}">
      <div class="run-card-top">
        <time class="run-card-date" datetime="${startDate}">${startDate}</time>
        ${badges ? `<span class="badge-row">${badges}</span>` : ''}
      </div>
      <div class="run-card-main">
        <strong class="run-train">${escapeHtml(record.train)}</strong>
        <span class="run-route">${originHtml}<span class="route-arrow" aria-hidden="true">→</span><span>${escapeHtml(record.destination)}</span></span>
      </div>
      <svg class="spark" viewBox="0 0 160 40" aria-hidden="true"></svg>
      <div class="run-card-stats">
        <span>${time(record.start)}–${endText}</span>
        <span>${span(record.end - record.start)}</span>
      </div>
      <div class="run-card-sub">
        <span class="run-peak">峰值加载中…</span>
        <span class="run-dist"></span>
        <span>${record.sampleCount.toLocaleString('zh-CN')} 点</span>
      </div>
    </a>`;
  }

  const tripCache = new Map();
  function lazyCards(container) {
    const cards = [...container.querySelectorAll('.run-card[data-id]')];
    if (!cards.length) return;
    const queue = [];
    const queuedIds = new Set();
    let active = 0;

    function applyCard(card, trip) {
      const svg = card.querySelector('.spark');
      const peakEl = card.querySelector('.run-peak');
      const distEl = card.querySelector('.run-dist');
      if (!trip || !Array.isArray(trip.samples) || !trip.samples.length) {
        if (peakEl) peakEl.textContent = '—';
        return;
      }
      if (svg) sparkline(svg, trip.samples, trip.sampleIntervalMs);
      const st = stats(trip);
      const displayPeak = Number(speed(st.peak.v));
      if (peakEl) {
        peakEl.innerHTML = `峰值 <strong style="color:${tierColor(displayPeak)}">${speed(st.peak.v)}</strong> km/h`;
      }
      if (distEl) {
        distEl.textContent = `≈ ${st.distanceKm.toFixed(1)} km`;
      }
    }

    function pump() {
      while (active < 3 && queue.length) {
        const card = queue.shift();
        const id = card.dataset.id;
        if (tripCache.has(id)) {
          applyCard(card, tripCache.get(id));
          continue;
        }
        active++;
        getJSON(`records/${encodeURIComponent(id)}.json`)
          .then(trip => {
            tripCache.set(id, trip);
            applyCard(card, trip);
          })
          .catch(() => {
            const peakEl = card.querySelector('.run-peak');
            if (peakEl) peakEl.textContent = '—';
          })
          .finally(() => {
            active--;
            pump();
          });
      }
    }

    const enqueue = card => {
      const id = card.dataset.id;
      if (tripCache.has(id)) {
        applyCard(card, tripCache.get(id));
        return;
      }
      if (queuedIds.has(id)) return;
      queuedIds.add(id);
      queue.push(card);
      pump();
    };

    if (typeof IntersectionObserver === 'function') {
      const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          enqueue(entry.target);
        }
      }, {rootMargin: '300px'});
      cards.forEach(card => observer.observe(card));
    } else {
      cards.forEach(enqueue);
    }
  }

  window.RL = {
    TIERS,
    tierIndex,
    tierColor,
    date,
    time,
    span,
    speed,
    escapeHtml,
    getJSON,
    gapLimit,
    distanceInRange,
    stats,
    rangeMean,
    sparkline,
    cardHtml,
    lazyCards
  };
})();
