/* Temperatures (Standard 3.2.2A): the weekly check list of fridges, freezers and
   hot holding, and a separate Deliveries screen (receival temperatures), plus the
   records for the council. Every manager can record; the server keeps who and
   when. Checks cannot be edited or deleted; a delivery can be corrected and its
   first values stay on record. */
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
const state={data:null,week:null,start:null,at:0,gen:0,pending:null,sign:null,recheck:null,scrolled:false,removing:null,history:null};

/* ---------- Screen ---------- */
const SHEET=[['Pizza Prep Fridge','fridge'],['Pasta Prep Fridge','fridge'],['Prep Fridge','fridge'],['Cold Room Inside','fridge'],['Cold Room Outside','fridge'],['Freezer','freezer'],['Bar Fridge','fridge']];
const screen=document.createElement('section');screen.id='tempScreen';screen.className='hidden';
screen.innerHTML=`<div class="manager-top"><div><h2>Temperatures</h2><p>Temperature check list · records for the council</p></div></div>
<div class="tmp-week-nav"><button type="button" class="shop-small" id="tmpPrev" aria-label="Previous week">‹</button><strong id="tmpWeekLabel">This week</strong><button type="button" class="shop-small" id="tmpNext" aria-label="Next week">›</button><button type="button" class="shop-small" id="tmpThis" hidden>This week</button></div>
<label class="tmp-who">Checked by <select id="tmpWho" aria-label="Who did the check"><option value="">Me</option></select></label>
<p class="rm-data-note" id="tmpHint">Type today's temperature in the Opening or Closing row. Earlier days cannot be changed.</p>
<div id="tmpSheetWrap" class="tmp-sheet-wrap"><div id="tmpSheet" class="empty-state">Loading…</div></div>
<div id="tmpPending" class="card shop-form tmp-pending" hidden></div>
<p class="rm-data-note" id="tmpEqMsg" aria-live="polite"></p>
<div id="tmpDetail" class="rm-data-note tmp-detail" hidden></div>
<h3 class="shop-h">Notes this week</h3>
<div class="card shop-card"><div id="tmpNotes" class="empty-state">No readings outside the safe range this week.</div></div>
<button type="button" class="shop-primary tmp-print-btn" id="tmpPrintWeek">PDF of this week (council sheet)</button>
<h3 class="shop-h">Equipment</h3>
<div class="card shop-card"><div id="tmpList" class="empty-state">No equipment yet.</div></div>
<form class="card shop-form" id="tmpEqForm" autocomplete="off">
 <button type="button" class="secondary" id="tmpSheetAdd" hidden>Add the 7 from the paper sheet</button>
 <div class="shop-form-row"><input id="tmpEqName" maxlength="60" placeholder="Add equipment e.g. Cool room" aria-label="Equipment name"><select id="tmpEqKind" aria-label="Type"><option value="fridge">Fridge</option><option value="freezer">Freezer</option><option value="hot">Hot holding</option></select></div>
 <button type="submit" class="secondary" id="tmpEqSave">Add equipment</button>
</form>
<h3 class="shop-h">Records for the council</h3>
<div class="card shop-form"><p class="rm-data-note" style="margin:0">Keep at least 3 months. Checks cannot be changed or deleted; a mistake is fixed with a new reading. Deliveries are in the Deliveries screen.</p>
 <button type="button" class="secondary" id="tmpHistBtn">Show the last 90 days</button></div>
<div id="tmpRecords" class="hidden"><div class="tmp-print-head"><strong>Temperature records</strong><span id="tmpRecHead"></span></div>
 <button type="button" class="shop-primary tmp-print-btn" id="tmpPrint">PDF of these records</button>
 <div id="tmpRecList"></div></div>`;
document.querySelector('main').append(screen);MANAGER_SCREEN_IDS.push(screen.id);

