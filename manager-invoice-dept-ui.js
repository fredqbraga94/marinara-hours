/* Invoices in two lists, Kitchen and Floor (like Suppliers and Notes): the
   Kitchen Manager sees only Kitchen invoices, the Floor Manager only Floor
   invoices, the Administrator both (switch at the top of Invoices, remembered
   on the phone; an invoice can be moved to the other list). Invoices, Top,
   Weekly and Prices show the chosen list; Costs is Kitchen only. The server
   checks who may use which list. */
(() => {
const $=id=>document.getElementById(id);
const DEP_KEY='mh-invoices-dept';
const readDep=()=>{try{const v=localStorage.getItem(DEP_KEY);return v==='Floor'||v==='Kitchen'?v:null;}catch(_){return null;}};
const isAdmin=()=>(typeof currentManagerRole==='undefined'?'':currentManagerRole)==='manager';
const ownDep=()=>{const r=typeof currentManagerRole==='undefined'?'':currentManagerRole;return r==='floor_manager'?'Floor':r==='kitchen_manager'?'Kitchen':null;};
const state={dept:null};
// The list in use: the Administrator's choice, or the manager's own.
const current=()=>ownDep()||state.dept||readDep()||'Kitchen';
window.mhInvDept=current;

// Every invoice call carries the list (unless it names one itself).
const orig=managerApi;
managerApi=async function(action,extra={}){
 if(typeof action==='string'&&action.startsWith('manager_invoice_')&&isAdmin()&&!(extra&&'department' in extra))extra={...(extra||{}),department:current()};
 return orig.call(this,action,extra);
};

const screen=$('invoicesScreen');if(!screen)return;
const sw=document.createElement('div');sw.id='invDept';sw.className='stock-dept hidden';
sw.innerHTML='<button type="button" data-inv-dept="Kitchen">Kitchen</button><button type="button" data-inv-dept="Floor">Floor</button>';
$('invTabs')?.insertAdjacentElement('beforebegin',sw);
const note=document.createElement('p');note.id='invDeptNote';note.className='inv-hint hidden';
$('invTabs')?.insertAdjacentElement('beforebegin',note);

function paint(){
 const dep=current(),admin=isAdmin();
 sw.classList.toggle('hidden',!admin);
 sw.querySelectorAll('[data-inv-dept]').forEach(b=>b.classList.toggle('selected',b.dataset.invDept===dep));
 note.classList.toggle('hidden',admin||!ownDep());
 note.textContent=ownDep()?`${ownDep()} invoices: only you and the Administrator see them.`:'';
 // Costs (ingredients and dishes) is Kitchen only.
 const costs=document.querySelector('#invTabs [data-inv-tab="costs"]');
 if(costs){costs.hidden=dep!=='Kitchen';const tabs=$('invTabs');if(tabs)tabs.style.gridTemplateColumns=`repeat(${dep==='Kitchen'?5:4},1fr)`;}
 if(dep!=='Kitchen'&&typeof invState!=='undefined'&&invState.tab==='costs')invShowTab('list');
}
function resetCaches(){
 if(typeof invState!=='undefined'){invState.open={};invState.lines={};invState.usage=null;invState.supplierNames=null;}
 window.mhPricesReset?.(true);window.mhTopProducts?.reset?.();
}
sw.addEventListener('click',e=>{
 const b=e.target.closest('[data-inv-dept]');if(!b||b.dataset.invDept===current())return;
 state.dept=b.dataset.invDept;try{localStorage.setItem(DEP_KEY,state.dept);}catch(_){}
 resetCaches();invClearMsg();paint();
 invShowTab(invState.tab==='costs'&&state.dept!=='Kitchen'?'list':invState.tab);
});
// Opening Invoices: show the switch and the right tabs.
for(const id of ['moreInvoicesBtn','invoicesCard'])$(id)?.addEventListener('click',paint,true);
new MutationObserver(()=>{if(!screen.classList.contains('hidden'))paint();}).observe(screen,{attributes:true,attributeFilter:['class']});

// Move an invoice to the other list (Administrator).
screen.addEventListener('click',async e=>{
 const b=e.target.closest('[data-inv-move]');if(!b)return;
 const to=b.dataset.invTo;
 if(b.dataset.confirm!=='1'){b.dataset.confirm='1';b.textContent=`Tap again to move to ${to}`;return;}
 b.disabled=true;
 try{await managerApi('manager_invoice_move',{id:b.dataset.invMove,department:to});resetCaches();invMsg(`Invoice moved to the ${to} list.`,true);loadInvoices();}
 catch(err){b.disabled=false;invMsg(err.message||'Unable to move the invoice.',false);}
});
window.addEventListener('marinara:session-reset',()=>{state.dept=null;});
})();
