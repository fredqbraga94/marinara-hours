// Dish costs (Invoices → Costs → Dishes): sums from invoice prices, prices by
// hand and sauces made in the kitchen; typing an amount updates the sums; Save
// sends the menu price and amounts; a price by hand is saved. Synthetic data;
// the server is replaced (checked in tests/integration/dish-costs.mjs).
import {createServer} from 'node:http';
import {readFileSync,mkdirSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const pw=require(process.env.PLAYWRIGHT_PATH||'playwright');const {devices}=pw;
const ENGINE=process.env.E2E_BROWSER==='webkit'?'webkit':'chromium';
const server=createServer((req,res)=>{try{const p=resolve('.'+(req.url==='/'?'/index.html':req.url.split('?')[0]));res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png'})[extname(p)]||'text/html');res.end(readFileSync(p));}catch(e){res.statusCode=404;res.end('no');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
mkdirSync('tmp/qa',{recursive:true});
const browser=await pw[ENGINE].launch();
const U=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
try{
for(const [size,options] of [['iphone',devices['iPhone 13']],['desktop',{viewport:{width:1440,height:1000}}]]){
 const context=await browser.newContext({...options,serviceWorkers:'block'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.route('https://**/*',route=>route.abort());
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(()=>{
  const U=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  currentManagerRole='kitchen_manager';currentSessionToken='qa-token';document.querySelector('#loginScreen').classList.add('hidden');showOnlyManagerScreen('managerScreen');setManagerHeader('Hawthorne');setManagerNavActive('home');
  const ing=[{id:U(1),name:'Test Cheese',invoice:{supplier:'Test Dairy',label:'Cheese 2kg',unit:'kg',price:10,date:'2026-11-01'},manual:null},
   {id:U(2),name:'Test Oysters',invoice:null,manual:{price:1.5,unit:'each',note:'Test $18 a dozen'}},
   {id:U(3),name:'Test Basil',invoice:null,manual:null},
   {id:U(4),name:'Test Tomato',invoice:{supplier:'Test Veg',label:'Tomato 5L',unit:'l',price:2,date:'2026-11-01'},manual:null},
   {id:U(5),name:'Test Prawns',invoice:null,manual:{price:18,unit:'kg',note:'Test prawns'}}];
  const L=(k,id,name,quantity=null)=>({kind:k,ref_id:id,name,quantity});
  const rec=[
   {id:U(10),name:'Test Pizza',category:'Pizza',makes:null,manual:null,lines:[L('ingredient',U(1),'Test Cheese'),L('recipe',U(20),'Test Sauce'),L('ingredient',U(3),'Test Basil'),L('ingredient',U(5),'Test Prawns')],
     sizes:[{size:'',sell_price:22,yield_qty:null,yield_unit:null,portions:[{kind:'ingredient',ref_id:U(1),qty:120,unit:'g',product:null},{kind:'recipe',ref_id:U(20),qty:100,unit:'ml',product:null}]}]},
   {id:U(11),name:'Test Oysters Plate',category:'Entrée',makes:null,manual:null,lines:[L('ingredient',U(2),'Test Oysters')],
     sizes:[{size:'',sell_price:33,portions:[{kind:'ingredient',ref_id:U(2),qty:6,unit:'each',product:null}]}]},
   {id:U(12),name:'Test No Price',category:'Pasta',makes:null,manual:null,lines:[L('ingredient',U(3),'Test Basil')],sizes:[]},
   {id:U(20),name:'Test Sauce',category:'Sauce',makes:'One test batch',manual:null,lines:[L('ingredient',U(4),'Test Tomato','5 litres')],
     sizes:[{size:'',sell_price:null,yield_qty:5,yield_unit:'l',portions:[{kind:'ingredient',ref_id:U(4),qty:5,unit:'l',product:null}]}]}];
  const products=[{supplier:'Test Seafood Co',product_key:'tsc-prawn-1315',description:'Test Prawn Cutlet 13/15 700g',unit:'pk',price:21,date:'2026-11-01'},
   {supplier:'Test Seafood Co',product_key:'tsc-prawn-meat',description:'Test Prawn Meat 31/35 700g',unit:'pk',price:12.6,date:'2026-11-01'}];
  window.__calls=[];const orig=managerApi;
  managerApi=async(action,extra={})=>{window.__calls.push([action,JSON.parse(JSON.stringify(extra))]);
   if(action==='manager_ingredient_costs')return{location:'Hawthorne',ingredients:[],products:[]};
   if(action==='manager_dish_costs')return JSON.parse(JSON.stringify({location:'Hawthorne',recipes:rec,ingredients:ing,products}));
   if(action==='manager_dish_cost_save'){const r=rec.find(x=>x.id===extra.recipe_id);const d=extra.dish;const size=d.size||'';
     if(d.remove){r.sizes=r.sizes.filter(s=>s.size!==size);return{recipe_id:r.id};}
     let s=r.sizes.find(x=>x.size===size);if(!s){s={size,sell_price:null,portions:[]};r.sizes.push(s);}
     if('sell_price' in d)s.sell_price=d.sell_price;
     if(d.portions)s.portions=d.portions.filter(p=>p.qty).map(p=>({...p,product:p.product?{...p.product,price:(products.find(x=>x.product_key===p.product.product_key)||{}).price}:null}));
     return{recipe_id:r.id,size};}
   if(action==='manager_cost_price_save'){const i=ing.find(x=>x.id===extra.ref_id);i.manual=extra.price?{...extra.price}:null;return{saved:!!extra.price};}
   if(action==='manager_roster_week')return{team:[],entries:[],services:[],leave:[]};
   return orig(action,extra);};
 });
 await page.evaluate(()=>openInvoicesScreen());
 await page.locator('#invoicesScreen').waitFor({state:'visible'});
 await page.locator('#invTabs [data-inv-tab="costs"]').click();
 await page.locator('#dcList .dc-dish').first().waitFor();
 // Dishes first; the ingredient price list is behind its own button.
 assert.equal(await page.locator('#dcIngredients').isVisible(),false);
 // Sums: cheese 0.12 kg × $10 = $1.20; sauce 5 l tomato × $2 = $10 per 5 l batch → $2/l × 0.1 l = $0.20; basil not counted.
 // Pizza $22 → $20 without GST → $1.40 = 7.0%.
 const pizza=page.locator('.dc-dish',{hasText:'Test Pizza'});
 assert.match(await pizza.innerText(),/7\.0%/);
 // Oysters: 6 × $1.50 = $9 of $30 = 30.0%.
 assert.match(await page.locator('.dc-dish',{hasText:'Test Oysters Plate'}).innerText(),/30\.0%/);
 assert.match(await page.locator('.dc-dish',{hasText:'Test No Price'}).innerText(),/No menu price/);
 assert.match(await page.locator('#dcSummary').innerText(),/18\.5%/,'average of 7.0 and 30.0');
 await page.screenshot({path:`tmp/qa/${size}-dish-costs.png`,fullPage:true});
 // Open the pizza: typing an amount updates the sums at once.
 await pizza.locator('[data-dc-open]').click();
 const ed=page.locator('.dc-dish.open .dc-edit');
 await ed.waitFor();
 assert.match(await ed.innerText(),/\$1\.40/);
 assert.match(await ed.innerText(),/from its recipe/,'the sauce price comes from its own recipe');
 const cheese=ed.locator('[data-dc-q="0"]');
 await cheese.fill('150');
 assert.match(await ed.locator('.dc-totals').innerText(),/\$1\.70/,'0.15 × 10 + 0.20');
 assert.equal(await page.evaluate(()=>document.activeElement?.dataset?.dcQ),'0','the cursor stays in the box');
 await ed.locator('[data-dc-sell]').fill('24.20');
 assert.match(await ed.locator('.dc-totals').innerText(),/7\.7%/,'1.70 / 22.00');
 // Basil has no price: set one by hand.
 await ed.locator('[data-dc-q="2"]').fill('5');
 assert.match(await ed.innerText(),/no price/);
 await ed.locator('[data-dc-price$="'+U(3)+'"]').click();
 await ed.locator('[data-dc-pp]').fill('40');
 await ed.locator('[data-dc-pu]').selectOption('kg');
 await ed.locator('[data-dc-pn]').fill('Test bunch');
 await ed.locator('[data-dc-price-save]').click();
 await page.locator('#invMessage').filter({hasText:'Price saved.'}).waitFor();
 const priceCall=await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_cost_price_save').at(-1)[1]);
 assert.deepEqual(priceCall,{kind:'ingredient',ref_id:U(3),price:{price:40,unit:'kg',note:'Test bunch'}});
 assert.equal(await ed.locator('[data-dc-q="0"]').inputValue(),'150','the typed amounts stay after saving a price');
 // 0.005 kg × $40 = $0.20 → $1.90 / $22 = 8.6%.
 assert.match(await ed.locator('.dc-totals').innerText(),/8\.6%/);
 await page.screenshot({path:`tmp/qa/${size}-dish-cost-edit.png`,fullPage:true});
 await ed.locator('[data-dc-save]').click();
 await page.locator('#invMessage').filter({hasText:'Saved: Test Pizza.'}).waitFor();
 const saved=await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_dish_cost_save').at(-1)[1]);
 assert.equal(saved.recipe_id,U(10));assert.equal(saved.dish.sell_price,24.2);
 assert.equal(saved.dish.size,'');
 assert.deepEqual(saved.dish.portions,[{kind:'ingredient',ref_id:U(1),qty:150,unit:'g',product:null},{kind:'recipe',ref_id:U(20),qty:100,unit:'ml',product:null},{kind:'ingredient',ref_id:U(3),qty:5,unit:'g',product:null},{kind:'ingredient',ref_id:U(5),qty:null,unit:'g',product:null}]);
 await page.locator('.dc-dish',{hasText:'Test Pizza'}).filter({hasText:'8.6%'}).waitFor();
 // Prawns: a product of their own, counted in pieces (13/15 → about 22 in 700 g).
 const pz=page.locator('.dc-dish',{hasText:'Test Pizza'});
 if(await pz.getAttribute('class').then(c=>!/\bopen\b/.test(c)))await pz.locator('[data-dc-open]').click();
 const ed3=page.locator('.dc-dish.open .dc-edit');
 await ed3.locator('[data-dc-pick="3"]').click();
 await ed3.locator('[data-dc-pick-q]').fill('prawn 13/15');
 await ed3.locator('[data-dc-pick-choose="0"]').click();
 assert.match(await ed3.locator('.dc-pick').innerText(),/13 to 15 pieces per pound .*about 22 in this pack/);
 await ed3.locator('[data-dc-pack-pieces]').click();
 assert.equal(await ed3.locator('[data-dc-pack="size"]').inputValue(),'22');
 await ed3.locator('[data-dc-pick-use]').click();
 assert.equal(await ed3.locator('[data-dc-u="3"]').inputValue(),'each','counted in pieces');
 await ed3.locator('[data-dc-q="3"]').fill('7');
 // 7 × $21/22 = $6.68 more: $1.90 + $6.68 = $8.58.
 assert.match(await ed3.locator('.dc-totals').innerText(),/\$8\.58/);
 // A Main size: starts with the same amounts; its own price.
 await ed3.locator('[data-dc-addsize]').click();
 await ed3.locator('[id^="dcNewSize-"]').fill('Main');
 await ed3.locator('[data-dc-addsize-ok]').click();
 const ed4=page.locator('.dc-dish.open .dc-edit');
 assert.equal(await ed4.locator('[role=tab][aria-selected=true]').innerText(),'Main');
 assert.equal(await ed4.locator('[data-dc-q="3"]').inputValue(),'7');
 await ed4.locator('[data-dc-q="3"]').fill('11');
 await ed4.locator('[data-dc-sell]').fill('33');
 await ed4.locator('[data-dc-save]').click();
 await page.locator('#invMessage').filter({hasText:'Saved: Test Pizza (Main).'}).waitFor();
 const main=await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_dish_cost_save').at(-1)[1].dish);
 assert.equal(main.size,'Main');assert.equal(main.sell_price,33);
 assert.deepEqual(main.portions[3],{kind:'ingredient',ref_id:U(5),qty:11,unit:'each',product:{supplier:'Test Seafood Co',product_key:'tsc-prawn-1315',label:'Test Prawn Cutlet 13/15 700g',pack_count:1,pack_size:22,pack_unit:'each'}});
 // The list shows both sizes.
 assert.match(await page.locator('.dc-dish',{hasText:'Test Pizza'}).locator('.inv-cost-head').innerText(),/Regular \$24\.20 \(8\.6%\) · Main \$33\.00/);
 await page.screenshot({path:`tmp/qa/${size}-dish-cost-sizes.png`,fullPage:true});
 // Remove the Main size (two taps).
 await page.locator('.dc-dish.open [data-dc-size-remove]').click();
 await page.locator('.dc-dish.open [data-dc-size-remove]').filter({hasText:'Tap again'}).click();
 await page.locator('#invMessage').filter({hasText:'Size removed.'}).waitFor();
 await page.locator('.dc-dish.open [data-dc-close]').click();
 // Bad numbers are not sent.
 await page.locator('.dc-dish',{hasText:'Test Oysters Plate'}).locator('[data-dc-open]').click();
 const ed2=page.locator('.dc-dish.open .dc-edit');
 await ed2.locator('[data-dc-q="0"]').fill('six');
 const n=await page.evaluate(()=>window.__calls.length);
 await ed2.locator('[data-dc-save]').click();
 await page.locator('#invMessage').filter({hasText:'Check the numbers'}).waitFor();
 assert.equal(await page.evaluate(()=>window.__calls.length),n);
 // Sauces & prep: price per litre from the batch.
 await page.locator('#dcFilter [data-dc-filter="prep"]').click();
 assert.match(await page.locator('.dc-dish',{hasText:'Test Sauce'}).innerText(),/\$2\.00\/l/);
 await page.locator('#dcFilter [data-dc-filter="todo"]').click();
 assert.match(await page.locator('#dcList').innerText(),/Test No Price/);
 // The ingredient price list is still there.
 await page.locator('#dcSwitch [data-dc-mode="ingredients"]').click();
 await page.locator('#dcIngredients').waitFor({state:'visible'});
 assert.equal(await page.locator('#dcDishes').isVisible(),false);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no sideways scroll');
 assert.deepEqual(errors,[]);
 await context.close();
}
console.log(`PASS (${ENGINE}): dish costs: sums from invoice prices, prices by hand and sauce batches; live sums while typing; price by hand saved; Save sends price and amounts; bad numbers refused; filters; ingredient prices kept; no overflow; no JavaScript errors.`);
}finally{await browser.close();server.close();}
