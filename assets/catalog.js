"use strict";
(async()=>{
  const [response,collectionResponse]=await Promise.all([
    fetch('records/index.json',{cache:'no-cache'}),
    fetch('records/collections.json',{cache:'no-cache'})
  ]);
  if(!response.ok||!collectionResponse.ok)throw new Error('暂时无法载入记录目录，请稍后刷新。');
  const [allRecords,collections]=await Promise.all([response.json(),collectionResponse.json()]);
  const time=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
  const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const collectionId=new URLSearchParams(location.search).get('id');
  const isCollectionPage=Boolean(document.getElementById('collection-title'));
  let records;
  if(isCollectionPage){
    const collection=collections.find(item=>item.id===collectionId);
    if(!collection)throw new Error('未找到这个线路合集，请返回运转记录册。');
    document.title=`${collection.title} · Rail Log`;
    document.getElementById('collection-title').textContent=collection.title;
    document.getElementById('collection-description').textContent=collection.description;
    records=allRecords.filter(record=>collection.recordIds.includes(record.id));
  }else{
    const collectedIds=new Set(collections.flatMap(collection=>collection.recordIds));
    records=allRecords.filter(record=>!collectedIds.has(record.id));
    const section=document.getElementById('collection-section');
    section.hidden=collections.length===0;
    document.getElementById('record-heading').textContent=collections.length?'其他运行记录':'运行记录';
    document.getElementById('collections').innerHTML=collections.map(collection=>{
      const members=allRecords.filter(record=>collection.recordIds.includes(record.id));
      const latest=members[0];
      return `<a class="collection-card" href="collection.html?id=${encodeURIComponent(collection.id)}"><div><strong>${escape(collection.title)}</strong><p>${escape(collection.description)}</p><span class="collection-meta">${members.length} 条记录${latest?` · 最近更新 ${date.format(latest.start)}`:''}</span></div><span class="collection-open">查看合集 <b aria-hidden="true">→</b></span></a>`;
    }).join('');
  }
  document.getElementById('record-count').textContent=`${records.length} 条记录`;
  const message=document.getElementById('catalog-message');
  message.hidden=records.length>0;message.textContent='还没有运行记录。';
  document.getElementById('records').innerHTML=records.map(record=>{
    const seconds=Math.round((record.end-record.start)/1000);
    const length=seconds<3600?`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`:`${Math.floor(seconds/3600)} 小时 ${Math.floor(seconds%3600/60)} 分`;
    const crossDate=date.format(record.start)!==date.format(record.end);
    return `<a class="record" href="viewer.html?id=${encodeURIComponent(record.id)}"><div class="record-date">${date.format(record.start)}<span>${record.partial?'部分记录':'运行记录'}</span></div><div class="record-route"><strong>${escape(record.train)} 次${record.beta===true?'<span class="beta-badge">Beta 版</span>':''}</strong><span>${escape(record.origin)} <i>—</i> ${escape(record.destination)}</span></div><div class="record-meta"><span>${time.format(record.start)}—${crossDate?date.format(record.end)+' ':''}${time.format(record.end)}</span><span>${length} · ${record.sampleCount.toLocaleString()} 个采样点</span></div><span class="record-open">查看记录 <b aria-hidden="true">→</b></span></a>`;
  }).join('');
})().catch(error=>{const message=document.getElementById('catalog-message');message.hidden=false;message.textContent=error.message;});
