/* Notes: things to remember, in two separate lists, Kitchen and Floor. The
   Kitchen Manager sees only Kitchen notes, the Floor Manager only Floor notes,
   the Administrator both (switch at the top). Pin a note to keep it on top,
   edit it, or remove it (two taps). The server checks who can see what. */
(() => {
const $=id=>document.getElementById(id);
const t=v=>escapeHtml(String(v??''));
const ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5h9l3.5 3.5v13.5H6z"/><path d="M15 3.5V7h3.5M9 11h6M9 14.5h6M9 18h3.5"/></svg>';
const PIN='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 5 3 3v1.5H7V12l3-3z"/><path d="M12 13.5V20"/></svg>';
const when=v=>v?new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',weekday:'short',day:'numeric',month:'short',hour:'numeric',minute:'2-digit'}).format(new Date(v)):'';
const DEP_KEY='mh-notes-dept';
const readDep=()=>{try{const v=localStorage.getItem(DEP_KEY);return v==='Floor'||v==='Kitchen'?v:null;}catch(_){return null;}};
const state={data:null,dept:readDep(),gen:0,editing:null,removing:null};

const screen=document.createElement('section');screen.id='notesScreen';screen.className='hidden';
screen.innerHTML=`<div class="manager-top"><div><h2>Notes</h2><p id="noteSub">Things to remember</p></div></div>
<div id="noteDept" class="stock-dept hidden"><button type="button" data-note-dept="Kitchen">Kitchen</button><button type="button" data-note-dept="Floor">Floor</button></div>
<form class="card shop-form" id="noteForm" autocomplete="off">
 <textarea id="noteBody" maxlength="2000" rows="3" placeholder="Write a note…" aria-label="Note"></textarea>
 <label class="shop-urgent"><input type="checkbox" id="notePinned"> Pin to the top</label>
 <div class="shop-form-row"><button type="submit" id="noteSave" class="shop-primary">Save note</button><button type="button" id="noteCancel" class="secondary hidden">Cancel</button></div>
 <p class="rm-data-note" id="noteMsg" aria-live="polite"></p>
</form>
<div class="card shop-card"><div id="noteList" class="empty-state">Loading…</div></div>`;
document.querySelector('main').append(screen);MANAGER_SCREEN_IDS.push(screen.id);

const opener=document.createElement('button');opener.type='button';opener.id='rmOpenNotes';opener.hidden=true;
opener.onclick=()=>{showOnlyManagerScreen(screen.id);setManagerNavActive('operations');window.scrollTo(0,0);if(state.data)state.data={...state.data,notes:null};render();load().catch(e=>msg(e.message||'Unable to load the notes.'));};
document.body.append(opener);

// A row in Operations and More (after Maintenance), and a card on Home.
const row=`<button type="button" class="rm-row" data-rm-go="rmOpenNotes">${ICON}<span><strong>Notes</strong><small>Kitchen and Floor notes</small></span><i aria-hidden="true">›</i></button>`;
for(const menu of [document.querySelector('#operationsScreen .rm-menu'),document.querySelector('#managerMoreScreen .rm-menu')]){
 const after=menu?.querySelector('[data-rm-go="rmOpenMaintenance"]');if(after)after.insertAdjacentHTML('afterend',row);else menu?.insertAdjacentHTML('beforeend',row);
}
if($('rmModules'))$('rmModules').insertAdjacentHTML('beforeend',`<button type="button" class="rm-module" data-rm-go="rmOpenNotes">${ICON}<span><strong>Notes</strong><small>Kitchen and Floor notes</small></span><i>›</i></button>`);
// Food Safety next to Notes on Home, so the cards stay in pairs.
const SHIELD='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>';
if($('rmModules')&&$('rmOpenFoodSafety')&&!$('rmModules').querySelector('[data-rm-go="rmOpenFoodSafety"]'))$('rmModules').insertAdjacentHTML('beforeend',`<button type="button" class="rm-module" data-rm-go="rmOpenFoodSafety">${SHIELD}<span><strong>Food Safety</strong><small>Temperatures, deliveries, cleaning</small></span><i>›</i></button>`);

const msg=(x,ok)=>{const m=$('noteMsg');m.textContent=x||'';m.style.color=ok?'#07613b':x?'#b3261e':'';};

async function load(){
 const gen=++state.gen;
 // Ask for the chosen list only when this person can choose (a Kitchen or
 // Floor Manager always gets their own list, whatever this phone remembers).
 const ask=state.data?.can_choose_department&&state.dept?{department:state.dept}:{};
 let d=await managerApi('manager_note_list',ask);
 if(gen!==state.gen)return;
 const pref=readDep();
 if(!ask.department&&d.can_choose_department&&pref&&pref!==d.department){d=await managerApi('manager_note_list',{department:pref});if(gen!==state.gen)return;}
 state.data=d;state.dept=d.department;render();
 refreshPinned().catch(()=>{});
}
/* Pinned notes go to Needs attention on Home (one row each). A Kitchen or
   Floor Manager gets their own pinned notes; the Administrator both lists. */
const pinned={at:0,gen:0};
window.mhNotes={pinned:[]};
function publish(list){window.mhNotes={pinned:list};window.dispatchEvent(new CustomEvent('marinara:notes'));}
async function refreshPinned(){
 const gen=++pinned.gen;
 const first=await managerApi('manager_note_list',{});
 let lists=[first];
 if(first.can_choose_department){const other=first.department==='Kitchen'?'Floor':'Kitchen';lists.push(await managerApi('manager_note_list',{department:other}));}
 if(gen!==pinned.gen)return;
 pinned.at=Date.now();
 const order={Kitchen:0,Floor:1};
 publish(lists.sort((a,b)=>order[a.department]-order[b.department]).flatMap(l=>(l.notes||[]).filter(n=>n.pinned).map(n=>({id:n.id,body:n.body,department:l.department}))));
}
// From a Needs attention row: open the note's own list.
for(const dep of ['Kitchen','Floor']){
 const b=document.createElement('button');b.type='button';b.id=`rmOpenNotes${dep}`;b.hidden=true;
 b.onclick=()=>{if(state.data?.can_choose_department!==false){state.dept=dep;try{localStorage.setItem(DEP_KEY,dep);}catch(_){}}state.data=state.data?{...state.data,department:dep,notes:null}:null;resetForm();msg('');opener.click();};
 document.body.append(b);
}
window.addEventListener('marinara:dashboard',()=>{if(Date.now()-pinned.at>60e3)refreshPinned().catch(()=>{});});
function line(n){
 const removing=state.removing===n.id;
 const by=n.updated_at?`Edited by ${t(n.updated_by||'')} · ${t(when(n.updated_at))}`:`${t(n.created_by||'')} · ${t(when(n.created_at))}`;
 return `<div class="shop-item note-item${n.pinned?' pinned':''}" data-note="${t(n.id)}">
  <span class="shop-main">${n.pinned?`<span class="note-pin">${PIN}Pinned</span>`:''}<span class="note-body">${t(n.body)}</span><small>${by}</small></span>
  <span class="shop-actions"><button type="button" class="shop-small" data-note-pin="${t(n.id)}">${n.pinned?'Unpin':'Pin'}</button><button type="button" class="shop-small" data-note-edit="${t(n.id)}">Edit</button><button type="button" class="shop-small${removing?' danger':''}" data-note-remove="${t(n.id)}">${removing?'Tap again to remove':'Remove'}</button></span></div>`;
}
function render(){
 const d=state.data,box=$('noteList'),sw=$('noteDept');
 sw.classList.toggle('hidden',!d?.can_choose_department);
 sw.querySelectorAll('[data-note-dept]').forEach(b=>b.classList.toggle('selected',b.dataset.noteDept===state.dept));
 $('noteSub').textContent=d?`${d.department} notes · seen by the ${d.department} Manager and the Administrator`:'Things to remember';
 if(!d?.notes){box.className='empty-state';box.textContent='Loading…';return;}
 const notes=d.notes||[];
 if(notes.length){box.className='';box.innerHTML=notes.map(line).join('');}
 else{box.className='empty-state';box.textContent=`No ${d.department} notes yet.`;}
}
function resetForm(){state.editing=null;$('noteForm').reset();$('noteSave').textContent='Save note';$('noteCancel').classList.add('hidden');}

$('noteForm').addEventListener('submit',async e=>{
 e.preventDefault();
 const body=$('noteBody').value.trim();
 if(!body){msg('Write the note first.');$('noteBody').focus();return;}
 const note={department:state.dept,body,pinned:$('notePinned').checked};
 if(state.editing)note.id=state.editing;
 const btn=$('noteSave');btn.disabled=true;msg('');
 try{await managerApi('manager_note_save',{note});msg(note.id?'Note saved.':'Note added.',true);resetForm();await load();}
 catch(err){msg(err.message||'Unable to save the note.');}
 finally{btn.disabled=false;}
});
$('noteCancel').onclick=()=>{resetForm();msg('');};

screen.addEventListener('click',e=>{
 const b=e.target.closest('[data-note-dept],[data-note-pin],[data-note-edit],[data-note-remove]');if(!b)return;
 const d=b.dataset,notes=state.data?.notes||[];
 if(d.noteDept){if(d.noteDept===state.dept)return;state.dept=d.noteDept;try{localStorage.setItem(DEP_KEY,state.dept);}catch(_){}
  state.removing=null;resetForm();msg('');state.data={...state.data,department:state.dept,notes:null};render();load().catch(err=>msg(err.message||'Unable to load the notes.'));return;}
 if(d.notePin){const n=notes.find(x=>x.id===d.notePin);if(!n)return;b.disabled=true;
  managerApi('manager_note_save',{note:{id:n.id,department:state.dept,body:n.body,pinned:!n.pinned}}).then(load).catch(err=>{b.disabled=false;msg(err.message||'Unable to save the note.');});return;}
 if(d.noteEdit){const n=notes.find(x=>x.id===d.noteEdit);if(!n)return;
  state.editing=n.id;$('noteBody').value=n.body;$('notePinned').checked=!!n.pinned;$('noteSave').textContent='Save changes';$('noteCancel').classList.remove('hidden');msg('');
  $('noteForm').scrollIntoView({block:'center'});$('noteBody').focus();return;}
 if(d.noteRemove){
  if(state.removing===d.noteRemove){b.disabled=true;
   managerApi('manager_note_remove',{id:d.noteRemove}).then(()=>{state.removing=null;if(state.editing===d.noteRemove)resetForm();msg('Note removed.',true);return load();})
    .catch(err=>{b.disabled=false;msg(err.message||'Unable to remove the note.');});}
  else{state.removing=d.noteRemove;render();}
 }
});
window.addEventListener('marinara:session-reset',()=>{state.gen++;pinned.gen++;pinned.at=0;publish([]);state.data=null;state.dept=readDep();state.removing=null;resetForm();msg('');render();});
})();
