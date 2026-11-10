// Compare suppliers (Invoices → Prices → Compare suppliers): grouping by name,
// price per unit, what a carton buys, money more a month, not the same, add by
// hand. Synthetic data; the server is replaced (checked in
// tests/integration/supplier-compare.mjs).
import {createServer} from 'node:http';
import {readFileSync,mkdirSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const pw=require(process.env.PLAYWRIGHT_PATH||'playwright');const {devices}=pw;
const ENGINE=process.env.E2E_BROWSER==='webkit'?'webkit':'chromium';
const server=createServer((req,res)=>{try{const p=resolve('.'+(req.url==='/'?'/index.html':req.url.split('?')[0]));res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png'})[extname(p)]||'text/html');res.end(readFileSync(p));}catch(e){res.statusCode=404;res.end('no');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await pw[ENGINE].launch();
try{
for(const [size,options] of [['iphone',devices['iPhone 13']],['desktop',{viewport:{width:1440,height:1000}}]]){
 const context=await browser.newContext({...options,serviceWorkers:'block'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.route('https://**/*',route=>route.abort());
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(()=>{
  currentManagerRole='kitchen_manager';currentSessionToken='qa-token';document.querySelector('#loginScreen').classList.add('hidden');showOnlyManagerScreen('managerScreen');setManagerHeader('Hawthorne');setManagerNavActive('home');
  const P=(supplier,product_key,description,unit,last_price,pack=null)=>({supplier,product_key,code:product_key,description,unit,pack,times:3,last_price,last_date:'2026-11-01',previous_price:null,change_pct:null,history:[{date:'2026-11-01',price:last_price}]});
  const book=[P('Test Wholesale','A1','TESTBRAND · BACON DICED 10MM 2.5KG · 2.5KG','CTN',150),P('Test Deli','B1','Testbrand Bacon Diced 2.5kg [CVC]','Ctn [6]',23.5,6),
   P('Test Wholesale','A2','QAFARM · MILK FULL CREAM 2LT · 6Q','CTN',24),P('Test Deli','B2','Qafarm Milk Full Cream [6x2lt] CTN','Box',23.4),
   P('Test Wholesale','A3','QACHEESE · MASCARPONE 1KG · 1KG','EA',19),P('Test Deli','b3','Otherbrand Mascarpone Tub 1kg','Unit',17.5),
   P('Test Wholesale','A4','QAMILL · FLOUR BAKERS · 12.5KG','CTN',16.5)];
  const cmpData={location:'Hawthorne',saved:[],links:[{supplier:'Test Deli',product_key:'B1',pack:{count:1,size:2.5,unit:'kg'}}],
   bought:[{supplier:'Test Wholesale',product_key:'A1',qty_90d:3,invoices_90d:3},{supplier:'Test Deli',product_key:'B1',qty_90d:9,invoices_90d:3},{supplier:'Test Wholesale',product_key:'A2',qty_90d:12,invoices_90d:6}]};
  window.__calls=[];const orig=managerApi;
  managerApi=async(action,extra={})=>{window.__calls.push([action,JSON.parse(JSON.stringify(extra))]);
   if(action==='manager_invoice_price_book')return{products:JSON.parse(JSON.stringify(book))};
   if(action==='manager_invoice_top_products')return{products:[]};
   if(action==='manager_supplier_compare')return JSON.parse(JSON.stringify(cmpData));
   if(action==='manager_supplier_compare_save'){const d=extra.data;let row=cmpData.saved.find(x=>x.supplier===d.supplier&&x.product_key===d.product_key);
    if(!row){row={supplier:d.supplier,product_key:d.product_key,pack:null,group_id:null,not_grouped:false};cmpData.saved.push(row);}
    if('pack' in d)row.pack=d.pack;
    if(d.group_with){let o=cmpData.saved.find(x=>x.supplier===d.group_with.supplier&&x.product_key===d.group_with.product_key);if(!o){o={...d.group_with,pack:null,group_id:null,not_grouped:false};cmpData.saved.push(o);}const g=o.group_id||row.group_id||'g1';o.group_id=g;row.group_id=g;row.not_grouped=false;o.not_grouped=false;}
    else if(d.ungroup){row.group_id=null;row.not_grouped=true;}
    return{product:row};}
   if(action==='manager_invoice_list')return{invoices:[],by_supplier:[],totals:[]};
   if(action==='manager_roster_week')return{team:[],entries:[],services:[],leave:[]};
   return orig(action,extra);};
 });
 await page.evaluate(()=>openInvoicesScreen());
 await page.locator('#invTabs [data-inv-tab="prices"]').click();
 await page.locator('#pbList .pb-row').first().waitFor();
 await page.locator('#pbChips [data-pb-filter="compare"]').click();
 await page.locator('#pbList.cmp-list .cmp-group').first().waitFor();
 assert.equal(await page.locator('#pbSearch').isVisible(),false,'no search box in Compare');
 const titles=await page.locator('.cmp-head strong').allInnerTexts();
 assert.equal(titles.length,3,`bacon, milk, mascarpone: ${titles}`);
 // Bacon: the carton (unclear) asks what it buys; the linked one is known.
 const bacon=page.locator('.cmp-group').filter({hasText:'Bacon'});
 assert.match(await bacon.locator('.cmp-head small').innerText(),/Say what one price buys/);
 assert.equal(await bacon.locator('.cmp-pack').count(),1,'only the carton asks');
 assert.match(await bacon.locator('.cmp-row').filter({hasText:'[CVC]'}).innerText(),/\$9\.40\/kg/);
 assert.equal(await bacon.locator('.cmp-pack [data-cmp-f="count"]').inputValue(),'','no number written in for a carton');
 assert.match(await bacon.locator('.cmp-pack').innerText(),/How many packs of 2\.5 kg come in one ctn for \$150\.00\?[\s\S]*about 6 packs/);
 assert.match(await bacon.locator('.cmp-row').filter({hasText:'[CVC]'}).innerText(),/2\.5 kg for \$23\.50 \(6 in a carton = \$141\.00\)/);
 // Saved as one pack: far too dear next to the other, so it is flagged and not counted.
 await bacon.locator('.cmp-pack [data-cmp-f="count"]').fill('1');
 await bacon.locator('[data-cmp-savepack]').click();
 await page.locator('.cmp-list .cmp-msg.ok').filter({hasText:'Saved.'}).waitFor();
 const flagged=page.locator('.cmp-group').filter({hasText:'Bacon'});
 assert.match(await flagged.locator('.cmp-head small').innerText(),/Check how many packs come in a carton/);
 assert.match(await flagged.locator('.cmp-warn').innerText(),/\$60\.00\/kg looks too dear/);
 assert.doesNotMatch(await page.locator('.cmp-sum').innerText(),/\$1,/,'not counted in the saving');
 await flagged.locator('.cmp-pack [data-cmp-f="count"]').fill('6');
 await flagged.locator('[data-cmp-savepack]').click();
 await page.waitForFunction(()=>!document.querySelector('.cmp-warn'));
 assert.deepEqual(await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_supplier_compare_save').at(-1)[1].data),{supplier:'Test Wholesale',product_key:'A1',pack:{count:6,size:2.5,unit:'kg'}});
 // 150 / 15 kg = $10/kg vs $9.40/kg; 3 cartons in 90 days = 15 kg a month → $9.00 more a month.
 const bacon2=page.locator('.cmp-group').filter({hasText:'Bacon'});
 assert.match(await bacon2.locator('.cmp-head small').innerText(),/Save about \$9\.00 a month buying all from Test Deli/);
 const dear=bacon2.locator('.cmp-row').filter({hasText:'Test Wholesale'});
 assert.match(await dear.innerText(),/\$10\.00\/kg[\s\S]*\+6%/);
 assert.match(await dear.innerText(),/15 kg a month · \$9\.00 more a month/);
 assert.match(await bacon2.locator('.cmp-row.best').innerText(),/Test Deli[\s\S]*Cheapest/);
 // Milk: "2LT · 6Q" and "[6x2lt]" both known: 6 × 2 L.
 const milk=page.locator('.cmp-group').filter({hasText:'Milk'});
 assert.match(await milk.locator('.cmp-row').first().innerText(),/Test Deli[\s\S]*\$1\.95\/L/);
 assert.match(await milk.locator('.cmp-row').nth(1).innerText(),/\$2\.00\/L/);
 await page.screenshot({path:`tmp/qa/${size}-compare.png`,fullPage:true});
 // Not the same (two taps).
 const masc=page.locator('.cmp-group').filter({hasText:'Mascarpone'});
 const ng=masc.locator('[data-cmp-ungroup]').first();await ng.click();assert.match(await ng.innerText(),/Tap again/);await ng.click();
 await page.locator('.cmp-list .cmp-msg.ok').filter({hasText:'Taken out of the comparison.'}).waitFor();
 await page.waitForFunction(()=>document.querySelectorAll('.cmp-group').length===2);
 // Add a product by hand: the flour goes with the milk group just to test the search.
 await page.locator('.cmp-group').filter({hasText:'Milk'}).locator('[data-cmp-adding]').click();
 await page.locator('[data-cmp-search]').fill('fl');
 await page.locator('.cmp-hit',{hasText:'QAMILL · FLOUR BAKERS'}).click();
 await page.locator('.cmp-list .cmp-msg.ok').filter({hasText:'Added to the comparison.'}).waitFor();
 const j=await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_supplier_compare_save').at(-1)[1].data);
 assert.equal(j.product_key,'A4');assert.ok(j.group_with&&j.group_with.supplier,'joined with a product of the group');
 assert.equal(await page.locator('.cmp-group').filter({hasText:'FLOUR BAKERS'}).count(),1);
 // Back to the price book.
 await page.locator('#pbChips [data-pb-filter="all"]').click();
 await page.locator('#pbList .pb-row').first().waitFor();
 assert.equal(await page.locator('#pbSearch').isVisible(),true);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no sideways scroll');
 assert.deepEqual(errors,[]);
 await context.close();
}
console.log(`PASS (${ENGINE}): compare suppliers: same product put together by name, price per kg/L, a carton asks how many packs (no number written in, estimate shown, a too-dear price flagged and not counted), saved, cheapest and money more a month, 6Q and [6x2lt] read, not the same (two taps), add a product by hand, back to the price book, no overflow, no JavaScript errors.`);
}finally{await browser.close();server.close();}
