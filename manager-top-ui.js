/* Top products (Invoices → Top): what the restaurant buys most, by spend or by
   number of orders, from the imported supplier history plus the saved invoices.
   Read-only; Administrator and Kitchen Manager only (the server refuses everyone else). */
(() => {
const $=id=>document.getElementById(id);
const SHOW=40;
const state={data:null,at:0,loading:null,sort:'spend',all:false,gen:0};
const money=n=>'$'+Number(n||0).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2});
const money0=n=>'$'+Math.round(Number(n||0)).toLocaleString('en-AU');
const day=d=>d?new Intl.DateTimeFormat('en-AU',{timeZone:'UTC',day:'numeric',month:'short',year:'2-digit'}).format(new Date(`${d}T00:00:00Z`)):'';
const t=v=>escapeHtml(String(v??''));
const pct=n=>`${Math.abs(Number(n)).toLocaleString('en-AU',{maximumFractionDigits:1})}%`;

let built=false;
function build(){
 if(built)return;built=true;
 $('invTopView').innerHTML=`<p class="inv-hint" id="tpHint">What you buy most, from your saved invoices and the supplier history.</p>
 <div class="rm-chips" id="tpChips"><button type="button" data-tp-sort="spend" aria-pressed="true">By spend</button><button type="button" data-tp-sort="orders" aria-pressed="false">By orders</button></div>
 <input id="tpSearch" class="inv-search" type="search" placeholder="Search a product, brand or code" autocomplete="off">
 <div class="card pb-card"><div id="tpList" class="empty-state">Loading…</div></div>
 <button type="button" id="tpMore" class="btn tp-more" hidden></button>
 <p class="rm-data-note">Prices before GST. Items sold by weight (pork, haloumi, chorizo) change with each carton weight, so their % is not a real price rise.</p>`;
 $('tpChips').addEventListener('click',e=>{const b=e.target.closest('[data-tp-sort]');if(!b)return;state.sort=b.dataset.tpSort;render();});
 $('tpSearch').addEventListener('input',render);
 $('tpMore').addEventListener('click',()=>{state.all=!state.all;render();});
}
async function load(force){
 if(!force&&state.data&&Date.now()-state.at<5*60e3)return state.data;
 if(state.loading)return state.loading;
 const gen=state.gen;
 state.loading=managerApi('manager_invoice_top_products').then(d=>{if(gen!==state.gen)return null;state.data=d||{products:[]};state.at=Date.now();return state.data;}).finally(()=>{state.loading=null;});
 return state.loading;
}
async function show(){
 build();
 if(!state.data)$('tpList').textContent='Loading…';
 try{await load();render();}
 catch(e){const b=$('tpList');b.className='empty-state';b.textContent=e.message||'Unable to load the most bought products.';}
}
function render(){
 const d=state.data;if(!d)return;
 for(const b of document.querySelectorAll('#tpChips [data-tp-sort]'))b.setAttribute('aria-pressed',String(b.dataset.tpSort===state.sort));
 const list=d.products||[];const total=Number(d.total)||0;
 const imp=(d.imports||[]).map(i=>`${t(i.supplier)} history from ${t(day(i.from))}`).join(', ');
 $('tpHint').innerHTML=list.length?`${list.length} products · <strong>${t(money0(total))}</strong> since ${t(day(d.period_from))}.${imp?` Includes ${imp}.`:''}`:'What you buy most, from your saved invoices and the supplier history.';
 const q=$('tpSearch').value.trim().toLowerCase();
 const ranked=list.slice().sort(state.sort==='orders'?(a,b)=>b.orders-a.orders||Number(b.spend)-Number(a.spend):(a,b)=>Number(b.spend)-Number(a.spend));
 const rank=new Map(ranked.map((p,i)=>[p,i+1]));
 let rows=ranked.filter(p=>!q||`${p.description} ${p.brand||''} ${p.supplier} ${p.code||''}`.toLowerCase().includes(q));
 const more=$('tpMore');
 if(!q&&rows.length>SHOW){more.hidden=false;more.textContent=state.all?`Show top ${SHOW} only`:`Show all ${rows.length}`;if(!state.all)rows=rows.slice(0,SHOW);}else more.hidden=true;
 const box=$('tpList');
 if(!list.length){box.className='empty-state';box.textContent='Nothing yet. Products appear here as soon as you save supplier invoices.';return;}
 if(!rows.length){box.className='empty-state';box.textContent='Nothing matches.';return;}
 box.className='';
 box.innerHTML=rows.map(p=>{
  const share=total?Number(p.spend)/total*100:0;
  // 40% or more is almost always a weight-priced carton, not a real price change.
  const c=p.change_pct==null||Number(p.change_pct)===0||Math.abs(Number(p.change_pct))>=40?'':`<em class="pb-chg ${Number(p.change_pct)>0?'up':'down'}">${Number(p.change_pct)>0?'▲':'▼'} ${pct(p.change_pct)}</em>`;
  const label=p.last_label?`<small>/${t(String(p.last_label).toLowerCase())}</small>`:'';
  return `<div class="pb-row tp-row"><span class="tp-rank">${rank.get(p)}</span><span class="pb-main"><strong>${t(p.description)}</strong><small>${p.brand?`${t(p.brand)} · `:''}${t(p.supplier)}${p.code?` · #${t(p.code)}`:''}</small><small>${p.orders} order${p.orders===1?'':'s'} · last ${t(day(p.last_date))} · ${t(money(p.last_price))}${label} ${c}</small></span><span class="pb-right"><strong>${t(money0(p.spend))}</strong><small>${share>=0.1?`${share.toLocaleString('en-AU',{maximumFractionDigits:1})}% of total`:'&lt; 0.1%'}</small></span></div>`;
 }).join('');
}
window.mhTopProducts={show,reset:()=>{state.at=0;}};
// A saved or removed invoice changes the ranking.
document.addEventListener('click',e=>{if(e.target.closest('#invSaveBtn,[data-inv-save],[data-inv-remove]'))state.at=0;},true);
window.addEventListener('marinara:session-reset',()=>{state.gen++;state.data=null;state.at=0;state.all=false;if(built){$('tpSearch').value='';$('tpList').className='empty-state';$('tpList').textContent='Loading…';}});
})();
