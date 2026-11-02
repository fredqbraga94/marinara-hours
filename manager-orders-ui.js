/* Orders to a supplier (first: Niko Fresh Produce). The list of what is usually
   ordered, a quantity next to each item, then one PDF to forward instead of a
   message item by item. No count and no par level. Each order is saved, so the
   last one can be repeated. Every manager. */
(() => {
const $=id=>document.getElementById(id);
const t=v=>escapeHtml(String(v??''));
const dayLong=v=>new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',weekday:'short',day:'numeric',month:'short',year:'numeric'}).format(new Date(v));
const isoLong=iso=>new Intl.DateTimeFormat('en-AU',{timeZone:'UTC',weekday:'long',day:'numeric',month:'short'}).format(new Date(`${iso}T00:00:00Z`));
const todayIso=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Brisbane'}).format(new Date());
const addDays=(iso,n)=>{const d=new Date(`${iso}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const UNITS=['box','kg','bunch','each','punnet','tray','bag','dozen'];
const DEFAULT_SUPPLIER='Niko Fresh Produce';
const state={data:null,supplier:null,qty:{},gen:0,removing:null,editing:false};
const ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3h8l1 3H7z"/><rect x="5" y="6" width="14" height="15" rx="2"/><path d="M9 11h6M9 15h6"/></svg>';
const screen=document.createElement('section');screen.id='orderScreen';screen.className='hidden';
screen.innerHTML=`<div class="manager-top"><div><h2>Orders</h2><p>Type the quantities, then send the PDF to the supplier</p></div></div>
<div class="ord-sups" id="ordSups"></div>
<div id="ordList" class="card shop-card"><div class="empty-state">Loading…</div></div>
<div class="card shop-form" id="ordSend" hidden>
 <label class="ord-field">Delivery <input type="date" id="ordDay" aria-label="Delivery day"></label>
 <textarea id="ordNote" maxlength="300" rows="2" placeholder="Note for the supplier (optional) e.g. Please deliver before 10am" aria-label="Note"></textarea>
 <button type="button" class="shop-primary" id="ordPdf">Make the PDF</button>
 <div class="shop-form-row"><button type="button" class="secondary" id="ordRepeat">Repeat last order</button><button type="button" class="secondary" id="ordClear">Clear</button></div>
 <p class="rm-data-note" id="ordMsg" aria-live="polite"></p>
</div>
<h3 class="shop-h">Last orders</h3>
<div class="card shop-card"><div id="ordPast" class="empty-state">No orders yet.</div></div>
<h3 class="shop-h">Edit the list</h3>
<form class="card shop-form" id="ordForm" autocomplete="off">
 <input id="ordSup" maxlength="60" placeholder="Supplier" aria-label="Supplier" list="ordSupList"><datalist id="ordSupList"></datalist>
 <div class="shop-form-row"><input id="ordName" maxlength="80" placeholder="Item e.g. Tomatoes" aria-label="Item"><input id="ordUnit" maxlength="20" placeholder="Unit" aria-label="Unit" list="ordUnits" class="ord-unit-in"></div>
 <datalist id="ordUnits">${UNITS.map(u=>`<option value="${u}">`).join('')}</datalist>
 <textarea id="ordMany" rows="3" placeholder="Or paste many items, one per line, e.g.&#10;Tomatoes - box&#10;Basil - bunch" aria-label="Many items"></textarea>
 <button type="submit" class="secondary" id="ordAdd">Add to the list</button>
 <p class="rm-data-note" id="ordFormMsg" aria-live="polite"></p>
</form>`;
document.querySelector('main').append(screen);MANAGER_SCREEN_IDS.push(screen.id);
const opener=document.createElement('button');opener.type='button';opener.id='rmOpenOrders';opener.hidden=true;
opener.onclick=()=>{showOnlyManagerScreen(screen.id);setManagerNavActive('operations');window.scrollTo(0,0);load().catch(e=>msg(e.message||'Unable to load.'));};
document.body.append(opener);
const row=`<button type="button" class="rm-row" data-rm-go="rmOpenOrders">${ICON}<span><strong>Orders</strong><small>Order list and PDF for suppliers</small></span><i aria-hidden="true">›</i></button>`;
for(const menu of [document.querySelector('#operationsScreen .rm-menu'),document.querySelector('#managerMoreScreen .rm-menu'),document.querySelector('#quickActionsDialog .rm-actions')]){
 const after=menu?.querySelector('[data-rm-go="rmOpenMaintenance"]')||menu?.querySelector('[data-rm-go="rmOpenShopping"]');if(after)after.insertAdjacentHTML('afterend',row);else menu?.insertAdjacentHTML('beforeend',row);
}
const say=(id,x,ok)=>{const m=$(id);m.textContent=x||'';m.style.color=ok?'#07613b':x?'#b3261e':'';};
const msg=(x,ok)=>say('ordMsg',x,ok),fmsg=(x,ok)=>say('ordFormMsg',x,ok);
// The quantities being typed stay on this phone until the PDF is made.
const draftKey=()=>`mh-order-draft:${state.data?.location||''}:${state.supplier||''}`;
const saveDraft=()=>{try{localStorage.setItem(draftKey(),JSON.stringify(state.qty));}catch(_){}};
const readDraft=()=>{try{return JSON.parse(localStorage.getItem(draftKey())||'{}')||{};}catch(_){return {};}};

async function load(){
 const gen=++state.gen;
 const d=await managerApi('manager_order_list',state.supplier?{supplier:state.supplier}:{});
 if(gen!==state.gen)return;state.data=d;state.supplier=d.supplier||state.supplier;state.qty=readDraft();render();
}
function render(){
 const d=state.data;if(!d)return;
 const sups=d.suppliers||[];
 $('ordSups').innerHTML=sups.length>1?sups.map(s=>`<button type="button" class="ord-sup${s===state.supplier?' on':''}" data-ord-sup="${t(s)}">${t(s)}</button>`).join(''):'';
 $('ordSupList').innerHTML=[...new Set([...sups,DEFAULT_SUPPLIER])].map(s=>`<option value="${t(s)}">`).join('');
 if(!$('ordSup').value)$('ordSup').value=state.supplier||DEFAULT_SUPPLIER;
 const items=d.items||[];const box=$('ordList');
 $('ordSend').hidden=!items.length;
 if(!items.length){box.innerHTML=`<div class="empty-state">No items yet. Add what you order from ${t(state.supplier||DEFAULT_SUPPLIER)} below (you can paste many at once).</div>`;}
 else box.innerHTML=`<div class="ord-head"><strong>${t(state.supplier)}</strong><span id="ordCount"></span></div>`+items.map(i=>`<div class="ord-row${state.qty[i.id]?' has':''}" data-ord-item="${t(i.id)}">
   <span class="ord-name"><strong>${t(i.name)}</strong>${i.unit?`<small>${t(i.unit)}</small>`:''}</span>
   <button type="button" class="ord-step" data-ord-minus aria-label="Less ${t(i.name)}">−</button>
   <input class="ord-qty" inputmode="decimal" maxlength="6" value="${t(state.qty[i.id]||'')}" aria-label="${t(i.name)} quantity">
   <button type="button" class="ord-step" data-ord-plus aria-label="More ${t(i.name)}">+</button>
   ${state.editing?`<button type="button" class="shop-small" data-ord-remove>${state.removing===i.id?'Tap again':'Remove'}</button>`:''}</div>`).join('')+
   `<div class="ord-edit"><button type="button" class="shop-small" id="ordEditBtn">${state.editing?'Done':'Remove items'}</button></div>`;
 count();
 if(!$('ordDay').value)$('ordDay').value=addDays(todayIso(),1);
 const past=d.orders||[];const pb=$('ordPast');
 if(!past.length){pb.className='empty-state';pb.textContent='No orders yet.';}
 else{pb.className='';pb.innerHTML=past.map(o=>`<div class="tmp-rec"><span class="tmp-rec-main"><strong>${t(dayLong(o.created_at))}${o.deliver_on?` · for ${t(isoLong(o.deliver_on))}`:''}</strong><small>${t(o.by||'')} · ${o.lines.length} item${o.lines.length===1?'':'s'} · ${t(o.lines.slice(0,4).map(l=>`${l.qty} ${l.name}`).join(', '))}${o.lines.length>4?'…':''}</small></span><button type="button" class="shop-small" data-ord-use="${t(o.id)}">Use again</button></div>`).join('');}
}
function count(){const n=Object.values(state.qty).filter(v=>String(v).trim()).length;const c=$('ordCount');if(c)c.textContent=n?`${n} item${n===1?'':'s'} to order`:'';}
const step=(v,d)=>{const x=Number(String(v||'0').replace(',','.'))||0;const y=Math.max(0,Math.round((x+d)*100)/100);return y?String(y):'';};
screen.addEventListener('input',ev=>{const i=ev.target.closest('.ord-qty');if(!i)return;const id=i.closest('[data-ord-item]').dataset.ordItem;
 const v=i.value.trim();if(v)state.qty[id]=v;else delete state.qty[id];i.closest('.ord-row').classList.toggle('has',!!v);saveDraft();count();});
screen.addEventListener('click',async ev=>{
 const r=ev.target.closest('[data-ord-item]');
 if(r&&(ev.target.closest('[data-ord-plus]')||ev.target.closest('[data-ord-minus]'))){const id=r.dataset.ordItem;const v=step(state.qty[id],ev.target.closest('[data-ord-plus]')?1:-1);
  if(v)state.qty[id]=v;else delete state.qty[id];const i=r.querySelector('.ord-qty');i.value=v;r.classList.toggle('has',!!v);saveDraft();count();return;}
 if(r&&ev.target.closest('[data-ord-remove]')){const id=r.dataset.ordItem;if(state.removing!==id){state.removing=id;render();return;}
  try{await managerApi('manager_order_item_save',{item:{id,active:false}});state.removing=null;delete state.qty[id];saveDraft();await load();}catch(err){msg(err.message||'Unable to remove.');}return;}
 if(ev.target.closest('#ordEditBtn')){state.editing=!state.editing;state.removing=null;render();return;}
 const sp=ev.target.closest('[data-ord-sup]');if(sp){state.supplier=sp.dataset.ordSup;$('ordSup').value=state.supplier;state.editing=false;load().catch(e=>msg(e.message));return;}
 const use=ev.target.closest('[data-ord-use]');if(use){const o=(state.data?.orders||[]).find(x=>x.id===use.dataset.ordUse);if(o)fillFrom(o);return;}
 if(ev.target.closest('#ordRepeat')){const o=(state.data?.orders||[])[0];if(!o){msg('No order yet to repeat.');return;}fillFrom(o);return;}
 if(ev.target.closest('#ordClear')){state.qty={};$('ordNote').value='';saveDraft();render();msg('');return;}
});
function fillFrom(o){
 const byName=new Map((state.data?.items||[]).map(i=>[i.name.toLowerCase(),i.id]));
 state.qty={};let missing=0;for(const l of o.lines){const id=byName.get(String(l.name).toLowerCase());if(id)state.qty[id]=l.qty;else missing++;}
 saveDraft();render();window.scrollTo({top:$('ordList').offsetTop-80,behavior:'smooth'});
 msg(missing?`${missing} item${missing===1?' is':'s are'} no longer on the list.`:'Quantities copied. Change what you need, then make the PDF.',!missing);
}
$('ordPdf').addEventListener('click',async()=>{
 const d=state.data;const items=d?.items||[];
 const lines=items.filter(i=>String(state.qty[i.id]||'').trim()).map(i=>({name:i.name,unit:i.unit||'',qty:String(state.qty[i.id]).trim()}));
 if(!lines.length){msg('Type a quantity for at least one item.');return;}
 if(!window.MarinaraTempPdf){msg('PDF tools are still loading. Try again.');return;}
 const b=$('ordPdf');b.disabled=true;b.textContent='Making the PDF…';
 const day=$('ordDay').value,note=$('ordNote').value.trim();
 try{
  await managerApi('manager_order_save',{order:{supplier:state.supplier,deliver_on:day,note,lines}});
  const fresh=await managerApi('manager_order_list',{supplier:state.supplier});
  const by=fresh.orders?.[0]?.by||'';
  await window.MarinaraTempPdf.open({kind:'table',title:'ORDER',place:`Marinara ${d.location||''}`,
   when:day?`Delivery: ${isoLong(day)}`:dayLong(Date.now()),
   limits:`To: ${state.supplier} · Ordered ${dayLong(Date.now())}${by?` by ${by}`:''} · ${lines.length} item${lines.length===1?'':'s'}`,
   logo:document.querySelector('.login-original-logo')?.src,filePrefix:`Marinara-Order-${state.supplier.replace(/[^a-zA-Z0-9]+/g,'-')}-`,fileDate:day||todayIso(),
   shareTitle:`Marinara order for ${state.supplier}`,foot:`Marinara Ristorante Cafe · ${d.location||''}`,
   head:['Item','Qty','Unit'],widths:{1:30,2:40},rows:lines.map(l=>[l.name,{t:l.qty,bold:false},l.unit]),
   notes:note?{title:'Note',head:['Note'],rows:[[note]],none:''}:null});
  state.qty={};$('ordNote').value='';saveDraft();state.data=fresh;render();msg('Order saved. Share the PDF with the supplier.',true);
 }catch(err){msg(err.message||'Unable to make the order.');}
 finally{b.disabled=false;b.textContent='Make the PDF';}
});
$('ordForm').addEventListener('submit',async ev=>{ev.preventDefault();
 const supplier=$('ordSup').value.trim()||DEFAULT_SUPPLIER;
 const many=$('ordMany').value.split('\n').map(x=>x.trim()).filter(Boolean).map(x=>{const m=x.split(/\s+[-–·|]\s+|\t|,\s*(?=[a-z]+$)/i);return {name:m[0].trim(),unit:(m[1]||'').trim()};});
 const one=$('ordName').value.trim()?[{name:$('ordName').value.trim(),unit:$('ordUnit').value.trim()}]:[];
 const all=[...one,...many].filter(i=>i.name);
 if(!all.length){fmsg('Write the item, e.g. Tomatoes.');return;}
 const b=$('ordAdd');b.disabled=true;let added=0;
 try{for(const i of all){const r=await managerApi('manager_order_item_save',{item:{supplier,name:i.name,unit:i.unit}});if(!r?.item?.existing)added++;}
  $('ordName').value='';$('ordUnit').value='';$('ordMany').value='';state.supplier=supplier;fmsg(`${added} added to ${supplier}${all.length>added?` (${all.length-added} already on the list)`:''}.`,true);await load();}
 catch(err){fmsg(err.message||'Unable to add.');}finally{b.disabled=false;}
});
window.addEventListener('marinara:session-reset',()=>{state.gen++;Object.assign(state,{data:null,supplier:null,qty:{},removing:null,editing:false});
 for(const id of ['ordSup','ordName','ordUnit','ordMany','ordNote','ordDay'])$(id).value='';$('ordList').innerHTML='';$('ordPast').innerHTML='';msg('');fmsg('');});
})();
