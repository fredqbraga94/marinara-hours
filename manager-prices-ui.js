/* Products (Finance → Invoices → Products): every product on the saved supplier
   invoices with the price paid each time, whether it went up or down, and how
   much is bought a week (one list instead of the old Top, Weekly and Prices), for
   the whole list or one supplier
   (Finance → Prices only, so who sees prices follows who may open Invoices). Read-only;
   Administrator, Kitchen and Floor Managers, each on their invoice list. */
(() => {
const $=id=>document.getElementById(id);
const RECENT_DAYS=14;
const state={products:[],at:0,loading:null,filter:'all',open:null,sup:'',saved:[],weekly:new Map()};
const WEEKS=8;
// The price is for one unit when the unit says so ("EA", "Unit", or a supplier's
// "Ctn [6]" that counts single units); otherwise ("CTN", "x 6", "Box"...) it is
// the carton's, and the number typed divides it.
const PER_UNIT=/^\s*(unit|units|ea|each|btl|bottle|bottles|pk|pack|packet|bag|tin|tub|block|kg|kgs|g|l|lt|ltr|litre|rw)\s*$|\[\s*\d+\s*\]/i;
// How many packs or units come in a carton: typed once, kept for this product.
function packEditor(p,key){
 const n=Number(p.pack)>1?Number(p.pack):'';
 return `<div class="pb-pack" data-pb-pack="${t(key)}"><label>How many in a ctn?<input type="number" inputmode="numeric" min="1" max="1000" step="1" value="${n}" placeholder="e.g. 10"></label><button type="button" class="shop-small" data-pb-pack-save>Save</button>${p.pack_saved?'<button type="button" class="shop-small" data-pb-pack-clear>Clear</button>':''}</div>`;
}
async function savePack(box,clear){
 const key=box.dataset.pbPack;const prod=state.products.find(p=>`${p.supplier}|${p.product_key}`===key);if(!prod)return;
 const v=clear?null:Number(box.querySelector('input').value);
 if(!clear&&!(Number.isInteger(v)&&v>=1&&v<=1000)){invMsg('Write how many come in a carton (1 to 1000).',false);return;}
 box.querySelectorAll('button').forEach(b=>b.disabled=true);
 try{await managerApi('manager_invoice_pack_save',{supplier:prod.supplier,product_key:prod.product_key,pack:v});
  state.at=0;await load(true);render();invMsg(clear?'Carton size cleared.':`Saved: ${v} in a ctn.`,true);}
 catch(e){box.querySelectorAll('button').forEach(b=>b.disabled=false);invMsg(e.message||'Unable to save the carton size.',false);}
}
// Each supplier in its own colour, the same every time, so the eye finds it fast.
// Gulli red, Moco blue (asked for); the others share colours that are neither.
const SUP_COLORS=['#1f6f4a','#7c2d92','#a16207','#0f766e','#4d7c0f','#57534e'];
const supColor=name=>{const n=String(name||'').toLowerCase();
 if(/gulli|global food/.test(n))return '#b91c1c';
 if(/\bmoco\b/.test(n))return '#1d4ed8';
 let h=0;for(const c of n)h=(h*31+c.charCodeAt(0))>>>0;return SUP_COLORS[h%SUP_COLORS.length];};
const keyOf=(supplier,key)=>`${String(supplier||'').toLowerCase()}|${String(key||'').toLowerCase()}`;
const qty=n=>{const v=Number(n)||0;return v>=10?String(Math.round(v)):v.toLocaleString('en-AU',{maximumFractionDigits:1});};
// "1.8 ctn a week": cartons when the supplier counts single units ("Ctn [6]").
function perWeek(w){if(!w||!(Number(w.avg_per_week)>0))return '';const m=String(w.unit||'').match(/^\s*c(?:tn|arton)s?\s*\[(\d+)\]\s*$/i);
 const n=m?Number(w.avg_per_week)/Number(m[1]):Number(w.avg_per_week);return `${qty(n)} ${m?'ctn':String(w.unit||'').toLowerCase()||'un'} a week`.replace(/\s+/g,' ');}
const norm=v=>String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
// "Moco" matches "MOCO Food Services"; "Global Food and Wine (Gulli)" matches itself.
const sameSupplier=(saved,inv)=>{const a=norm(saved),b=norm(inv);if(!a||!b)return false;if(a===b)return true;
 const word=w=>w.length>=3&&!['food','foods','fresh','services','the','and','wine','pty','ltd','produce'].includes(w);
 const aw=a.split(' ').filter(word),bw=b.split(' ').filter(word);return aw.length>0&&aw.every(w=>bw.includes(w));};
// The suppliers saved in Stock & Orders → Suppliers (same list, Kitchen or Floor), so
// one with no invoice yet can still be picked.
async function loadSaved(){
 const admin=(typeof currentManagerRole==='undefined'?'':currentManagerRole)==='manager';const dep=window.mhInvDept?.();
 try{const d=await managerApi('manager_supplier_list',admin&&dep?{department:dep}:{});state.saved=(d.suppliers||[]).map(x=>x.name);}catch(_){state.saved=[];}
}
const groupOf=p=>state.saved.find(n=>sameSupplier(n,p.supplier))||p.supplier;
function groups(){const m=new Map(state.saved.map(n=>[n,0]));for(const p of state.products){const g=groupOf(p);m.set(g,(m.get(g)||0)+1);}
 return [...m].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));}
