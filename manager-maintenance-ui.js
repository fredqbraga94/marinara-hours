/* Maintenance: equipment that is broken or needs fixing. Every manager can
   report a problem, mark it "being fixed", mark it fixed (with what was done),
   reopen it, or remove it. The server keeps who reported it, who fixed it and when. */
(() => {
const $=id=>document.getElementById(id);
const t=v=>escapeHtml(String(v??''));
const WRENCH='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
const state={open:[],fixed:[],contacts:[],at:0,gen:0,editing:null,removing:null,fixing:null,pending:null,contactEditing:null,contactRemoving:null};
const CAM='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
const PHONE='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>';
const telHref=p=>'tel:'+String(p||'').replace(/[^0-9+]/g,'');
const TRADES=['Plumber','Electrician','Oven','Stove','Fridge / cool room','Gas','Coffee machine','Dishwasher','Air conditioning','Pest control','Handyman'];
const day=v=>v?new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',day:'numeric',month:'short'}).format(new Date(v)):'';

/* ---------- Screen ---------- */
const screen=document.createElement('section');screen.id='maintenanceScreen';screen.className='hidden';
screen.innerHTML=`<div class="manager-top"><div><h2>Maintenance</h2><p>Equipment that needs fixing</p></div></div>
<form class="card shop-form" id="mntForm" autocomplete="off">
 <input id="mntEquipment" maxlength="80" placeholder="What is broken? e.g. Pizza oven" aria-label="Equipment">
 <input id="mntProblem" maxlength="300" placeholder="What is wrong? (optional)" aria-label="Problem">
 <label class="shop-urgent"><input type="checkbox" id="mntUrgent"> Urgent</label>
 <div class="mh-photo-pick"><button type="button" id="mntPhotoBtn" class="mh-photo-btn">${CAM}<span>Add photo</span></button><img id="mntPhotoPrev" alt="Photo to add" hidden><button type="button" id="mntPhotoClear" class="shop-small" hidden>Remove photo</button></div>
 <div class="shop-form-row"><button type="submit" id="mntSave" class="shop-primary">Report problem</button><button type="button" id="mntCancel" class="secondary hidden">Cancel</button></div>
 <p class="rm-data-note" id="mntMsg" aria-live="polite"></p>
</form>
<h3 class="shop-h">To fix <span id="mntOpenCount"></span></h3>
<div class="card shop-card"><div id="mntOpen" class="empty-state">Loading…</div></div>
<h3 class="shop-h mnt-contacts-h">Contacts <button type="button" class="shop-small" id="mntContactAdd">+ Add contact</button></h3>
<form class="card shop-form hidden" id="mntContactForm" autocomplete="off">
 <input id="mntCTrade" maxlength="60" list="mntTrades" placeholder="Service e.g. Plumber, Oven" aria-label="Service">
 <datalist id="mntTrades">${TRADES.map(x=>`<option value="${x}">`).join('')}</datalist>
 <input id="mntCName" maxlength="80" placeholder="Name or company (optional)" aria-label="Name">
 <input id="mntCPhone" maxlength="30" type="tel" inputmode="tel" placeholder="Phone e.g. 0400 123 456" aria-label="Phone">
 <input id="mntCNote" maxlength="200" placeholder="Note (optional) e.g. after hours ok" aria-label="Note">
 <div class="shop-form-row"><button type="submit" id="mntCSave" class="shop-primary">Save contact</button><button type="button" id="mntCCancel" class="secondary">Cancel</button></div>
 <p class="rm-data-note" id="mntCMsg" aria-live="polite"></p>
</form>
<div class="card shop-card"><div id="mntContacts" class="empty-state">No contacts yet. Add who fixes things (plumber, oven…) to call them from here.</div></div>
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

// A card on Home, like Team, Stock, Kitchen and Invoices.
if(document.getElementById('rmModules'))document.getElementById('rmModules').insertAdjacentHTML('beforeend',`<button type="button" class="rm-module" data-rm-go="rmOpenMaintenance">${WRENCH}<span><strong>Maintenance</strong><small>Equipment to fix</small></span><i>›</i></button>`);

const msg=(text,ok)=>{const m=$('mntMsg');m.textContent=text||'';m.style.color=ok?'#07613b':text?'#b3261e':'';};

async function load(){
 const gen=state.gen;
 const [d,c]=await Promise.all([managerApi('manager_maintenance_list'),managerApi('manager_contact_list').catch(()=>null)]);
 if(gen!==state.gen)return;
 state.open=d.open||[];state.fixed=d.fixed||[];if(c)state.contacts=c.contacts||[];state.at=Date.now();
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
  :`${i.thumb?'':`<button type="button" class="shop-small" data-mnt-addphoto="${t(i.id)}">Add photo</button>`}${busy?'':`<button type="button" class="shop-small" data-mnt-start="${t(i.id)}">Start fixing</button>`}<button type="button" class="shop-small mnt-done" data-mnt-fix="${t(i.id)}">Fixed</button><button type="button" class="shop-small" data-mnt-edit="${t(i.id)}">Edit</button><button type="button" class="shop-small${removing?' danger':''}" data-mnt-remove="${t(i.id)}">${removing?'Tap again to remove':'Remove'}</button>`;
 const fixBox=fixing?`<div class="mnt-fixbox"><input id="mntFixNote" maxlength="300" placeholder="What was done? (optional) e.g. Technician replaced the part" aria-label="What was done"><div class="shop-form-row"><button type="button" class="shop-primary" data-mnt-fix-save="${t(i.id)}">Mark as fixed</button><button type="button" class="secondary" data-mnt-fix-cancel>Cancel</button></div></div>`:'';
 return `<div class="shop-item mnt-item${fixed?' done':i.urgent?' urgent':''}${busy?' busy':''}">
  ${i.thumb?`<button type="button" class="mh-thumb" data-mnt-photo="${t(i.id)}" aria-label="Open photo of ${t(i.equipment)}"><img src="${t(i.thumb)}" alt=""></button>`:`<span class="mnt-icon" aria-hidden="true">${fixed?'✓':WRENCH}</span>`}
  <span class="shop-main"><strong>${t(i.equipment)}${tags}</strong>${i.problem?`<small>${t(i.problem)}</small>`:''}${fixed&&i.fix_note?`<small class="mnt-note">${t(i.fix_note)}</small>`:''}<small>${t(who)}</small>${fixed?'':callFor(i)}${fixBox}</span>
  <span class="shop-actions">${actions}</span></div>`;
}
// "Call" buttons for contacts whose service matches the equipment (e.g. Oven → Pizza oven).
function callFor(i){
 const eq=String(i.equipment||'').toLowerCase();
 const words=s=>s.toLowerCase().split(/[^a-z0-9]+/).filter(w=>w.length>2);
 const match=state.contacts.filter(c=>{const tw=words(c.trade);return tw.some(w=>eq.includes(w));}).slice(0,2);
 return match.map(c=>`<a class="mnt-call" href="${t(telHref(c.phone))}">${PHONE}Call ${t(c.trade)}${c.name?` · ${t(c.name)}`:''}</a>`).join('');
}
function contactLine(c){
 const removing=state.contactRemoving===c.id;
 return `<div class="shop-item mnt-contact"><span class="mnt-icon" aria-hidden="true">${PHONE}</span>
  <span class="shop-main"><strong>${t(c.trade)}</strong>${c.name?`<small class="mnt-cname">${t(c.name)}</small>`:''}<small>${t(c.phone)}${c.note?` · ${t(c.note)}`:''}</small></span>
  <span class="shop-actions"><a class="mnt-call big" href="${t(telHref(c.phone))}" aria-label="Call ${t(c.trade)}${c.name?` ${t(c.name)}`:''}">${PHONE}Call</a><button type="button" class="shop-small" data-c-edit="${t(c.id)}">Edit</button><button type="button" class="shop-small${removing?' danger':''}" data-c-remove="${t(c.id)}">${removing?'Tap again to remove':'Remove'}</button></span></div>`;
}
function render(){
 const open=$('mntOpen'),fixed=$('mntFixed'),contacts=$('mntContacts');
 if(state.contacts.length){contacts.className='';contacts.innerHTML=state.contacts.map(contactLine).join('');}
 else{contacts.className='empty-state';contacts.textContent='No contacts yet. Add who fixes things (plumber, oven…) to call them from here.';}
 $('mntOpenCount').textContent=state.open.length?`(${state.open.length})`:'';
 if(!state.at){open.className='empty-state';open.textContent='Loading…';return;}
 if(state.open.length){open.className='';open.innerHTML=state.open.map(i=>itemLine(i,false)).join('');}
 else{open.className='empty-state';open.textContent='Nothing to fix. Everything is working.';}
 if(state.fixed.length){fixed.className='';fixed.innerHTML=state.fixed.map(i=>itemLine(i,true)).join('');}
 else{fixed.className='empty-state';fixed.textContent='Nothing yet.';}
 if(state.fixing)$('mntFixNote')?.focus();
}
function setPending(p){
 state.pending=p;const img=$('mntPhotoPrev');
 if(p){img.src=p.thumb;img.hidden=false;$('mntPhotoClear').hidden=false;$('mntPhotoBtn').querySelector('span').textContent='Change photo';}
 else{img.removeAttribute('src');img.hidden=true;$('mntPhotoClear').hidden=true;$('mntPhotoBtn').querySelector('span').textContent=state.editing?'Add or change photo':'Add photo';}
}
$('mntPhotoBtn').onclick=async()=>{
 const f=await window.mhPhoto.pick();if(!f)return;
 try{msg('');setPending(await window.mhPhoto.shrink(f));}catch(err){msg(err.message||'This photo could not be used.');}
};
$('mntPhotoClear').onclick=()=>setPending(null);
async function addPhotoTo(id){
 const f=await window.mhPhoto.pick();if(!f)return;
 msg('Saving photo…',true);
 try{await window.mhPhoto.upload('maintenance',id,await window.mhPhoto.shrink(f));msg('Photo saved.',true);await load();}
 catch(err){msg(err.message||'Unable to save the photo.');}
}
/* Contacts */
const cmsg=(text,ok)=>{const m=$('mntCMsg');m.textContent=text||'';m.style.color=ok?'#07613b':text?'#b3261e':'';};
function closeContactForm(){state.contactEditing=null;$('mntContactForm').reset();$('mntContactForm').classList.add('hidden');$('mntContactAdd').hidden=false;cmsg('');}
function openContactForm(c){
 state.contactEditing=c?c.id:null;$('mntContactForm').classList.remove('hidden');$('mntContactAdd').hidden=true;cmsg('');
 $('mntCTrade').value=c?.trade||'';$('mntCName').value=c?.name||'';$('mntCPhone').value=c?.phone||'';$('mntCNote').value=c?.note||'';
 $('mntCSave').textContent=c?'Save changes':'Save contact';
 $('mntContactForm').scrollIntoView({block:'center'});$('mntCTrade').focus();
}
$('mntContactAdd').onclick=()=>openContactForm(null);
$('mntCCancel').onclick=closeContactForm;
$('mntContactForm').addEventListener('submit',async e=>{
 e.preventDefault();
 const contact={trade:$('mntCTrade').value.trim(),name:$('mntCName').value.trim(),phone:$('mntCPhone').value.trim(),note:$('mntCNote').value.trim()};
 if(!contact.trade){cmsg('Write the service, e.g. Plumber.');$('mntCTrade').focus();return;}
 if(!/^[0-9+() .-]{3,30}$/.test(contact.phone)){cmsg('Write a phone number (numbers only).');$('mntCPhone').focus();return;}
 if(state.contactEditing)contact.id=state.contactEditing;
 const btn=$('mntCSave');btn.disabled=true;
 try{await managerApi('manager_contact_save',{contact});closeContactForm();msg(contact.id?'Contact saved.':`Contact added: ${contact.trade}`,true);await load();}
 catch(err){cmsg(err.message||'Unable to save the contact.');}
 finally{btn.disabled=false;}
});
function resetForm(){
 state.editing=null;setPending(null);$('mntForm').reset();$('mntSave').textContent='Report problem';$('mntCancel').classList.add('hidden');
}

$('mntForm').addEventListener('submit',async e=>{
 e.preventDefault();
 const item={equipment:$('mntEquipment').value.trim(),problem:$('mntProblem').value.trim(),urgent:$('mntUrgent').checked};
 if(!item.equipment){msg('Write which equipment needs fixing.');$('mntEquipment').focus();return;}
 if(state.editing)item.id=state.editing;
 const btn=$('mntSave');btn.disabled=true;msg('');
 try{
  const saved=await managerApi('manager_maintenance_save',{item});
  let note='';
  if(state.pending){try{await window.mhPhoto.upload('maintenance',saved.item.id,state.pending);}catch(err){note=` The photo was not saved: ${err.message||'try again'}.`;}}
  msg((item.id?'Saved.':`Reported: ${item.equipment}`)+note,!note);resetForm();await load();
 }catch(err){msg(err.message||'Unable to save.');}
 finally{btn.disabled=false;}
});
$('mntCancel').onclick=()=>{resetForm();msg('');};

async function mark(id,status,note){
 try{await managerApi('manager_maintenance_mark',{id,status,note:note||''});state.removing=null;state.fixing=null;await load();}
 catch(err){msg(err.message||'Unable to update.');}
}
screen.addEventListener('click',e=>{
 const b=e.target.closest('[data-mnt-start],[data-mnt-fix],[data-mnt-fix-save],[data-mnt-fix-cancel],[data-mnt-reopen],[data-mnt-edit],[data-mnt-remove],[data-mnt-photo],[data-mnt-addphoto],[data-c-edit],[data-c-remove]');if(!b)return;
 const d=b.dataset;
 if(d.mntPhoto){const i=[...state.open,...state.fixed].find(x=>x.id===d.mntPhoto);if(i)window.mhPhoto.view('maintenance',i.id,{thumb:i.thumb,title:i.equipment,canChange:i.status!=='fixed',onChange:()=>load().catch(()=>{})});return;}
 if(d.mntAddphoto){addPhotoTo(d.mntAddphoto);return;}
 if(d.cEdit){const c=state.contacts.find(x=>x.id===d.cEdit);if(c)openContactForm(c);return;}
 if(d.cRemove){
  if(state.contactRemoving===d.cRemove){b.disabled=true;managerApi('manager_contact_remove',{id:d.cRemove}).then(()=>{state.contactRemoving=null;return load();}).catch(err=>msg(err.message||'Unable to remove the contact.'));}
  else{state.contactRemoving=d.cRemove;render();}
  return;
 }
 if(d.mntStart){b.disabled=true;mark(d.mntStart,'in_progress');return;}
 if(d.mntFix){state.fixing=d.mntFix;state.removing=null;render();return;}
 if(d.mntFixSave){b.disabled=true;mark(d.mntFixSave,'fixed',$('mntFixNote')?.value.trim());return;}
 if('mntFixCancel' in d){state.fixing=null;render();return;}
 if(d.mntReopen){b.disabled=true;mark(d.mntReopen,'open');return;}
 if(d.mntEdit){
  const i=state.open.find(x=>x.id===d.mntEdit);if(!i)return;
  state.editing=i.id;$('mntEquipment').value=i.equipment;$('mntProblem').value=i.problem||'';$('mntUrgent').checked=!!i.urgent;
  $('mntSave').textContent='Save changes';$('mntCancel').classList.remove('hidden');msg('');setPending(null);
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
window.addEventListener('marinara:session-reset',()=>{state.gen++;state.open=[];state.fixed=[];state.at=0;state.removing=null;state.fixing=null;state.contacts=[];state.contactRemoving=null;closeContactForm();resetForm();msg('');publish();render();});
})();
