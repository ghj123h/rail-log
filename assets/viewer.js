"use strict";
(async () => {
  const $ = id => document.getElementById(id);
  const id = new URLSearchParams(location.search).get('id');
  if (!id || !/^\d{12}$/.test(id)) throw new Error('请从记录目录选择一条运行记录。');
  const response = await fetch(`records/${id}.json`, {cache: 'no-cache'});
  if (!response.ok) throw new Error('没有找到这条运行记录，请返回目录重新选择。');
  const trip = await response.json();
  if (!Array.isArray(trip.samples) || !trip.samples.length) throw new Error('这条记录没有可显示的速度数据。');
  let inCollection = false;
  try {
    const groups = await fetch('records/collections.json', {cache: 'no-cache'});
    if (groups.ok) {
      const collections = await groups.json();
      inCollection = collections.some(collection => collection.recordIds?.includes(trip.id));
    }
  } catch {
    // The speed chart and independent route remain available if the catalog is unavailable.
  }
  if (inCollection) $('route-map-card').remove();
  const colors = {speed:'#216052', band:'#ba8b47', pass:'#746082', stop:'#387661'};
  const speedLevels = [
    {min:0,max:200,label:'[0, 200)',color:'#155b9b',background:'#eef4fb'},
    {min:200,max:250,label:'[200, 250)',color:'#19734c',background:'#eff7f1'},
    {min:250,max:300,label:'[250, 300)',color:'#8a6900',background:'#fff8dc'},
    {min:300,max:340,label:'[300, 340)',color:'#b45309',background:'#fff0e5'},
    {min:340,max:Infinity,label:'[340, +∞)',color:'#b42332',background:'#fceef0'}
  ];
  const speedLevel = value => Math.max(0,speedLevels.findIndex(level=>value<level.max));
  function speedText(value,unit=''){
    const text=value.toFixed(2);
    return `<span class="speed-value" style="color:${speedLevels[speedLevel(Number(text))].color}">${text}${unit}</span>`;
  }
  const samples = trip.samples;
  const full = [trip.logStart, trip.logEnd];
  let view = [...full], mode = 'select', drag = null;
  const events = trip.events.map(event => ({...event})).sort((a,b)=>a.start-b.start);
  const dateFormatter = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
  const timeFormatter = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  const formatDate = t => dateFormatter.format(t);
  const formatTime = t => timeFormatter.format(t);
  const dateTime = t => `${formatDate(t)} ${formatTime(t)}`;
  const duration = ms => {const seconds=Math.round(ms/1000);return seconds<60?`${seconds} 秒`:seconds<3600?`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`:`${Math.floor(seconds/3600)} 小时 ${Math.floor(seconds%3600/60)} 分 ${seconds%60} 秒`;};
  const escape = text => String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const inferenceTag = event => event.source==='inferred'?'<span class="inferred-tag">事后推算</span>':'';
  function averageSpeed(event){
    if(event.start===event.end)return '时间点';
    const points=samples.filter(s=>s.t>=event.start&&s.t<=event.end);
    if(!points.length)return '无采样记录';
    const interval=trip.sampleIntervalMs||1000;
    const incomplete=points[0].t-event.start>interval||event.end-points.at(-1).t>interval||points.some((s,i)=>i&&s.t-points[i-1].t>1.5*interval);
    const average=points.reduce((sum,s)=>sum+s.v,0)/points.length;
    return `${speedText(average,' km/h')}${incomplete?'（采样不完整）':''}`;
  }
  const passAverages=new Map(events.filter(e=>e.type==='pass').map(e=>[e.id,averageSpeed(e)]));
  document.title=`${trip.title} · 运转记录册${trip.beta===true?' Beta':''}`;
  $('trip-title').setAttribute('aria-label',trip.title);
  $('trip-train').textContent=trip.train;
  $('trip-origin').textContent=trip.origin;
  $('trip-destination').textContent=trip.destination;
  $('trip-partial').hidden=!trip.partial;
  $('trip-beta').hidden=trip.beta!==true;
  $('trip-date').textContent=formatDate(samples[0].t);
  $('trip-date').dateTime=formatDate(samples[0].t);
  const crossDate=formatDate(samples[0].t)!==formatDate(samples.at(-1).t);
  $('sample-range').textContent=`${formatTime(samples[0].t)} — ${crossDate?formatDate(samples.at(-1).t)+' ':''}${formatTime(samples.at(-1).t)}`;
  $('sample-count').textContent=samples.length.toLocaleString('zh-CN');
  if(trip.speedCleaning?.removedCount){
    $('cleaning-note').textContent=`按加速度绝对值 ${trip.speedCleaning.maxAbsAccelerationMps2} m/s² 的上限剔除 ${trip.speedCleaning.removedCount} 个异常速度点，删除处留空。`;
    $('cleaning-note').hidden=false;
  }
  $('load-message').hidden=true;$('viewer-content').hidden=false;
  const chart = echarts.init($('chart'),null,{renderer:'canvas'});
  const data = [];
  for(let i=0;i<samples.length;i++){
    if(i && samples[i].t-samples[i-1].t>1.5*(trip.sampleIntervalMs||1000))data.push([samples[i-1].t+1,null,null,null]);
    const s=samples[i];data.push([s.t,s.v,Math.max(0,s.v-s.a),s.v+s.a]);
  }
  function eventSeries(){
    return {id:'events',name:'区间',type:'custom',xAxisIndex:1,yAxisIndex:1,
      renderItem(params,api){
        const lane=api.value(0),a=api.coord([api.value(1),lane]),b=api.coord([api.value(2),lane]);
        const point=api.value(1)===api.value(2),w=Math.max(point?8:5,b[0]-a[0]);
        const rect=echarts.graphic.clipRectByRect({x:a[0]-(w-(b[0]-a[0]))/2,y:a[1]-8,width:w,height:16},params.coordSys);
        return rect?{type:'rect',shape:{...rect,r:point?3:2},style:{fill:lane===0?colors.pass:colors.stop,opacity:.8},silent:true}:null;
      },
      encode:{x:[1,2],y:0},data:events.map(e=>[e.type==='stop'?1:0,e.start,e.end]),silent:true,z:4};
  }
  const commonLine={type:'line',symbol:'none',connectNulls:false,smooth:false,animation:false,clip:true,emphasis:{disabled:true},silent:true};
  const speedMax=Math.max(50,Math.ceil(samples.reduce((max,s)=>Math.max(max,s.v+s.a),0)/50)*50);
  chart.setOption({animation:false,textStyle:{fontFamily:'Inter, "Microsoft YaHei", sans-serif'},
    grid:[{left:66,right:28,top:36,bottom:167},{left:66,right:28,height:56,bottom:73}],
    xAxis:[0,1].map(i=>({type:'time',gridIndex:i,min:full[0],max:full[1],boundaryGap:false,
      axisLine:{show:i===0,lineStyle:{color:'#b8c3bc'}},axisTick:{show:false},
      axisLabel:{show:i===0,color:'#53645a',fontSize:12,hideOverlap:true,formatter:t=>formatTime(t)},
      splitLine:{show:i===0,lineStyle:{color:'#edf0e9'}}})),
    yAxis:[{type:'value',min:0,max:speedMax,name:'速度 / km/h',nameTextStyle:{color:'#53645a',fontSize:12},axisLabel:{fontSize:12,formatter:value=>`{speed${speedLevel(value)}|${value}}`,rich:Object.fromEntries(speedLevels.map((level,i)=>[`speed${i}`,{color:level.color,fontSize:12}]))},splitLine:{lineStyle:{color:'#dce3db'}}},
      {type:'category',gridIndex:1,data:['通过','停车'],inverse:true,axisLine:{show:false},axisTick:{show:false},axisLabel:{color:'#53645a',fontSize:12},splitLine:{show:true,lineStyle:{color:'#e9ede6'}}}],
    dataZoom:[{id:'inside',type:'inside',xAxisIndex:[0,1],filterMode:'none',minValueSpan:2000,zoomOnMouseWheel:true,moveOnMouseMove:false,moveOnMouseWheel:false,preventDefaultMouseMove:true},
      {id:'slider',type:'slider',xAxisIndex:[0,1],filterMode:'none',minValueSpan:2000,bottom:14,left:66,right:28,height:26,showDetail:false,brushSelect:false,borderColor:'#bbc8bc',backgroundColor:'#f4f5ee',fillerColor:'#477b671f',handleStyle:{color:'#fff',borderColor:'#688477'},dataBackground:{lineStyle:{color:'#a5b5a7'},areaStyle:{color:'#e1e9db'}},selectedDataBackground:{lineStyle:{color:colors.speed},areaStyle:{color:'#bbd3c1'}}}],
    series:[{...commonLine,id:'speed-scale-background',data:[],z:0,markArea:{silent:true,z:0,label:{show:false},data:speedLevels.filter(level=>level.min<speedMax).map(level=>[{yAxis:level.min,itemStyle:{color:level.background}},{yAxis:Math.min(level.max,speedMax)}])}},
      {...commonLine,id:'lower',stack:'band',lineStyle:{opacity:0},areaStyle:{opacity:0},data:data.map(d=>[d[0],d[2]])},
      {...commonLine,id:'band',stack:'band',lineStyle:{opacity:0},areaStyle:{color:colors.band,opacity:.4},data:data.map(d=>[d[0],d[2]===null?null:d[3]-d[2]])},
      {...commonLine,id:'speed',lineStyle:{color:colors.speed,width:2},data:data.map(d=>[d[0],d[1]]),z:5},eventSeries()]
  });
  function bounds(){return chart.getModel().getComponent('grid',0).coordinateSystem.getRect();}
  function updateRange(){
    const option=chart.getOption().dataZoom[0];
    view=[full[0]+(full[1]-full[0])*option.start/100,full[0]+(full[1]-full[0])*option.end/100];
    $('view-range').textContent=`${crossDate?formatDate(view[0])+' ':''}${formatTime(view[0])} — ${crossDate?formatDate(view[1])+' ':''}${formatTime(view[1])} · ${duration(view[1]-view[0])}`;
  }
  function zoom(a,b){
    if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a)throw new Error('结束时间必须晚于开始时间');
    const width=Math.min(full[1]-full[0],Math.max(2000,b-a));
    a=Math.max(full[0],Math.min(a,full[1]-width));b=a+width;
    chart.dispatchAction({type:'dataZoom',startValue:a,endValue:b});hideTip();updateRange();
    return {start:view[0],end:view[1]};
  }
  function scale(factor){const center=(view[0]+view[1])/2,half=(view[1]-view[0])*factor/2;zoom(center-half,center+half);}
  function hideTip(){for(const id of ['tooltip','crosshair','hover-dot','hover-span'])$(id).hidden=true;}
  function nearest(t){let lo=0,hi=samples.length;while(lo<hi){const mid=(lo+hi)>>1;if(samples[mid].t<t)lo=mid+1;else hi=mid;}return lo===0?samples[0]:lo===samples.length?samples.at(-1):t-samples[lo-1].t<samples[lo].t-t?samples[lo-1]:samples[lo];}
  function placeTip(html,x,y){const el=$('tooltip');el.innerHTML=html;el.hidden=false;const w=$('chart').clientWidth,h=$('chart').clientHeight;el.style.left=`${Math.max(6,Math.min(x+18,w-el.offsetWidth-8))}px`;el.style.top=`${Math.max(6,Math.min(y+18,h-el.offsetHeight-8))}px`;}
  function showAt(x,y){
    if(drag)return;
    hideTip();
    const rect=bounds();
    if(chart.containPixel({gridIndex:0},[x,y])){
      const t=chart.convertFromPixel({gridIndex:0},[x,y])[0],s=nearest(t);
      if(Math.abs(s.t-t)>.75*(trip.sampleIntervalMs||1000)){placeTip(`<div class="tip-time">${dateTime(t)}</div><div class="empty-tip">该时段无采样记录</div>`,x,y);return;}
      const pos=chart.convertToPixel({gridIndex:0},[s.t,s.v]);
      $('crosshair').hidden=false;Object.assign($('crosshair').style,{left:`${pos[0]}px`,top:`${rect.y}px`,height:`${rect.height}px`});
      $('hover-dot').hidden=false;Object.assign($('hover-dot').style,{left:`${pos[0]}px`,top:`${pos[1]}px`});
      placeTip(`<div class="tip-time">${dateTime(s.t)}</div><div class="tip-value">${speedText(s.v,'<small>km/h</small>')}</div><div class="tip-row"><span>速度精度</span><strong>± ${s.a.toFixed(2)} km/h</strong></div><div class="tip-row"><span>上下范围</span><strong>${speedText(Math.max(0,s.v-s.a))}–${speedText(s.v+s.a)}</strong></div>`,x,y);
    }else if(chart.containPixel({gridIndex:1},[x,y])){
      const hits=events.filter(e=>{const lane=e.type==='stop'?1:0,a=chart.convertToPixel({gridIndex:1},[e.start,lane]),b=chart.convertToPixel({gridIndex:1},[e.end,lane]);return Math.abs(y-a[1])<=12&&x>=Math.min(a[0],b[0])-5&&x<=Math.max(a[0],b[0])+5;});
      if(!hits.length)return;
      const start=Math.min(...hits.map(e=>e.start)),end=Math.max(...hits.map(e=>e.end));
      const left=Math.max(rect.x,chart.convertToPixel({xAxisIndex:0},start)),right=Math.min(rect.x+rect.width,chart.convertToPixel({xAxisIndex:0},end));
      const color=hits[0].type==='stop'?colors.stop:colors.pass;
      $('hover-span').hidden=false;Object.assign($('hover-span').style,{left:`${left}px`,top:`${rect.y}px`,width:`${Math.max(1,right-left)}px`,height:`${rect.height}px`,backgroundColor:`${color}11`,borderLeftColor:`${color}99`,borderRightColor:`${color}99`});
      placeTip(hits.map(e=>`<div class="event-item"><div class="event-title">${escape(e.name)} ${inferenceTag(e)}</div><div class="tip-time">${formatDate(e.start)}</div><div>${formatTime(e.start)}${e.end===e.start?' · 时间点':` — ${formatDate(e.end)!==formatDate(e.start)?formatDate(e.end)+' ':''}${formatTime(e.end)}`}</div>${e.end===e.start?'':`<div class="tip-row"><span>时长</span><strong>${duration(e.end-e.start)}</strong></div>`}${e.type==='pass'&&e.start!==e.end?`<div class="tip-row"><span>平均速度</span><strong>${passAverages.get(e.id)}</strong></div>`:''}</div>`).join(''),x,y);
    }
  }
  chart.getZr().on('mousemove',e=>showAt(e.offsetX,e.offsetY));
  chart.getZr().on('click',e=>showAt(e.offsetX,e.offsetY));
  chart.getZr().on('globalout',()=>{if(!drag)hideTip();});
  chart.getZr().on('dblclick',()=>zoom(...full));
  chart.on('datazoom',()=>{updateRange();hideTip();});
  function setMode(value){mode=value;$('select-mode').setAttribute('aria-pressed',value==='select');$('pan-mode').setAttribute('aria-pressed',value==='pan');chart.setOption({dataZoom:[{id:'inside',moveOnMouseMove:value==='pan'}]});$('chart').style.cursor=value==='select'?'crosshair':'grab';}
  $('select-mode').onclick=()=>setMode('select');$('pan-mode').onclick=()=>setMode('pan');
  $('zoom-in').onclick=()=>scale(.5);$('zoom-out').onclick=()=>scale(2);$('reset-view').onclick=()=>zoom(...full);
  function localPoint(e){const r=$('chart').getBoundingClientRect();return [e.clientX-r.left,e.clientY-r.top];}
  $('chart').addEventListener('pointerdown',e=>{const p=localPoint(e);if(mode!=='select'||e.button!==0||e.pointerType==='touch'||!chart.containPixel({gridIndex:0},p))return;drag={x:p[0],id:e.pointerId};$('chart').setPointerCapture(e.pointerId);hideTip();});
  $('chart').addEventListener('pointermove',e=>{if(!drag)return;const rect=bounds(),x=Math.max(rect.x,Math.min(rect.x+rect.width,localPoint(e)[0]));$('selection').hidden=false;Object.assign($('selection').style,{left:`${Math.min(x,drag.x)}px`,top:`${rect.y}px`,width:`${Math.abs(x-drag.x)}px`,height:`${rect.height}px`});});
  $('chart').addEventListener('pointerup',e=>{if(!drag)return;const first=drag.x;drag=null;$('selection').hidden=true;const rect=bounds(),last=Math.max(rect.x,Math.min(rect.x+rect.width,localPoint(e)[0]));if(Math.abs(first-last)>6)zoom(chart.convertFromPixel({xAxisIndex:0},Math.min(first,last)),chart.convertFromPixel({xAxisIndex:0},Math.max(first,last)));});
  $('chart').addEventListener('pointercancel',()=>{drag=null;$('selection').hidden=true;});
  $('chart').addEventListener('keydown',e=>{const step=(view[1]-view[0])*.2;if(e.key==='ArrowLeft')zoom(view[0]-step,view[1]-step);else if(e.key==='ArrowRight')zoom(view[0]+step,view[1]+step);else if(['+','='].includes(e.key))scale(.5);else if(e.key==='-')scale(2);else if(e.key==='Home')zoom(...full);else return;e.preventDefault();});
  new ResizeObserver(()=>{chart.resize();hideTip();}).observe($('chart-wrap'));
  setMode('select');updateRange();
  $('event-count').textContent = `${events.length} 处`;
  if (trip.eventNote) {
    $('trip-event-note').textContent = trip.eventNote;
    $('trip-event-note').hidden = false;
  }
  $('average-note').hidden = !events.some(event => event.type === 'pass' && event.start !== event.end);
  $('event-rows').innerHTML = events.map(event => {
    const isPoint = event.start === event.end;
    const from = (crossDate ? formatDate(event.start) + ' ' : '') + formatTime(event.start);
    const to = (crossDate ? formatDate(event.end) + ' ' : '') + formatTime(event.end);
    return `<tr>
      <th scope="row">${escape(event.name)} ${inferenceTag(event)}</th>
      <td class="event-kind"><span class="type-tag ${event.type === 'stop' ? 'stop' : 'pass'}">${event.type === 'stop' ? '停车' : '通过'}</span></td>
      <td class="event-time" data-label="时间">${isPoint ? from : from + ' — ' + to}</td>
      <td class="event-duration" data-label="时长">${isPoint ? '时间点' : duration(event.end-event.start)}</td>
      <td class="event-mean" data-label="均速">${event.type === 'pass' ? passAverages.get(event.id) : '—'}</td>
      <td class="actions"><button type="button" data-id="${escape(event.id)}" aria-label="查看${escape(event.name)}区间">查看 <span aria-hidden="true">↗</span></button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="event-empty">尚无区间标记</td></tr>';
  $('event-rows').onclick=e=>{
    const button=e.target.closest('button[data-id]');if(!button)return;
    const event=events.find(item=>item.id===button.dataset.id);if(!event)return;
    const padding=Math.max(10000,(event.end-event.start)*.5);zoom(event.start-padding,event.end+padding);$('chart').scrollIntoView({block:'center',behavior:'smooth'});
  };
  let routeMap=null;
  const getState=()=>({view:[...view],events:events.map(e=>({...e})),samples:samples.length});
  window.TRIP_VIEWER={chart,zoom,getState,nearest,get routeMap(){return routeMap;}};
  if(document.modelContext?.registerTool){
    const lifecycle=new AbortController();
    const register=tool=>{try{Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}};
    register({name:'get_trip_view',description:'读取当前时间窗口、停车和通过区间。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute:getState});
    register({name:'set_time_window',description:'将速度图放大到指定北京时间范围。只调整图表视窗，不修改记录。',inputSchema:{type:'object',properties:{start:{type:'string',description:'带时区的 ISO 开始时间，例如 2026-09-23T16:36:10+08:00'},end:{type:'string',description:'带时区的 ISO 结束时间'}},required:['start','end'],additionalProperties:false},annotations:{readOnlyHint:false},execute:input=>{if(!input||typeof input.start!=='string'||typeof input.end!=='string'||!/[+-]\d\d:\d\d$|Z$/.test(input.start)||!/[+-]\d\d:\d\d$|Z$/.test(input.end))throw new Error('时间必须包含时区');return zoom(Date.parse(input.start),Date.parse(input.end));}});
    window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
  }

  if (!inCollection) {
    try {
      routeMap = await window.RailRouteMap.mount(trip);
    } catch (error) {
      $('map-message').hidden = false;
      $('map-message').textContent = '线路图载入失败：' + error.message;
    }
  }
})().catch(error=>{
  document.getElementById('viewer-content').hidden=true;
  const message=document.getElementById('load-message');message.hidden=false;message.textContent=error.message;
});