const canSee=()=>['manager','kitchen_manager','floor_manager'].includes(typeof currentManagerRole==='undefined'?'':currentManagerRole)&&(!window.mhCan||window.mhCan('invoices'));
const money=n=>typeof invMoney==='function'?invMoney(n):'$'+Number(n).toFixed(2);
const day=d=>d?new Intl.DateTimeFormat('en-AU',{timeZone:'UTC',day:'numeric',month:'short'}).format(new Date(`${d}T00:00:00Z`)):'';
const daysSince=d=>Math.floor((Date.now()+10*3600e3-Date.parse(`${d}T00:00:00Z`))/864e5);
const pct=n=>`${Math.abs(Number(n)).toLocaleString('en-AU',{maximumFractionDigits:1})}%`;
const t=v=>escapeHtml(String(v??''));
const up=p=>Number(p.change_pct)>0, down=p=>Number(p.change_pct)<0;
const recentUp=p=>up(p)&&!p.year&&daysSince(p.last_date)<=RECENT_DAYS;

async function load(force){
 if(!canSee())return [];
 if(!force&&state.at&&Date.now()-state.at<5*60e3)return state.products;
 if(state.loading)return state.loading;
 const gen=state.gen||0;
 // The supplier history (Invoices → Top) adds the change over the year for
 // products whose saved invoices do not show a change yet.
 state.loading=Promise.all([managerApi('manager_invoice_price_book'),managerApi('manager_invoice_top_products').catch(()=>null),managerApi('manager_invoice_usage',{weeks:WEEKS}).catch(()=>null)]).then(([d,top,use])=>{if(gen!==(state.gen||0))return [];
  state.weekly=new Map((use&&use.items||[]).map(w=>[keyOf(w.supplier,w.code||w.description),w]));
  state.products=withYear(d.products||[],top&&top.products||[]);state.at=Date.now();return state.products;}).finally(()=>{state.loading=null;});
 const list=await state.loading;
 if(gen!==(state.gen||0))return [];
 window.mhPriceUps=list.filter(recentUp);
 window.dispatchEvent(new CustomEvent('marinara:prices'));
 return list;
}
window.mhPriceUps=[];
// 40% or more is almost always a carton sold by weight, not a real price change.
const realYear=x=>x.from_history&&x.change_pct!=null&&Number(x.change_pct)!==0&&Math.abs(Number(x.change_pct))<40;
// One name style: the supplier history's brand and name when the product is in it.
const histName=x=>x.brand?`${x.brand} · ${x.description}`:x.description;
// The same product under a new code (the supplier renumbered it): same supplier and
// the same words in the name, in any order ("Cheese Bocconcini 1Kg" = "Bocconcini Cheese 1kg").
const nameKey=(supplier,desc)=>`${String(supplier).toLowerCase()}|${String(desc||'').toLowerCase().split('·').pop().replace(/[^a-z0-9.]+/g,' ').trim().split(/\s+/).sort().join(' ')}`;
function withYear(book,top){
 const out=book.slice();const byKey=new Map(out.map(p=>[`${String(p.supplier).toLowerCase()}|${p.code||p.product_key}`,p]));
 const byName=new Map();for(const p of out){const k=nameKey(p.supplier,p.description);byName.set(k,byName.has(k)?null:p);}
 for(const x of top){
  if(!x.from_history)continue;
  const key=`${String(x.supplier).toLowerCase()}|${x.code}`;const have=byKey.get(key)||byName.get(nameKey(x.supplier,x.description))||null;
  const hist=[{date:x.first_date,price:x.first_price,fromHistory:true},{date:x.last_date,price:x.last_price,fromHistory:true}].filter((h,i,a)=>h.date&&h.price!=null&&(i===0||h.date!==a[0].date));
  if(have){
   have.description=histName(x);
   // Keep a change the saved invoices already show; otherwise use the year.
   if(have.change_pct==null&&realYear(x)){Object.assign(have,{change_pct:x.change_pct,previous_price:x.first_price,previous_date:x.first_date,year:true,times:Math.max(have.times||0,x.orders||0),
     // One timeline: the first price of the year from the history, then the saved invoices.
     history:[{date:x.first_date,price:x.first_price,fromHistory:true},...(have.history||[]).filter(h=>h.date>x.first_date)]});}
   else have.times=Math.max(have.times||0,x.orders||0);
   continue;
  }
  out.push({supplier:x.supplier,product_key:x.code,code:x.code,description:histName(x),unit:x.last_label||'',times:x.orders,last_price:x.last_price,last_date:x.last_date,
   previous_price:realYear(x)?x.first_price:null,previous_date:realYear(x)?x.first_date:null,change_pct:realYear(x)?x.change_pct:null,history:hist,year:realYear(x),from_history:true});
 }
 return out;
}
// Forget the cached list (after an invoice is saved or removed).
window.mhPricesReset=(all)=>{state.at=0;if(all){state.gen=(state.gen||0)+1;state.products=[];state.open=null;state.sup='';state.saved=[];state.weekly=new Map();window.mhPriceUps=[];}};
const weekOf=p=>state.weekly.get(keyOf(p.supplier,p.code||p.product_key))||state.weekly.get(keyOf(p.supplier,p.description));