const opener=document.createElement('button');opener.type='button';opener.id='rmOpenTemps';opener.hidden=true;
opener.onclick=()=>{showOnlyManagerScreen(screen.id);setManagerNavActive('operations');window.scrollTo(0,0);state.start=null;render();requestAnimationFrame(showToday);load().catch(e=>eqMsg(e.message||'Unable to load.'));};
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
const checker=r=>r.checked_by||r.recorded_by||'';
const byLine=r=>`${t(checker(r))}${r.checked_by&&r.recorded_by&&r.checked_by!==r.recorded_by?` (typed by ${t(r.recorded_by)})`:''}`;
const whoOptions=(sel)=>`<option value="">Me</option>${(state.data?.people||[]).map(p=>`<option value="${t(p.id)}"${p.id===sel?' selected':''}>${t(p.name)}</option>`).join('')}`;
function fillWho(id){const el=$(id);if(!el)return;const v=el.value;el.innerHTML=whoOptions(v);el.value=[...el.options].some(o=>o.value===v)?v:'';}

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
 return `<div class="tmp-rec${r.ok?'':' bad'}"><span class="tmp-rec-main"><strong>${what}</strong><small>${t(time(r.recorded_at))} · ${byLine(r)}${r.action?` · Action: ${t(r.action)}`:''}${editedNote(r)}</small></span><b>${t(deg(r.temp))}</b></div>`;
}
function wasText(r){const o=r.original;if(!o)return '';return [o.item,o.supplier,KIND[o.food]?.[0],o.temp!=null?deg(o.temp):'',o.checked_by&&o.checked_by!==checker(r)?`by ${o.checked_by}`:''].filter(Boolean).join(' · ');}
function editedNote(r){return r.edited_at?`<br><em class="tmp-edited">Corrected by ${t(r.edited_by||'')} ${dayLong(r.edited_at)===dayLong(r.recorded_at)?'':t(dayLong(r.edited_at))+' '}${t(time(r.edited_at))} · was: ${t(wasText(r))}</em>`:'';}
function sheetHtml(w,forPrint){
 const days=[...Array(7)].map((_,i)=>addDays(w.start,i));
 const cell=new Map((w.cells||[]).map(c=>[`${c.equipment_id}|${c.day}|${c.slot}`,c]));
 const head=`<tr><th class="tmp-eqcol">Equipment</th><th class="tmp-slotcol">Time</th>${days.map(d=>{const [n,dd]=dayHead(d);return `<th class="${d===w.today?'tmp-today':''}">${n}<small>${dd}</small></th>`;}).join('')}</tr>`;
 const rows=(w.equipment||[]).map(e=>SLOTS.map(([slot,label],si)=>`<tr class="${si?'tmp-closing':''}">${si?'':`<th rowspan="2" class="tmp-eqcol" scope="rowgroup"><span>${t(e.name)}</span><small>${t(KIND[e.kind][1])}</small></th>`}<td class="tmp-slotcol">${label}</td>${days.map(d=>{
   const c=cell.get(`${e.id}|${d}|${slot}`);const key=`${e.id}|${d}|${slot}`;
   const editable=!forPrint&&d===w.today&&e.active;const pend=(state.pending&&state.pending.key===key)||(state.sign&&state.sign.key===key);const pv=state.pending?.key===key?state.pending.temp:state.sign?.key===key?state.sign.temp:'';
   if(editable&&(!c||state.recheck===key||pend))return `<td class="tmp-today${pend?' bad':''}"><input inputmode="decimal" maxlength="6" placeholder="${e.kind==='freezer'?'-°C':'°C'}" aria-label="${t(e.name)} ${label} today °C" data-tmp-cell="${t(key)}" value="${pend?t(pv):''}"></td>`;
   if(!c)return `<td class="${d===w.today?'tmp-today':''}${d<w.today&&!forPrint?' tmp-missed':''}"></td>`;
   return `<td class="${d===w.today?'tmp-today ':''}${c.ok?'':'bad'}"><button type="button" class="tmp-val" data-tmp-show="${t(key)}" ${forPrint?'tabindex="-1"':''}>${t(Number(c.temp).toFixed(1))}<small>${t(initials(checker(c)))}</small></button></td>`;
 }).join('')}</tr>`).join('')).join('');
 return `<table class="tmp-sheet"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}
function notesHtml(w){
 const bad=(w.cells||[]).filter(c=>!c.ok).sort((a,b)=>a.recorded_at.localeCompare(b.recorded_at));
 return bad.map(c=>{const [n,dd]=dayHead(c.day);return `<div class="tmp-rec bad"><span class="tmp-rec-main"><strong>${t(n)} ${dd} · ${t(c.equipment||'')} · ${c.slot==='closing'?'Closing':'Opening'}</strong><small>${t(time(c.recorded_at))} · ${byLine(c)} · Action: ${t(c.action||'—')}</small></span><b>${t(deg(c.temp))}</b></div>`;}).join('');
}
// Keep today's column in view (beside the sticky Equipment and Time columns).
function showToday(){
 const wrap=$('tmpSheetWrap'),th=wrap?.querySelector('th.tmp-today');if(!th||!wrap.clientWidth)return;
 const sticky=[...wrap.querySelectorAll('thead .tmp-eqcol,thead .tmp-slotcol')].reduce((a,x)=>a+x.offsetWidth,0);
 const left=th.offsetLeft-sticky,right=th.offsetLeft+th.offsetWidth-wrap.clientWidth;
 if(wrap.scrollLeft>left||wrap.scrollLeft<right)wrap.scrollLeft=Math.max(0,left-(wrap.clientWidth-sticky-th.offsetWidth)/2);
}
// While a box of the sheet is being typed in, update the other cells only, so the
// box (and the iPhone keyboard) stays: tap the next box and keep typing.
function softSheet(box,w){
 const act=document.activeElement;const key=act?.dataset?.tmpCell;
 const old=box.querySelector('table.tmp-sheet');if(!key||!old||!old.contains(act))return false;
 const tmp=document.createElement('div');tmp.innerHTML=sheetHtml(w,false);const neu=tmp.querySelector('table.tmp-sheet');
 const a=old.tBodies[0]?.rows,b=neu.tBodies[0]?.rows;if(!a||!b||a.length!==b.length)return false;
 if(old.tHead.innerHTML!==neu.tHead.innerHTML)return false;
 for(let r=0;r<a.length;r++){if(a[r].cells.length!==b[r].cells.length)return false;}
 for(let r=0;r<a.length;r++)for(let c=0;c<a[r].cells.length;c++){
  const x=a[r].cells[c],y=b[r].cells[c];if(x.contains(act))continue;
  if(x.outerHTML!==y.outerHTML){x.replaceWith(y.cloneNode(true));}
 }
 return true;
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
  else if(!softSheet(box,w)){box.className='';box.innerHTML=sheetHtml(w,false);
   if(thisWeek)requestAnimationFrame(showToday);}
  const notes=notesHtml(w);const nb=$('tmpNotes');
  if(notes){nb.className='';nb.innerHTML=notes;}else{nb.className='empty-state';nb.textContent='No readings outside the safe range this week.';}
 }
 const p=state.pending,pb=$('tmpPending'),sg=state.sign;
 if(sg){const e=(w?.equipment||[]).find(x=>x.id===sg.id);pb.hidden=false;pb.innerHTML=`<p class="tmp-need-p">${t(e?.name||'')} · ${sg.slot==='closing'?'Closing':'Opening'}: did you mean minus?</p><div class="shop-form-row"><button type="button" class="shop-primary" id="tmpSignNeg">${t(deg(-sg.temp))}</button><button type="button" class="secondary" id="tmpSignPos">+${t(deg(sg.temp))}</button></div>`;}
 else if(p){const e=(w?.equipment||[]).find(x=>x.id===p.id);pb.hidden=false;pb.innerHTML=`<p class="tmp-need-p">${t(e?.name||'')} · ${p.slot==='closing'?'Closing':'Opening'}: ${t(deg(p.temp))} is outside the safe range (${t(KIND[e?.kind]?.[1]||'')}). Write what you did.</p><input id="tmpPendAction" maxlength="200" placeholder="e.g. Moved food to the other fridge, called the technician" aria-label="Corrective action"><div class="shop-form-row"><button type="button" class="shop-primary" id="tmpPendSave">Save</button><button type="button" class="secondary" id="tmpPendCancel">Cancel</button></div>`;}
 else{pb.hidden=true;pb.innerHTML='';}
 fillWho('tmpWho');fillWho('tmpDWho');
 const eq=(d?.equipment)||[];const lb=$('tmpList');
 $('tmpSheetAdd').hidden=!!eq.length||!d;
 if(!eq.length){lb.className='empty-state';lb.textContent='No equipment yet.';}
 else{lb.className='';lb.innerHTML=eq.map(e=>`<div class="tmp-rec"><span class="tmp-rec-main"><strong>${t(e.name)}</strong><small>${t(KIND[e.kind][0])} · ${t(KIND[e.kind][1])}</small></span><button type="button" class="shop-small" data-tmp-remove="${t(e.id)}">${state.removing===e.id?'Tap again to remove':'Remove'}</button></div>`).join('');}
}

async function saveCell(key,raw,action,signed){
 const [id,day,slot]=key.split('|');const e=(state.week?.equipment||[]).find(x=>x.id===id);if(!e)return;
 const v=num(raw);if(v===null){eqMsg('Type the temperature in °C, e.g. 3.5');return;}
 if(e.kind==='freezer'&&v>0&&!signed){state.sign={key,id,slot,temp:v};state.pending=null;render();return;}
 state.sign=null;
 if(!okFor(e.kind,v)&&!action){state.pending={key,id,day,slot,temp:v};render();$('tmpPendAction')?.focus();return;}
 try{await managerApi('manager_temp_record',{entry:{kind:'equipment',equipment_id:id,slot,temp:v,action:action||'',checked_by:$('tmpWho').value}});
  state.pending=null;state.recheck=null;eqMsg(`${e.name} · ${slot==='closing'?'Closing':'Opening'}: ${deg(v)} saved.`,true);await load();}
 catch(err){eqMsg(err.message||'Unable to save.');}
}
screen.addEventListener('change',ev=>{const i=ev.target.closest('[data-tmp-cell]');if(i&&i.value.trim())saveCell(i.dataset.tmpCell,i.value,'');});
screen.addEventListener('keydown',ev=>{if(ev.key!=='Enter')return;const i=ev.target.closest('[data-tmp-cell]');if(i){ev.preventDefault();i.blur();}else if(ev.target.id==='tmpPendAction'){ev.preventDefault();$('tmpPendSave')?.click();}});
screen.addEventListener('click',async ev=>{
 if(ev.target.closest('#tmpSignNeg')){const g=state.sign;await saveCell(g.key,String(-g.temp),'',true);return;}
 if(ev.target.closest('#tmpSignPos')){const g=state.sign;await saveCell(g.key,String(g.temp),'',true);return;}
 if(ev.target.closest('#tmpPendSave')){const p=state.pending;const a=($('tmpPendAction').value||'').trim();if(!a){eqMsg('Write what you did about it.');return;}await saveCell(p.key,String(p.temp),a,true);return;}
 if(ev.target.closest('#tmpPendCancel')){state.pending=null;render();return;}
 const sh=ev.target.closest('[data-tmp-show]');
 if(sh){const key=sh.dataset.tmpShow;const c=(state.week?.cells||[]).find(x=>`${x.equipment_id}|${x.day}|${x.slot}`===key);const det=$('tmpDetail');
  if(c){det.hidden=false;det.innerHTML=`${t(c.equipment||'')} · ${c.slot==='closing'?'Closing':'Opening'} · ${t(shortDate(c.day))}: <b>${t(deg(c.temp))}</b> at ${t(time(c.recorded_at))} by ${byLine(c)}${c.action?` · Action: ${t(c.action)}`:''}${c.day===state.week.today?' · <button type="button" class="shop-small" data-tmp-recheck="'+t(key)+'">Check again</button>':''}`;}
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
// PDF (iPhone home-screen apps cannot print a page): Share > Print, or save.
const LIMITS='Fridge 5°C or below · Freezer -15°C or below · Hot holding 60°C or above · initials = who checked · red = outside the safe range';
const logo=()=>document.querySelector('.login-original-logo')?.src;
const slotName=s=>s==='closing'?'Closing':'Opening';
async function makePdf(btn,build,msg=eqMsg){
 if(!window.MarinaraTempPdf){msg('PDF tools are still loading. Try again.');return;}
 const label=btn.textContent;btn.disabled=true;btn.textContent='Making the PDF…';
 try{await window.MarinaraTempPdf.open(build());}catch(err){msg(err.message||'Unable to make the PDF.');}
 finally{btn.disabled=false;btn.textContent=label;}
}
function weekReport(){
 const w=state.week;const days=[...Array(7)].map((_,i)=>addDays(w.start,i));
 const cell=new Map((w.cells||[]).map(c=>[`${c.equipment_id}|${c.day}|${c.slot}`,c]));
 const v=c=>c?{t:`${Number(c.temp).toFixed(1)} ${initials(checker(c))}`,bad:!c.ok}:null;
 return {kind:'week',title:'TEMPERATURE CHECK LIST',place:`Marinara ${w.location||''}`,when:`${shortDate(w.start)} - ${shortDate(days[6])}`,limits:LIMITS,logo:logo(),fileDate:w.start,
  foot:`Marinara Ristorante Cafe · printed ${dayLong(Date.now())}. Every reading is saved with who checked and the time; records cannot be changed.`,
  days:days.map(d=>{const [n,dd]=dayHead(d);return `${n} ${dd}`;}),
  rows:(w.equipment||[]).map(e=>({name:e.name,sub:KIND[e.kind][1],cells:days.map(d=>({opening:v(cell.get(`${e.id}|${d}|opening`)),closing:v(cell.get(`${e.id}|${d}|closing`))}))})),
  notes:(w.cells||[]).filter(c=>!c.ok).sort((a,b)=>a.recorded_at.localeCompare(b.recorded_at)).map(c=>{const [n,dd]=dayHead(c.day);return [`${n} ${dd}`,c.equipment||'',`${slotName(c.slot)} ${time(c.recorded_at)}`,deg(c.temp),c.action||'',checker(c)];})};
}
function recordsReport(){return recordsReportFrom(state.history||{});}
function recordsReportFrom(h){
 const recs=h.records||[];
 return {kind:'records',title:'TEMPERATURE RECORDS',place:`Marinara ${h.location||''}`,when:`Last ${h.days||90} days`,limits:LIMITS,logo:logo(),fileDate:`last-${h.days||90}-days`,
  foot:`Marinara Ristorante Cafe · printed ${dayLong(Date.now())}. ${recs.length} record${recs.length===1?'':'s'}. Checks cannot be changed; a corrected delivery shows its first values.`,
  records:recs.map(r=>[dayLong(r.recorded_at),time(r.recorded_at),r.kind==='equipment'?`${r.equipment||'Equipment'} - ${slotName(r.slot)}`:`Delivery: ${r.item}${r.supplier?` (${r.supplier})`:''} - ${KIND[r.food]?.[0]||''}`,deg(r.temp),[r.action||'',r.edited_at?`Corrected by ${r.edited_by||''} ${dayLong(r.edited_at)} ${time(r.edited_at)}; was: ${wasText(r)}`:''].filter(Boolean).join(' / '),checker(r)+(r.checked_by&&r.recorded_by&&r.checked_by!==r.recorded_by?` (typed by ${r.recorded_by})`:''),!r.ok])};
}
$('tmpPrintWeek').addEventListener('click',()=>{if(state.week)makePdf($('tmpPrintWeek'),weekReport);});
$('tmpPrint').addEventListener('click',()=>{if(state.history)makePdf($('tmpPrint'),recordsReport);});

/* ---------- Deliveries (receival) ---------- */
const TRUCK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h11v10H3z"/><path d="M14 9h4l3 3v4h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17.5" cy="17.5" r="1.8"/></svg>';
const dstate={list:null,gen:0,editing:null,at:0};
const dscreen=document.createElement('section');dscreen.id='deliveryScreen';dscreen.className='hidden';
const foodOpts=sel=>`<option value="chilled"${sel==='chilled'?' selected':''}>Chilled · 5°C or below</option><option value="frozen"${sel==='frozen'?' selected':''}>Frozen · -15°C or below</option>`;
dscreen.innerHTML=`<div class="manager-top"><div><h2>Deliveries</h2><p>Temperature of chilled and frozen deliveries · receival</p></div></div>
<form class="card shop-form" id="tmpDelivery" autocomplete="off">
 <input id="tmpItem" maxlength="80" placeholder="Product e.g. Cream, Prawns" aria-label="Product">
 <input id="tmpSupplier" maxlength="80" placeholder="Supplier (optional)" aria-label="Supplier" list="tmpSupList">
 <datalist id="tmpSupList"></datalist>
 <div class="shop-form-row"><select id="tmpFood" aria-label="Chilled or frozen">${foodOpts('chilled')}</select><button type="button" class="secondary tmp-sign" data-tmp-sign="tmpDTemp" aria-label="Change plus or minus">±</button><input id="tmpDTemp" inputmode="decimal" maxlength="6" placeholder="°C" aria-label="Temperature in °C"></div>
 <input id="tmpDAction" maxlength="200" placeholder="What did you do? e.g. Rejected, sent back" aria-label="Corrective action" hidden>
 <label class="tmp-who">Checked by <select id="tmpDWho" aria-label="Who did the check"><option value="">Me</option></select></label>
 <button type="submit" class="shop-primary" id="tmpDSave">Save delivery</button>
 <p class="rm-data-note" id="tmpDMsg" aria-live="polite"></p>
</form>
<h3 class="shop-h">Last 7 days</h3>
<p class="rm-data-note">Tap Edit to fix a mistake. The first values stay on record with who changed it.</p>
<div id="tmpDList"><div class="card shop-card"><div class="empty-state">Loading…</div></div></div>
<button type="button" class="shop-primary tmp-print-btn" id="tmpDPdf">PDF of deliveries (last 90 days)</button>`;
document.querySelector('main').append(dscreen);MANAGER_SCREEN_IDS.push(dscreen.id);
const dopener=document.createElement('button');dopener.type='button';dopener.id='rmOpenDeliveries';dopener.hidden=true;
dopener.onclick=()=>{showOnlyManagerScreen(dscreen.id);setManagerNavActive('operations');window.scrollTo(0,0);dstate.editing=null;renderDeliveries();loadDeliveries().catch(e=>dMsg(e.message||'Unable to load.'));};
document.body.append(dopener);
const drow=`<button type="button" class="rm-row" data-rm-go="rmOpenDeliveries">${TRUCK}<span><strong>Deliveries</strong><small>Receival temperatures</small></span><i aria-hidden="true">›</i></button>`;
for(const menu of [document.querySelector('#operationsScreen .rm-menu'),document.querySelector('#managerMoreScreen .rm-menu'),document.querySelector('#quickActionsDialog .rm-actions')])
 menu?.querySelector('[data-rm-go="rmOpenTemps"]')?.insertAdjacentHTML('afterend',drow);

async function loadDeliveries(){
 const gen=dstate.gen;if(!state.data)load().catch(()=>{});const h=await managerApi('manager_temp_history',{days:7});
 if(gen!==dstate.gen)return;dstate.list=(h.records||[]).filter(r=>r.kind==='receiving');dstate.at=Date.now();renderDeliveries();
}
function renderDeliveries(){
 fillWho('tmpDWho');const box=$('tmpDList');const list=dstate.list;
 const sups=[...new Set((list||[]).map(r=>r.supplier).filter(Boolean))].sort();
 $('tmpSupList').innerHTML=sups.map(x=>`<option value="${t(x)}">`).join('');
 if(!list){box.innerHTML='<div class="card shop-card"><div class="empty-state">Loading…</div></div>';return;}
 if(!list.length){box.innerHTML='<div class="card shop-card"><div class="empty-state">No deliveries in the last 7 days.</div></div>';return;}
 const byDay=new Map();for(const r of list){const k=dayLong(r.recorded_at);if(!byDay.has(k))byDay.set(k,[]);byDay.get(k).push(r);}
 box.innerHTML=[...byDay].map(([k,rs])=>`<h4 class="tmp-day">${t(k)}</h4><div class="card shop-card">${rs.map(r=>dstate.editing===r.id?editForm(r):`<div class="tmp-rec${r.ok?'':' bad'}"><span class="tmp-rec-main"><strong>${t(r.item)}${r.supplier?` · ${t(r.supplier)}`:''} <small>(${t(KIND[r.food]?.[0]||'')})</small></strong><small>${t(time(r.recorded_at))} · ${byLine(r)}${r.action?` · Action: ${t(r.action)}`:''}${editedNote(r)}</small></span><b>${t(deg(r.temp))}</b><button type="button" class="shop-small" data-tmp-dedit="${t(r.id)}">Edit</button></div>`).join('')}</div>`).join('');
}
function editForm(r){
 return `<div class="tmp-rec tmp-dedit" data-tmp-dform="${t(r.id)}"><div class="shop-form" style="width:100%;padding:0;box-shadow:none;border:0">
  <input data-f="item" maxlength="80" value="${t(r.item)}" aria-label="Product">
  <input data-f="supplier" maxlength="80" value="${t(r.supplier||'')}" placeholder="Supplier (optional)" aria-label="Supplier" list="tmpSupList">
  <div class="shop-form-row"><select data-f="food" aria-label="Chilled or frozen">${foodOpts(r.food)}</select><button type="button" class="secondary tmp-sign" data-tmp-sign="edit" aria-label="Change plus or minus">±</button><input data-f="temp" inputmode="decimal" maxlength="6" value="${t(Number(r.temp).toFixed(1))}" aria-label="Temperature in °C"></div>
  <input data-f="action" maxlength="200" value="${t(r.action||'')}" placeholder="What did you do? (needed outside the safe range)" aria-label="Corrective action">
  <label class="tmp-who">Checked by <select data-f="checked_by" aria-label="Who did the check">${whoOptions(r.checked_by_id&&r.checked_by!==r.recorded_by?r.checked_by_id:'')}</select></label>
  <div class="shop-form-row"><button type="button" class="shop-primary" data-tmp-dsave="${t(r.id)}">Save change</button><button type="button" class="secondary" data-tmp-dcancel>Cancel</button></div></div></div>`;
}
const deliveryOut=()=>{const v=num($('tmpDTemp').value);return v!==null&&!okFor($('tmpFood').value,v);};
const syncDelivery=()=>{$('tmpDAction').hidden=!deliveryOut();};
$('tmpDTemp').addEventListener('input',syncDelivery);$('tmpFood').addEventListener('change',syncDelivery);
const flip=i=>{const r=i.value.trim();i.value=r.startsWith('-')?r.slice(1):'-'+r;};
dscreen.addEventListener('click',async ev=>{
 const sg=ev.target.closest('[data-tmp-sign]');
 if(sg){const i=sg.dataset.tmpSign==='edit'?sg.closest('[data-tmp-dform]').querySelector('[data-f="temp"]'):$('tmpDTemp');flip(i);syncDelivery();i.focus();return;}
 const ed=ev.target.closest('[data-tmp-dedit]');if(ed){dstate.editing=ed.dataset.tmpDedit;renderDeliveries();dscreen.querySelector('[data-tmp-dform] [data-f="item"]')?.focus();return;}
 if(ev.target.closest('[data-tmp-dcancel]')){dstate.editing=null;dMsg('');renderDeliveries();return;}
 const sv=ev.target.closest('[data-tmp-dsave]');
 if(sv){const f=sv.closest('[data-tmp-dform]');const g=k=>f.querySelector(`[data-f="${k}"]`).value.trim();
  const entry={item:g('item'),supplier:g('supplier'),food:g('food'),temp:num(g('temp')),action:g('action'),checked_by:g('checked_by')};
  if(!entry.item){dMsg('Write the product.');return;}
  if(entry.temp===null){dMsg('Type the temperature in °C.');return;}
  if(!okFor(entry.food,entry.temp)&&!entry.action){dMsg('Outside the safe range. Write what you did (e.g. rejected).');f.querySelector('[data-f="action"]').focus();return;}
  sv.disabled=true;
  try{await managerApi('manager_temp_delivery_edit',{id:sv.dataset.tmpDsave,entry});dstate.editing=null;dMsg(`${entry.item}: change saved.`,true);await loadDeliveries();}
  catch(err){dMsg(err.message||'Unable to save the change.');sv.disabled=false;}
  return;}
});
$('tmpDelivery').addEventListener('submit',async ev=>{ev.preventDefault();
 const item=$('tmpItem').value.trim(),v=num($('tmpDTemp').value),action=$('tmpDAction').value.trim();
 if(!item){dMsg('Write the product.');return;}
 if(v===null){dMsg('Type the temperature in °C.');return;}
 if(deliveryOut()&&!action){syncDelivery();dMsg('Outside the safe range. Write what you did (e.g. rejected).');$('tmpDAction').focus();return;}
 const b=$('tmpDSave');b.disabled=true;
 try{await managerApi('manager_temp_record',{entry:{kind:'receiving',item,supplier:$('tmpSupplier').value.trim(),food:$('tmpFood').value,temp:v,action,checked_by:$('tmpDWho').value}});
  for(const id of ['tmpItem','tmpSupplier','tmpDTemp','tmpDAction'])$(id).value='';syncDelivery();dMsg(`${item}: ${deg(v)} saved.`,true);await loadDeliveries();}
 catch(err){dMsg(err.message||'Unable to save.');}finally{b.disabled=false;}
});
$('tmpDPdf').addEventListener('click',async()=>{
 const b=$('tmpDPdf');
 try{const h=await managerApi('manager_temp_history',{days:90});const recs=(h.records||[]).filter(r=>r.kind==='receiving');
  await makePdf(b,()=>({...recordsReportFrom({...h,records:recs}),title:'DELIVERY TEMPERATURES',fileDate:'deliveries-last-90-days',limits:'Chilled 5°C or below · Frozen -15°C or below · red = outside the safe range'}),dMsg);}
 catch(err){dMsg(err.message||'Unable to make the PDF.');}
});
function resetDeliveries(){dstate.gen++;dstate.list=null;dstate.editing=null;for(const id of ['tmpItem','tmpSupplier','tmpDTemp','tmpDAction'])$(id).value='';$('tmpDMsg').textContent='';syncDelivery();renderDeliveries();}

window.addEventListener('marinara:dashboard',()=>{if(Date.now()-state.at>60e3)load().catch(()=>{});});
window.addEventListener('marinara:session-reset',()=>{state.gen++;state.data=null;state.week=null;state.start=null;state.at=0;state.pending=null;state.sign=null;state.recheck=null;state.scrolled=false;state.removing=null;state.history=null;$('tmpDetail').hidden=true;$('tmpRecords').classList.add('hidden');$('tmpRecList').innerHTML='';$('tmpEqMsg').textContent='';publish();render();resetDeliveries();});
})();
