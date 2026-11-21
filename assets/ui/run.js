"use strict";
(() => {
  const $ = id => document.getElementById(id);

  function showError(message) {
    const status = $('run-status');
    status.hidden = false;
    status.classList.add('is-error');
    status.innerHTML = `<span>${RL.escapeHtml(message)}</span><a class="back-link" href="./">← 返回总览</a>`;
    $('run-view').hidden = true;
  }

  (async () => {
    const id = new URLSearchParams(location.search).get('id');
    if (!id || !/^\d{12}$/.test(id)) {
      showError('请先从总览页面选择一条运转记录。');
      return;
    }

    const trip = await RL.getJSON(`records/${encodeURIComponent(id)}.json`, '没有找到这条运转记录，请返回总览重新选择。');
    if (!Array.isArray(trip.samples) || !trip.samples.length) {
      showError('这条记录暂缺有效的逐秒速度采样。');
      return;
    }

    try {
      const collections = await RL.getJSON('records/collections.json');
      const parent = collections.find(c => Array.isArray(c.recordIds) && c.recordIds.includes(trip.id));
      if (parent) {
        const colLink = $('run-collection-link');
        colLink.href = `collection.html?id=${encodeURIComponent(parent.id)}`;
        colLink.textContent = `${parent.title} ↗`;
        colLink.hidden = false;
      }
    } catch {
      // Optional collection breadcrumb; run viewer continues without it.
    }

    const samples = trip.samples;
    const interval = trip.sampleIntervalMs || 1000;
    const gapLimit = RL.gapLimit(trip);
    const st = RL.stats(trip);
    const full = [trip.logStart ?? st.first, trip.logEnd ?? st.last];
    const events = (trip.events || []).map(ev => ({...ev})).sort((a, b) => a.start - b.start);
    const crossDate = RL.date(st.first) !== RL.date(st.last);
    const peakDisplay = Number(RL.speed(st.peak.v));

    document.title = `${trip.train} ${trip.origin || '…'}→${trip.destination} · 逐秒行车志`;
    $('run-train').textContent = trip.train;
    if (trip.origin) {
      $('run-origin').textContent = trip.origin;
    } else {
      $('run-origin').innerHTML = '<span class="origin-unknown" title="起点未录入">…</span>';
    }
    $('run-dest').textContent = trip.destination;
    const dateEl = $('run-date');
    dateEl.textContent = crossDate ? `${RL.date(st.first)} — ${RL.date(st.last)}` : RL.date(st.first);
    dateEl.dateTime = RL.date(st.first);

    const badges = [
      trip.partial ? '<span class="tag tag-partial">部分记录</span>' : '',
      trip.beta === true ? '<span class="tag tag-beta">Beta</span>' : ''
    ].filter(Boolean).join('');
    $('run-badges').innerHTML = badges;

    $('stat-window').textContent = `${RL.time(st.first)} — ${crossDate ? `${RL.date(st.last)} ` : ''}${RL.time(st.last)}`;
    $('stat-duration').textContent = RL.span(st.last - st.first);
    $('stat-samples').textContent = `${samples.length.toLocaleString('zh-CN')} 点`;
    $('peak-btn').innerHTML = `<strong style="color:${RL.tierColor(peakDisplay)}">${RL.speed(st.peak.v)}</strong><span> km/h</span>`;
    $('stat-distance').textContent = `≈ ${st.distanceKm.toFixed(1)} km`;
    $('stat-acc').textContent = `± ${st.medianAccuracy.toFixed(1)} km/h`;

    const notes = [];
    if (trip.speedCleaning?.removedCount) {
      notes.push(`<p>已按加速度绝对值上限 ${trip.speedCleaning.maxAbsAccelerationMps2} m/s² 剔除 ${trip.speedCleaning.removedCount} 个异常采样点，剔除位置保持留空。</p>`);
    }
    if (trip.eventNote) {
      notes.push(`<p>${RL.escapeHtml(trip.eventNote)}</p>`);
    }
    if (notes.length) {
      $('run-notes').innerHTML = notes.join('');
      $('run-notes').hidden = false;
    }

    // Tier composition bar and 5-tier legend
    const totalTierMs = st.tierMs.reduce((sum, ms) => sum + ms, 0);
    $('tier-bar').innerHTML = RL.TIERS.map((tier, idx) => {
      const ms = st.tierMs[idx];
      if (!totalTierMs || !ms) return '';
      const pct = (ms / totalTierMs) * 100;
      return `<div class="tier-bar-seg" style="width:${pct.toFixed(3)}%;background:${tier.color}" title="${tier.label} km/h：${pct.toFixed(1)}%"></div>`;
    }).join('');
    $('tier-legend').innerHTML = RL.TIERS.map((tier, idx) => {
      const pct = totalTierMs ? (st.tierMs[idx] / totalTierMs) * 100 : 0;
      return `<span class="tier-legend-item ${pct === 0 ? 'is-zero' : ''}"><i class="tier-swatch" style="background:${tier.color}"></i><span>${tier.label}</span><span>${totalTierMs ? `${pct.toFixed(1)}%` : '0%'}</span></span>`;
    }).join('') + '<span class="band-legend"><i class="band-swatch"></i>精度色带</span>';

    $('run-status').hidden = true;
    $('run-view').hidden = false;

    // Prepare ECharts series arrays
    const lowerData = [];
    const bandData = [];
    const speedData = [];
    for (let i = 0; i < samples.length; i++) {
      if (i > 0 && samples[i].t - samples[i - 1].t > gapLimit) {
        const gapT = samples[i - 1].t + 1;
        lowerData.push([gapT, null]);
        bandData.push([gapT, null]);
        speedData.push([gapT, null]);
      }
      const s = samples[i];
      const lo = Math.max(0, s.v - s.a);
      const hi = s.v + s.a;
      lowerData.push([s.t, lo]);
      bandData.push([s.t, hi - lo]);
      speedData.push([s.t, s.v]);
    }

    const speedMax = Math.max(50, Math.ceil(samples.reduce((max, s) => Math.max(max, s.v + s.a), 0) / 50) * 50);
    const thresholds = [200, 250, 300, 340].filter(thr => thr < speedMax);
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

    function nearestSample(t) {
      let lo = 0, hi = samples.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (samples[mid].t < t) lo = mid + 1;
        else hi = mid;
      }
      if (lo === 0) return samples[0];
      if (lo === samples.length) return samples[samples.length - 1];
      return t - samples[lo - 1].t <= samples[lo].t - t ? samples[lo - 1] : samples[lo];
    }

    const chartEl = $('speed-chart');
    const chart = echarts.init(chartEl, null, {renderer: 'canvas'});

    chart.setOption({
      animation: false,
      textStyle: {fontFamily: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif'},
      grid: {left: 52, right: 56, top: 42, bottom: 78},
      xAxis: {
        type: 'time',
        min: full[0],
        max: full[1],
        boundaryGap: false,
        axisLine: {lineStyle: {color: '#2a3140'}},
        axisTick: {show: false},
        axisLabel: {
          color: '#8d93a1',
          fontSize: 11,
          fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
          hideOverlap: true,
          formatter: t => RL.time(t)
        },
        splitLine: {show: true, lineStyle: {color: 'rgba(42, 49, 64, 0.55)', type: 'dashed'}}
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: speedMax,
        name: 'km/h',
        nameTextStyle: {
          color: '#8d93a1',
          fontSize: 11,
          fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
          align: 'right',
          padding: [0, 4, 0, 0]
        },
        axisLabel: {
          color: '#8d93a1',
          fontSize: 11,
          fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace'
        },
        splitLine: {lineStyle: {color: '#2a3140', type: 'dashed'}}
      },
      visualMap: {
        type: 'piecewise',
        show: false,
        seriesIndex: 2,
        dimension: 1,
        pieces: [
          {lt: 200, color: RL.TIERS[0].color},
          {gte: 200, lt: 250, color: RL.TIERS[1].color},
          {gte: 250, lt: 300, color: RL.TIERS[2].color},
          {gte: 300, lt: 340, color: RL.TIERS[3].color},
          {gte: 340, color: RL.TIERS[4].color}
        ]
      },
      dataZoom: [
        {
          id: 'in',
          type: 'inside',
          filterMode: 'none',
          minValueSpan: 2000,
          zoomOnMouseWheel: true,
          moveOnMouseWheel: false,
          moveOnMouseMove: coarse ? true : 'shift',
          preventDefaultMouseMove: true
        },
        {
          id: 'sl',
          type: 'slider',
          filterMode: 'none',
          minValueSpan: 2000,
          bottom: 16,
          left: 52,
          right: 56,
          height: 24,
          showDetail: false,
          brushSelect: false,
          borderColor: '#2a3140',
          backgroundColor: '#10131a',
          fillerColor: 'rgba(255, 181, 71, 0.16)',
          handleStyle: {color: '#ffb547', borderColor: '#10131a'},
          dataBackground: {
            lineStyle: {color: '#4f586b'},
            areaStyle: {color: 'rgba(124, 141, 181, 0.16)'}
          },
          selectedDataBackground: {
            lineStyle: {color: '#ffb547'},
            areaStyle: {color: 'rgba(255, 181, 71, 0.2)'}
          }
        }
      ],
      tooltip: {
        trigger: 'axis',
        confine: true,
        backgroundColor: 'rgba(16, 19, 26, 0.96)',
        borderColor: '#2a3140',
        borderWidth: 1,
        padding: [10, 12],
        textStyle: {color: '#e8e6df', fontSize: 12},
        axisPointer: {
          type: 'line',
          lineStyle: {color: 'rgba(82, 199, 216, 0.55)', width: 1, type: 'dashed'}
        },
        formatter(params) {
          const item = Array.isArray(params) ? params[0] : params;
          const t = item?.axisValue;
          if (!Number.isFinite(t)) return '';
          const s = nearestSample(t);
          const covering = events.filter(ev => ev.start === ev.end
            ? Math.abs(t - ev.start) <= 1000
            : (t >= ev.start && t <= ev.end));
          const evHtml = covering.map(ev => {
            const kind = ev.type === 'stop' ? '停车' : '通过';
            const kindColor = ev.type === 'stop' ? '#b4a7ff' : '#e8e6df';
            const inf = ev.source === 'inferred' ? ' · 事后推算' : '';
            return `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #2a3140;color:${kindColor}"><strong>${RL.escapeHtml(ev.name)}</strong> <span style="font-size:11px;opacity:.85">${kind}${inf}</span></div>`;
          }).join('');

          if (!s || Math.abs(s.t - t) > 0.75 * interval) {
            return `<div style="font-family:var(--mono);color:#8d93a1">${RL.date(t)} ${RL.time(t)}</div><div style="margin-top:4px;color:#8d93a1">此刻无采样</div>${evHtml}`;
          }

          const dispV = Number(RL.speed(s.v));
          const lo = Math.max(0, s.v - s.a);
          const hi = s.v + s.a;
          return `<div style="font-family:var(--mono);color:#8d93a1;font-size:11px">${RL.date(s.t)} ${RL.time(s.t)}</div>
            <div style="margin-top:4px;font-family:var(--mono);font-size:17px;font-weight:700;color:${RL.tierColor(dispV)}">${RL.speed(s.v)} <span style="font-size:12px;font-weight:400;color:#8d93a1">km/h</span></div>
            <div style="margin-top:4px;display:flex;justify-content:space-between;gap:14px;font-size:11px;color:#8d93a1"><span>速度精度</span><strong style="font-family:var(--mono);color:#e8e6df">± ${s.a.toFixed(2)} km/h</strong></div>
            <div style="margin-top:2px;display:flex;justify-content:space-between;gap:14px;font-size:11px;color:#8d93a1"><span>上下范围</span><strong style="font-family:var(--mono)"><span style="color:${RL.tierColor(Number(RL.speed(lo)))}">${RL.speed(lo)}</span>–<span style="color:${RL.tierColor(Number(RL.speed(hi)))}">${RL.speed(hi)}</span></strong></div>
            ${evHtml}`;
        }
      },
      series: [
        {
          id: 'lower',
          type: 'line',
          stack: 'acc',
          symbol: 'none',
          connectNulls: false,
          animation: false,
          silent: true,
          clip: true,
          lineStyle: {opacity: 0},
          areaStyle: {opacity: 0},
          data: lowerData
        },
        {
          id: 'band',
          type: 'line',
          stack: 'acc',
          symbol: 'none',
          connectNulls: false,
          animation: false,
          silent: true,
          clip: true,
          lineStyle: {opacity: 0},
          areaStyle: {color: 'rgba(232, 230, 223, 0.16)'},
          data: bandData
        },
        {
          id: 'speed',
          type: 'line',
          symbol: 'none',
          connectNulls: false,
          animation: false,
          clip: true,
          emphasis: {disabled: true},
          lineStyle: {width: 1.6},
          data: speedData,
          z: 5,
          markLine: {
            silent: true,
            symbol: ['none', 'none'],
            data: thresholds.map(thr => {
              const color = RL.TIERS[RL.tierIndex(thr)].color;
              return {
                yAxis: thr,
                lineStyle: {color, type: 'dashed', width: 1, opacity: 0.72},
                label: {
                  show: true,
                  position: 'end',
                  formatter: String(thr),
                  color,
                  fontSize: 11,
                  fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace'
                }
              };
            })
          },
          markPoint: {
            silent: true,
            symbol: 'circle',
            symbolSize: 8,
            itemStyle: {
              color: RL.tierColor(peakDisplay),
              borderColor: '#10131a',
              borderWidth: 1.5
            },
            label: {
              show: true,
              position: 'top',
              distance: 6,
              color: RL.tierColor(peakDisplay),
              backgroundColor: 'rgba(16, 19, 26, 0.9)',
              borderColor: RL.tierColor(peakDisplay),
              borderWidth: 1,
              borderRadius: 4,
              padding: [2, 6],
              fontSize: 11,
              fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
              formatter: () => `峰值 ${RL.speed(st.peak.v)}`
            },
            data: [{coord: [st.peak.t, st.peak.v]}]
          }
        },
        {
          id: 'events',
          type: 'custom',
          data: events.map(ev => ({value: [ev.start, ev.end, ev.type === 'stop' ? 1 : 0]})),
          encode: {x: [0, 1]},
          z: 1,
          silent: true,
          tooltip: {show: false},
          renderItem(params, api) {
            const ev = events[params.dataIndex];
            const start = api.value(0);
            const end = api.value(1);
            const isStop = api.value(2) === 1;
            const p0 = api.coord([start, 0]);
            const p1 = api.coord([end, 0]);
            const cs = params.coordSys;
            const spanPx = p1[0] - p0[0];
            const w = Math.max(2, spanPx);
            const rawX = spanPx < 2 ? p0[0] - 1 : p0[0];
            const rect = echarts.graphic.clipRectByRect({x: rawX, y: cs.y, width: w, height: cs.height}, cs);
            if (!rect) return null;
            const strokeStyle = ev.source === 'inferred'
              ? {stroke: isStop ? 'rgba(180,167,255,0.65)' : 'rgba(232,230,223,0.55)', lineWidth: 1, lineDash: [3, 3]}
              : {};
            const labelX = Math.max(cs.x + 8, Math.min(cs.x + cs.width - 8, rect.x + Math.min(rect.width / 2, 10)));
            return {
              type: 'group',
              children: [
                {
                  type: 'rect',
                  shape: rect,
                  style: {
                    fill: isStop ? 'rgba(180, 167, 255, 0.14)' : 'rgba(232, 230, 223, 0.10)',
                    ...strokeStyle
                  },
                  silent: true
                },
                {
                  type: 'text',
                  x: labelX,
                  y: cs.y + 6,
                  rotation: -Math.PI / 2,
                  style: {
                    text: ev.name,
                    fill: isStop ? '#b4a7ff' : '#e8e6df',
                    stroke: '#0c0f15',
                    lineWidth: 3,
                    strokeFirst: true,
                    font: '11px "PingFang SC", "Microsoft YaHei", sans-serif',
                    align: 'left',
                    verticalAlign: 'middle'
                  },
                  silent: true
                }
              ]
            };
          }
        }
      ]
    });

    let view = [...full];
    const historyStack = [];
    let hashTimer = null;
    let map = null;

    function isFullRange(a, b) {
      const fullWidth = full[1] - full[0];
      return fullWidth <= 0 || (b - a) >= fullWidth * 0.999;
    }

    function updateWindowUI() {
      const dz = chart.getOption().dataZoom[0];
      const a = full[0] + ((full[1] - full[0]) * dz.start) / 100;
      const b = full[0] + ((full[1] - full[0]) * dz.end) / 100;
      view = [a, b];
      $('win-readout').textContent = `${crossDate ? `${RL.date(a)} ` : ''}${RL.time(a)} – ${crossDate ? `${RL.date(b)} ` : ''}${RL.time(b)} · ${RL.span(b - a)}`;
      $('btn-back').disabled = historyStack.length === 0;

      if (map) {
        if (isFullRange(a, b)) map.setFocus(null);
        else map.setFocus(a, b);
      }

      clearTimeout(hashTimer);
      hashTimer = setTimeout(() => {
        const target = isFullRange(a, b)
          ? `${location.pathname}${location.search}`
          : `${location.pathname}${location.search}#w=${Math.round(a)}-${Math.round(b)}`;
        if (`${location.pathname}${location.search}${location.hash}` !== target) {
          history.replaceState(null, '', target);
        }
      }, 300);
    }

    function zoom(a, b) {
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return view;
      const fullWidth = Math.max(2000, full[1] - full[0]);
      const width = Math.min(fullWidth, Math.max(2000, b - a));
      const clampedStart = Math.max(full[0], Math.min(a, full[1] - width));
      const clampedEnd = clampedStart + width;
      chart.dispatchAction({type: 'dataZoom', startValue: clampedStart, endValue: clampedEnd});
      updateWindowUI();
      return {start: view[0], end: view[1]};
    }

    function pushZoom(a, b) {
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return view;
      const prev = [...view];
      const result = zoom(a, b);
      if (Math.abs(view[0] - prev[0]) > 50 || Math.abs(view[1] - prev[1]) > 50) {
        if (historyStack.length >= 50) historyStack.shift();
        historyStack.push(prev);
        $('btn-back').disabled = false;
      }
      return result;
    }

    function scaleView(factor) {
      const center = (view[0] + view[1]) / 2;
      const half = ((view[1] - view[0]) * factor) / 2;
      pushZoom(center - half, center + half);
    }

    function goBack() {
      if (!historyStack.length) return;
      const prev = historyStack.pop();
      zoom(prev[0], prev[1]);
    }

    // Apply initial #w=<a>-<b> window if present and valid
    const hashMatch = location.hash.match(/^#w=(\d+)-(\d+)$/);
    if (hashMatch) {
      const ha = Number(hashMatch[1]);
      const hb = Number(hashMatch[2]);
      if (Number.isFinite(ha) && Number.isFinite(hb) && hb > ha && hb > full[0] && ha < full[1]) {
        zoom(ha, hb);
      } else {
        updateWindowUI();
      }
    } else {
      updateWindowUI();
    }

    chart.on('datazoom', updateWindowUI);
    chart.on('updateAxisPointer', e => {
      const val = e.axesInfo?.[0]?.value;
      map?.setCursor(Number.isFinite(val) ? val : null);
    });
    chart.getZr().on('globalout', () => map?.setCursor(null));
    chart.getZr().on('dblclick', () => pushZoom(full[0], full[1]));

    $('btn-back').onclick = goBack;
    $('btn-zin').onclick = () => scaleView(0.5);
    $('btn-zout').onclick = () => scaleView(2);
    $('btn-reset').onclick = () => pushZoom(full[0], full[1]);
    $('peak-btn').onclick = () => {
      pushZoom(st.peak.t - 90000, st.peak.t + 90000);
      $('speed-panel').scrollIntoView({block: 'center', behavior: 'smooth'});
    };

    chartEl.addEventListener('keydown', e => {
      const step = (view[1] - view[0]) * 0.2;
      if (e.key === 'ArrowLeft') zoom(view[0] - step, view[1] - step);
      else if (e.key === 'ArrowRight') zoom(view[0] + step, view[1] + step);
      else if (e.key === '+' || e.key === '=') scaleView(0.5);
      else if (e.key === '-') scaleView(2);
      else if (e.key === '0' || e.key === 'Home') pushZoom(full[0], full[1]);
      else if (e.key === 'Backspace') goBack();
      else return;
      e.preventDefault();
    });

    // Drag-to-brush zoom on plot area
    let drag = null;
    const brushBox = $('brush-box');
    const localPoint = e => {
      const rect = chartEl.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    };
    const gridRect = () => chart.getModel().getComponent('grid', 0).coordinateSystem.getRect();

    chartEl.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch' || e.button !== 0 || e.shiftKey) return;
      const p = localPoint(e);
      if (!chart.containPixel('grid', p)) return;
      drag = {startX: p[0], rect: gridRect(), id: e.pointerId};
      chartEl.setPointerCapture(e.pointerId);
      chart.dispatchAction({type: 'hideTip'});
    });

    chartEl.addEventListener('pointermove', e => {
      if (!drag) return;
      const r = drag.rect;
      const x = Math.max(r.x, Math.min(r.x + r.width, localPoint(e)[0]));
      brushBox.hidden = false;
      Object.assign(brushBox.style, {
        left: `${Math.min(x, drag.startX)}px`,
        top: `${r.y}px`,
        width: `${Math.abs(x - drag.startX)}px`,
        height: `${r.height}px`
      });
    });

    chartEl.addEventListener('pointerup', e => {
      if (!drag) return;
      const {startX, rect} = drag;
      drag = null;
      brushBox.hidden = true;
      const endX = Math.max(rect.x, Math.min(rect.x + rect.width, localPoint(e)[0]));
      if (Math.abs(endX - startX) > 6) {
        const t1 = chart.convertFromPixel({xAxisIndex: 0}, Math.min(startX, endX));
        const t2 = chart.convertFromPixel({xAxisIndex: 0}, Math.max(startX, endX));
        if (Number.isFinite(t1) && Number.isFinite(t2) && t2 > t1) {
          pushZoom(t1, t2);
        }
      }
    });

    chartEl.addEventListener('pointercancel', () => {
      drag = null;
      brushBox.hidden = true;
    });

    new ResizeObserver(() => chart.resize()).observe($('speed-wrap'));

    // Events table
    $('event-count').textContent = `${events.length} 处`;
    const hasPassInterval = events.some(ev => ev.type === 'pass' && ev.start !== ev.end);
    $('event-mean-note').hidden = !hasPassInterval;

    if (!events.length) {
      $('event-table-wrap').hidden = true;
      $('events-empty').hidden = false;
    } else {
      $('event-rows').innerHTML = events.map((ev, index) => {
        const isPoint = ev.start === ev.end;
        const evCross = RL.date(ev.start) !== RL.date(ev.end);
        const from = `${crossDate ? `${RL.date(ev.start)} ` : ''}${RL.time(ev.start)}`;
        const to = `${(crossDate || evCross) ? `${RL.date(ev.end)} ` : ''}${RL.time(ev.end)}`;
        const timeText = isPoint ? from : `${from} — ${to}`;
        const durText = isPoint ? '时间点' : RL.span(ev.end - ev.start);
        let meanHtml = '—';
        if (ev.type === 'pass' && !isPoint) {
          const res = RL.rangeMean(samples, ev.start, ev.end, interval);
          if (!res) {
            meanHtml = '无采样记录';
          } else {
            const disp = Number(RL.speed(res.mean));
            meanHtml = `<strong style="color:${RL.tierColor(disp)}">${RL.speed(res.mean)} km/h</strong>${res.incomplete ? '（采样不完整）' : ''}`;
          }
        }
        let deltaHtml = '—';
        if (index > 0) {
          const prevEnd = events[index - 1].end;
          const dt = ev.start - prevEnd;
          if (dt <= 0) {
            deltaHtml = '0 秒';
          } else {
            const km = RL.distanceInRange(samples, prevEnd, ev.start, gapLimit);
            deltaHtml = `${RL.span(dt)} · ≈ ${km.toFixed(1)} km`;
          }
        }
        const inferredTag = ev.source === 'inferred' ? '<span class="tag tag-inferred">事后推算</span>' : '';
        return `<tr tabindex="0" role="button" data-id="${RL.escapeHtml(ev.id)}" aria-label="缩放至 ${RL.escapeHtml(ev.name)} 时段">
          <th scope="row">${RL.escapeHtml(ev.name)}${inferredTag}</th>
          <td data-label="类型"><span class="kind-pill ${ev.type === 'stop' ? 'is-stop' : 'is-pass'}">${ev.type === 'stop' ? '停车' : '通过'}</span></td>
          <td data-label="起止（UTC+8）" class="mono">${timeText}</td>
          <td data-label="历时" class="mono">${durText}</td>
          <td data-label="区间均速" class="mono">${meanHtml}</td>
          <td data-label="距上一标记" class="mono">${deltaHtml}</td>
        </tr>`;
      }).join('');

      const activateEvent = row => {
        const ev = events.find(item => item.id === row?.dataset.id);
        if (!ev) return;
        const pad = Math.max(10000, (ev.end - ev.start) * 0.5);
        pushZoom(ev.start - pad, ev.end + pad);
        $('speed-panel').scrollIntoView({block: 'center', behavior: 'smooth'});
      };

      $('event-rows').addEventListener('click', e => {
        activateEvent(e.target.closest('tr[data-id]'));
      });
      $('event-rows').addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          const row = e.target.closest('tr[data-id]');
          if (!row) return;
          e.preventDefault();
          activateEvent(row);
        }
      });
    }

    window.RunView = {
      chart,
      zoom,
      getState: () => ({view: [...view], history: historyStack.length, samples: samples.length, events: events.length}),
      get map() { return map; }
    };

    const onHover = t => {
      if (t == null || t < view[0] || t > view[1]) {
        chart.dispatchAction({type: 'hideTip'});
        return;
      }
      const s = nearestSample(t);
      if (!s) return;
      const pt = chart.convertToPixel({seriesIndex: 2}, [s.t, s.v]);
      if (Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
        chart.dispatchAction({type: 'showTip', x: pt[0], y: pt[1]});
      }
    };

    map = await window.RailRouteMap.mount(trip, {onHover});
    if (map && !isFullRange(view[0], view[1])) {
      map.setFocus(view[0], view[1]);
    }
  })().catch(error => {
    showError(error.message || '载入运转记录失败。');
  });
})();
