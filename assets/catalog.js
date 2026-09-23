"use strict";
(async()=>{
  const response=await fetch('records/index.json');
  if(!response.ok)throw new Error('暂时无法载入记录目录，请稍后刷新。');
  const records=await response.json();
  const time=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
  const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  document.getElementById('record-count').textContent=`${records.length} 条记录`;
  const message=document.getElementById('catalog-message');
  message.hidden=records.length>0;message.textContent='还没有运行记录。';
  document.getElementById('records').innerHTML=records.map(record=>{
    const seconds=Math.round((record.end-record.start)/1000);
    const length=seconds<3600?`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`:`${Math.floor(seconds/3600)} 小时 ${Math.floor(seconds%3600/60)} 分`;
    const crossDate=date.format(record.start)!==date.format(record.end);
    return `<a class="record" href="viewer.html?id=${encodeURIComponent(record.id)}"><div class="record-date">${date.format(record.start)}<span>${record.partial?'部分记录':'运行记录'}</span></div><div class="record-route"><strong>${escape(record.train)} 次</strong><span>${escape(record.origin)} <i>—</i> ${escape(record.destination)}</span></div><div class="record-meta"><span>${time.format(record.start)}—${crossDate?date.format(record.end)+' ':''}${time.format(record.end)}</span><span>${length} · ${record.sampleCount.toLocaleString()} 个采样点</span></div><span class="record-open">查看记录 <b aria-hidden="true">→</b></span></a>`;
  }).join('');
})().catch(error=>{const message=document.getElementById('catalog-message');message.hidden=false;message.textContent=error.message;});
