// Ingredient prices: rename an ingredient (a taken name is refused) and type
// a price for a supplier that sends no PDF (it replaces an invoice link, and
// linking replaces it). Synthetic data; the server is replaced (checked in
// tests/integration/ingredient-edit.mjs).
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
  const ing=[{id:U(1),name:'Test BBQ chicken',used_in:1,link:null,made_here:null,manual:null},
   {id:U(2),name:'Test Chicken',used_in:4,link:null,made_here:null,manual:{price:12.5,unit:'kg',note:'Test estimate'}},
   {id:U(3),name:'Test Bacon',used_in:3,made_here:null,manual:null,link:{supplier:'Test Deli',product_key:'b1',label:'Test Bacon 2.5kg',pack_count:1,pack_size:2.5,pack_unit:'kg',base_unit:'kg',latest_price:23.5,price_date:'2026-11-01',cost_per_unit:9.4}}];
  const products=[{supplier:'Test Deli',product_key:'b1',code:'B1',description:'Test Bacon 2.5kg',unit:'EA',price:23.5,date:'2026-11-01'},
   {supplier:'Test Deli',product_key:'c1',code:'C1',description:'Test Chicken Thigh 5kg',unit:'EA',price:60,date:'2026-11-01'}];
  window.__calls=[];const orig=managerApi;
  managerApi=async(action,extra={})=>{window.__calls.push([action,JSON.parse(JSON.stringify(extra))]);
   if(action==='manager_ingredient_costs')return JSON.parse(JSON.stringify({location:'Hawthorne',ingredients:ing.slice().sort((a,b)=>a.name.localeCompare(b.name)),products}));
   if(action==='manager_dish_costs')return{location:'Hawthorne',recipes:[],ingredients:[],products:[]};
   if(action==='manager_ingredient_rename'){const i=ing.find(x=>x.id===extra.ingredient_id);i.name=extra.name;return{ingredient:{id:i.id,name:i.name}};}
   if(action==='manager_cost_price_save'){const i=ing.find(x=>x.id===extra.ref_id);i.manual=extra.price?{...extra.price}:null;return{saved:!!extra.price};}
   if(action==='manager_ingredient_cost_save'){const i=ing.find(x=>x.id===extra.ingredient_id);const l=extra.link;
    i.link=l?{supplier:l.supplier,product_key:l.product_key,label:l.label,pack_count:l.pack_count,pack_size:l.pack_size,pack_unit:l.pack_unit,base_unit:l.pack_unit==='g'?'kg':l.pack_unit,cost_per_unit:60/(l.pack_count*l.pack_size)}:null;return{saved:true};}
   if(action==='manager_roster_week')return{team:[],entries:[],services:[],leave:[]};
   return orig(action,extra);};
 });
 await page.evaluate(()=>openInvoicesScreen());
 await page.locator('#invoicesScreen').waitFor({state:'visible'});
 await page.locator('#invTabs [data-inv-tab="costs"]').click();
 await page.locator('#dcSwitch [data-dc-mode="ingredients"]').click();
 await page.locator('#invCosts .inv-cost').first().waitFor();
 const sum=(await page.innerText('#invCostsSummary')).replace(/\s+/g,' ');
 assert.match(sum,/2 With a price/);assert.match(sum,/1 No price/);
 assert.deepEqual(await page.locator('#invCostsFilter button').allInnerTexts(),['No price','With a price','Made here','All']);
 // "No price" list: only BBQ chicken.
 assert.deepEqual(await page.locator('#invCosts .inv-cost-head strong').allInnerTexts(),['Test BBQ chicken']);
 assert.match(await page.locator('#invCosts .inv-cost-head').first().innerText(),/Add price/);
 // Rename: refused when the name is taken, then a new name.
 await page.locator('.inv-cost-head',{hasText:'Test BBQ chicken'}).click();
 await page.locator('[data-inv-cost-name]').fill('test chicken');await page.locator('[data-inv-cost-rename]').click();
 await page.locator('#invMessage.error').filter({hasText:'There is already an ingredient called Test Chicken'}).waitFor();
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_ingredient_rename').length),0,'not sent');
 await page.locator('[data-inv-cost-name]').fill('Test Chicken breast');await page.locator('[data-inv-cost-rename]').click();
 await page.locator('#invMessage.ok').filter({hasText:'Test BBQ chicken is now Test Chicken breast, in every recipe and dish cost.'}).waitFor();
 await page.locator('#invCosts .inv-cost-head strong',{hasText:'Test Chicken breast'}).waitFor();
 // Typed price (supplier with no PDF); the editor stays open after renaming.
 assert.equal(await page.locator('[data-inv-cost-name]').inputValue(),'Test Chicken breast');
 await page.locator('[data-inv-typed-save]').click();
 await page.locator('#invMessage.error').filter({hasText:'Write the price'}).waitFor();
 await page.locator('[data-inv-typed="price"]').fill('11.5');await page.locator('[data-inv-typed="note"]').fill('Test Niko');
 await page.screenshot({path:`tmp/qa/${size}-ingredient-edit.png`,fullPage:true});
 await page.locator('[data-inv-typed-save]').click();
 await page.locator('#invMessage.ok').filter({hasText:'Test Chicken breast: $11.50/kg saved. Dish costs use it now.'}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_cost_price_save').at(-1)[1]),{kind:'ingredient',ref_id:U(1),price:{price:11.5,unit:'kg',note:'Test Niko'}});
 assert.equal(await page.locator('#invCosts .inv-cost').count(),0,'no ingredient left without a price');
 await page.locator('#invCostsFilter [data-inv-costs-filter="done"]').click();
 const row=page.locator('.inv-cost-head',{hasText:'Test Chicken breast'});
 assert.match((await row.innerText()).replace(/\s+/g,' '),/\$11\.50\/kg Typed price · Test Niko · used in 1 recipe/);
 // A typed price on a linked ingredient replaces the link.
 await page.locator('.inv-cost-head',{hasText:'Test Bacon'}).click();
 await page.locator('[data-inv-typed="price"]').fill('10');await page.locator('[data-inv-typed-save]').click();
 await page.locator('#invMessage.ok').filter({hasText:'Test Bacon: $10.00/kg saved.'}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_ingredient_cost_save').at(-1)[1]),{ingredient_id:U(3),link:null},'unlinked first');
 // Linking an invoice product replaces a typed price.
 await page.locator('.inv-cost-head',{hasText:'Test Chicken breast'}).click();
 await page.locator('[data-inv-cost-search]').fill('thigh');
 await page.locator('.inv-prod',{hasText:'Test Chicken Thigh'}).click();
 await page.locator('[data-inv-cost-save]').click();
 await page.locator('#invMessage.ok').filter({hasText:'Test Chicken breast linked.'}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_cost_price_save').at(-1)[1]),{kind:'ingredient',ref_id:U(1),price:null},'typed price removed');
 // Remove a typed price (two taps).
 await page.locator('.inv-cost-head',{hasText:'Test Chicken'}).filter({hasNotText:'breast'}).click();
 const rm=page.locator('[data-inv-typed-remove]');await rm.click();assert.equal(await rm.innerText(),'Tap again');await rm.click();
 await page.locator('#invMessage.ok').filter({hasText:'Typed price removed from Test Chicken.'}).waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no sideways scroll');
 assert.deepEqual(errors,[]);
 await context.close();
}
console.log(`PASS (${ENGINE}): ingredient prices: With a price / No price, rename (taken name refused, new name everywhere), typed price for a supplier with no PDF (saved, shown, replaces a link), linking replaces a typed price, remove typed price (two taps), no overflow, no JavaScript errors.`);
}finally{await browser.close();server.close();}
