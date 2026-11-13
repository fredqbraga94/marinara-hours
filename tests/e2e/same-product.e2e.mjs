// Finance → Products: "Same product as" joins two names of one product (the
// price list and the invoices name it differently), and "Separate" undoes it.
// Synthetic data; the server is replaced (what the server does is checked in
// tests/integration/product-links.mjs).
import {createServer} from 'node:http';
import {readFileSync,mkdirSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const pw=require(process.env.PLAYWRIGHT_PATH||'playwright');const {devices}=pw;
const ENGINE=process.env.E2E_BROWSER==='webkit'?'webkit':'chromium';
const server=createServer((req,res)=>{try{const p=resolve('.'+(req.url==='/'?'/index.html':req.url.split('?')[0]));res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.png':'image/png'})[extname(p)]||'text/html');res.end(readFileSync(p));}catch(e){res.statusCode=404;res.end('no');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
mkdirSync('tmp/qa',{recursive:true});
const browser=await pw[ENGINE].launch();
try{
for(const [size,options] of [['iphone',devices['iPhone 13']],['desktop',{viewport:{width:1440,height:1000}}]]){
 const context=await browser.newContext({...options,serviceWorkers:'block'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.route('https://**/*',route=>route.abort());
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(()=>{
  currentManagerRole='kitchen_manager';currentSessionToken='qa-token';document.querySelector('#loginScreen').classList.add('hidden');showOnlyManagerScreen('managerScreen');setManagerHeader('Hawthorne');setManagerNavActive('home');
  const S='QA Wholesale';const orig=managerApi;window.__links={};window.__calls=[];
  const base=[
   {supplier:S,product_key:'NEW1',code:'NEW1',description:'QA P3 Big Blend Shredded Cheese 2kg',unit:'Ctn [4]',times:2,last_date:'2026-11-10',history:[{date:'2026-11-03',price:19.65},{date:'2026-11-10',price:19.65}]},
   {supplier:S,product_key:'OLD1',code:'OLD1',description:'QA Big Blend P3 Cheese Shredded Blend (QA Brand) 2kg',unit:'Ctn [4]',times:3,last_date:'2026-10-20',history:[{date:'2026-10-06',price:22.33},{date:'2026-10-20',price:22.33}]},
   {supplier:S,product_key:'OTH1',code:'OTH1',description:'QA Butter Unsalted 1Kg',unit:'EA',times:1,last_date:'2026-11-10',history:[{date:'2026-11-10',price:9}]},
  ];
  // Like the server: a joined product's prices go under the one it was joined to.
  const book=()=>{const out=[];
   for(const p of base){if(window.__links[p.product_key])continue;
    const merged=base.filter(x=>window.__links[x.product_key]===p.product_key);
    const h=[...p.history,...merged.flatMap(x=>x.history)].sort((a,b)=>a.date.localeCompare(b.date));
    const last=h.at(-1),prev=[...h].reverse().find(x=>x.price!==last.price);
    out.push({...p,last_date:last.date,last_price:last.price,previous_price:prev?.price??null,change_pct:prev?Math.round((last.price-prev.price)/prev.price*1000)/10:null,pack:4,pack_saved:false,history:h,times:p.times+merged.reduce((a,x)=>a+x.times,0),
     merged:merged.length?merged.map(x=>({product_key:x.product_key,code:x.code,description:x.description})):null});}
   return out;};
  managerApi=async(action,extra)=>{
   if(action==='manager_invoice_link_save'){window.__calls.push(extra);if(extra.same_as)window.__links[extra.product_key]=extra.same_as;else delete window.__links[extra.product_key];return{...extra};}
   if(action==='manager_invoice_price_book')return{products:book()};
   if(action==='manager_invoice_top_products')return{products:[]};
   if(action==='manager_invoice_usage')return{items:[{supplier:S,code:'NEW1',description:'x',unit:'Ctn [4]',avg_per_week:4,spend_per_week:80,max_week:6},{supplier:S,code:'OLD1',description:'y',unit:'Ctn [4]',avg_per_week:8,spend_per_week:180,max_week:9}]};
   if(action==='manager_invoice_list')return{invoices:[]};
   if(action==='manager_supplier_list')return{suppliers:[]};
   return orig(action,extra);};
 });
 await page.evaluate(()=>document.getElementById('invoicesCard')?.click());
 await page.locator('#invoicesScreen').waitFor({state:'visible'});
 await page.locator('#invTabs [data-inv-tab="prices"]').click();
 await page.locator('#pbList .pb-row').first().waitFor();
 assert.equal(await page.locator('#pbList .pb-row').count(),3);
 // Tap the new name; the closest name is offered first.
 await page.locator('#pbList .pb-row').filter({hasText:'QA P3 Big Blend'}).click();
 const sel=page.locator('#pbList [data-pb-link] select');
 const opts=await sel.locator('option').allInnerTexts();
 assert.deepEqual(opts,['Choose…','QA Big Blend P3 Cheese Shredded Blend (QA Brand) 2kg (OLD1)','QA Butter Unsalted 1Kg (OTH1)']);
 await page.locator('#pbList [data-pb-link-save]').click();
 await page.locator('#invMessage:not(.ok)').filter({hasText:'Choose the other product.'}).waitFor();
 assert.equal(await page.evaluate(()=>window.__calls.length),0);
 await sel.selectOption('OLD1');
 await page.locator('#pbList [data-pb-link-save]').click();
 await page.locator('#invMessage.ok').filter({hasText:'Joined: QA Big Blend P3 Cheese Shredded Blend (QA Brand) 2kg now shows here.'}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.__calls),[{supplier:'QA Wholesale',product_key:'OLD1',same_as:'NEW1'}]);
 assert.equal(await page.locator('#pbList .pb-row').count(),2,'one product now');
 const row=await page.locator('#pbList .pb-row').filter({hasText:'QA P3 Big Blend'}).innerText();
 assert.match(row,/3 ctn a week/,'the weeks of both names together (4 + 8 units, 4 a ctn)');
 assert.match(row,/12%/,'the change across both names');
 // It stays open after joining.
 const hist=page.locator('#pbList .pb-hist');
 assert.match(await hist.innerText(),/Also as: QA Big Blend P3 Cheese Shredded Blend \(QA Brand\) 2kg/);
 assert.equal(await page.locator('#pbList .pb-hist li').filter({hasText:/Oct/}).count(),2,'the old prices are in the history');
 const over=await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth);
 assert.equal(over,false,'no sideways scroll');
 await page.screenshot({path:`tmp/qa/${size}-same-product.png`,fullPage:true});
 await page.locator('#pbList [data-pb-unlink="OLD1"]').click();
 await page.locator('#invMessage.ok').filter({hasText:'Separated: they show as two products again.'}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.__calls.at(-1)),{supplier:'QA Wholesale',product_key:'OLD1',same_as:null});
 assert.equal(await page.locator('#pbList .pb-row').count(),3);
 assert.deepEqual(errors,[]);
 await context.close();
}
console.log(`PASS (${ENGINE}): Same product as: closest name first, join shows one product with both histories and weeks, Separate undoes it, no overflow, no JavaScript errors.`);
}finally{await browser.close();server.close();}
