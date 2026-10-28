/* Temperatures (Standard 3.2.2A): daily checks of fridges, freezers and hot
   holding, deliveries, and the records for the council. Every manager can record;
   the server keeps who and when, and records cannot be edited or deleted. */
(() => {
const $=id=>document.getElementById(id);
const t=v=>escapeHtml(String(v??''));
const THERMO='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 9v7"/></svg>';
const KIND={fridge:['Fridge','5°C or below'],freezer:['Freezer','-15°C or below'],hot:['Hot holding','60°C or above'],chilled:['Chilled','5°C or below'],frozen:['Frozen','-15°C or below']};
const okFor=(food,v)=>food==='fridge'||food==='chilled'?v<=5:food==='freezer'||food==='frozen'?v<=-15:food==='hot'?v>=60:false;
const num=s=>{const v=Number(String(s??'').trim().replace(',','.'));return String(s??'').trim()===''||!Number.isFinite(v)?null:v;};
const deg=v=>`${Number(v).toLocaleString('en-AU',{minimumFractionDigits:1,maximumFractionDigits:1})}°C`;
const time=v=>new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',hour:'numeric',minute:'2-digit'}).format(new Date(v));
const dayLong=v=>new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',weekday:'short',day:'numeric',month:'short',year:'numeric'}).format(new Date(v));
const state={data:null,week:null,start:null,at:0,gen:0,pending:null,recheck:null,scrolled:false,removing:null,history:null};

/* ---------- Screen ---------- */
const SHEET=[['Pizza Prep Fridge','fridge'],['Pasta Prep Fridge','fridge'],['Prep Fridge','fridge'],['Cold Room Inside','fridge'],['Cold Room Outside','fridge'],['Freezer','freezer'],['Bar Fridge','fridge']];
const screen=document.createElement('section');screen.id='tempScreen';screen.className='hidden';
screen.innerHTML=`<div class="manager-top"><div><h2>Temperatures</h2><p>Temperature check list · records for the council</p></div></div>
<div class="tmp-week-nav"><button type="button" class="shop-small" id="tmpPrev" aria-label="Previous week">‹</button><strong id="tmpWeekLabel">This week</strong><button type="button" class="shop-small" id="tmpNext" aria-label="Next week">›</button><button type="button" class="shop-small" id="tmpThis" hidden>This week</button></div>
<p class="rm-data-note" id="tmpHint">Type today's temperature in the Opening or Closing row. Earlier days cannot be changed.</p>
<div id="tmpSheetWrap" class="tmp-sheet-wrap"><div id="tmpSheet" class="empty-state">Loading…</div></div>
<div id="tmpPending" class="card shop-form tmp-pending" hidden></div>
<p class="rm-data-note" id="tmpEqMsg" aria-live="polite"></p>
<div id="tmpDetail" class="rm-data-note tmp-detail" hidden></div>
<h3 class="shop-h">Notes this week</h3>
<div class="card shop-card"><div id="tmpNotes" class="empty-state">No readings outside the safe range this week.</div></div>
<button type="button" class="shop-primary tmp-print-btn" id="tmpPrintWeek">Print this week (council sheet)</button>
<h3 class="shop-h">Delivery</h3>
<form class="card shop-form" id="tmpDelivery" autocomplete="off">
 <input id="tmpItem" maxlength="80" placeholder="Product e.g. Cream, Prawns" aria-label="Product">
 <input id="tmpSupplier" maxlength="80" placeholder="Supplier (optional)" aria-label="Supplier">
 <div class="shop-form-row"><select id="tmpFood" aria-label="Chilled or frozen"><option value="chilled">Chilled · 5°C or below</option><option value="frozen">Frozen · -15°C or below</option></select><input id="tmpDTemp" inputmode="decimal" maxlength="6" placeholder="°C" aria-label="Temperature in °C"></div>
 <input id="tmpDAction" maxlength="200" placeholder="What did you do? e.g. Rejected, sent back" aria-label="Corrective action" hidden>
 <button type="submit" class="shop-primary" id="tmpDSave">Save delivery</button>
 <p class="rm-data-note" id="tmpDMsg" aria-live="polite"></p>
</form>
<h3 class="shop-h">Recorded today</h3>
<div class="card shop-card"><div id="tmpToday" class="empty-state">Nothing yet today.</div></div>
<h3 class="shop-h">Equipment</h3>
<div class="card shop-card"><div id="tmpList" class="empty-state">No equipment yet.</div></div>
<form class="card shop-form" id="tmpEqForm" autocomplete="off">
 <button type="button" class="secondary" id="tmpSheetAdd" hidden>Add the 7 from the paper sheet</button>
 <div class="shop-form-row"><input id="tmpEqName" maxlength="60" placeholder="Add equipment e.g. Cool room" aria-label="Equipment name"><select id="tmpEqKind" aria-label="Type"><option value="fridge">Fridge</option><option value="freezer">Freezer</option><option value="hot">Hot holding</option></select></div>
 <button type="submit" class="secondary" id="tmpEqSave">Add equipment</button>
</form>
<h3 class="shop-h">Records for the council</h3>
<div class="card shop-form"><p class="rm-data-note" style="margin:0">Keep at least 3 months. Records cannot be changed or deleted; a mistake is fixed with a new reading.</p>
 <button type="button" class="secondary" id="tmpHistBtn">Show the last 90 days</button></div>
<div id="tmpRecords" class="hidden"><div class="tmp-print-head"><strong>Temperature records</strong><span id="tmpRecHead"></span></div>
 <button type="button" class="shop-primary tmp-print-btn" id="tmpPrint">Print or save as PDF</button>
 <div id="tmpRecList"></div></div>`;
document.querySelector('main').append(screen);MANAGER_SCREEN_IDS.push(screen.id);

const opener=document.createElement('button');opener.type='button';opener.id='rmOpenTemps';opener.hidden=true;
opener.onclick=()=>{showOnlyManagerScreen(screen.id);setManagerNavActive('operations');window.scrollTo(0,0);state.start=null;render();load().catch(e=>eqMsg(e.message||'Unable to load.'));};
document.body.append(opener);
const menuRow=`<button type="button" class="rm-row" data-rm-go="rmOpenTemps">${THERMO}<span><strong>Temperatures</strong><small>Daily checks for the council</small></span><i aria-hidden="true">›</i></button>`;
for(const menu of [document.querySelector('#operationsScreen .rm-menu'),document.querySelector('#managerMoreScreen .rm-menu'),document.querySelector('#quickActionsDialog .rm-actions')]){
 const after=menu?.querySelector('[data-rm-go="rmOpenMaintenance"]')||menu?.querySelector('[data-rm-go="stockCard"]');
 if(after)after.insertAdjacentHTML('afterend',menuRow);else menu?.insertAdjacentHTML('beforeend',menuRow);
}

const say=(id,text,ok)=>{const m=$(id);m.textContent=text||'';m.style.color=ok?'#07613b':text?'#b3261e':'';};
const eqMsg=(x,ok)=>say('tmpEqMsg',x,ok),dMsg=(x,ok)=>say('tmpDMsg',x,ok);
const addDays=(iso,n)=>{const d=new Date(`${iso}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const dayHead=iso=>{const d=new Date(`${iso}T00:00:00Z`);return [['SUN','MON','TUE','WED','THU','FRI','SAT'][d.getUTCDay()],d.getUTCDate()];};
const shortDate=iso=>new Intl.DateTimeFormat('en-AU',{timeZone:'UTC',day:'numeric',month:'short'}).format(new Date(`${iso}T00:00:00Z`));
const initials=n=>String(n||'').split(/\s+/).filter(Boolean).map(w=>w[0]).join('').slice(0,3).toUpperCase();
const SLOTS=[['opening','Opening'],['closing','Closing']];

async function load(){
 const gen=state.gen;
 const [d,w]=await Promise.all([managerApi('manager_temp_today'),managerApi('manager_temp_week',state.start?{start:state.start}:{})]);
 if(gen!==state.gen)return;
 state.data=d;state.week=w;state.at=Date.now();publish();render();
}
async function loadWeek(){
 const gen=state.gen;$('tmpSheet').className='empty-state';$('tmpSheet').textContent='Loading…';
 const w=await managerApi('manager_temp_week',state.start?{start:state.start}:{});
 if(gen!==state.gen)return;state.week=w;render();
}
// Home: "N temperature checks to do today".
function publish(){
 const d=state.data||{};const eq=d.equipment||[];
 window.mhTemps={missing:Number(d.missing)||0,total:eq.length,names:eq.filter(e=>!e.opening).map(e=>e.name)};
 window.dispatchEvent(new CustomEvent('marinara:temps'));
}
window.mhTemps={missing:0,total:0,names:[]};

function recLine(r){
 const what=r.kind==='equipment'?`${t(r.equipment||'Equipment')} <small>(${r.slot==='closing'?'Closing':'Opening'})</small>`:`${t(r.item)}${r.supplier?` · ${t(r.supplier)}`:''} <small>(${t(KIND[r.food]?.[0]||'')} delivery)</small>`;
 return `<div class="tmp-rec${r.ok?'':' bad'}"><span class="tmp-rec-main"><strong>${what}</strong><small>${t(time(r.recorded_at))} · ${t(r.recorded_by||'')}${r.action?` · Action: ${t(r.action)}`:''}</small></span><b>${t(deg(r.temp))}</b></div>`;
}
function sheetHtml(w,forPrint){
 const days=[...Array(7)].map((_,i)=>addDays(w.start,i));
 const cell=new Map((w.cells||[]).map(c=>[`${c.equipment_id}|${c.day}|${c.slot}`,c]));
 const head=`<tr><th class="tmp-eqcol">Equipment</th><th class="tmp-slotcol">Time</th>${days.map(d=>{const [n,dd]=dayHead(d);return `<th class="${d===w.today?'tmp-today':''}">${n}<small>${dd}</small></th>`;}).join('')}</tr>`;
 const rows=(w.equipment||[]).map(e=>SLOTS.map(([slot,label],si)=>`<tr class="${si?'tmp-closing':''}">${si?'':`<th rowspan="2" class="tmp-eqcol" scope="rowgroup"><span>${t(e.name)}</span><small>${t(KIND[e.kind][1])}</small></th>`}<td class="tmp-slotcol">${label}</td>${days.map(d=>{
   const c=cell.get(`${e.id}|${d}|${slot}`);const key=`${e.id}|${d}|${slot}`;
   const editable=!forPrint&&d===w.today&&e.active;const pend=state.pending&&state.pending.key===key;
   if(editable&&(!c||state.recheck===key||pend))return `<td class="tmp-today${pend?' bad':''}"><input inputmode="decimal" maxlength="6" placeholder="°C" aria-label="${t(e.name)} ${label} today °C" data-tmp-cell="${t(key)}" value="${pend?t(state.pending.temp):''}"></td>`;
   if(!c)return `<td class="${d===w.today?'tmp-today':''}${d<w.today&&!forPrint?' tmp-missed':''}"></td>`;
   return `<td class="${d===w.today?'tmp-today ':''}${c.ok?'':'bad'}"><button type="button" class="tmp-val" data-tmp-show="${t(key)}" ${forPrint?'tabindex="-1"':''}>${t(Number(c.temp).toFixed(1))}<small>${t(initials(c.recorded_by))}</small></button></td>`;
 }).join('')}</tr>`).join('')).join('');
 return `<table class="tmp-sheet"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}
function notesHtml(w){
 const bad=(w.cells||[]).filter(c=>!c.ok).sort((a,b)=>a.recorded_at.localeCompare(b.recorded_at));
 return bad.map(c=>{const [n,dd]=dayHead(c.day);return `<div class="tmp-rec bad"><span class="tmp-rec-main"><strong>${t(n)} ${dd} · ${t(c.equipment||'')} · ${c.slot==='closing'?'Closing':'Opening'}</strong><small>${t(time(c.recorded_at))} · ${t(c.recorded_by||'')} · Action: ${t(c.action||'—')}</small></span><b>${t(deg(c.temp))}</b></div>`;}).join('');
}
function render(){
 const w=state.week,d=state.data;
 const box=$('tmpSheet');
 if(!w){box.className='empty-state';box.textContent='Loading…';}
 else{
  const end=addDays(w.start,6);const thisWeek=w.today>=w.start&&w.today<=end;
  $('tmpWeekLabel').textContent=`${thisWeek?'This week':'Week'} · ${shortDate(w.start)} – ${shortDate(end)}`;
  $('tmpThis').hidden=thisWeek;$('tmpNext').disabled=thisWeek;
  $('tmpHint').hidden=!thisWeek;
  if(!(w.equipment||[]).length){box.className='empty-state';box.textContent='Add your fridges and freezers below (or the 7 from the paper sheet) to start the check list.';}
  else{box.className='';box.innerHTML=sheetHtml(w,false);
   if(thisWeek&&!state.scrolled){state.scrolled=true;requestAnimationFrame(()=>{const th=box.querySelector('th.tmp-today');const wrap=$('tmpSheetWrap');if(th&&wrap)wrap.scrollLeft=Math.max(0,th.offsetLeft-wrap.clientWidth/2);});}}
  const notes=notesHtml(w);const nb=$('tmpNotes');
  if(notes){nb.className='';nb.innerHTML=notes;}else{nb.className='empty-state';nb.textContent='No readings outside the safe range this week.';}
 }
 const p=state.pending,pb=$('tmpPending');
 if(p){const e=(w?.equipment||[]).find(x=>x.id===p.id);pb.hidden=false;pb.innerHTML=`<p class="tmp-need-p">${t(e?.name||'')} · ${p.slot==='closing'?'Closing':'Opening'}: ${t(deg(p.temp))} is outside the safe range (${t(KIND[e?.kind]?.[1]||'')}). Write what you did.</p><input id="tmpPendAction" maxlength="200" placeholder="e.g. Moved food to the other fridge, called the technician" aria-label="Corrective action"><div class="shop-form-row"><button type="button" class="shop-primary" id="tmpPendSave">Save</button><button type="button" class="secondary" id="tmpPendCancel">Cancel</button></div>`;}
 else{pb.hidden=true;pb.innerHTML='';}
 const today=d?.today||[];const tb=$('tmpToday');
 if(!today.length){tb.className='empty-state';tb.textContent='Nothing yet today.';}else{tb.className='';tb.innerHTML=today.map(recLine).join('');}
 const eq=(d?.equipment)||[];const lb=$('tmpList');
 $('tmpSheetAdd').hidden=!!eq.length||!d;
 if(!eq.length){lb.className='empty-state';lb.textContent='No equipment yet.';}
 else{lb.className='';lb.innerHTML=eq.map(e=>`<div class="tmp-rec"><span class="tmp-rec-main"><strong>${t(e.name)}</strong><small>${t(KIND[e.kind][0])} · ${t(KIND[e.kind][1])}</small></span><button type="button" class="shop-small" data-tmp-remove="${t(e.id)}">${state.removing===e.id?'Tap again to remove':'Remove'}</button></div>`).join('');}
}

async function saveCell(key,raw,action){
 const [id,day,slot]=key.split('|');const e=(state.week?.equipment||[]).find(x=>x.id===id);if(!e)return;
 const v=num(raw);if(v===null){eqMsg('Type the temperature in °C, e.g. 3.5');return;}
 if(!okFor(e.kind,v)&&!action){state.pending={key,id,day,slot,temp:v};render();$('tmpPendAction')?.focus();return;}
 try{await managerApi('manager_temp_record',{entry:{kind:'equipment',equipment_id:id,slot,temp:v,action:action||''}});
  state.pending=null;state.recheck=null;eqMsg(`${e.name} · ${slot==='closing'?'Closing':'Opening'}: ${deg(v)} saved.`,true);await load();}
 catch(err){eqMsg(err.message||'Unable to save.');}
}
screen.addEventListener('change',ev=>{const i=ev.target.closest('[data-tmp-cell]');if(i&&i.value.trim())saveCell(i.dataset.tmpCell,i.value,'');});
screen.addEventListener('keydown',ev=>{if(ev.key!=='Enter')return;const i=ev.target.closest('[data-tmp-cell]');if(i){ev.preventDefault();i.blur();}else if(ev.target.id==='tmpPendAction'){ev.preventDefault();$('tmpPendSave')?.click();}});
screen.addEventListener('click',async ev=>{
 if(ev.target.closest('#tmpPendSave')){const p=state.pending;const a=($('tmpPendAction').value||'').trim();if(!a){eqMsg('Write what you did about it.');return;}await saveCell(p.key,String(p.temp),a);return;}
 if(ev.target.closest('#tmpPendCancel')){state.pending=null;render();return;}
 const sh=ev.target.closest('[data-tmp-show]');
 if(sh){const key=sh.dataset.tmpShow;const c=(state.week?.cells||[]).find(x=>`${x.equipment_id}|${x.day}|${x.slot}`===key);const det=$('tmpDetail');
  if(c){det.hidden=false;det.innerHTML=`${t(c.equipment||'')} · ${c.slot==='closing'?'Closing':'Opening'} · ${t(shortDate(c.day))}: <b>${t(deg(c.temp))}</b> at ${t(time(c.recorded_at))} by ${t(c.recorded_by||'')}${c.action?` · Action: ${t(c.action)}`:''}${c.day===state.week.today?' · <button type="button" class="shop-small" data-tmp-recheck="'+t(key)+'">Check again</button>':''}`;}
  return;}
 const rc=ev.target.closest('[data-tmp-recheck]');if(rc){state.recheck=rc.dataset.tmpRecheck;$('tmpDetail').hidden=true;render();screen.querySelector(`[data-tmp-cell="${CSS.escape(state.recheck)}"]`)?.focus();return;}
 if(ev.target.closest('#tmpPrev')){state.start=addDays(state.week.start,-7);state.scrolled=true;loadWeek().catch(e=>eqMsg(e.message));return;}
 if(ev.target.closest('#tmpNext')){state.start=addDays(state.week.start,7);loadWeek().catch(e=>eqMsg(e.message));return;}
 if(ev.target.closest('#tmpThis')){state.start=null;state.scrolled=false;loadWeek().catch(e=>eqMsg(e.message));return;}
 if(ev.target.closest('#tmpSheetAdd')){const b=ev.target.closest('#tmpSheetAdd');b.disabled=true;
  try{for(const [name,kind] of SHEET)await managerApi('manager_temp_equipment_save',{item:{name,kind}});eqMsg('Added the 7 from the paper sheet. Change or remove any below.',true);await load();}catch(err){eqMsg(err.message||'Unable to add.');}finally{b.disabled=false;}return;}
 const r=ev.target.closest('[data-tmp-remove]');
 if(r){const id=r.dataset.tmpRemove;if(state.removing!==id){state.removing=id;render();return;}
  r.disabled=true;try{await managerApi('manager_temp_equipment_save',{item:{id,active:false}});state.removing=null;eqMsg('Removed from the list. Its records are kept.',true);await load();}catch(err){eqMsg(err.message||'Unable to remove.');r.disabled=false;}}
});
$('tmpEqForm').addEventListener('submit',async ev=>{ev.preventDefault();
 const name=$('tmpEqName').value.trim();if(!name){eqMsg('Write the name, e.g. Cool room.');return;}
 const b=$('tmpEqSave');b.disabled=true;
 try{await managerApi('manager_temp_equipment_save',{item:{name,kind:$('tmpEqKind').value}});$('tmpEqName').value='';eqMsg(`Added: ${name}`,true);await load();}
 catch(err){eqMsg(err.message||'Unable to add.');}finally{b.disabled=false;}
});
const deliveryOut=()=>{const v=num($('tmpDTemp').value);return v!==null&&!okFor($('tmpFood').value,v);};
const syncDelivery=()=>{$('tmpDAction').hidden=!deliveryOut();};
$('tmpDTemp').addEventListener('input',syncDelivery);$('tmpFood').addEventListener('change',syncDelivery);
$('tmpDelivery').addEventListener('submit',async ev=>{ev.preventDefault();
 const item=$('tmpItem').value.trim(),v=num($('tmpDTemp').value),action=$('tmpDAction').value.trim();
 if(!item){dMsg('Write the product.');return;}
 if(v===null){dMsg('Type the temperature in °C.');return;}
 if(deliveryOut()&&!action){syncDelivery();dMsg('Outside the safe range. Write what you did (e.g. rejected).');$('tmpDAction').focus();return;}
 const b=$('tmpDSave');b.disabled=true;
 try{await managerApi('manager_temp_record',{entry:{kind:'receiving',item,supplier:$('tmpSupplier').value.trim(),food:$('tmpFood').value,temp:v,action}});
  for(const id of ['tmpItem','tmpSupplier','tmpDTemp','tmpDAction'])$(id).value='';syncDelivery();dMsg(`${item}: ${deg(v)} saved.`,true);await load();}
 catch(err){dMsg(err.message||'Unable to save.');}finally{b.disabled=false;}
});
$('tmpHistBtn').addEventListener('click',async()=>{
 const b=$('tmpHistBtn');b.disabled=true;b.textContent='Loading…';
 try{const h=await managerApi('manager_temp_history',{days:90});state.history=h;
  const recs=h.records||[];const byDay=new Map();for(const r of recs){const k=dayLong(r.recorded_at);if(!byDay.has(k))byDay.set(k,[]);byDay.get(k).push(r);}
  $('tmpRecHead').textContent=`${h.location||''} · last ${h.days} days · ${recs.length} record${recs.length===1?'':'s'} · printed ${dayLong(Date.now())}`;
  $('tmpRecList').innerHTML=recs.length?[...byDay].map(([k,rs])=>`<h4 class="tmp-day">${t(k)}</h4><div class="card shop-card">${rs.map(recLine).join('')}</div>`).join(''):'<p class="rm-data-note">No records yet.</p>';
  $('tmpRecords').classList.remove('hidden');b.textContent='Refresh the last 90 days';}
 catch(err){eqMsg(err.message||'Unable to load the records.');b.textContent='Show the last 90 days';}
 finally{b.disabled=false;}
});
function printNow(cls){document.body.classList.add(cls);const done=()=>{document.body.classList.remove(cls);window.removeEventListener('afterprint',done);};window.addEventListener('afterprint',done);window.print();setTimeout(done,60000);}
$('tmpPrintWeek').addEventListener('click',()=>{
 const w=state.week;if(!w)return;let box=$('tmpWeekPrint');if(!box){box=document.createElement('div');box.id='tmpWeekPrint';document.body.append(box);}
 box.innerHTML=`<h2>Marinara ${t(w.location||'')} – Temperature Check list</h2><p>Week ${t(shortDate(w.start))} – ${t(shortDate(addDays(w.start,6)))} · Fridge 5°C or below · Freezer -15°C or below · Hot holding 60°C or above · initials = who checked</p>${sheetHtml(w,true)}<h3>Notes (readings outside the safe range and what was done)</h3>${notesHtml(w)||'<p>None.</p>'}<p class="tmp-print-foot">Printed ${t(dayLong(Date.now()))} from Marinara Hours. Every reading is saved with the name of who checked and the time; records cannot be changed.</p>`;
 printNow('tmp-printing-week');
});
$('tmpPrint').addEventListener('click',()=>printNow('tmp-printing'));

window.addEventListener('marinara:dashboard',()=>{if(Date.now()-state.at>60e3)load().catch(()=>{});});
window.addEventListener('marinara:session-reset',()=>{state.gen++;state.data=null;state.week=null;state.start=null;state.at=0;state.pending=null;state.recheck=null;state.scrolled=false;state.removing=null;state.history=null;$('tmpDetail').hidden=true;$('tmpRecords').classList.add('hidden');$('tmpRecList').innerHTML='';for(const id of ['tmpEqMsg','tmpDMsg'])$(id).textContent='';publish();render();});
})();
