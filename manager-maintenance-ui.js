/* Maintenance: equipment that is broken or needs fixing. Every manager can
   report a problem, mark it "being fixed", mark it fixed (with what was done),
   reopen it, or remove it. The server keeps who reported it, who fixed it and when. */
(() => {
const $=id=>document.getElementById(id);
const t=v=>escapeHtml(String(v??''));
const WRENCH='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0 5 5L21 13a6 6 0 0 1-7.6 1.6L6 22l-4-4 7.4-7.4A6 6 0 0 1 11 3l1.7 1.3a4 4 0 0 0 2 2z"/></svg>';
const state={open:[],fixed:[],at:0,gen:0,editing:null,removing:null,fixing:null};
const day=v=>v?new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',day:'numeric',month:'short'}).format(new Date(v)):'';

/* ---------- Screen ---------- */
const screen=document.createElement('section');screen.id='maintenanceScreen';screen.className='hidden';
screen.innerHTML=`<div class="manager-top"><div><h2>Maintenance</h2><p>Equipment that needs fixing</p></div></div>
<form class="card shop-form" id="mntForm" autocomplete="off">
 <input id="mntEquipment" maxlength="80" placeholder="What is broken? e.g. Pizza oven" aria-label="Equipment">
 <input id="mntProblem" maxlength="300" placeholder="What is wrong? (optional)" aria-label="Problem">
 <label class="shop-urgent"><input type="checkbox" id="mntUrgent"> Urgent</label>
 <div class="shop-form-row"><button type="submit" id="mntSave" class="shop-primary">Report problem</button><button type="button" id="mntCancel" class="secondary hidden">Cancel</button></div>
 <p class="rm-data-note" id="mntMsg" aria-live="polite"></p>
</form>
<h3 class="shop-h">To fix <span id="mntOpenCount"></span></h3>
<div class="card shop-card"><div id="mntOpen" class="empty-state">Loading…</div></div>
<h3 class="shop-h">Fixed in the last 30 days</h3>
<div class="card shop-card"><div id="mntFixed" class="empty-state">Nothing yet.</div></div>`;
document.querySelector('main').append(screen);MANAGER_SCREEN_IDS.push(screen.id);

const opener=document.createElement('button');opener.type='button';opener.id='rmOpenMaintenance';opener.hidden=true;
opener.onclick=()=>{showOnlyManagerScreen(screen.id);setManagerNavActive('operations');window.scrollTo(0,0);render();load().catch(e=>msg(e.message||'Unable to load the list.'));};
document.body.append(opener);

// A row in Operations, More and the + menu (after Shopping, or after Stock).
const menuRow=`<button type="button" class="rm-row" data-rm-go="rmOpenMaintenance">${WRENCH}<span><strong>Maintenance</strong><small>Equipment to fix</small></span><i aria-hidden="true">›</i></button>`;
for(const menu of [document.querySelector('#operationsScreen .rm-menu'),document.querySelector('#managerMoreScreen .rm-menu'),document.querySelector('#quickActionsDialog .rm-actions')]){
 const after=menu?.querySelector('[data-rm-go="rmOpenShopping"]')||menu?.querySelector('[data-rm-go="stockCard"]');
 if(after)after.insertAdjacentHTML('afterend',menuRow);else menu?.insertAdjacentHTML('beforeend',menuRow);
}

const msg=(text,ok)=>{const m=$('mntMsg');m.textContent=text||'';m.style.color=ok?'#07613b':text?'#b3261e':'';};

async function load(){
 const gen=state.gen;
 const d=await managerApi('manager_maintenance_list');
 if(gen!==state.gen)return;
 state.open=d.open||[];state.fixed=d.fixed||[];state.at=Date.now();
 publish();render();
}
// Home: "N repairs open" (urgent ones at the top, in red).
function publish(){
 window.mhMaintenance={open:state.open.length,urgent:state.open.filter(i=>i.urgent).length,
  names:state.open.slice(0,2).map(i=>i.equipment),urgentNames:state.open.filter(i=>i.urgent).map(i=>i.equipment)};
 window.dispatchEvent(new CustomEvent('marinara:maintenance'));
}
window.mhMaintenance={open:0,urgent:0,names:[],urgentNames:[]};

function itemLine(i,fixed){
 const busy=i.status==='in_progress';
 const who=fixed?`Fixed by ${i.done_by||'—'} · ${day(i.done_at)}`
  :busy?`Started by ${i.started_by||'—'} · ${day(i.started_at)}`
  :`Reported by ${i.created_by||'—'} · ${day(i.created_at)}`;
 const removing=state.removing===i.id,fixing=state.fixing===i.id;
 const tags=(i.urgent&&!fixed?' <em class="shop-tag">Urgent</em>':'')+(busy?' <em class="mnt-tag">Being fixed</em>':'');
 const actions=fixed
  ?`<button type="button" class="shop-small" data-mnt-reopen="${t(i.id)}">Reopen</button>`
  :`${busy?'':`<button type="button" class="shop-small" data-mnt-start="${t(i.id)}">Start fixing</button>`}<button type="button" class="shop-small mnt-done" data-mnt-fix="${t(i.id)}">Fixed</button><button type="button" class="shop-small" data-mnt-edit="${t(i.id)}">Edit</button><button type="button" class="shop-small${removing?' danger':''}" data-mnt-remove="${t(i.id)}">${removing?'Tap again to remove':'Remove'}</button>`;
 const fixBox=fixing?`<div class="mnt-fixbox"><input id="mntFixNote" maxlength="300" placeholder="What was done? (optional) e.g. Technician replaced the part" aria-label="What was done"><div class="shop-form-row"><button type="button" class="shop-primary" data-mnt-fix-save="${t(i.id)}">Mark as fixed</button><button type="button" class="secondary" data-mnt-fix-cancel>Cancel</button></div></div>`:'';
 return `<div class="shop-item mnt-item${fixed?' done':i.urgent?' urgent':''}${busy?' busy':''}">
  <span class="mnt-icon" aria-hidden="true">${fixed?'✓':WRENCH}</span>
  <span class="shop-main"><strong>${t(i.equipment)}${tags}</strong>${i.problem?`<small>${t(i.problem)}</small>`:''}${fixed&&i.fix_note?`<small class="mnt-note">${t(i.fix_note)}</small>`:''}<small>${t(who)}</small>${fixBox}</span>
  <span class="shop-actions">${actions}</span></div>`;
}
function render(){
 const open=$('mntOpen'),fixed=$('mntFixed');
 $('mntOpenCount').textContent=state.open.length?`(${state.open.length})`:'';
 if(!state.at){open.className='empty-state';open.textContent='Loading…';return;}
 if(state.open.length){open.className='';open.innerHTML=state.open.map(i=>itemLine(i,false)).join('');}
 else{open.className='empty-state';open.textContent='Nothing to fix. Everything is working.';}
 if(state.fixed.length){fixed.className='';fixed.innerHTML=state.fixed.map(i=>itemLine(i,true)).join('');}
 else{fixed.className='empty-state';fixed.textContent='Nothing yet.';}
 if(state.fixing)$('mntFixNote')?.focus();
}
function resetForm(){
 state.editing=null;$('mntForm').reset();$('mntSave').textContent='Report problem';$('mntCancel').classList.add('hidden');
}

$('mntForm').addEventListener('submit',async e=>{
 e.preventDefault();
 const item={equipment:$('mntEquipment').value.trim(),problem:$('mntProblem').value.trim(),urgent:$('mntUrgent').checked};
 if(!item.equipment){msg('Write which equipment needs fixing.');$('mntEquipment').focus();return;}
 if(state.editing)item.id=state.editing;
 const btn=$('mntSave');btn.disabled=true;msg('');
 try{
  await managerApi('manager_maintenance_save',{item});
  msg(item.id?'Saved.':`Reported: ${item.equipment}`,true);resetForm();await load();
 }catch(err){msg(err.message||'Unable to save.');}
 finally{btn.disabled=false;}
});
$('mntCancel').onclick=()=>{resetForm();msg('');};

async function mark(id,status,note){
 try{await managerApi('manager_maintenance_mark',{id,status,note:note||''});state.removing=null;state.fixing=null;await load();}
 catch(err){msg(err.message||'Unable to update.');}
}
screen.addEventListener('click',e=>{
 const b=e.target.closest('[data-mnt-start],[data-mnt-fix],[data-mnt-fix-save],[data-mnt-fix-cancel],[data-mnt-reopen],[data-mnt-edit],[data-mnt-remove]');if(!b)return;
 const d=b.dataset;
 if(d.mntStart){b.disabled=true;mark(d.mntStart,'in_progress');return;}
 if(d.mntFix){state.fixing=d.mntFix;state.removing=null;render();return;}
 if(d.mntFixSave){b.disabled=true;mark(d.mntFixSave,'fixed',$('mntFixNote')?.value.trim());return;}
 if('mntFixCancel' in d){state.fixing=null;render();return;}
 if(d.mntReopen){b.disabled=true;mark(d.mntReopen,'open');return;}
 if(d.mntEdit){
  const i=state.open.find(x=>x.id===d.mntEdit);if(!i)return;
  state.editing=i.id;$('mntEquipment').value=i.equipment;$('mntProblem').value=i.problem||'';$('mntUrgent').checked=!!i.urgent;
  $('mntSave').textContent='Save changes';$('mntCancel').classList.remove('hidden');msg('');
  $('mntForm').scrollIntoView({block:'center'});$('mntEquipment').focus();return;
 }
 if(d.mntRemove){
  if(state.removing===d.mntRemove){b.disabled=true;mark(d.mntRemove,'removed');}
  else{state.removing=d.mntRemove;state.fixing=null;render();}
 }
});
screen.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.id==='mntFixNote'){e.preventDefault();screen.querySelector('[data-mnt-fix-save]')?.click();}});

// Keep the Home count current (at most once a minute); forget it on sign-out.
window.addEventListener('marinara:dashboard',()=>{if(Date.now()-state.at>60e3)load().catch(()=>{});});
window.addEventListener('marinara:session-reset',()=>{state.gen++;state.open=[];state.fixed=[];state.at=0;state.removing=null;state.fixing=null;resetForm();msg('');publish();render();});
})();
