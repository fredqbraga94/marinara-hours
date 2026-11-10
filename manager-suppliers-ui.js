/* Suppliers: who we buy from, with the contact person, phone and email, so a
   manager can call or email them from here. Two lists, Kitchen and Floor: the
   Kitchen Manager sees only Kitchen suppliers, the Floor Manager only Floor,
   the Administrator both (switch at the top; a supplier can be moved). Names
   already used in Stock, Orders and Invoices are offered while typing. */
(() => {
const $=id=>document.getElementById(id);
const t=v=>escapeHtml(String(v??''));
const svg=p=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICON=svg('<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17.5" cy="17.5" r="1.8"/>');
const PHONE=svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>');
const MAIL=svg('<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>');
const telHref=p=>'tel:'+String(p||'').replace(/[^0-9+]/g,'');
const PHONE_OK=/^[0-9+() .-]{3,30}$/;
const EMAIL_OK=/^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DEP_KEY='mh-suppliers-dept';
const readDep=()=>{try{const v=localStorage.getItem(DEP_KEY);return v==='Floor'||v==='Kitchen'?v:null;}catch(_){return null;}};
const state={list:[],known:[],at:0,gen:0,editing:null,removing:null,dept:null,canChoose:false};
// Products and prices of each supplier are in Finance → Prices (the "Prices" button opens it on that supplier).
const canSeePrices=()=>['manager','kitchen_manager','floor_manager'].includes(typeof currentManagerRole==='undefined'?'':currentManagerRole)&&(!window.mhCan||window.mhCan('invoices'));

const screen=document.createElement('section');screen.id='supplierScreen';screen.className='hidden';
screen.innerHTML=`<div class="manager-top"><div><h2>Suppliers</h2><p id="supSub">Contacts, phones and emails</p></div></div>
<div id="supDept" class="stock-dept hidden"><button type="button" data-sup-dept="Kitchen">Kitchen</button><button type="button" data-sup-dept="Floor">Floor</button></div>
<button type="button" class="shop-primary sup-add" id="supAdd">+ Add supplier</button>
<form class="card shop-form hidden" id="supForm" autocomplete="off" novalidate>
 <input id="supName" maxlength="60" list="supKnown" placeholder="Supplier e.g. Moco Food Services" aria-label="Supplier name">
 <datalist id="supKnown"></datalist>
 <input id="supContact" maxlength="80" placeholder="Contact person (optional)" aria-label="Contact person">
 <input id="supPhone" maxlength="30" type="tel" inputmode="tel" placeholder="Phone (optional) e.g. 0400 123 456" aria-label="Phone">
 <input id="supEmail" maxlength="120" type="email" inputmode="email" autocapitalize="off" placeholder="Email (optional) e.g. orders@supplier.com.au" aria-label="Email">
 <label class="sup-dept-pick hidden" id="supDeptPick">List <select id="supDeptSel" aria-label="List"><option>Kitchen</option><option>Floor</option></select></label>
 <textarea id="supNote" maxlength="300" rows="2" placeholder="Note (optional) e.g. order by 2pm, account number, delivery days" aria-label="Note"></textarea>
 <div class="shop-form-row"><button type="submit" id="supSave" class="shop-primary">Save supplier</button><button type="button" id="supCancel" class="secondary">Cancel</button></div>
 <p class="rm-data-note" id="supFormMsg" aria-live="polite"></p>
</form>
<p class="rm-data-note" id="supMsg" aria-live="polite"></p>
<div class="card shop-card"><div id="supList" class="empty-state">Loading…</div></div>`;
document.querySelector('main').append(screen);MANAGER_SCREEN_IDS.push(screen.id);

const opener=document.createElement('button');opener.type='button';opener.id='rmOpenSuppliers';opener.hidden=true;
opener.onclick=()=>{showOnlyManagerScreen(screen.id);setManagerNavActive('operations');window.scrollTo(0,0);render();load().catch(e=>msg(e.message||'Unable to load the suppliers.'));};
document.body.append(opener);

// A row in Operations and More, after Orders (Stock & Orders gathers it into its group).
const row=`<button type="button" class="rm-row" data-rm-go="rmOpenSuppliers">${ICON}<span><strong>Suppliers</strong><small>Contacts, phones and emails</small></span><i aria-hidden="true">›</i></button>`;
for(const menu of [document.querySelector('#operationsScreen .rm-menu'),document.querySelector('#managerMoreScreen .rm-menu')]){
 const after=menu?.querySelector('[data-rm-go="rmOpenOrders"]');if(after)after.insertAdjacentHTML('afterend',row);else menu?.insertAdjacentHTML('beforeend',row);
}

const say=(id,x,ok)=>{const m=$(id);m.textContent=x||'';m.style.color=ok?'#07613b':x?'#b3261e':'';};
const msg=(x,ok)=>say('supMsg',x,ok),fmsg=(x,ok)=>say('supFormMsg',x,ok);

async function load(){
 const gen=++state.gen;
 // Ask for the chosen list only when this person can choose (a Kitchen or
 // Floor Manager always gets their own list, whatever this phone remembers).
 let d=await managerApi('manager_supplier_list',state.canChoose&&state.dept?{department:state.dept}:{});
 if(gen!==state.gen)return;
 const pref=readDep();
 if(!state.canChoose&&d.can_choose_department&&pref&&pref!==d.department){d=await managerApi('manager_supplier_list',{department:pref});if(gen!==state.gen)return;}
 state.list=d.suppliers||[];state.known=d.known||[];state.dept=d.department||'Kitchen';state.canChoose=!!d.can_choose_department;state.at=Date.now();render();
}
function line(s){
 const removing=state.removing===s.id;
 const calls=[s.phone?`<a class="mnt-call big" href="${t(telHref(s.phone))}" aria-label="Call ${t(s.name)}">${PHONE}Call</a>`:'',
  s.email?`<a class="mnt-call big" href="mailto:${t(s.email)}" aria-label="Email ${t(s.name)}">${MAIL}Email</a>`:''].join('');
 const details=[s.contact,s.phone,s.email].filter(Boolean).map(t).join(' · ');
 return `<div class="shop-item sup-item" data-sup="${t(s.id)}"><span class="mnt-icon" aria-hidden="true">${ICON}</span>
  <span class="shop-main"><strong>${t(s.name)}</strong>${details?`<small>${details}</small>`:''}${s.note?`<small class="sup-note">${t(s.note)}</small>`:''}</span>
  <span class="shop-actions">${calls}${canSeePrices()?`<button type="button" class="shop-small" data-sup-prices="${t(s.id)}">Prices</button>`:''}<button type="button" class="shop-small" data-sup-edit="${t(s.id)}">Edit</button><button type="button" class="shop-small${removing?' danger':''}" data-sup-remove="${t(s.id)}">${removing?'Tap again to remove':'Remove'}</button></span></div>`;
}
function render(){
 const box=$('supList');
 $('supDept').classList.toggle('hidden',!state.canChoose);
 $('supDept').querySelectorAll('[data-sup-dept]').forEach(b=>b.classList.toggle('selected',b.dataset.supDept===state.dept));
 $('supSub').textContent=state.at&&state.dept?`${state.dept} suppliers · contacts, phones and emails`:'Contacts, phones and emails';
 $('supKnown').innerHTML=state.known.map(n=>`<option value="${t(n)}">`).join('');
 if(!state.at){box.className='empty-state';box.textContent='Loading…';return;}
 if(state.list.length){box.className='';box.innerHTML=state.list.map(line).join('');}
 else{box.className='empty-state';box.textContent=`No ${state.dept||''} suppliers yet. Tap "+ Add supplier" to save the first one.`.replace('  ',' ');}
}

function closeForm(){state.editing=null;$('supForm').reset();$('supForm').classList.add('hidden');$('supAdd').hidden=false;fmsg('');}
function openForm(s){
 state.editing=s?s.id:null;msg('');fmsg('');
 $('supName').value=s?.name||'';$('supContact').value=s?.contact||'';$('supPhone').value=s?.phone||'';$('supEmail').value=s?.email||'';$('supNote').value=s?.note||'';
 $('supSave').textContent=s?'Save changes':'Save supplier';
 $('supDeptPick').classList.toggle('hidden',!state.canChoose);$('supDeptSel').value=s?.department||state.dept||'Kitchen';
 $('supForm').classList.remove('hidden');$('supAdd').hidden=true;
 $('supForm').scrollIntoView({block:'center'});$('supName').focus();
}
$('supAdd').onclick=()=>openForm(null);
$('supCancel').onclick=closeForm;
$('supForm').addEventListener('submit',async e=>{
 e.preventDefault();
 const supplier={name:$('supName').value.trim(),contact:$('supContact').value.trim(),phone:$('supPhone').value.trim(),email:$('supEmail').value.trim().toLowerCase(),note:$('supNote').value.trim()};
 if(!supplier.name){fmsg("Write the supplier's name.");$('supName').focus();return;}
 if(supplier.phone&&!PHONE_OK.test(supplier.phone)){fmsg('Write the phone with numbers only.');$('supPhone').focus();return;}
 if(supplier.email&&!EMAIL_OK.test(supplier.email)){fmsg('This email does not look right.');$('supEmail').focus();return;}
 supplier.department=state.canChoose?$('supDeptSel').value:state.dept;
 const same=supplier.department===state.dept&&state.list.find(x=>x.name.toLowerCase()===supplier.name.toLowerCase()&&x.id!==state.editing);
 if(same){fmsg(`${same.name} is already on the list. Tap Edit on it to change it.`);return;}
 if(state.editing)supplier.id=state.editing;
 const btn=$('supSave');btn.disabled=true;fmsg('');
 const moved=supplier.department!==state.dept;
 try{await managerApi('manager_supplier_save',{supplier});closeForm();msg(moved?`${supplier.name} is now in the ${supplier.department} list.`:supplier.id?'Supplier saved.':`Supplier added: ${supplier.name}`,true);await load();}
 catch(err){fmsg(err.message||'Unable to save the supplier.');}
 finally{btn.disabled=false;}
});
screen.addEventListener('click',e=>{
 const b=e.target.closest('[data-sup-edit],[data-sup-remove],[data-sup-prices],[data-sup-dept]');if(!b)return;
 const d=b.dataset;
 if(d.supDept){if(d.supDept===state.dept)return;state.dept=d.supDept;try{localStorage.setItem(DEP_KEY,state.dept);}catch(_){}
  state.removing=null;closeForm();msg('');state.list=[];state.at=0;render();load().catch(err=>msg(err.message||'Unable to load the suppliers.'));return;}
 if(d.supPrices){const x=state.list.find(y=>y.id===d.supPrices);if(x)window.mhOpenSupplierPrices?.(x.name,state.canChoose?state.dept:null);return;}
 if(d.supEdit){const s=state.list.find(x=>x.id===d.supEdit);if(s)openForm(s);return;}
 if(d.supRemove){
  if(state.removing===d.supRemove){
   b.disabled=true;const name=state.list.find(x=>x.id===d.supRemove)?.name||'';
   managerApi('manager_supplier_remove',{id:d.supRemove}).then(()=>{state.removing=null;msg(`Removed: ${name}`,true);return load();})
    .catch(err=>{b.disabled=false;msg(err.message||'Unable to remove the supplier.');});
  }else{state.removing=d.supRemove;render();}
 }
});
window.addEventListener('marinara:session-reset',()=>{state.gen++;state.list=[];state.known=[];state.at=0;state.removing=null;state.dept=null;state.canChoose=false;closeForm();msg('');render();});
})();
