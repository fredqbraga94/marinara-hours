/* Price book: every product on the saved supplier invoices, the price paid each
   time, and whether it went up or down. Read-only; Administrator and Kitchen
   Manager only (the server refuses everyone else). */
(() => {
const $=id=>document.getElementById(id);
const RECENT_DAYS=14;
const state={products:[],at:0,loading:null,filter:'all',open:null};
const canSee=()=>['manager','kitchen_manager'].includes(typeof currentManagerRole==='undefined'?'':currentManagerRole)&&(!window.mhCan||window.mhCan('invoices'));
const money=n=>typeof invMoney==='function'?invMoney(n):'$'+Number(n).toFixed(2);
const day=d=>d?new Intl.DateTimeFormat('en-AU',{timeZone:'UTC',day:'numeric',month:'short'}).format(new Date(`${d}T00:00:00Z`)):'';
const daysSince=d=>Math.floor((Date.now()+10*3600e3-Date.parse(`${d}T00:00:00Z`))/864e5);
const pct=n=>`${Math.abs(Number(n)).toLocaleString('en-AU',{maximumFractionDigits:1})}%`;
const t=v=>escapeHtml(String(v??''));
const up=p=>Number(p.change_pct)>0, down=p=>Number(p.change_pct)<0;
const recentUp=p=>up(p)&&!p.year&&daysSince(p.last_date)<=RECENT_DAYS;
const OFTEN=3;

async function load(force){
 if(!canSee())return [];
 if(!force&&state.at&&Date.now()-state.at<5*60e3)return state.products;
 if(state.loading)return state.loading;
 const gen=state.gen||0;
 // The supplier history (Invoices → Top) adds the change over the year for
 // products whose saved invoices do not show a change yet.
 state.loading=Promise.all([managerApi('manager_invoice_price_book'),managerApi('manager_invoice_top_products').catch(()=>null)]).then(([d,top])=>{if(gen!==(state.gen||0))return [];state.products=withYear(d.products||[],top&&top.products||[]);state.at=Date.now();return state.products;}).finally(()=>{state.loading=null;});
 const list=await state.loading;
 if(gen!==(state.gen||0))return [];
 window.mhPriceUps=list.filter(recentUp);
 window.dispatchEvent(new CustomEvent('marinara:prices'));
 return list;
}
window.mhPriceUps=[];
// 40% or more is almost always a carton sold by weight, not a real price change.
const realYear=x=>x.from_history&&x.change_pct!=null&&Number(x.change_pct)!==0&&Math.abs(Number(x.change_pct))<40;
function withYear(book,top){
 const out=book.slice();const byKey=new Map(out.map(p=>[`${String(p.supplier).toLowerCase()}|${p.code||p.product_key}`,p]));
 for(const x of top){
  if(!x.from_history)continue;
  const key=`${String(x.supplier).toLowerCase()}|${x.code}`;const have=byKey.get(key);
  const hist=[{date:x.first_date,price:x.first_price,fromHistory:true},{date:x.last_date,price:x.last_price,fromHistory:true}].filter((h,i,a)=>h.date&&h.price!=null&&(i===0||h.date!==a[0].date));
  if(have){
   // Keep a change the saved invoices already show; otherwise use the year.
   if(have.change_pct==null&&realYear(x)){Object.assign(have,{change_pct:x.change_pct,previous_price:x.first_price,previous_date:x.first_date,year:true,times:Math.max(have.times||0,x.orders||0),
     // One timeline: the first price of the year from the history, then the saved invoices.
     history:[{date:x.first_date,price:x.first_price,fromHistory:true},...(have.history||[]).filter(h=>h.date>x.first_date)]});}
   else have.times=Math.max(have.times||0,x.orders||0);
   continue;
  }
  out.push({supplier:x.supplier,product_key:x.code,code:x.code,description:x.description,unit:x.last_label||'',times:x.orders,last_price:x.last_price,last_date:x.last_date,
   previous_price:realYear(x)?x.first_price:null,previous_date:realYear(x)?x.first_date:null,change_pct:realYear(x)?x.change_pct:null,history:hist,year:realYear(x),from_history:true});
 }
 return out;
}
// Forget the cached list (after an invoice is saved or removed).
window.mhPricesReset=(all)=>{state.at=0;if(all){state.gen=(state.gen||0)+1;state.products=[];state.open=null;window.mhPriceUps=[];}};

/* ---------- Prices tab ---------- */
let built=false;
function build(){
 if(built)return;built=true;
 $('invPricesView').innerHTML=`<p class="inv-hint">Every product on your saved invoices and the supplier history, and the price you paid. Tap one to see its history.</p>
 <div class="rm-chips" id="pbChips"></div>
 <input id="pbSearch" class="inv-search" type="search" placeholder="Search a product or supplier" autocomplete="off">
 <div class="card pb-card"><div id="pbList" class="empty-state">Loading…</div></div>`;
 $('pbChips').addEventListener('click',e=>{const b=e.target.closest('[data-pb-filter]');if(!b)return;state.filter=b.dataset.pbFilter;state.open=null;render();});
 $('pbSearch').addEventListener('input',()=>{state.open=null;render();});
 $('pbList').addEventListener('click',e=>{const b=e.target.closest('[data-pb]');if(!b)return;state.open=state.open===b.dataset.pb?null:b.dataset.pb;render();});
}
const FILTERS=[['all','All',()=>true],['up','Went up',up],['down','Went down',down],['often','Bought often',p=>p.times>=OFTEN]];
function render(){
 const list=state.products;
 $('pbChips').innerHTML=FILTERS.map(([k,l,f])=>`<button type="button" data-pb-filter="${k}" aria-pressed="${state.filter===k}">${l} <span>${list.filter(f).length}</span></button>`).join('');
 const q=$('pbSearch').value.trim().toLowerCase();
 const f=FILTERS.find(x=>x[0]===state.filter)[2];
 let rows=list.filter(p=>f(p)&&(!q||`${p.description} ${p.supplier} ${p.code||''}`.toLowerCase().includes(q)));
 rows=rows.slice().sort(state.filter==='up'?(a,b)=>(!!a.year-!!b.year)||(a.year?Number(b.change_pct)-Number(a.change_pct):b.last_date.localeCompare(a.last_date)||Number(b.change_pct)-Number(a.change_pct))
   :state.filter==='down'?(a,b)=>(!!a.year-!!b.year)||Number(a.change_pct)-Number(b.change_pct)
   :(a,b)=>b.times-a.times||String(a.description).localeCompare(String(b.description)));
 const box=$('pbList');
 if(!list.length){box.className='empty-state';box.textContent='No prices yet. They appear here as soon as you save supplier invoices.';return;}
 if(!rows.length){box.className='empty-state';box.textContent=state.filter==='up'?'No price went up. Good news.':'Nothing matches.';return;}
 box.className='';
 box.innerHTML=rows.map(p=>{
  const key=`${p.supplier}|${p.product_key}`;const open=state.open===key;
  const chg=p.change_pct==null?'':`<em class="pb-chg ${up(p)?'up':'down'}">${up(p)?'▲':'▼'} ${pct(p.change_pct)}${p.year?' <span>in the year</span>':''}</em>`;
  // Carton price first when the supplier counts single units ("Ctn [4]").
  const pack=Number(p.pack)>1?Number(p.pack):1;const cm=v=>money(Number(v)*pack);
  const unitLabel=pack>1?'ctn':String(p.unit||'').toLowerCase();
  const unit=(unitLabel?`<small>/${t(unitLabel)}</small>`:'')+(pack>1?`<small>${t(money(p.last_price))} each · ${pack} a ctn</small>`:'');
  let hist='';
  if(open){
   const h=p.history||[];
   const lines=h.slice().reverse().map((x,i,arr)=>{const prev=arr[i+1];const diff=prev?Number(x.price)-Number(prev.price):0;
     return `<li><span>${t(day(x.date))}</span><strong>${t(cm(x.price))}</strong><span class="${diff>0?'up':diff<0?'down':''}">${!prev?(x.fromHistory?'start of the year':'first time'):diff?`${diff>0?'+':'−'}${t(cm(Math.abs(diff)))}`:'same'}</span></li>`;}).join('');
   const first=h[0];const total=first&&Number(first.price)?(Number(p.last_price)-Number(first.price))/Number(first.price)*100:0;
   hist=`<div class="pb-hist">${p.from_history&&!p.year?`<p>From the supplier history: ${p.times} orders in the year. Items sold by weight change price with each carton.</p>`:h.length>1?`<p>Since ${t(day(first.date))}: ${t(cm(first.price))} → ${t(cm(p.last_price))}${pack>1?' a ctn':''}${Math.abs(total)>=0.05?` <b class="${total>0?'up':'down'}">(${total>0?'+':'−'}${pct(total)})</b>`:' (no change)'}</p>`:'<p>Bought once so far. The next invoice will show if the price changed.</p>'}<ul>${lines}</ul><small>${p.year?'Prices before October come from the supplier history (first price of the year). ':''}${p.code?`Code ${t(p.code)}`:''}</small></div>`;
  }
  return `<button type="button" class="pb-row${open?' open':''}" data-pb="${t(key)}" aria-expanded="${open}"><span class="pb-main"><strong>${t(p.description)}</strong><small>${t(p.supplier)} · ${p.times}× · last ${t(day(p.last_date))}</small></span><span class="pb-right"><strong>${t(cm(p.last_price))}</strong>${unit}${chg}</span></button>${hist}`;
 }).join('');
}
// The Prices tab now shows the price book (the old "changes only" list is kept on the server).
loadInvoicePrices=async function(){
 build();render();
 try{await load(true);render();}
 catch(error){const box=$('pbList');box.className='empty-state';box.textContent=error.message||'Unable to load prices.';}
};
// Home → "N prices went up" opens Prices filtered to the rises.
window.mhOpenPriceUps=()=>{state.filter='up';state.open=null;const b=$('invoicesCard');if(b&&!b.disabled){b.click();invShowTab('prices');}};
const opener=document.createElement('button');opener.type='button';opener.id='rmOpenPriceUps';opener.hidden=true;opener.onclick=()=>window.mhOpenPriceUps();document.body.append(opener);
// Keep the Home alert current; a new invoice saved refreshes it.
window.addEventListener('marinara:dashboard',()=>{if(canSee())load(false).catch(()=>{});else{window.mhPricesReset(true);}});
document.addEventListener('click',e=>{if(e.target.closest('#invSaveBtn,[data-inv-save],[data-inv-remove]'))setTimeout(()=>window.mhPricesReset(),0);},true);
})();
