/* Compare suppliers (Invoices → Prices → Compare suppliers): the same product
   bought from more than one supplier, at the price per kg, litre or each, and
   what the dearer one costs more a month (from what was bought in the last 90
   days). Products with the same name are put together by the app; a manager
   can add another product to a group, take one out ("Not the same"), and say
   what one invoice price buys when the product line does not make it clear
   (a carton of several packs). Administrator and Kitchen Manager only. */
(() => {
const R=()=>window.MarinaraInvoiceReader;
const t=v=>escapeHtml(String(v??''));
const money=n=>typeof invMoney==='function'?invMoney(n):'$'+Number(n).toFixed(2);
const day=d=>d?new Intl.DateTimeFormat('en-AU',{timeZone:'UTC',day:'numeric',month:'short'}).format(new Date(`${d}T00:00:00Z`)):'';
const keyOf=p=>`${p.supplier}|${p.product_key}`;
const state={data:null,at:0,loading:null,gen:0,adding:null,editing:null,msg:'',ok:false};

async function load(force){
 if(!force&&state.data&&Date.now()-state.at<5*60e3)return state.data;
 if(state.loading)return state.loading;
 const gen=state.gen;
 state.loading=managerApi('manager_supplier_compare').then(d=>{if(gen!==state.gen)return null;state.data=d;state.at=Date.now();return d;}).finally(()=>{state.loading=null;});
 return state.loading;
}

/* ----- what one invoice price buys ----- */
const CARTON=/^(ctn|ctns|carton|cartons|box|case|cs)$/i;
function guess(p){
 const g=R()?.packGuess?R().packGuess(p.description,p.unit):{count:1,size:1,unit:'each'};
 const d=String(p.description||'');
 // "MILK FULL CREAM 2LT · 6Q": 6 bottles of 2 L.
 const q=d.match(/·\s*(\d+)\s*q\s*$/i),sz=d.split('·').slice(0,-1).join(' ').match(/(\d+(?:\.\d+)?)\s*(kg|gm|g|lt|ltr|l|ml)(?![a-z])/i);
 if(q&&sz){const U={kg:'kg',gm:'g',g:'g',lt:'l',ltr:'l',l:'l',ml:'ml'};return{count:Number(q[1]),size:Number(sz[1]),unit:U[sz[2].toLowerCase()],sure:true};}
 const plain=g.count===1&&g.size===1&&g.unit==='each'&&!/^(ea|each|unit)$/i.test(String(p.unit||'').trim());
 // A carton priced as one, with only one size on the line: it may hold several packs.
 const carton=CARTON.test(String(p.unit||'').trim())&&g.count===1&&!(Number(p.pack)>1);
 return{...g,sure:!plain&&!carton};
}
function packOf(p,d){
 const k=keyOf(p);
 const saved=(d.saved||[]).find(x=>keyOf(x)===k&&x.pack);if(saved)return{...saved.pack,count:Number(saved.pack.count),size:Number(saved.pack.size),source:'saved',sure:true};
 const link=(d.links||[]).find(x=>keyOf(x)===k);if(link)return{...link.pack,count:Number(link.pack.count),size:Number(link.pack.size),source:'link',sure:true};
 return{...guess(p),source:'guess'};
}
const base=u=>u==='g'?'kg':u==='ml'?'l':u;
const amount=pk=>pk.count*pk.size/(pk.unit==='g'||pk.unit==='ml'?1000:1);

/* ----- the same product at different suppliers ----- */
const STOP=new Set('the and with of in for gf i ctn carton unit each ea box bag pack pk qty pcs premium fresh large small medium regular printed sliced'.split(' '));
const stem=w=>w.length>4&&w.endsWith('es')&&!w.endsWith('ses')?w.slice(0,-2):w.length>3&&w.endsWith('s')&&!w.endsWith('ss')?w.slice(0,-1):w;
// The product name without the brand: "BRAND · NAME · SIZE" → NAME; "Brand Name 2kg" → "Name 2kg".
const nameOf=d=>{const seg=String(d).split('·').map(x=>x.trim());return seg.length>=2?seg[1]:String(d).replace(/^\S+\s+/,'');};
const toks=d=>new Set(nameOf(d).toLowerCase().replace(/g\/f/g,' ').replace(/[·\[\]()*,'/_\-:]/g,' ').split(/\s+/).filter(w=>w&&!STOP.has(w)&&(!/\d/.test(w)||/^\d+"$/.test(w))).map(stem));
function groups(products,d){
 const saved=new Map((d.saved||[]).map(x=>[keyOf(x),x]));
 const items=products.filter(p=>!p.from_history||p.history?.some(h=>!h.fromHistory)).map(p=>({p,k:keyOf(p),t:toks(p.description),s:saved.get(keyOf(p))}));
 const df=new Map();for(const it of items)for(const w of it.t)df.set(w,(df.get(w)||0)+1);
 const idf=w=>Math.log((items.length+1)/(df.get(w)||1));
 const parent=items.map((_,i)=>i);const find=i=>parent[i]===i?i:(parent[i]=find(parent[i]));const join=(a,b)=>{parent[find(a)]=find(b);};
 // Put together by the manager.
 const byGroup=new Map();items.forEach((it,i)=>{const g=it.s?.group_id;if(g){if(byGroup.has(g))join(i,byGroup.get(g));else byGroup.set(g,i);}});
 // Put together by the name (without the brand): a rare word in common and most of the words.
 for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){
  const a=items[i],b=items[j];
  if(a.p.supplier===b.p.supplier||a.s?.not_grouped||b.s?.not_grouped||a.s?.group_id||b.s?.group_id)continue;
  let sh=0,un=0,sa=0,sb=0,rare=false;for(const w of a.t)sa+=idf(w);for(const w of b.t)sb+=idf(w);
  for(const w of new Set([...a.t,...b.t])){const v=idf(w);un+=v;if(a.t.has(w)&&b.t.has(w)){sh+=v;if(df.get(w)<=4)rare=true;}}
  // Most of the shorter name, and a good part of both names.
  if(rare&&sa&&sb&&sh/Math.min(sa,sb)>=0.6&&sh/un>=0.35)join(i,j);
 }
 const out=new Map();items.forEach((it,i)=>{const r=find(i);if(!out.has(r))out.set(r,[]);out.get(r).push(it.p);});
 return[...out.values()].filter(g=>new Set(g.map(p=>p.supplier)).size>1).map(g=>describe(g,d)).sort((a,b)=>b.saving-a.saving||a.title.localeCompare(b.title));
}
function describe(members,d){
 const bought=new Map((d.bought||[]).map(x=>[keyOf(x),x]));
 const rows=members.map(p=>{
  const pk=packOf(p,d),b=bought.get(keyOf(p));
  const pu=pk.sure&&p.last_price!=null?Number(p.last_price)/amount(pk):null;
  const perMonth=b&&pk.sure?Number(b.qty_90d)/3*amount(pk):null;
  return{p,pk,pu,unit:base(pk.unit),perMonth,bought:b};
 });
 const units=new Set(rows.filter(r=>r.pu!=null).map(r=>r.unit));
 const same=units.size===1;
 const known=rows.filter(r=>r.pu!=null);
 const best=same&&known.length>1?known.reduce((a,b)=>b.pu<a.pu?b:a):null;
 let saving=0;
 for(const r of rows){r.diff=best&&r.pu!=null&&r!==best?r.pu-best.pu:null;r.monthly=r.diff!=null&&r.perMonth?r.diff*r.perMonth:null;if(r.monthly>0)saving+=r.monthly;}
 rows.sort((a,b)=>(a.pu==null)-(b.pu==null)||(a.pu??0)-(b.pu??0));
 const title=members.map(p=>String(p.description)).sort((a,b)=>a.length-b.length)[0];
 return{title,rows,best,saving,needsPack:rows.some(r=>!r.pk.sure),mixed:units.size>1};
}

/* ----- view ----- */
const unitWord=u=>u==='each'?'each':u==='l'?'L':u;
function packForm(r){
 const pk=r.pk,k=keyOf(r.p);
 return `<div class="cmp-pack" data-cmp-packform="${t(k)}">
  <span>One price (${t(money(r.p.last_price))}${r.p.unit?' / '+t(String(r.p.unit).toLowerCase()):''}) buys</span>
  <input data-cmp-f="count" inputmode="decimal" value="${t(pk.count||1)}" aria-label="How many">
  <span>×</span>
  <input data-cmp-f="size" inputmode="decimal" value="${t(pk.size||1)}" aria-label="Size">
  <select data-cmp-f="unit" aria-label="Unit">${['kg','g','l','ml','each'].map(u=>`<option${pk.unit===u?' selected':''}>${u}</option>`).join('')}</select>
  <button type="button" data-cmp-savepack="${t(k)}">Save</button>
 </div>`;
}
function rowHtml(g,r){
 const k=keyOf(r.p),editing=state.editing===k||!r.pk.sure;
 const price=r.pu!=null?`<strong>${t(money(r.pu))}/${t(unitWord(r.unit))}</strong>`:`<strong class="cmp-q">?</strong>`;
 const tag=g.best&&r===g.best?`<em class="pb-chg down">Cheapest</em>`:r.diff!=null&&g.best?`<em class="pb-chg up">+${t((r.diff/g.best.pu*100).toLocaleString('en-AU',{maximumFractionDigits:0}))}%</em>`:'';
 const packTxt=r.pk.sure?`${r.pk.count>1?`${r.pk.count} × `:''}${r.pk.size} ${r.pk.unit} for ${money(r.p.last_price)}`:'';
 const month=r.perMonth?`≈ ${(+r.perMonth.toFixed(r.perMonth<10?1:0)).toLocaleString('en-AU')} ${unitWord(r.unit)} a month`:r.bought?'':'Not bought in the last 90 days';
 const more=r.monthly>0.5?` · <b class="up">${t(money(r.monthly))} more a month</b>`:'';
 return `<div class="cmp-row${g.best&&r===g.best?' best':''}">
  <div class="cmp-top"><span class="pb-main"><strong>${t(r.p.supplier)}</strong><small>${t(r.p.description)}</small><small>${t([packTxt,`last ${day(r.p.last_date)}`].filter(Boolean).join(' · '))}</small><small>${t(month)}${more}</small></span>
  <span class="pb-right">${price}${tag}</span></div>
  ${editing?packForm(r):''}
  <div class="cmp-acts">${r.pk.sure&&!editing?`<button type="button" data-cmp-editpack="${t(k)}">Change what it buys</button>`:''}<button type="button" data-cmp-ungroup="${t(k)}">Not the same</button></div>
 </div>`;
}
function groupHtml(g,i,products){
 const head=g.saving>=1?`Save about <b>${t(money(g.saving))} a month</b> buying all from ${t(g.best.p.supplier)}`
  :g.needsPack?'Say what one price buys to compare'
  :g.mixed?'Sold in different units: say what one price buys'
  :g.best?`${t(g.best.p.supplier)} is the cheapest`:'';
 const adding=state.adding===i;
 const others=adding?addList(g,products):'';
 return `<div class="card cmp-group" data-cmp-g="${i}"><div class="cmp-head"><strong>${t(g.title)}</strong><small>${head}</small></div>
  ${g.rows.map(r=>rowHtml(g,r)).join('')}
  ${adding?`<div class="cmp-add"><input class="inv-search" data-cmp-search="${i}" placeholder="Search a product to add" autocomplete="off" value="${t(state.addQ||'')}">${others}</div>`
   :`<button type="button" class="cmp-addbtn" data-cmp-adding="${i}">+ Add a product to compare</button>`}
 </div>`;
}
function addList(g,products){
 const inG=new Set(g.rows.map(r=>keyOf(r.p)));const q=String(state.addQ||'').trim().toLowerCase();
 if(q.length<2)return `<p class="inv-hint">Type at least 2 letters (e.g. the brand or "bacon").</p>`;
 const hits=products.filter(p=>!inG.has(keyOf(p))&&(!p.from_history||p.history?.some(h=>!h.fromHistory))&&`${p.description} ${p.supplier}`.toLowerCase().includes(q)).slice(0,8);
 if(!hits.length)return `<p class="inv-hint">Nothing matches.</p>`;
 return hits.map(p=>`<button type="button" class="cmp-hit" data-cmp-join="${t(keyOf(p))}" data-cmp-with="${t(keyOf(g.rows[0].p))}"><span>${t(p.description)}</span><small>${t(p.supplier)} · ${t(money(p.last_price))}</small></button>`).join('');
}
let lastProducts=[];
async function render(box,products){
 lastProducts=products;
 if(!state.data){box.className='empty-state';box.textContent='Loading…';
  try{await load(false);}catch(e){box.className='empty-state';box.textContent=e.message||'Unable to load the comparison.';return;}
  if(!state.data)return;}
 const gs=groups(products,state.data);state.groups=gs;
 if(!gs.length){box.className='empty-state';box.textContent='No product is bought from more than one supplier yet. When one is, it shows here with the cheaper price.';return;}
 const total=gs.reduce((a,g)=>a+g.saving,0);
 box.className='cmp-list';
 box.innerHTML=`<p class="cmp-sum">${gs.length} ${gs.length===1?'product':'products'} bought from more than one supplier.${total>=1?` Buying each from the cheapest would save about <b>${t(money(total))} a month</b>.`:''}</p>
  ${state.msg?`<p class="cmp-msg ${state.ok?'ok':'err'}" role="status">${t(state.msg)}</p>`:''}
  ${gs.map((g,i)=>groupHtml(g,i,products)).join('')}
  <p class="inv-hint">Prices are the last invoice price. A month is the average of the last 90 days.</p>`;
}
function rerender(){const box=document.getElementById('pbList');if(box&&box.classList.contains('cmp-list'))render(box,lastProducts);}
const [sup,key]=[k=>k.slice(0,k.indexOf('|')),k=>k.slice(k.indexOf('|')+1)];
async function save(data,okMsg){
 state.msg='';
 try{await managerApi('manager_supplier_compare_save',{data});state.msg=okMsg;state.ok=true;await load(true);}
 catch(e){state.msg=e.message||'Unable to save.';state.ok=false;}
 state.editing=null;state.adding=null;state.addQ='';rerender();
}
document.addEventListener('click',e=>{
 const box=e.target.closest('#pbList.cmp-list');if(!box)return;
 const b=e.target.closest('[data-cmp-adding],[data-cmp-join],[data-cmp-ungroup],[data-cmp-editpack],[data-cmp-savepack]');if(!b)return;
 const d=b.dataset;
 if(d.cmpAdding!=null){state.adding=Number(d.cmpAdding);state.addQ='';state.msg='';rerender();box.querySelector(`[data-cmp-search="${d.cmpAdding}"]`)?.focus();return;}
 if(d.cmpJoin){b.disabled=true;save({supplier:sup(d.cmpJoin),product_key:key(d.cmpJoin),group_with:{supplier:sup(d.cmpWith),product_key:key(d.cmpWith)}},'Added to the comparison.');return;}
 if(d.cmpUngroup){
  if(d.confirm!=='1'){d.confirm='1';b.textContent='Tap again: not the same';return;}
  b.disabled=true;save({supplier:sup(d.cmpUngroup),product_key:key(d.cmpUngroup),ungroup:true},'Taken out of the comparison.');return;}
 if(d.cmpEditpack){state.editing=d.cmpEditpack;state.msg='';rerender();return;}
 if(d.cmpSavepack){
  const f=b.closest('[data-cmp-packform]');const v=n=>f.querySelector(`[data-cmp-f="${n}"]`).value;
  const count=Number(String(v('count')).replace(',','.')),size=Number(String(v('size')).replace(',','.')),unit=v('unit');
  if(!(count>0)||!(size>0)){state.msg='Write how many and how big, e.g. 6 × 2.5 kg.';state.ok=false;rerender();return;}
  b.disabled=true;save({supplier:sup(d.cmpSavepack),product_key:key(d.cmpSavepack),pack:{count,size,unit}},'Saved. The price per unit uses it now.');
 }
});
document.addEventListener('input',e=>{
 const s=e.target.closest('[data-cmp-search]');if(!s)return;
 state.addQ=s.value;const g=state.groups?.[Number(s.dataset.cmpSearch)];if(!g)return;
 const wrap=s.parentElement;wrap.querySelectorAll('.cmp-hit,.inv-hint').forEach(x=>x.remove());
 wrap.insertAdjacentHTML('beforeend',addList(g,lastProducts));
});
window.MarinaraCompare={render,reset(){state.gen++;state.data=null;state.at=0;state.msg='';state.adding=null;state.editing=null;}};
window.addEventListener('marinara:session-reset',()=>window.MarinaraCompare.reset());
})();
