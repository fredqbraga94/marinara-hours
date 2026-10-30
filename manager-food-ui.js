/* Food temperatures and Cleaning (Standard 3.2.2A, Eat Safe Brisbane).
   Food temperatures: pick the check (cooking, reheating, hot or cold holding,
   cooling), type the food and the °C, Save; today's readings show as a table.
   Cooling: the start reading, then the 2-hour and 6-hour readings appear as
   "Cooling in progress" with their own box. A reading of today can be
   corrected; its first values stay on record.
   Cleaning: the weekly sheet (tasks x MON-SUN); tap today's box when a task is
   done, with who did it. Every manager can record; the server keeps who and
   when. */
(() => {
const $=id=>document.getElementById(id);
const t=v=>escapeHtml(String(v??''));
const num=s=>{const v=Number(String(s??'').trim().replace(',','.'));return String(s??'').trim()===''||!Number.isFinite(v)?null:v;};
const deg=v=>`${Number(v).toLocaleString('en-AU',{minimumFractionDigits:1,maximumFractionDigits:1})}°C`;
const time=v=>new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',hour:'numeric',minute:'2-digit'}).format(new Date(v));
const dayLong=v=>new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',weekday:'short',day:'numeric',month:'short',year:'numeric'}).format(new Date(v));
const isoLong=iso=>new Intl.DateTimeFormat('en-AU',{timeZone:'UTC',weekday:'short',day:'numeric',month:'short'}).format(new Date(`${iso}T00:00:00Z`));
const shortDate=iso=>new Intl.DateTimeFormat('en-AU',{timeZone:'UTC',day:'numeric',month:'short'}).format(new Date(`${iso}T00:00:00Z`));
const addDays=(iso,n)=>{const d=new Date(`${iso}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const dayHead=iso=>{const d=new Date(`${iso}T00:00:00Z`);return [['SUN','MON','TUE','WED','THU','FRI','SAT'][d.getUTCDay()],d.getUTCDate()];};
const initials=n=>String(n||'').split(/\s+/).filter(Boolean).map(w=>w[0]).join('').slice(0,3).toUpperCase();
const mins=m=>{m=Math.max(0,Math.round(m));const h=Math.floor(m/60),r=m%60;return h?`${h} h${r?` ${r} min`:''}`:`${r} min`;};
const say=(id,text,ok)=>{const m=$(id);if(!m)return;m.textContent=text||'';m.style.color=ok?'#07613b':text?'#b3261e':'';};
const logo=()=>document.querySelector('.login-original-logo')?.src;
const whoOptions=(people,sel)=>`<option value="">Me</option>${(people||[]).map(p=>`<option value="${t(p.id)}"${p.id===sel?' selected':''}>${t(p.name)}</option>`).join('')}`;
function fillWho(el,people){if(!el)return;const v=el.value;el.innerHTML=whoOptions(people,v);el.value=[...el.options].some(o=>o.value===v)?v:'';}
async function makePdf(btn,build,msg){
 if(!window.MarinaraTempPdf){msg('PDF tools are still loading. Try again.');return;}
 const label=btn.textContent;btn.disabled=true;btn.textContent='Making the PDF…';
 try{await window.MarinaraTempPdf.open(await build());}catch(err){msg(err.message||'Unable to make the PDF.');}
 finally{btn.disabled=false;btn.textContent=label;}
}
function addMenuRow(id,html,afterGo){
 for(const menu of [document.querySelector('#operationsScreen .rm-menu'),document.querySelector('#managerMoreScreen .rm-menu'),document.querySelector('#quickActionsDialog .rm-actions')]){
  if(!menu)continue;const after=[...afterGo].map(g=>menu.querySelector(`[data-rm-go="${g}"]`)).find(Boolean);
  if(after)after.insertAdjacentHTML('afterend',html);else menu.insertAdjacentHTML('beforeend',html);
 }
}

/* =================== Food temperatures =================== */
const CHECKS={cook:['Cooking','75°C or above'],reheat:['Reheating','75°C or above'],hot:['Hot holding','60°C or above'],cold:['Cold holding','5°C or below'],cool:['Cooling','start']};
const STAGE=['Cooling start','Cooling 2 h','Cooling 6 h'];
const STAGE_RULE=['',`21°C or below within 2 h`,`5°C or below within 6 h`];
const foodOk=(check,stage,v,m)=>check==='cook'||check==='reheat'?v>=75:check==='hot'?v>=60:check==='cold'?v<=5:check==='cool'?(stage===0?true:stage===1?v<=21&&m<=125:v<=5&&m<=365):false;
const checkName=r=>r.check==='cool'?STAGE[r.stage]||'Cooling':CHECKS[r.check]?.[0]||'';
const FOOD_LIMITS='Cooking and reheating 75°C or above · Hot holding 60°C or above · Cold holding 5°C or below · Cooling: from 60°C to 21°C within 2 hours, then to 5°C within 6 hours of the start';
const fstate={data:null,day:null,check:'cook',gen:0,at:0,editing:null,cpend:null};
const THERMO2='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 9v7"/><path d="M18 4c1 1 1 2 0 3s-1 2 0 3"/></svg>';
const fscreen=document.createElement('section');fscreen.id='foodTempScreen';fscreen.className='hidden';
fscreen.innerHTML=`<div class="manager-top"><div><h2>Food temperatures</h2><p>Cooking, reheating, hot and cold holding, cooling</p></div></div>
<div class="tmp-week-nav"><button type="button" class="shop-small" id="ftPrev" aria-label="Previous day">‹</button><strong id="ftDayLabel">Today</strong><button type="button" class="shop-small" id="ftNext" aria-label="Next day">›</button><button type="button" class="shop-small" id="ftToday" hidden>Today</button></div>
<form class="card shop-form" id="ftForm" autocomplete="off">
 <div class="ft-checks" role="group" aria-label="Which check">${Object.entries(CHECKS).map(([k,[n,r]])=>`<button type="button" class="ft-chip" data-ft-check="${k}" aria-pressed="${k==='cook'}"><strong>${n}</strong><small>${k==='cool'?'start · then 2 h and 6 h':r}</small></button>`).join('')}</div>
 <input id="ftFood" maxlength="80" placeholder="Food e.g. Bolognese, Chicken, Soup" aria-label="Food" list="ftFoods"><datalist id="ftFoods"></datalist>
 <div class="shop-form-row"><input id="ftTemp" inputmode="decimal" maxlength="6" placeholder="°C" aria-label="Temperature in °C"><button type="submit" class="shop-primary" id="ftSave">Save</button></div>
 <input id="ftAction" maxlength="200" placeholder="What did you do? e.g. Cooked longer to 80°C" aria-label="Corrective action" hidden>
 <label class="tmp-who">Checked by <select id="ftWho" aria-label="Who did the check"><option value="">Me</option></select></label>
 <p class="rm-data-note" id="ftMsg" aria-live="polite"></p>
</form>
<div id="ftCooling"></div>
<h3 class="shop-h" id="ftListHead">Today</h3>
<div class="tmp-sheet-wrap"><div id="ftList" class="empty-state">Loading…</div></div>
<p class="rm-data-note">${FOOD_LIMITS}. Red = outside the safe range. A reading of today can be corrected; the first values stay on record.</p>
<button type="button" class="shop-primary tmp-print-btn" id="ftPdf">PDF of the last 90 days (council record)</button>`;
document.querySelector('main').append(fscreen);MANAGER_SCREEN_IDS.push(fscreen.id);
const fopener=document.createElement('button');fopener.type='button';fopener.id='rmOpenFoodTemps';fopener.hidden=true;
fopener.onclick=()=>{showOnlyManagerScreen(fscreen.id);setManagerNavActive('operations');window.scrollTo(0,0);fstate.day=null;fstate.editing=null;fstate.cpend=null;renderFood();loadFood().catch(e=>say('ftMsg',e.message||'Unable to load.'));};
document.body.append(fopener);
const fmsg=(x,ok)=>say('ftMsg',x,ok);

async function loadFood(){
 const gen=fstate.gen;const d=await managerApi('manager_food_day',fstate.day?{day:fstate.day}:{});
 if(gen!==fstate.gen)return;fstate.data=d;fstate.at=Date.now();renderFood();
}
const isToday=()=>!fstate.data||fstate.data.day===fstate.data.today;
function foodRow(r,today){
 if(fstate.editing===r.id)return `<tr class="ft-editrow"><td colspan="5"><div class="ft-edit" data-ft-eform="${t(r.id)}">
  <input data-f="food" maxlength="80" value="${t(r.food)}" aria-label="Food"${r.stage>0?' disabled':''}>
  <div class="shop-form-row"><input data-f="temp" inputmode="decimal" maxlength="6" value="${t(Number(r.temp).toFixed(1))}" aria-label="Temperature in °C"><input data-f="action" maxlength="200" value="${t(r.action||'')}" placeholder="What did you do? (needed outside the safe range)" aria-label="Corrective action"></div>
  <label class="tmp-who">Checked by <select data-f="checked_by" aria-label="Who did the check">${whoOptions(fstate.data?.people,r.checked_by&&r.checked_by!==r.recorded_by?r.checked_by_id:'')}</select></label>
  <div class="shop-form-row"><button type="button" class="shop-primary" data-ft-esave="${t(r.id)}">Save change</button><button type="button" class="secondary" data-ft-ecancel>Cancel</button></div></div></td></tr>`;
 const was=r.original?`<em class="tmp-edited">Corrected by ${t(r.edited_by||'')} ${t(time(r.edited_at))} · was: ${t([r.original.food!==r.food?r.original.food:'',r.original.temp!=null?deg(r.original.temp):'',r.original.checked_by&&r.original.checked_by!==r.checked_by?`by ${r.original.checked_by}`:''].filter(Boolean).join(' · '))}</em>`:'';
 const by=`${t(r.checked_by||r.recorded_by||'')}${r.checked_by&&r.recorded_by&&r.checked_by!==r.recorded_by?` (typed by ${t(r.recorded_by)})`:''}`;
 return `<tr class="${r.ok?'':'bad'}"><td class="ft-time">${t(time(r.recorded_at))}</td><td class="ft-food"><strong>${t(r.food)}</strong><small class="ft-by">by ${by}</small>${r.action?`<small>Action: ${t(r.action)}</small>`:''}${was}</td><td class="ft-check">${t(checkName(r))}${r.minutes!=null?`<small>after ${t(mins(r.minutes))}</small>`:''}</td><td class="ft-temp"><b>${t(deg(r.temp))}</b></td><td class="ft-act">${today?`<button type="button" class="shop-small" data-ft-edit="${t(r.id)}">Edit</button>`:''}</td></tr>`;
}
function renderFood(){
 const d=fstate.data,today=isToday();
 $('ftForm').hidden=!today;
 for(const b of fscreen.querySelectorAll('[data-ft-check]'))b.setAttribute('aria-pressed',String(b.dataset.ftCheck===fstate.check));
 $('ftFood').placeholder=fstate.check==='cool'?'Food to cool e.g. Bolognese, Stock':'Food e.g. Bolognese, Chicken, Soup';
 fillWho($('ftWho'),d?.people);
 $('ftFoods').innerHTML=(d?.foods||[]).map(x=>`<option value="${t(x)}">`).join('');
 syncFood();
 if(d){$('ftDayLabel').textContent=today?`Today · ${isoLong(d.day)}`:isoLong(d.day);$('ftToday').hidden=today;$('ftNext').disabled=today;$('ftListHead').textContent=today?'Today':isoLong(d.day);}
 // Cooling in progress (today only).
 const cb=$('ftCooling');const cool=today?(d?.cooling||[]):[];
 cb.innerHTML=cool.length?`<h3 class="shop-h">Cooling in progress</h3><div class="card shop-card">${cool.map(c=>{const s=c.start;const due=new Date(new Date(s.recorded_at).getTime()+(c.next===1?120:360)*60e3);const late=Date.now()>due.getTime();const p=fstate.cpend?.id===s.id;
  return `<div class="ft-cool${late?' late':''}" data-ft-batch="${t(s.id)}"><div class="tmp-rec-main"><strong>${t(s.food)}</strong><small>Started ${t(time(s.recorded_at))} at ${t(deg(s.temp))} · next: <b>${c.next===1?'2-hour':'6-hour'} reading</b> (${t(STAGE_RULE[c.next])}) · due by ${t(time(due))}${late?' · late':''}</small></div>
   <div class="shop-form-row"><input data-ft-ctemp inputmode="decimal" maxlength="6" placeholder="°C" aria-label="${t(s.food)} ${c.next===1?'2-hour':'6-hour'} reading °C" value="${p?t(fstate.cpend.temp):''}"><button type="button" class="shop-primary" data-ft-csave="${t(s.id)}" data-next="${c.next}">Save</button></div>
   ${p?`<input data-ft-caction maxlength="200" placeholder="Outside the safe range. What did you do? e.g. Thrown away" aria-label="Corrective action">`:''}</div>`;}).join('')}</div>`:'';
 const box=$('ftList');
 if(!d){box.className='empty-state';box.textContent='Loading…';return;}
 const recs=d.records||[];
 if(!recs.length){box.className='empty-state';box.textContent=today?'No food temperatures yet today. Choose the check above, type the food and the °C, then Save.':'No food temperatures this day.';return;}
 box.className='';box.innerHTML=`<table class="ft-table"><thead><tr><th>Time</th><th>Food · checked by</th><th>Check</th><th>°C</th><th aria-label="Edit"></th></tr></thead><tbody>${recs.map(r=>foodRow(r,today)).join('')}</tbody></table>`;
}
const foodOut=()=>{const v=num($('ftTemp').value);return v!==null&&!foodOk(fstate.check,0,v,0);};
function syncFood(){$('ftAction').hidden=!foodOut();}
$('ftTemp').addEventListener('input',syncFood);
fscreen.addEventListener('click',async ev=>{
 const ch=ev.target.closest('[data-ft-check]');if(ch){fstate.check=ch.dataset.ftCheck;renderFood();$('ftFood').focus();return;}
 if(ev.target.closest('#ftPrev')){fstate.day=addDays(fstate.data?.day||new Date().toISOString().slice(0,10),-1);fstate.editing=null;loadFood().catch(e=>fmsg(e.message));return;}
 if(ev.target.closest('#ftNext')){const d=fstate.data;if(!d)return;const n=addDays(d.day,1);fstate.day=n>=d.today?null:n;loadFood().catch(e=>fmsg(e.message));return;}
 if(ev.target.closest('#ftToday')){fstate.day=null;loadFood().catch(e=>fmsg(e.message));return;}
 const ed=ev.target.closest('[data-ft-edit]');if(ed){fstate.editing=ed.dataset.ftEdit;renderFood();fscreen.querySelector('[data-ft-eform] [data-f="temp"]')?.focus();return;}
 if(ev.target.closest('[data-ft-ecancel]')){fstate.editing=null;fmsg('');renderFood();return;}
 const es=ev.target.closest('[data-ft-esave]');
 if(es){const f=es.closest('[data-ft-eform]');const g=k=>f.querySelector(`[data-f="${k}"]`).value.trim();const r=(fstate.data?.records||[]).find(x=>x.id===es.dataset.ftEsave);if(!r)return;
  const entry={food:g('food'),temp:num(g('temp')),action:g('action'),checked_by:g('checked_by')};
  if(!entry.food){fmsg('Write the food.');return;}
  if(entry.temp===null){fmsg('Type the temperature in °C.');return;}
  if(!foodOk(r.check,r.stage,entry.temp,r.minutes||0)&&!entry.action){fmsg('Outside the safe range. Write what you did.');f.querySelector('[data-f="action"]').focus();return;}
  es.disabled=true;
  try{await managerApi('manager_food_edit',{id:r.id,entry});fstate.editing=null;fmsg(`${entry.food}: change saved.`,true);await loadFood();}
  catch(err){fmsg(err.message||'Unable to save the change.');es.disabled=false;}
  return;}
 const cs=ev.target.closest('[data-ft-csave]');
 if(cs){const wrap=cs.closest('[data-ft-batch]');const id=cs.dataset.ftCsave;const next=Number(cs.dataset.next);const c=(fstate.data?.cooling||[]).find(x=>x.start.id===id);if(!c)return;
  const v=num(wrap.querySelector('[data-ft-ctemp]').value);if(v===null){fmsg('Type the temperature in °C.');return;}
  const m=(Date.now()-new Date(c.start.recorded_at).getTime())/60e3;
  const action=(wrap.querySelector('[data-ft-caction]')?.value||'').trim();
  if(!foodOk('cool',next,v,m)&&!action){fstate.cpend={id,temp:String(v)};renderFood();fmsg(`${c.start.food}: ${deg(v)} after ${mins(m)} is outside the safe range (${STAGE_RULE[next]}). Write what you did.`);fscreen.querySelector('[data-ft-caction]')?.focus();return;}
  cs.disabled=true;
  try{await managerApi('manager_food_record',{entry:{batch_id:id,temp:v,action,checked_by:$('ftWho').value}});fstate.cpend=null;fmsg(`${c.start.food} · ${STAGE[next]}: ${deg(v)} saved.`,true);await loadFood();}
  catch(err){cs.disabled=false;
   if(!action&&(err.code==='ACTION_REQUIRED'||/outside the safe range/i.test(err.message||''))){fstate.cpend={id,temp:String(v)};renderFood();fmsg(`${c.start.food}: ${deg(v)} is outside the safe range (${STAGE_RULE[next]}). Write what you did.`);fscreen.querySelector('[data-ft-caction]')?.focus();}
   else fmsg(err.message||'Unable to save.');}
  return;}
});
fscreen.addEventListener('keydown',ev=>{if(ev.key==='Enter'&&ev.target.matches('[data-ft-ctemp],[data-ft-caction]')){ev.preventDefault();ev.target.closest('[data-ft-batch]').querySelector('[data-ft-csave]').click();}});
$('ftForm').addEventListener('submit',async ev=>{ev.preventDefault();
 const food=$('ftFood').value.trim(),v=num($('ftTemp').value),action=$('ftAction').value.trim(),check=fstate.check;
 if(!food){fmsg('Write the food.');$('ftFood').focus();return;}
 if(v===null){fmsg('Type the temperature in °C, e.g. 82');$('ftTemp').focus();return;}
 if(foodOut()&&!action){syncFood();fmsg(`${deg(v)} is outside the safe range for ${CHECKS[check][0].toLowerCase()} (${CHECKS[check][1]}). Write what you did.`);$('ftAction').focus();return;}
 const b=$('ftSave');b.disabled=true;
 try{await managerApi('manager_food_record',{entry:{food,check,temp:v,action,checked_by:$('ftWho').value}});
  $('ftFood').value='';$('ftTemp').value='';$('ftAction').value='';syncFood();
  fmsg(check==='cool'?`${food}: cooling started at ${deg(v)}. The 2-hour reading is below in Cooling in progress.`:`${food} · ${CHECKS[check][0]}: ${deg(v)} saved.`,true);await loadFood();}
 catch(err){fmsg(err.message||'Unable to save.');}finally{b.disabled=false;}
});
$('ftPdf').addEventListener('click',()=>makePdf($('ftPdf'),async()=>{
 const h=await managerApi('manager_food_history',{days:90});const recs=h.records||[];
 return {kind:'table',landscape:true,title:'FOOD TEMPERATURE RECORD',place:`Marinara ${h.location||''}`,when:`Last ${h.days||90} days`,limits:FOOD_LIMITS,logo:logo(),
  filePrefix:'Marinara-Food-Temperatures-',fileDate:`last-${h.days||90}-days`,shareTitle:'Marinara food temperatures',
  foot:`Marinara Ristorante Cafe · printed ${dayLong(Date.now())}. ${recs.length} record${recs.length===1?'':'s'}. A corrected reading shows its first values.`,
  head:['Date','Time','Food','Check','Temp','Action taken','Checked by'],widths:{0:30,1:16,3:30,4:16,5:80},badCol:4,bad:recs.map(r=>!r.ok),
  rows:recs.map(r=>[dayLong(r.recorded_at),time(r.recorded_at),r.food,`${checkName(r)}${r.minutes!=null?` (after ${mins(r.minutes)})`:''}`,deg(r.temp),
   [r.action||'',r.edited_at?`Corrected by ${r.edited_by||''} ${time(r.edited_at)}; was: ${[r.original?.food,r.original?.temp!=null?deg(r.original.temp):''].filter(Boolean).join(' ')}`:''].filter(Boolean).join(' / '),
   (r.checked_by||r.recorded_by||'')+(r.checked_by&&r.recorded_by&&r.checked_by!==r.recorded_by?` (typed by ${r.recorded_by})`:'')])};
},fmsg));

/* =================== Cleaning =================== */
const USUAL=[
 ['Benches and prep surfaces','Wash, rinse, sanitise','daily'],
 ['Chopping boards and knives','Dishwasher, or wash and sanitise','daily'],
 ['Stove, grill and fryer area','Degrease and wipe','daily'],
 ['Pizza and pasta stations','Wash, rinse, sanitise','daily'],
 ['Sinks and taps','Wash and sanitise','daily'],
 ['Fridge handles and door seals','Wipe and sanitise','daily'],
 ['Kitchen floor','Sweep and mop','daily'],
 ['Bins','Empty, wash lids','daily'],
 ['Hand basins','Soap and paper towels stocked','daily'],
 ['Inside fridges and cool room','Empty shelves, wash, sanitise','weekly'],
 ['Freezer shelves','Wipe and tidy','weekly'],
 ['Ovens and pizza oven','Deep clean','weekly'],
 ['Rangehood filters','Degrease','weekly'],
 ['Walls and splashbacks','Wash','weekly'],
 ['Dry store shelves','Wipe, check for pests','weekly'],
 ['Floor drains','Clean and flush','weekly'],
];
const FREQ={daily:'Every day',weekly:'Once a week'};
const cstate={week:null,start:null,gen:0,at:0,undo:null,removing:null};
const BROOM='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3l-4 9"/><path d="M6 12h8l2 9H4z"/><path d="M8 16v5M12 16v5"/></svg>';
const cscreen=document.createElement('section');cscreen.id='cleanScreen';cscreen.className='hidden';
cscreen.innerHTML=`<div class="manager-top"><div><h2>Cleaning</h2><p>Cleaning schedule · tick what was done</p></div></div>
<div class="tmp-week-nav"><button type="button" class="shop-small" id="clPrev" aria-label="Previous week">‹</button><strong id="clWeekLabel">This week</strong><button type="button" class="shop-small" id="clNext" aria-label="Next week">›</button><button type="button" class="shop-small" id="clThis" hidden>This week</button></div>
<label class="tmp-who">Done by <select id="clWho" aria-label="Who did it"><option value="">Me</option></select></label>
<p class="rm-data-note" id="clHint">Tap today's box when a task is done. Tap it again to undo (today only).</p>
<div class="tmp-sheet-wrap" id="clSheetWrap"><div id="clSheet" class="empty-state">Loading…</div></div>
<p class="rm-data-note" id="clMsg" aria-live="polite"></p>
<button type="button" class="shop-primary tmp-print-btn" id="clPdf">PDF of this week (council sheet)</button>
<h3 class="shop-h">Tasks</h3>
<div class="card shop-card"><div id="clList" class="empty-state">No tasks yet.</div></div>
<form class="card shop-form" id="clForm" autocomplete="off">
 <button type="button" class="secondary" id="clUsual" hidden>Add the usual kitchen list (16 tasks)</button>
 <input id="clName" maxlength="80" placeholder="Add a task e.g. Coffee machine" aria-label="Task">
 <input id="clHow" maxlength="120" placeholder="How (optional) e.g. Wash, rinse, sanitise" aria-label="How">
 <select id="clFreq" aria-label="How often"><option value="daily">Every day</option><option value="weekly">Once a week</option></select>
 <button type="submit" class="secondary" id="clAdd">Add task</button>
</form>`;
document.querySelector('main').append(cscreen);MANAGER_SCREEN_IDS.push(cscreen.id);
const copener=document.createElement('button');copener.type='button';copener.id='rmOpenCleaning';copener.hidden=true;
copener.onclick=()=>{showOnlyManagerScreen(cscreen.id);setManagerNavActive('operations');window.scrollTo(0,0);cstate.start=null;cstate.undo=null;renderClean();loadClean().catch(e=>cmsg(e.message||'Unable to load.'));};
document.body.append(copener);
const cmsg=(x,ok)=>say('clMsg',x,ok);
async function loadClean(){
 const gen=cstate.gen;const w=await managerApi('manager_clean_week',cstate.start?{start:cstate.start}:{});
 if(gen!==cstate.gen)return;cstate.week=w;cstate.at=Date.now();renderClean();
}
function cleanSheet(w){
 const days=[...Array(7)].map((_,i)=>addDays(w.start,i));
 const done=new Map((w.done||[]).map(x=>[`${x.task_id}|${x.day}`,x]));
 const head=`<tr><th class="tmp-eqcol">Task</th>${days.map(d=>{const [n,dd]=dayHead(d);return `<th class="${d===w.today?'tmp-today':''}">${n}<small>${dd}</small></th>`;}).join('')}</tr>`;
 const group=f=>{const tasks=(w.tasks||[]).filter(x=>x.frequency===f);if(!tasks.length)return '';
  return `<tr class="cl-group"><th class="tmp-eqcol cl-groupcell" scope="rowgroup">${FREQ[f]}</th>${days.map(()=>'<td></td>').join('')}</tr>`+tasks.map(task=>{
   const weekDone=f==='weekly'&&days.some(d=>done.has(`${task.id}|${d}`));
   return `<tr><th class="tmp-eqcol" scope="row"><span>${t(task.name)}</span>${task.how?`<small>${t(task.how)}</small>`:''}${weekDone?'<small class="cl-weekdone">Done this week</small>':''}</th>${days.map(d=>{
    const x=done.get(`${task.id}|${d}`);const key=`${task.id}|${d}`;const today=d===w.today&&task.active;
    if(x)return `<td class="cl-done${d===w.today?' tmp-today':''}">${today?`<button type="button" class="cl-box on${cstate.undo===key?' undo':''}" data-cl-undo="${t(task.id)}" aria-label="${t(task.name)} done by ${t(x.by)}. Tap to undo">${cstate.undo===key?'Undo?':`✓<small>${t(initials(x.by))}</small>`}</button>`:`<span class="cl-box on" title="${t(x.by)} ${t(time(x.recorded_at))}">✓<small>${t(initials(x.by))}</small></span>`}</td>`;
    if(today)return `<td class="tmp-today"><button type="button" class="cl-box" data-cl-mark="${t(task.id)}" aria-label="${t(task.name)} done today">${weekDone?'·':''}</button></td>`;
    const missed=f==='daily'&&d<w.today;
    return `<td class="${missed?'tmp-missed':''}${weekDone?' cl-na':''}"></td>`;
   }).join('')}</tr>`;}).join('');};
 return `<table class="tmp-sheet cl-sheet"><thead>${head}</thead><tbody>${group('daily')}${group('weekly')}</tbody></table>`;
}
function cleanShowToday(){
 const wrap=$('clSheetWrap'),th=wrap?.querySelector('th.tmp-today');if(!th||!wrap.clientWidth)return;
 const sticky=wrap.querySelector('thead .tmp-eqcol')?.offsetWidth||0;
 const left=th.offsetLeft-sticky,right=th.offsetLeft+th.offsetWidth-wrap.clientWidth;
 if(wrap.scrollLeft>left||wrap.scrollLeft<right)wrap.scrollLeft=Math.max(0,left-(wrap.clientWidth-sticky-th.offsetWidth)/2);
}
function renderClean(){
 const w=cstate.week;const box=$('clSheet');
 fillWho($('clWho'),w?.people);
 if(!w){box.className='empty-state';box.textContent='Loading…';}
 else{
  const end=addDays(w.start,6);const thisWeek=w.today>=w.start&&w.today<=end;
  $('clWeekLabel').textContent=`${thisWeek?'This week':'Week'} · ${shortDate(w.start)} – ${shortDate(end)}`;
  $('clThis').hidden=thisWeek;$('clNext').disabled=thisWeek;$('clHint').hidden=!thisWeek;
  if(!(w.tasks||[]).length){box.className='empty-state';box.textContent='Add your cleaning tasks below (or the usual kitchen list) to start the sheet.';}
  else{box.className='';box.innerHTML=cleanSheet(w);if(thisWeek)requestAnimationFrame(cleanShowToday);}
 }
 const tasks=(w?.tasks||[]).filter(x=>x.active);const lb=$('clList');
 $('clUsual').hidden=!w||!!tasks.length;
 if(!tasks.length){lb.className='empty-state';lb.textContent='No tasks yet.';}
 else{lb.className='';lb.innerHTML=tasks.map(x=>`<div class="tmp-rec"><span class="tmp-rec-main"><strong>${t(x.name)}</strong><small>${t(FREQ[x.frequency])}${x.how?` · ${t(x.how)}`:''}</small></span><button type="button" class="shop-small" data-cl-remove="${t(x.id)}">${cstate.removing===x.id?'Tap again to remove':'Remove'}</button></div>`).join('');}
}
cscreen.addEventListener('click',async ev=>{
 const mk=ev.target.closest('[data-cl-mark]');
 if(mk){const task=(cstate.week?.tasks||[]).find(x=>x.id===mk.dataset.clMark);mk.disabled=true;cstate.undo=null;
  try{await managerApi('manager_clean_mark',{task_id:mk.dataset.clMark,done:true,checked_by:$('clWho').value});cmsg(`${task?.name||'Task'}: done.`,true);await loadClean();}
  catch(err){cmsg(err.message||'Unable to save.');mk.disabled=false;}return;}
 const un=ev.target.closest('[data-cl-undo]');
 if(un){const key=`${un.dataset.clUndo}|${cstate.week?.today}`;if(cstate.undo!==key){cstate.undo=key;renderClean();return;}
  un.disabled=true;const task=(cstate.week?.tasks||[]).find(x=>x.id===un.dataset.clUndo);
  try{await managerApi('manager_clean_mark',{task_id:un.dataset.clUndo,done:false});cstate.undo=null;cmsg(`${task?.name||'Task'}: tick removed.`,true);await loadClean();}
  catch(err){cmsg(err.message||'Unable to save.');un.disabled=false;}return;}
 if(cstate.undo&&!ev.target.closest('[data-cl-undo]')){cstate.undo=null;renderClean();}
 if(ev.target.closest('#clPrev')){cstate.start=addDays(cstate.week.start,-7);loadClean().catch(e=>cmsg(e.message));return;}
 if(ev.target.closest('#clNext')){cstate.start=addDays(cstate.week.start,7);loadClean().catch(e=>cmsg(e.message));return;}
 if(ev.target.closest('#clThis')){cstate.start=null;loadClean().catch(e=>cmsg(e.message));return;}
 if(ev.target.closest('#clUsual')){const b=$('clUsual');b.disabled=true;
  try{for(const [name,how,frequency] of USUAL)await managerApi('manager_clean_task_save',{item:{name,how,frequency}});cmsg('Added the usual list. Change or remove any task below.',true);await loadClean();}
  catch(err){cmsg(err.message||'Unable to add.');}finally{b.disabled=false;}return;}
 const rm=ev.target.closest('[data-cl-remove]');
 if(rm){const id=rm.dataset.clRemove;if(cstate.removing!==id){cstate.removing=id;renderClean();return;}
  rm.disabled=true;try{await managerApi('manager_clean_task_save',{item:{id,active:false}});cstate.removing=null;cmsg('Removed from the list. Its ticks are kept.',true);await loadClean();}catch(err){cmsg(err.message||'Unable to remove.');rm.disabled=false;}}
});
$('clForm').addEventListener('submit',async ev=>{ev.preventDefault();
 const name=$('clName').value.trim();if(!name){cmsg('Write the task, e.g. Coffee machine.');return;}
 const b=$('clAdd');b.disabled=true;
 try{await managerApi('manager_clean_task_save',{item:{name,how:$('clHow').value.trim(),frequency:$('clFreq').value}});$('clName').value='';$('clHow').value='';cmsg(`Added: ${name}`,true);await loadClean();}
 catch(err){cmsg(err.message||'Unable to add.');}finally{b.disabled=false;}
});
$('clPdf').addEventListener('click',()=>{const w=cstate.week;if(!w)return;makePdf($('clPdf'),()=>{
 const days=[...Array(7)].map((_,i)=>addDays(w.start,i));
 const done=new Map((w.done||[]).map(x=>[`${x.task_id}|${x.day}`,x]));
 const rows=[];
 for(const f of ['daily','weekly']){const tasks=(w.tasks||[]).filter(x=>x.frequency===f);if(!tasks.length)continue;
  rows.push([{t:FREQ[f].toUpperCase(),bold:true},{t:'',bold:true},...days.map(()=>({t:'',bold:true}))]);
  for(const task of tasks)rows.push([task.name,task.how||'',...days.map(d=>{const x=done.get(`${task.id}|${d}`);return x?initials(x.by):'';})]);}
 const who=new Map();for(const x of w.done||[])who.set(x.by,initials(x.by));
 return {kind:'table',landscape:true,center:true,title:'CLEANING SCHEDULE',place:`Marinara ${w.location||''}`,when:`${shortDate(w.start)} - ${shortDate(days[6])}`,
  limits:'Initials = who did the task that day · Every day tasks: one tick per day · Once a week tasks: one tick in the week',logo:logo(),
  filePrefix:'Marinara-Cleaning-',fileDate:w.start,shareTitle:'Marinara cleaning schedule',
  foot:`Marinara Ristorante Cafe · printed ${dayLong(Date.now())}. Every tick is saved with who did it and the time.`,
  head:['Task','How',...days.map(d=>{const [n,dd]=dayHead(d);return `${n} ${dd}`;})],widths:{0:58,1:58},rows,
  notes:{title:'Initials',head:['Initials','Name'],rows:[...who].map(([n,i])=>[i,n]),none:'Nothing ticked this week.'}};
},cmsg);});

/* =================== Menu, refresh, reset =================== */
addMenuRow('rmOpenFoodTemps',`<button type="button" class="rm-row" data-rm-go="rmOpenFoodTemps">${THERMO2}<span><strong>Food temperatures</strong><small>Cooking, reheating, hot and cold, cooling</small></span><i aria-hidden="true">›</i></button>`,['rmOpenDeliveries','rmOpenTemps']);
addMenuRow('rmOpenCleaning',`<button type="button" class="rm-row" data-rm-go="rmOpenCleaning">${BROOM}<span><strong>Cleaning</strong><small>Cleaning schedule for the council</small></span><i aria-hidden="true">›</i></button>`,['rmOpenFoodTemps']);
window.addEventListener('marinara:session-reset',()=>{
 fstate.gen++;Object.assign(fstate,{data:null,day:null,check:'cook',at:0,editing:null,cpend:null});
 cstate.gen++;Object.assign(cstate,{week:null,start:null,at:0,undo:null,removing:null});
 for(const id of ['ftFood','ftTemp','ftAction','clName','clHow'])$(id).value='';$('ftMsg').textContent='';$('clMsg').textContent='';
 renderFood();renderClean();
});
})();
