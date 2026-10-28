// Invoices → Prices with the supplier history: the change over the year shows in
// "Went up"/"Went down" (tagged "in the year"), after the recent changes from
// saved invoices; weight-priced items are left out; the Home alert only counts
// recent rises. Synthetic data; the server is replaced.
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
  currentManagerRole='manager';currentSessionToken='qa-token';document.querySelector('#loginScreen').classList.add('hidden');showOnlyManagerScreen('managerScreen');setManagerHeader('Hawthorne');setManagerNavActive('home');
  const today=new Date(Date.now()+10*3600e3).toISOString().slice(0,10);
  const S='QA Wholesale';const orig=managerApi;
  managerApi=async(action,extra)=>{
   if(action==='manager_invoice_price_book')return{products:[
    {supplier:S,product_key:'QA1',code:'QA1',description:'QA cream',unit:'CTN',times:2,last_price:113,last_date:today,previous_price:null,change_pct:null,history:[{date:today,price:113}]},
    {supplier:S,product_key:'QA4',code:'QA4',description:'QA flour',unit:'CTN',times:3,last_price:17,last_date:today,previous_price:16,previous_date:today,change_pct:6.3,history:[{date:today,price:16},{date:today,price:17}]}]};
   if(action==='manager_invoice_top_products')return{products:[
    {supplier:S,code:'QA1',description:'QA cream',orders:130,spend:37000,last_date:today,last_price:113,last_label:'Carton',first_price:107.73,first_date:'2025-10-29',change_pct:4.9,from_history:true},
    {supplier:S,code:'QA2',description:'QA olive oil',orders:13,spend:1500,last_date:'2026-09-14',last_price:102.5,last_label:'Box',first_price:89.5,first_date:'2026-03-11',change_pct:14.5,from_history:true},
    {supplier:S,code:'QA3',description:'QA pork by weight',orders:117,spend:19000,last_date:'2026-10-12',last_price:156.9,last_label:'Carton',first_price:313.88,first_date:'2025-10-29',change_pct:-50,from_history:true},
    {supplier:S,code:'QA5',description:'QA cocoa',orders:3,spend:1000,last_date:'2026-09-10',last_price:297,last_label:'Carton',first_price:330,first_date:'2026-02-11',change_pct:-10,from_history:true}]};
   if(action==='manager_invoice_list')return{invoices:[]};
   return orig(action,extra);};
 });
 await page.evaluate(()=>document.getElementById('invoicesCard')?.click());
 await page.locator('#invoicesScreen').waitFor({state:'visible'});
 await page.locator('#invTabs [data-inv-tab="prices"]').click();
 await page.locator('#pbList .pb-row').first().waitFor();
 assert.equal(await page.locator('#pbList .pb-row').count(),5,'scanned products plus the history-only ones');
 await page.locator('[data-pb-filter="up"]').click();
 const ups=await page.locator('#pbList .pb-row .pb-main strong').allInnerTexts();
 assert.deepEqual(ups,['QA flour','QA olive oil','QA cream'],'recent rise first, then the year (biggest first)');
 assert.match(await page.locator('#pbList .pb-row').nth(1).innerText(),/14\.5%\s*in the year/);
 await page.locator('#pbList .pb-row').nth(2).click();
 assert.match(await page.locator('#pbList .pb-hist').innerText(),/In the year \(supplier history\).*\+4\.9%/s);
 await page.screenshot({path:`tmp/qa/${size}-prices-year.png`});
 await page.locator('[data-pb-filter="down"]').click();
 assert.deepEqual(await page.locator('#pbList .pb-row .pb-main strong').allInnerTexts(),['QA cocoa'],'weight-priced pork is left out');
 assert.deepEqual(await page.evaluate(()=>window.mhPriceUps.map(p=>p.description)),['QA flour'],'Home alert: recent rises only');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no sideways scroll');
 assert.deepEqual(errors,[]);
 await context.close();
}
console.log(`PASS (${ENGINE}): Prices with the supplier history: year changes in Went up/down after recent ones, weight items left out, Home alert recent only, no overflow, no JavaScript errors.`);
}finally{await browser.close();server.close();}
