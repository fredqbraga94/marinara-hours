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
const state={data:null,at:0,gen:0,need:{},removing:null,history:null};

/* ---------- Screen ---------- */
const screen=document.createElement('section');screen.id='tempScreen';screen.className='hidden';
screen.innerHTML=`<div class="manager-top"><div><h2>Temperatures</h2><p>Daily checks and deliveries · records for the council</p></div></div>
<h3 class="shop-h">Today <span id="tmpCount"></span></h3>
<div class="card shop-card"><div id="tmpEquip" class="empty-state">Loading…</div></div>
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
 <div class="shop-form-row"><input id="tmpEqName" maxlength="60" placeholder="Add equipment e.g. Cool room" aria-label="Equipment name"><select id="tmpEqKind" aria-label="Type"><option value="fridge">Fridge</option><option value="freezer">Freezer</option><option value="hot">Hot holding</option></select></div>
 <button type="submit" class="secondary" id="tmpEqSave">Add equipment</button>
 <p class="rm-data-note" id="tmpEqMsg" aria-live="polite"></p>
</form>
<h3 class="shop-h">Records for the council</h3>
<div class="card shop-form"><p class="rm-data-note" style="margin:0">Keep at least 3 months. Records cannot be changed or deleted; a mistake is fixed with a new reading.</p>
 <button type="button" class="secondary" id="tmpHistBtn">Show the last 90 days</button></div>
<div id="tmpRecords" class="hidden"><div class="tmp-print-head"><strong>Temperature records</strong><span id="tmpRecHead"></span></div>
 <button type="button" class="shop-primary tmp-print-btn" id="tmpPrint">Print or save as PDF</button>
 <div id="tmpRecList"></div></div>`;
document.querySelector('main').append(screen);MANAGER_SCREEN_IDS.push(screen.id);

const opener=document.createElement('button');opener.type='button';opener.id='rmOpenTemps';opener.hidden=true;
opener.onclick=()=>{showOnlyManagerScreen(screen.id);setManagerNavActive('operations');window.scrollTo(0,0);render();load().catch(e=>eqMsg(e.message||'Unable to load.'));};
document.body.append(opener);
const menuRow=`<button type="button" class="rm-row" data-rm-go="rmOpenTemps">${THERMO}<span><strong>Temperatures</strong><small>Daily checks for the council</small></span><i aria-hidden="true">›</i></button>`;
for(const menu of [document.querySelector('#operationsScreen .rm-menu'),document.querySelector('#managerMoreScreen .rm-menu'),document.querySelector('#quickActionsDialog .rm-actions')]){
 const after=menu?.querySelector('[data-rm-go="rmOpenMaintenance"]')||menu?.querySelector('[data-rm-go="stockCard"]');
 if(after)after.insertAdjacentHTML('afterend',menuRow);else menu?.insertAdjacentHTML('beforeend',menuRow);
}

const say=(id,text,ok)=>{const m=$(id);m.textContent=text||'';m.style.color=ok?'#07613b':text?'#b3261e':'';};
const eqMsg=(x,ok)=>say('tmpEqMsg',x,ok),dMsg=(x,ok)=>say('tmpDMsg',x,ok);

async function load(){
 const gen=state.gen;
 const d=await managerApi('manager_temp_today');
 if(gen!==state.gen)return;
 state.data=d;state.at=Date.now();publish();render();
}
// Home: "N temperature checks to do today".
function publish(){
 const d=state.data||{};window.mhTemps={missing:Number(d.missing)||0,total:(d.equipment||[]).length,names:(d.equipment||[]).filter(e=>!e.today).map(e=>e.name)};
 window.dispatchEvent(new CustomEvent('marinara:temps'));
}
window.mhTemps={missing:0,total:0,names:[]};

