"use strict";

(async () => {
  const get = id => document.getElementById(id);
  const date = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  });
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  });
  const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  const printDate = value => date.format(value).replaceAll("-", ".");

  function periodText(records) {
    if (!records.length) return "";
    const first = printDate(Math.min(...records.map(record => record.start)));
    const last = printDate(Math.max(...records.map(record => record.end)));
    return first === last ? first : `${first} — ${last}`;
  }

  function recordRow(record) {
    const startDate = date.format(record.start);
    const endDate = date.format(record.end);
    const endLabel = startDate === endDate ? "" : endDate + " ";
    const seconds = Math.round((record.end - record.start) / 1000);
    const length = seconds < 3600
      ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
      : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
    const badges = [
      record.partial ? '<span class="record-partial">部分记录</span>' : "",
      record.beta === true ? '<span class="record-beta">Beta 版</span>' : ""
    ].join("");
    return `<li><a class="record" href="viewer.html?id=${encodeURIComponent(record.id)}">
      <time class="record-date" datetime="${startDate}">${printDate(record.start)}</time>
      <span class="record-train"><strong>${escapeHtml(record.train)}</strong>${badges ? `<span class="record-badges">${badges}</span>` : ""}</span>
      <span class="record-route"><span>${escapeHtml(record.origin)}</span><i aria-hidden="true">→</i><span class="sr-only">至</span><span>${escapeHtml(record.destination)}</span></span>
      <span class="record-time"><span>${time.format(record.start)}–${endLabel}${time.format(record.end)}</span><small>${length}</small></span>
      <span class="record-samples">${record.sampleCount.toLocaleString("zh-CN")}<small> 个采样点</small></span>
      <span class="record-arrow" aria-hidden="true">↗</span>
    </a></li>`;
  }

  function collectionLink(collection, members) {
    const latest = members[0];
    return `<a class="collection-entry" href="collection.html?id=${encodeURIComponent(collection.id)}">
      <span class="catalog-symbol collection-symbol" aria-hidden="true"><i></i></span>
      <span class="collection-entry-text"><strong>${escapeHtml(collection.title)}</strong>
        <span class="collection-meta">${members.length} 条记录${latest ? `<span>最近记录 ${printDate(latest.start)}</span>` : ""}</span>
      </span>
      <span class="entry-arrow" aria-hidden="true">↗</span>
    </a>`;
  }

  const [indexResponse, collectionsResponse] = await Promise.all([
    fetch("records/index.json", {cache: "no-cache"}),
    fetch("records/collections.json", {cache: "no-cache"})
  ]);
  if (!indexResponse.ok || !collectionsResponse.ok) throw new Error("暂时无法载入记录目录，请稍后刷新。");
  const [allRecords, collections] = await Promise.all([indexResponse.json(), collectionsResponse.json()]);
  const isCollection = Boolean(get("collection-title"));
  let records;

  if (isCollection) {
    const id = new URLSearchParams(location.search).get("id");
    const collection = collections.find(item => item.id === id);
    if (!collection) throw new Error("未找到这个线路合集，请返回记录目录。");
    records = allRecords.filter(record => collection.recordIds.includes(record.id));
    document.title = `${collection.title} · Rail Log`;
    get("collection-title").textContent = collection.title;
    const stations = [...new Set(records.flatMap(record => [record.origin, record.destination]).filter(Boolean))];
    get("endpoint-list").textContent = stations.join("、");
    get("collection-stations").hidden = !stations.length;
  } else {
    const collectedIds = new Set(collections.flatMap(collection => collection.recordIds));
    records = allRecords.filter(record => !collectedIds.has(record.id));
    get("collection-section").hidden = !collections.length;
    get("record-heading").textContent = collections.length ? "其他运行记录" : "运行记录";
    get("collections").innerHTML = collections.map(collection =>
      collectionLink(collection, allRecords.filter(record => collection.recordIds.includes(record.id)))
    ).join("");
    get("catalog-stats").innerHTML = `<span><strong>${allRecords.length}</strong> 条记录</span><span><strong>${collections.length}</strong> 个线路合集</span>`;
    get("catalog-stats").hidden = false;
  }

  const mapRecords = isCollection ? records : allRecords;
  get("catalog-period").textContent = periodText(mapRecords);
  get("catalog-period").hidden = !mapRecords.length;
  get("record-count").textContent = `${records.length} 条记录`;
  get("catalog-message").textContent = "还没有运行记录。";
  get("catalog-message").hidden = records.length > 0;
  get("timetable-columns").hidden = !records.length;
  get("records").innerHTML = records.map(recordRow).join("");
  if (location.hash === "#collection-section" && !isCollection && collections.length) {
    get("collection-section").scrollIntoView({block: "start"});
  }
  window.RailNetworkMap.init(mapRecords, isCollection ? {title: "合集路线图", includeIntermediateStations: true} : {});
})().catch(error => {
  const message = document.getElementById("catalog-message");
  message.hidden = false;
  message.textContent = error.message;
  const mapMessage = document.getElementById("map-message");
  mapMessage.hidden = false;
  mapMessage.textContent = "线路图载入失败：" + error.message;
});