/* ---------- Prices tab ---------- */
let built=false;
function build(){
 if(built)return;built=true;
 $('invPricesView').innerHTML=`<p class="inv-hint">What you buy: the last price paid, if it went up or down, and how much a week. Tap a product to see its prices.</p>
 <div class="pb-import"><button type="button" class="shop-small" id="pbImportBtn">Import price list</button><input id="pbImportFile" type="file" accept=".csv,text/csv" hidden></div>
 <div id="pbImportBox" class="card pb-import-box hidden"></div>
 <select id="pbSup" class="inv-search pb-sup" aria-label="Supplier"></select>
 <div id="pbSupBar" class="pb-supbar hidden"></div>
 <div class="rm-chips" id="pbChips"></div>
 <input id="pbSearch" class="inv-search" type="search" placeholder="Search a product or supplier" autocomplete="off">
 <div class="card pb-card"><div id="pbList" class="empty-state">Loading…</div></div>`;
 $('pbImportBtn').addEventListener('click',()=>$('pbImportFile').click());
 $('pbImportFile').addEventListener('change',e=>{const f=e.target.files?.[0];e.target.value='';window.mhPriceListImport?.(f);});
 $('pbSup').addEventListener('change',()=>{state.sup=$('pbSup').value;state.open=null;render();});
 $('pbSupBar').addEventListener('click',e=>{if(e.target.closest('[data-pb-type]')&&state.sup)window.MarinaraTypedInvoice?.open(state.sup);});
 $('pbChips').addEventListener('click',e=>{const b=e.target.closest('[data-pb-filter]');if(!b)return;state.filter=b.dataset.pbFilter;state.open=null;render();});
 $('pbSearch').addEventListener('input',()=>{state.open=null;render();});
 $('pbList').addEventListener('click',e=>{const pk=e.target.closest('[data-pb-pack]');if(pk){if(e.target.closest('[data-pb-pack-save]'))savePack(pk,false);else if(e.target.closest('[data-pb-pack-clear]'))savePack(pk,true);return;}const b=e.target.closest('[data-pb]');if(!b)return;state.open=state.open===b.dataset.pb?null:b.dataset.pb;render();});
}
const FILTERS=[['all','Most bought',()=>true],['up','Went up',up],['down','Went down',down]];
// Most bought: spend a week (last weeks), then how often it was ordered.
const spendWk=p=>Number(weekOf(p)?.spend_per_week)||0;
function render(){
 const gs=groups();if(state.sup&&!gs.some(g=>g[0]===state.sup))gs.push([state.sup,0]);
 $('pbSup').innerHTML=`<option value="">All suppliers (${state.products.length})</option>`+gs.map(([n,c])=>`<option value="${t(n)}"${n===state.sup?' selected':''}>${t(n)} (${c})</option>`).join('');
 const list=state.sup?state.products.filter(p=>groupOf(p)===state.sup):state.products;
 const bar=$('pbSupBar');bar.classList.toggle('hidden',!state.sup);
 bar.innerHTML=state.sup?`${list.length?'':`<p class="inv-hint">No products from ${t(state.sup)} yet. They show here from their invoices: if ${t(state.sup)} sends no PDF, type one of their invoices.</p>`}<button type="button" class="shop-small" data-pb-type>+ Type one of their invoices</button>`:'';
 $('pbChips').innerHTML=FILTERS.map(([k,l,f])=>`<button type="button" data-pb-filter="${k}" aria-pressed="${state.filter===k}">${l}${k==='all'?'':` <span>${list.filter(f).length}</span>`}</button>`).join('');
 const q=$('pbSearch').value.trim().toLowerCase();
 const f=FILTERS.find(x=>x[0]===state.filter)[2];
 let rows=list.filter(p=>f(p)&&(!q||`${p.description} ${p.supplier} ${p.code||''}`.toLowerCase().includes(q)));
 rows=rows.slice().sort(state.filter==='up'?(a,b)=>(!!a.year-!!b.year)||(a.year?Number(b.change_pct)-Number(a.change_pct):b.last_date.localeCompare(a.last_date)||Number(b.change_pct)-Number(a.change_pct))
   :state.filter==='down'?(a,b)=>(!!a.year-!!b.year)||Number(a.change_pct)-Number(b.change_pct)
   :(a,b)=>spendWk(b)-spendWk(a)||b.times-a.times||String(a.description).localeCompare(String(b.description)));
 const box=$('pbList');
 if(!list.length){box.className='empty-state';box.textContent=state.sup?'No prices yet.':'No prices yet. They appear here as soon as you save supplier invoices.';return;}
 if(!rows.length){box.className='empty-state';box.textContent=state.filter==='up'?'No price went up. Good news.':'Nothing matches.';return;}
 box.className='';
 box.innerHTML=rows.map(p=>{
  const key=`${p.supplier}|${p.product_key}`;const open=state.open===key;
  const chg=p.change_pct==null?'':`<em class="pb-chg ${up(p)?'up':'down'}">${up(p)?'▲':'▼'} ${pct(p.change_pct)}${p.year?' <span>in the year</span>':''}</em>`;
  // Carton price first when the supplier counts single units ("Ctn [4]").
  // Or the price is already a carton's ("ctn" on the invoice) and a manager typed how
  // many come in it: then each one is the carton price divided by that number.
  const pack=Number(p.pack)>1?Number(p.pack):1;const perCtn=pack>1&&!PER_UNIT.test(p.unit||'');
  const cm=v=>money(perCtn?Number(v):Number(v)*pack);
  const each=perCtn?Number(p.last_price)/pack:Number(p.last_price);
  const unitLabel=pack>1?'ctn':String(p.unit||'').toLowerCase();
  const unit=(unitLabel?`<small>/${t(unitLabel)}</small>`:'')+(pack>1?`<small>${t(money(each))} each · ${pack} a ctn</small>`:'');
  let hist='';
  if(open){
   const h=p.history||[];
   const lines=h.slice().reverse().map((x,i,arr)=>{const prev=arr[i+1];const diff=prev?Number(x.price)-Number(prev.price):0;
     return `<li><span>${t(day(x.date))}${x.list?' <em>price list</em>':''}</span><strong>${t(cm(x.price))}</strong><span class="${diff>0?'up':diff<0?'down':''}">${!prev?(x.fromHistory?'start of the year':'first time'):diff?`${diff>0?'+':'−'}${t(cm(Math.abs(diff)))}`:'same'}</span></li>`;}).join('');
   const first=h[0];const total=first&&Number(first.price)?(Number(p.last_price)-Number(first.price))/Number(first.price)*100:0;
   const w=weekOf(p);const wk=perWeek(w);
   hist=`<div class="pb-hist">${wk?`<p>About <b>${t(wk)}</b> over the last weeks${Number(w.max_week)>Number(w.avg_per_week)?` · busiest week ${t(qty(w.max_week))}`:''} · about ${t(money(w.spend_per_week))} a week.</p>`:''}${p.from_history&&!p.year?`<p>From the supplier history: ${p.times} orders in the year. Items sold by weight change price with each carton.</p>`:h.length>1?`<p>Since ${t(day(first.date))}: ${t(cm(first.price))} → ${t(cm(p.last_price))}${pack>1?' a ctn':''}${Math.abs(total)>=0.05?` <b class="${total>0?'up':'down'}">(${total>0?'+':'−'}${pct(total)})</b>`:' (no change)'}</p>`:p.times?'<p>Bought once so far. The next invoice will show if the price changed.</p>':'<p>From the supplier\'s price list (not bought yet in the saved invoices).</p>'}<ul>${lines}</ul><small>${p.year?'Prices before October come from the supplier history (first price of the year). ':''}${p.code?`Code ${t(p.code)}`:''}</small>${packEditor(p,key)}</div>`;
  }
  return `<button type="button" class="pb-row${open?' open':''}" data-pb="${t(key)}" aria-expanded="${open}"><span class="pb-main"><span class="pb-sup-tag" style="--sup:${supColor(p.supplier)}">${t(p.supplier)}</span><strong>${t(p.description)}</strong><small>${perWeek(weekOf(p))?`<b class="pb-wk">${t(perWeek(weekOf(p)))}</b>`:p.last_from_list?`price list ${t(day(p.last_date))}`:`${p.times}× · last ${t(day(p.last_date))}`}</small></span><span class="pb-right"><strong>${t(cm(p.last_price))}</strong>${unit}${chg}</span></button>${hist}`;
 }).join('');
}
// The Prices tab now shows the price book (the old "changes only" list is kept on the server).
loadInvoicePrices=async function(){
 build();render();
 try{await Promise.all([load(true),loadSaved()]);render();}
 catch(error){const box=$('pbList');box.className='empty-state';box.textContent=error.message||'Unable to load prices.';}
};
// Home → "N prices went up" opens Prices filtered to the rises.
window.mhPricesReload=()=>{if(typeof invState!=='undefined'&&invState.tab==='prices')loadInvoicePrices();};
window.mhOpenPriceUps=()=>{state.filter='up';state.open=null;const b=$('invoicesCard');if(b&&!b.disabled){b.click();invShowTab('prices');}};
const opener=document.createElement('button');opener.type='button';opener.id='rmOpenPriceUps';opener.hidden=true;opener.onclick=()=>window.mhOpenPriceUps();document.body.append(opener);
// Keep the Home alert current; a new invoice saved refreshes it.
window.addEventListener('marinara:dashboard',()=>{if(canSee())load(false).catch(()=>{});else{window.mhPricesReset(true);}});
document.addEventListener('click',e=>{if(e.target.closest('#invSaveBtn,[data-inv-save],[data-inv-remove]'))setTimeout(()=>window.mhPricesReset(),0);},true);
})();
