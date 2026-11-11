/* Import a supplier's price list (Finance → Products → Import price list), e.g.
   the CSV Gulli sends with the current price of each product we buy. The file is
   read on the phone: drinks go to the Floor list, the rest to Kitchen, and milk
   to both (the bar uses it too). A price
   list gives prices, not purchases: Products shows them ("price list"), dish
   costs use them, spending does not count them. The server checks who may save
   on which list (the Administrator both; each manager their own). */
(() => {
const $=id=>document.getElementById(id);
const t=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const role=()=>typeof currentManagerRole==='undefined'?'':currentManagerRole;
const ownDep=()=>role()==='floor_manager'?'Floor':role()==='kitchen_manager'?'Kitchen':null;
const today=()=>new Date(Date.now()+10*3600e3).toISOString().slice(0,10);
const money=n=>`$${Number(n).toFixed(2)}`;

// CSV with quoted fields that can hold commas and line breaks.
function parseCsv(text){
 const rows=[];let row=[],f='',q=false;
 for(let i=0;i<text.length;i++){const c=text[i];
  if(q){if(c==='"'){if(text[i+1]==='"'){f+='"';i++;}else q=false;}else f+=c;}
  else if(c==='"')q=true;
  else if(c===','){row.push(f);f='';}
  else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(f);f='';if(row.some(x=>x.trim()))rows.push(row);row=[];}
  else f+=c;}
 row.push(f);if(row.some(x=>x.trim()))rows.push(row);
 return rows;
}
const num=v=>{const n=Number(String(v??'').replace(/[$,\s]/g,''));return Number.isFinite(n)?n:null;};
// Milk (not milk chocolate): used by the kitchen and the bar, so on both lists.
const BOTH=/\bmilk\b(?!\s*choc)/i;
const DRINK=/liquor licen|\b(beer|lager|ale|cider|wine|prosecco|champagne|brut|spumante|chianti|shiraz|pinot|merlot|ros[eé]|riesling|moscato|chardonnay|sauvignon|cabernet|grenache|cannonau|montepulciano|valpolicella|vermentino|primitivo|pecorino|sangiovese|nero d'avola|nerello|etna|brunello|amarone|aglianico|semillon|grappa|nocello|limoncello|vodka|gin|rum|whisky|whiskey|tequila|liqueur|amaro|aperol|campari|vermouth|marsala)\b/i;

// The products of the file: one per code, the carton size when the file has it.
function readList(text,fileName){
 const rows=parseCsv(text.replace(/^﻿/,''));
 if(rows.length<2)return {error:'This file has no products.'};
 const head=rows[0].map(h=>h.trim().toLowerCase());
 const col=(...res)=>{for(const re of res){const i=head.findIndex(h=>re.test(h));if(i>=0)return i;}return -1;};
 const C={code:col(/^item\s*#|^code$|^item\s*code|^sku$/),name:col(/^item\s*name$|^product|^name$/,/^description$/),desc:col(/^description$/),
  pack:col(/^pack/),price:col(/^price$|^carton\s*price|^pack\s*price/),unit:col(/per\s*unit/)};
 if(C.name<0||(C.price<0&&C.unit<0))return {error:'Could not find the product name and price columns in this file.'};
 const all=rows.slice(1).map(r=>{
  const name=(r[C.name]||'').replace(/\s+/g,' ').trim(),desc=C.desc>=0&&C.desc!==C.name?(r[C.desc]||''):'';
  const pack=Math.max(1,Math.round(num(r[C.pack])||1)),price=C.price>=0?num(r[C.price]):null;
  const each=C.unit>=0&&num(r[C.unit])>0?num(r[C.unit]):(price>0?price/pack:null);
  const drink=DRINK.test(name)||DRINK.test(desc);
  return {code:(C.code>=0?r[C.code]:'').trim(),description:name,pack,unit_price:each?Math.round(each*10000)/10000:null,drink,both:!drink&&BOTH.test(name)};
 }).filter(x=>x.description&&x.unit_price>0);
 const by=new Map();
 for(const x of all){const k=(x.code||x.description).toLowerCase();const have=by.get(k);if(!have||x.pack>have.pack)by.set(k,x);}
 // Wine sold by the bottle in cartons ("750ml [12]"), as on the supplier's invoices.
 const items=[...by.values()].map(x=>{const box=x.drink&&x.description.match(/\[(\d+)\]/);
  return {...x,unit:x.pack>1?`Ctn [${x.pack}]`:box?`Ctn [${box[1]}]`:'Unit'};});
 const gfw=/GFW SKU/i.test(text);
 return {items,supplier:gfw?'Global Food and Wine (Gulli)':'',file_name:String(fileName||'').slice(0,200)};
}

const kitchenOf=items=>items.filter(x=>!x.drink),floorOf=items=>items.filter(x=>x.drink||x.both);
let state=null; // {items, supplier, file_name, date}
function box(){return $('pbImportBox');}
function render(){
 const b=box();if(!b)return;
 if(!state){b.classList.add('hidden');b.innerHTML='';return;}
 if(state.error){b.classList.remove('hidden');b.innerHTML=`<p class="inv-flag warn">${t(state.error)}</p><button type="button" class="shop-small" data-pl-cancel>Close</button>`;return;}
 const k=kitchenOf(state.items),f=floorOf(state.items),both=state.items.filter(x=>x.both).length,own=ownDep();
 const mine=own==='Kitchen'?k:own==='Floor'?f:state.items;
 const left=own==='Kitchen'?f.length-both:own==='Floor'?k.length-both:0;
 const sample=state.items.slice(0,4).map(x=>`<li><span>${t(x.description)}</span><b>${t(money(x.unit_price))}${x.pack>1?` · ${x.pack} a ctn`:''}</b></li>`).join('');
 b.classList.remove('hidden');
 b.innerHTML=`<h3>Price list</h3>
  <p class="inv-hint">${state.items.length} products: <b>${k.length} Kitchen</b> (food, cleaning) and <b>${f.length} Floor</b> (drinks${both?`, and ${both} milk on both`:''}). Prices only: this does not count as spending.</p>
  ${left?`<p class="inv-hint">${left} ${own==='Kitchen'?'drinks go to the Floor list':'Kitchen products go to the Kitchen list'}: only ${own==='Kitchen'?'the Floor Manager':'the Kitchen Manager'} or the Administrator can import them.</p>`:''}
  <label class="pl-field">Supplier<input id="plSupplier" class="inv-search" value="${t(state.supplier)}" maxlength="80" autocomplete="off"></label>
  <label class="pl-field">Price list date<input id="plDate" class="inv-search" type="date" value="${t(state.date)}"></label>
  <ul class="pl-sample">${sample}</ul>
  <div class="pl-actions"><button type="button" class="btn primary" data-pl-save>Save ${own?mine.length:state.items.length} prices</button><button type="button" class="shop-small" data-pl-cancel>Cancel</button></div>`;
}
async function save(btn){
 const supplier=$('plSupplier').value.trim(),date=$('plDate').value;
 if(!supplier){invMsg('Write the supplier name.',false);$('plSupplier').focus();return;}
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){invMsg('Choose the date of the price list.',false);return;}
 const own=ownDep(),parts=[['Kitchen',kitchenOf(state.items)],['Floor',floorOf(state.items)]].filter(([d,list])=>list.length&&(!own||own===d));
 btn.disabled=true;btn.textContent='Saving…';
 const done=[];
 try{
  for(const [dep,list] of parts){
   const items=list.map(({code,description,unit,unit_price,pack})=>({code,description,unit,unit_price,pack}));
   for(let i=0;i<items.length;i+=1000){
    await managerApi('manager_invoice_price_list_save',{...(own?{}:{department:dep}),list:{supplier,date,file_name:state.file_name,items:items.slice(i,i+1000)}});
   }
   done.push(`${list.length} ${dep}`);
  }
  state=null;render();
  window.mhPricesReset?.(true);window.mhPricesReload?.();
  invMsg(`Price list saved: ${done.join(' and ')} prices.`,true);
 }catch(e){btn.disabled=false;btn.textContent='Try again';invMsg((done.length?`Saved ${done.join(' and ')}. `:'')+(e.message||'Unable to save the price list.'),false);}
}
// Called by the Products tab with the chosen file.
window.mhPriceListImport=async file=>{
 if(!file)return;
 if(!/\.csv$/i.test(file.name)&&!/csv|text/i.test(file.type)){state={error:'Choose the price list as a CSV file (the one the supplier sent, or saved from Excel as CSV).'};render();return;}
 const text=await file.text();const r=readList(text,file.name);
 state=r.error?{error:r.error}:{...r,date:today()};render();
 box()?.scrollIntoView({block:'nearest'});
};
document.addEventListener('click',e=>{
 if(!box()?.contains(e.target))return;
 if(e.target.closest('[data-pl-cancel]')){state=null;render();return;}
 const s=e.target.closest('[data-pl-save]');if(s)save(s);
});
window.MarinaraPriceList={readList,parseCsv};
})();
