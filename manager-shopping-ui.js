/* Shopping list: things to buy that do not come from the suppliers (a new knife,
   paper towels). Every manager can add, edit, mark bought or remove an item.
   The server keeps who asked, who bought it and when. */
(() => {
const $=id=>document.getElementById(id);
const t=v=>escapeHtml(String(v??''));
const CART='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h2l2.4 11h11l2-8H6.3"/><circle cx="9" cy="19.5" r="1.5"/><circle cx="17" cy="19.5" r="1.5"/></svg>';
const state={open:[],bought:[],at:0,gen:0,editing:null,removing:null,pending:null};
const CAM='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
const day=v=>v?new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',day:'numeric',month:'short'}).format(new Date(v)):'';

/* ---------- Screen ---------- */
const screen=document.createElement('section');screen.id='shoppingScreen';screen.className='hidden';
screen.innerHTML=`<div class="manager-top"><div><h2>Shopping</h2><p>Things to buy for the restaurant</p></div></div>
<form class="card shop-form" id="shopForm" autocomplete="off">
 <input id="shopName" maxlength="80" placeholder="What do we need? e.g. Chef knife" aria-label="Item">
 <div class="shop-form-row"><input id="shopQty" maxlength="40" placeholder="How many (optional)" aria-label="How many">
 <label class="shop-urgent"><input type="checkbox" id="shopUrgent"> Urgent</label></div>
 <input id="shopNote" maxlength="200" placeholder="Note (optional)" aria-label="Note">
 <div class="mh-photo-pick"><button type="button" id="shopPhotoBtn" class="mh-photo-btn">${CAM}<span>Add photo</span></button><img id="shopPhotoPrev" alt="Photo to add" hidden><button type="button" id="shopPhotoClear" class="shop-small" hidden>Remove photo</button></div>
 <div class="shop-form-row"><button type="submit" id="shopSave">Add to list</button><button type="button" id="shopCancel" class="secondary hidden">Cancel</button></div>
 <p class="rm-data-note" id="shopMsg" aria-live="polite"></p>
</form>
<h3 class="shop-h">To buy <span id="shopOpenCount"></span></h3>
<div class="card shop-card"><div id="shopOpen" class="empty-state">Loading…</div></div>
<h3 class="shop-h">Bought in the last 14 days</h3>
<div class="card shop-card"><div id="shopBought" class="empty-state">Nothing yet.</div></div>`;
document.querySelector('main').append(screen);MANAGER_SCREEN_IDS.push(screen.id);

const opener=document.createElement('button');opener.type='button';opener.id='rmOpenShopping';opener.hidden=true;
opener.onclick=()=>{showOnlyManagerScreen(screen.id);setManagerNavActive('operations');window.scrollTo(0,0);render();load().catch(e=>msg(e.message||'Unable to load the list.'));};
document.body.append(opener);

// A row in Operations, More and the + menu (next to Stock).
const menuRow=`<button type="button" class="rm-row" data-rm-go="rmOpenShopping">${CART}<span><strong>Shopping</strong><small>Things to buy</small></span><i aria-hidden="true">›</i></button>`;
for(const menu of [document.querySelector('#operationsScreen .rm-menu'),document.querySelector('#managerMoreScreen .rm-menu'),document.querySelector('#quickActionsDialog .rm-actions')]){
 const stock=menu?.querySelector('[data-rm-go="stockCard"]');
 if(stock)stock.insertAdjacentHTML('afterend',menuRow);else menu?.insertAdjacentHTML('beforeend',menuRow);
}

const msg=(text,ok)=>{const m=$('shopMsg');m.textContent=text||'';m.style.color=ok?'#07613b':text?'#b3261e':'';};

async function load(){
 const gen=state.gen;
 const d=await managerApi('manager_shopping_list');
 if(gen!==state.gen)return;
 state.open=d.open||[];state.bought=d.bought||[];state.at=Date.now();
 publish();render();
}
// Home: "N things to buy".
function publish(){
 window.mhShopping={open:state.open.length,urgent:state.open.filter(i=>i.urgent).length,names:state.open.slice(0,2).map(i=>i.name),urgentNames:state.open.filter(i=>i.urgent).map(i=>i.name)};
 window.dispatchEvent(new CustomEvent('marinara:shopping'));
}
window.mhShopping={open:0,urgent:0,names:[],urgentNames:[]};

function itemLine(i,bought){
 const who=bought?`Bought by ${i.done_by||'—'} · ${day(i.done_at)}`:`Asked by ${i.created_by||'—'} · ${day(i.created_at)}`;
 const extra=[i.qty,i.note].filter(Boolean).join(' · ');
 const removing=state.removing===i.id;
 const actions=bought
  ?`<button type="button" class="shop-small" data-shop-undo="${t(i.id)}">Undo</button>`
  :`${i.thumb?'':`<button type="button" class="shop-small" data-shop-addphoto="${t(i.id)}">Add photo</button>`}<button type="button" class="shop-small" data-shop-edit="${t(i.id)}">Edit</button><button type="button" class="shop-small${removing?' danger':''}" data-shop-remove="${t(i.id)}">${removing?'Tap again to remove':'Remove'}</button>`;
 return `<div class="shop-item${bought?' done':i.urgent?' urgent':''}">
  ${bought?`<span class="shop-tick done" aria-hidden="true">✓</span>`:`<button type="button" class="shop-tick" data-shop-bought="${t(i.id)}" aria-label="Mark ${t(i.name)} as bought"></button>`}
  ${i.thumb?`<button type="button" class="mh-thumb" data-shop-photo="${t(i.id)}" aria-label="Open photo of ${t(i.name)}"><img src="${t(i.thumb)}" alt=""></button>`:''}
  <span class="shop-main"><strong>${t(i.name)}${i.urgent&&!bought?' <em class="shop-tag">Urgent</em>':''}</strong>${extra?`<small>${t(extra)}</small>`:''}<small>${t(who)}</small></span>
  <span class="shop-actions">${actions}</span></div>`;
}
function render(){
 const open=$('shopOpen'),bought=$('shopBought');
 $('shopOpenCount').textContent=state.open.length?`(${state.open.length})`:'';
 if(!state.at){open.className='empty-state';open.textContent='Loading…';return;}
 if(state.open.length){open.className='';open.innerHTML=state.open.map(i=>itemLine(i,false)).join('');}
 else{open.className='empty-state';open.textContent='Nothing to buy. Add something above.';}
 if(state.bought.length){bought.className='';bought.innerHTML=state.bought.map(i=>itemLine(i,true)).join('');}
 else{bought.className='empty-state';bought.textContent='Nothing yet.';}
}
function setPending(p){
 state.pending=p;const img=$('shopPhotoPrev');
 if(p){img.src=p.thumb;img.hidden=false;$('shopPhotoClear').hidden=false;$('shopPhotoBtn').querySelector('span').textContent='Change photo';}
 else{img.removeAttribute('src');img.hidden=true;$('shopPhotoClear').hidden=true;$('shopPhotoBtn').querySelector('span').textContent=state.editing?'Add or change photo':'Add photo';}
}
$('shopPhotoBtn').onclick=async()=>{
 const f=await window.mhPhoto.pick();if(!f)return;
 try{msg('');setPending(await window.mhPhoto.shrink(f));}catch(err){msg(err.message||'This photo could not be used.');}
};
$('shopPhotoClear').onclick=()=>setPending(null);
async function addPhotoTo(id){
 const f=await window.mhPhoto.pick();if(!f)return;
 msg('Saving photo…',true);
 try{await window.mhPhoto.upload('shopping',id,await window.mhPhoto.shrink(f));msg('Photo saved.',true);await load();}
 catch(err){msg(err.message||'Unable to save the photo.');}
}
function resetForm(){
 state.editing=null;setPending(null);$('shopForm').reset();$('shopSave').textContent='Add to list';$('shopCancel').classList.add('hidden');
}

$('shopForm').addEventListener('submit',async e=>{
 e.preventDefault();
 const item={name:$('shopName').value.trim(),qty:$('shopQty').value.trim(),note:$('shopNote').value.trim(),urgent:$('shopUrgent').checked};
 if(!item.name){msg('Write what needs to be bought.');$('shopName').focus();return;}
 if(state.editing)item.id=state.editing;
 const btn=$('shopSave');btn.disabled=true;msg('');
 try{
  const saved=await managerApi('manager_shopping_save',{item});
  let note='';
  if(state.pending){try{await window.mhPhoto.upload('shopping',saved.item.id,state.pending);}catch(err){note=` The photo was not saved: ${err.message||'try again'}.`;}}
  msg((item.id?'Saved.':`Added: ${item.name}`)+note,!note);resetForm();await load();
 }catch(err){msg(err.message||'Unable to save the item.');}
 finally{btn.disabled=false;}
});
$('shopCancel').onclick=()=>{resetForm();msg('');};

async function mark(id,status){
 try{await managerApi('manager_shopping_mark',{id,status});state.removing=null;await load();}
 catch(err){msg(err.message||'Unable to update the item.');}
}
screen.addEventListener('click',e=>{
 const b=e.target.closest('[data-shop-bought],[data-shop-undo],[data-shop-edit],[data-shop-remove],[data-shop-photo],[data-shop-addphoto]');if(!b)return;
 if(b.dataset.shopPhoto){const i=[...state.open,...state.bought].find(x=>x.id===b.dataset.shopPhoto);if(i)window.mhPhoto.view('shopping',i.id,{thumb:i.thumb,title:i.name,canChange:i.status==='open',onChange:()=>load().catch(()=>{})});return;}
 if(b.dataset.shopAddphoto){addPhotoTo(b.dataset.shopAddphoto);return;}
 if(b.dataset.shopBought){b.disabled=true;mark(b.dataset.shopBought,'bought');return;}
 if(b.dataset.shopUndo){b.disabled=true;mark(b.dataset.shopUndo,'open');return;}
 if(b.dataset.shopEdit){
  const i=state.open.find(x=>x.id===b.dataset.shopEdit);if(!i)return;
  state.editing=i.id;$('shopName').value=i.name;$('shopQty').value=i.qty||'';$('shopNote').value=i.note||'';$('shopUrgent').checked=!!i.urgent;
  $('shopSave').textContent='Save changes';$('shopCancel').classList.remove('hidden');msg('');setPending(null);
  $('shopForm').scrollIntoView({block:'center'});$('shopName').focus();return;
 }
 if(b.dataset.shopRemove){
  if(state.removing===b.dataset.shopRemove){b.disabled=true;mark(b.dataset.shopRemove,'removed');}
  else{state.removing=b.dataset.shopRemove;render();}
 }
});

// Keep the Home count current (at most once a minute); forget it on sign-out.
window.addEventListener('marinara:dashboard',()=>{if(Date.now()-state.at>60e3)load().catch(()=>{});});
window.addEventListener('marinara:session-reset',()=>{state.gen++;state.open=[];state.bought=[];state.at=0;state.removing=null;resetForm();msg('');publish();render();});
})();
