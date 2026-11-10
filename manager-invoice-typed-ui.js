/* Type an invoice that has no PDF (e.g. Niko's paper invoices): supplier,
   number, date and the lines (qty, unit, product, total). Saved like a PDF
   invoice, so it counts in the spending reports and its prices follow in
   Prices and in the dish costs. Products typed before for the same supplier
   are offered while typing, so the same product keeps the same name. */
(() => {
const $=id=>document.getElementById(id);
const t=v=>escapeHtml(String(v??''));
const UNITS=['box','kg','bunch','each','punnet','bag','tray','litre'];
const today=()=>new Date(Date.now()+10*3600e3).toISOString().slice(0,10);
const money=n=>invMoney(Math.round(n*100)/100);
const num=v=>{const s=String(v??'').trim().replace(/[$,\s]/g,'');if(!s)return null;const n=Number(s);return Number.isFinite(n)?n:NaN;};
const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
const state={open:false,lines:[],book:null,saving:false};

const list=$('invListView');if(!list)return;
const btn=document.createElement('button');btn.type='button';btn.id='invTypeOpen';btn.className='btn inv-type-open';btn.textContent='+ Type an invoice (no PDF)';
list.querySelector('.inv-hint')?.insertAdjacentElement('afterend',btn);
const box=document.createElement('div');box.id='invTyped';box.className='inv-typed-card card hidden';
btn.insertAdjacentElement('afterend',box);

const blank=()=>({qty:'',unit:'',desc:'',total:''});
async function loadBook(){
 if(state.book)return state.book;
 try{state.book=(await managerApi('manager_invoice_price_book')).products||[];}catch(_){state.book=[];}
 return state.book;
}
function suppliers(){return[...new Set((state.book||[]).map(p=>p.supplier).filter(Boolean))].sort((a,b)=>a.localeCompare(b));}
function productsOf(s){const k=clean(s).toLowerCase();return(state.book||[]).filter(p=>String(p.supplier||'').toLowerCase()===k);}

function sum(){return state.lines.reduce((a,l)=>{const n=num(l.total);return a+(Number.isFinite(n)&&n!==null?n:0);},0);}
function lineRow(l,i){
 return `<div class="inv-tl" data-tl="${i}">
  <input class="q" data-tl-f="qty" inputmode="decimal" value="${t(l.qty)}" placeholder="Qty" aria-label="Quantity, line ${i+1}">
  <input class="u" data-tl-f="unit" list="invTypedUnits" value="${t(l.unit)}" placeholder="Unit (box)" aria-label="Unit, line ${i+1}" autocapitalize="off">
  <input class="d" data-tl-f="desc" list="invTypedProducts" value="${t(l.desc)}" placeholder="Product, e.g. Swiss brown mushrooms" aria-label="Product, line ${i+1}">
  <input class="m" data-tl-f="total" inputmode="decimal" value="${t(l.total)}" placeholder="Line total $" aria-label="Line total, line ${i+1}">
  <button type="button" class="x" data-tl-remove="${i}" aria-label="Remove line ${i+1}">×</button>
 </div>`;
}
function render(){
 if(!state.open){box.classList.add('hidden');btn.classList.remove('hidden');return;}
 btn.classList.add('hidden');box.classList.remove('hidden');
 const sup=$('invTypedSupplier')?.value??state.supplier??'';
 box.innerHTML=`<h3>Type an invoice</h3>
  <p class="inv-hint">For a supplier that sends no PDF. Type it as it is on the paper: it counts in the reports and its prices follow in Prices and in the dish costs.</p>
  <label>Supplier <input id="invTypedSupplier" list="invTypedSuppliers" maxlength="80" value="${t(sup)}" placeholder="e.g. Niko Fresh Produce" autocomplete="off"></label>
  <datalist id="invTypedSuppliers">${suppliers().map(s=>`<option value="${t(s)}">`).join('')}</datalist>
  <div class="inv-gen-row"><label>Invoice no. <input id="invTypedNumber" maxlength="60" value="${t(state.number||'')}" inputmode="numeric" autocomplete="off"></label>
  <label>Date <input id="invTypedDate" type="date" value="${t(state.date||today())}"></label></div>
  <datalist id="invTypedUnits">${UNITS.map(u=>`<option value="${u}">`).join('')}</datalist>
  <datalist id="invTypedProducts">${productsOf(sup).map(p=>`<option value="${t(p.description)}">`).join('')}</datalist>
  <div id="invTypedLines">${state.lines.map(lineRow).join('')}</div>
  <button type="button" class="inv-tl-add" id="invTypedAdd">+ Add a line</button>
  <div class="inv-gen-row"><label>GST <input id="invTypedGst" inputmode="decimal" value="${t(state.gst??'0')}" placeholder="0"></label>
  <label>Grand total on the paper <input id="invTypedTotal" inputmode="decimal" value="${t(state.total||'')}" placeholder="$"></label></div>
  <p class="inv-hint">Fresh fruit and veg have no GST: leave it 0.</p>
  <div id="invTypedCheck" aria-live="polite"></div>
  <div class="inv-review-actions"><button type="button" id="invTypedCancel">Cancel</button><button type="button" class="save" id="invTypedSave">Save invoice</button></div>`;
 check();
}
function check(){
 const el=$('invTypedCheck');if(!el)return;
 const sv=$('invTypedSave');if(sv&&sv.dataset.confirm){delete sv.dataset.confirm;sv.textContent='Save invoice';}
 const s=sum(),g=num($('invTypedGst').value)||0,paper=num($('invTypedTotal').value);
 const filled=state.lines.filter(l=>clean(l.desc)||clean(l.total)).length;
 if(!filled){el.innerHTML='';return;}
 if(paper===null||Number.isNaN(paper)){el.innerHTML=`<div class="inv-flag new">Lines: ${filled} · ${money(s+g)}. Type the grand total on the paper to check it.</div>`;return;}
 if(Math.abs(s+g-paper)<0.005)invClearMsg();
 el.innerHTML=Math.abs(s+g-paper)<0.005?`<div class="inv-flag ok">Adds up: ${filled} lines match the total ${money(paper)}</div>`
  :`<div class="inv-flag warn">The lines come to ${money(s+g)}, the paper says ${money(paper)}. Check the amounts.</div>`;
}
function syncHead(){state.supplier=$('invTypedSupplier')?.value;state.number=$('invTypedNumber')?.value;state.date=$('invTypedDate')?.value;state.gst=$('invTypedGst')?.value;state.total=$('invTypedTotal')?.value;}

async function openTyped(supplier){invClearMsg();state.open=true;state.lines=[blank(),blank(),blank()];state.supplier=supplier||'';state.number='';state.date=today();state.gst='0';state.total='';render();
 await loadBook();if(state.open){syncHead();render();}box.scrollIntoView({block:'start'});$(supplier?'invTypedNumber':'invTypedSupplier')?.focus();}
btn.onclick=()=>openTyped('');
// From Suppliers → Products: open Invoices with the form for that supplier.
window.MarinaraTypedInvoice={open:async supplier=>{await openInvoicesScreen();await openTyped(supplier);}};
box.addEventListener('input',e=>{
 const f=e.target.closest('[data-tl-f]');
 if(f){const i=Number(f.closest('[data-tl]').dataset.tl);state.lines[i][f.dataset.tlF]=f.value;
  // A product typed before: its unit comes with it.
  if(f.dataset.tlF==='desc'){const p=productsOf($('invTypedSupplier').value).find(x=>String(x.description).toLowerCase()===clean(f.value).toLowerCase());
   const u=f.closest('[data-tl]').querySelector('[data-tl-f="unit"]');if(p&&p.unit&&!u.value){u.value=String(p.unit).toLowerCase();state.lines[i].unit=u.value;}}
  check();return;}
 if(e.target.id==='invTypedSupplier'){const dl=$('invTypedProducts');if(dl)dl.innerHTML=productsOf(e.target.value).map(p=>`<option value="${t(p.description)}">`).join('');}
 if(e.target.id==='invTypedGst'||e.target.id==='invTypedTotal')check();
});
box.addEventListener('click',async e=>{
 if(e.target.id==='invTypedAdd'){syncHead();state.lines.push(blank());render();box.querySelector(`[data-tl="${state.lines.length-1}"] .q`)?.focus();return;}
 const rm=e.target.closest('[data-tl-remove]');
 if(rm){syncHead();state.lines.splice(Number(rm.dataset.tlRemove),1);if(!state.lines.length)state.lines.push(blank());render();return;}
 if(e.target.id==='invTypedCancel'){state.open=false;render();invClearMsg();return;}
 if(e.target.id!=='invTypedSave'||state.saving)return;
 syncHead();
 const supplier=clean(state.supplier),number=clean(state.number),date=state.date||'';
 if(!supplier||!number||!/^\d{4}-\d{2}-\d{2}$/.test(date)){invMsg('Write the supplier, the invoice number and the date.',false);return;}
 const lines=[];
 for(const [i,l] of state.lines.entries()){
  const desc=clean(l.desc),tot=num(l.total),qty=num(l.qty);
  if(!desc&&tot===null&&qty===null&&!clean(l.unit))continue;
  if(!desc){invMsg(`Line ${i+1}: write the product.`,false);return;}
  if(tot===null||Number.isNaN(tot)||tot<0){invMsg(`${desc}: write the line total, e.g. 24.00.`,false);return;}
  if(Number.isNaN(qty)||(qty!==null&&qty<=0)){invMsg(`${desc}: the quantity must be a number.`,false);return;}
  const q=qty??1;
  lines.push({code:'',description:desc,qty:q,unit:clean(l.unit).toLowerCase(),unit_price:Math.round(tot/q*10000)/10000,line_total:tot,gst:0});
 }
 if(!lines.length){invMsg('Add at least one line.',false);return;}
 const gst=num(state.gst)??0;if(Number.isNaN(gst)||gst<0){invMsg('GST must be a number (0 for fruit and veg).',false);return;}
 const subtotal=Math.round(lines.reduce((a,l)=>a+l.line_total,0)*100)/100,total=Math.round((subtotal+gst)*100)/100;
 const paper=num(state.total);
 if(paper!==null&&!Number.isNaN(paper)&&Math.abs(paper-total)>=0.005&&e.target.dataset.confirm!=='1'){
  e.target.dataset.confirm='1';e.target.textContent='Save anyway';invMsg(`The lines come to ${money(total)}, the paper says ${money(paper)}. Check, or tap "Save anyway".`,false);return;}
 const inv={supplier,number,kind:'invoice',date,subtotal,gst,total,lines};
 state.saving=true;e.target.disabled=true;
 try{
  if(await invAlreadySaved(inv)){invMsg(`${supplier} #${number} is already saved.`,false);return;}
  await managerApi('manager_invoice_save',{invoice:{...inv,checks_ok:paper!==null&&!Number.isNaN(paper)&&Math.abs(paper-total)<0.005,file_name:'Typed in the app'}});
  state.open=false;state.book=null;render();
  invMsg(`Saved: ${supplier} #${number} · ${lines.length} lines · ${money(total)}.`,true);
  window.MarinaraDishCost?.afterInvoiceSave?.(inv);
  loadInvoices();
 }catch(err){invMsg(err.code==='INVOICE_DUPLICATE'?`${supplier} #${number} is already saved.`:(err.message||'Unable to save the invoice.'),false);}
 finally{state.saving=false;if(state.open){e.target.disabled=false;}}
});
window.addEventListener('marinara:session-reset',()=>{state.open=false;state.book=null;state.lines=[];render();});
})();