function recLine(r){
 const what=r.kind==='equipment'?t(r.equipment||'Equipment'):`${t(r.item)}${r.supplier?` · ${t(r.supplier)}`:''} <small>(${t(KIND[r.food]?.[0]||'')} delivery)</small>`;
 return `<div class="tmp-rec${r.ok?'':' bad'}"><span class="tmp-rec-main"><strong>${what}</strong><small>${t(time(r.recorded_at))} · ${t(r.recorded_by||'')}${r.action?` · Action: ${t(r.action)}`:''}</small></span><b>${t(deg(r.temp))}</b></div>`;
}
function render(){
 const d=state.data;
 const box=$('tmpEquip');
 if(!d){box.className='empty-state';box.textContent='Loading…';return;}
 const eq=d.equipment||[];
 $('tmpCount').textContent=eq.length?`(${eq.length-Number(d.missing||0)} of ${eq.length} checked)`:'';
 if(!eq.length){box.className='empty-state';box.textContent='Add your fridges, freezers and hot holding below to start the daily checks.';}
 else{box.className='';box.innerHTML=eq.map(e=>{
  const last=e.today;const need=state.need[e.id];
  const status=last?`<small class="${last.ok?'tmp-ok':'tmp-bad'}">${last.ok?'✓':'⚠'} ${t(deg(last.temp))} at ${t(time(last.recorded_at))} · ${t(last.recorded_by||'')}</small>`:'<small class="tmp-todo">Not checked today</small>';
  return `<div class="tmp-eq${last?'':' todo'}"><div class="tmp-eq-top"><span class="tmp-rec-main"><strong>${t(e.name)}</strong><small>${t(KIND[e.kind][0])} · ${t(KIND[e.kind][1])}</small>${status}</span>
   <span class="tmp-in"><input inputmode="decimal" maxlength="6" placeholder="°C" aria-label="Temperature of ${t(e.name)} in °C" data-tmp-temp="${t(e.id)}" value="${t(need?.temp??'')}"><button type="button" class="shop-primary" data-tmp-save="${t(e.id)}">Save</button></span></div>
   ${need?`<div class="tmp-need"><p>${t(deg(need.temp))} is outside the safe range (${t(KIND[e.kind][1])}). Write what you did.</p><input maxlength="200" placeholder="e.g. Moved food to the other fridge, called the technician" aria-label="Corrective action" data-tmp-action="${t(e.id)}"></div>`:''}</div>`;}).join('');}
 const today=d.today||[];const tb=$('tmpToday');
 if(!today.length){tb.className='empty-state';tb.textContent='Nothing yet today.';}else{tb.className='';tb.innerHTML=today.map(recLine).join('');}
 const lb=$('tmpList');
 if(!eq.length){lb.className='empty-state';lb.textContent='No equipment yet.';}
 else{lb.className='';lb.innerHTML=eq.map(e=>`<div class="tmp-rec"><span class="tmp-rec-main"><strong>${t(e.name)}</strong><small>${t(KIND[e.kind][0])} · ${t(KIND[e.kind][1])}</small></span><button type="button" class="shop-small" data-tmp-remove="${t(e.id)}">${state.removing===e.id?'Tap again to remove':'Remove'}</button></div>`).join('');}
}

async function saveReading(id){
 const input=screen.querySelector(`[data-tmp-temp="${CSS.escape(id)}"]`);const v=num(input?.value);
 const e=(state.data?.equipment||[]).find(x=>x.id===id);if(!e)return;
 if(v===null){eqMsg('Type the temperature in °C, e.g. 3.5');input?.focus();return;}
 const actionEl=screen.querySelector(`[data-tmp-action="${CSS.escape(id)}"]`);const action=(actionEl?.value||'').trim();
 if(!okFor(e.kind,v)&&!action){state.need[id]={temp:v};render();screen.querySelector(`[data-tmp-action="${CSS.escape(id)}"]`)?.focus();return;}
 const b=screen.querySelector(`[data-tmp-save="${CSS.escape(id)}"]`);if(b){b.disabled=true;b.textContent='Saving…';}
 try{await managerApi('manager_temp_record',{entry:{kind:'equipment',equipment_id:id,temp:v,action}});delete state.need[id];eqMsg(`${e.name}: ${deg(v)} saved.`,true);await load();}
 catch(err){eqMsg(err.message||'Unable to save.');if(b){b.disabled=false;b.textContent='Save';}}
}
screen.addEventListener('click',async ev=>{
 const s=ev.target.closest('[data-tmp-save]');if(s){saveReading(s.dataset.tmpSave);return;}
 const r=ev.target.closest('[data-tmp-remove]');
 if(r){const id=r.dataset.tmpRemove;if(state.removing!==id){state.removing=id;render();return;}
  r.disabled=true;try{await managerApi('manager_temp_equipment_save',{item:{id,active:false}});state.removing=null;eqMsg('Removed from the list. Its records are kept.',true);await load();}catch(err){eqMsg(err.message||'Unable to remove.');r.disabled=false;}}
});
screen.addEventListener('keydown',ev=>{if(ev.key!=='Enter')return;const i=ev.target.closest('[data-tmp-temp],[data-tmp-action]');if(!i)return;ev.preventDefault();saveReading(i.dataset.tmpTemp||i.dataset.tmpAction);});
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
$('tmpPrint').addEventListener('click',()=>{document.body.classList.add('tmp-printing');const done=()=>{document.body.classList.remove('tmp-printing');window.removeEventListener('afterprint',done);};window.addEventListener('afterprint',done);window.print();setTimeout(done,60000);});

window.addEventListener('marinara:dashboard',()=>{if(Date.now()-state.at>60e3)load().catch(()=>{});});
window.addEventListener('marinara:session-reset',()=>{state.gen++;state.data=null;state.at=0;state.need={};state.removing=null;state.history=null;$('tmpRecords').classList.add('hidden');$('tmpRecList').innerHTML='';for(const id of ['tmpEqMsg','tmpDMsg'])$(id).textContent='';publish();render();});
})();
