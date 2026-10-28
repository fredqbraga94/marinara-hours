// Invoices → Top: ranking by spend or orders, search, top 40 then show all, the
// list forgotten when another person signs in. Synthetic data; the server is
// replaced (the server itself is checked in tests/integration/top-products.mjs).
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
  const products=[];for(let i=1;i<=45;i++)products.push({supplier:'QA Wholesale',code:'QA'+i,brand:'QA Brand',description:'QA product '+i,orders:i%7===0?90:50-i,spend:10000/i,last_date:'2026-10-20',last_price:10+i,last_label:'Carton',first_price:10,first_date:'2025-11-01',change_pct:i===1?4.9:(i===2?-3:null),from_history:true});
  window.__calls=0;const orig=managerApi;
  managerApi=async(action,extra)=>{if(action==='manager_invoice_top_products'){window.__calls++;return{period_from:'2025-10-28',total:products.reduce((s,p)=>s+p.spend,0),imports:[{supplier:'QA Wholesale',from:'2025-10-28',to:'2026-10-02',source:'QA'}],products};}
   if(action==='manager_invoice_list'||action==='manager_invoice_prices')return{invoices:[],products:[]};return orig(action,extra);};
 });
 await page.evaluate(()=>{document.getElementById('invoicesCard')?.click();});
 await page.locator('#invoicesScreen').waitFor({state:'visible'});
 await page.locator('#invTabs [data-inv-tab="top"]').click();
 await page.locator('#tpList .tp-row').first().waitFor();
 assert.equal(await page.locator('#tpList .tp-row').count(),40,'top 40 first');
 assert.match(await page.locator('#tpHint').innerText(),/45 products .* since 28 Oct 25.*QA Wholesale history/s);
 assert.match(await page.locator('#tpList .tp-row').first().innerText(),/1\s*QA product 1[\s\S]*▲ 4\.9%[\s\S]*\$10,000/);
 await page.screenshot({path:`tmp/qa/${size}-top-products.png`});
 // By orders: product 7 (90 orders) goes up.
 await page.locator('[data-tp-sort="orders"]').click();
 assert.match(await page.locator('#tpList .tp-row .pb-main strong').first().innerText(),/QA product (7|14|21|28|35|42)$/);
 // Show all, then search.
 await page.locator('#tpMore').click();assert.equal(await page.locator('#tpList .tp-row').count(),45);
 await page.locator('#tpSearch').fill('QA44');assert.equal(await page.locator('#tpList .tp-row').count(),1);
 await page.locator('#tpSearch').fill('nothing like this');assert.match(await page.locator('#tpList').innerText(),/Nothing matches/);
 // Cached: going back to the tab does not ask the server again.
 await page.locator('#tpSearch').fill('');
 await page.locator('#invTabs [data-inv-tab="list"]').click();await page.locator('#invTabs [data-inv-tab="top"]').click();
 assert.equal(await page.evaluate(()=>window.__calls),1,'loaded once');
 assert.equal(await page.locator('#invPricesView').isVisible(),false,'only the Top view shows');
 // Another person signs in: the list is forgotten.
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('marinara:session-reset')));
 assert.equal(await page.locator('#tpList .tp-row').count(),0);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no sideways scroll');
 assert.deepEqual(errors,[]);
 await context.close();
}
console.log(`PASS (${ENGINE}): Invoices → Top: by spend and by orders, top 40 then all, search, cached, forgotten on sign-out, no overflow, no JavaScript errors.`);
}finally{await browser.close();server.close();}
