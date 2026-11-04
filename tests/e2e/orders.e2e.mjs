// Orders: paste the supplier's items, type quantities (+/−), make the PDF
// (saved first), repeat the last order, remove an item. Synthetic data; the
// server is replaced (checked in tests/integration/supplier-orders.mjs).
import {createServer} from 'node:http';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
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
  try{localStorage.clear();}catch(_){}
  const items=[],orders=[];let n=0;const id=()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;
  window.__calls=[];const orig=managerApi;
  managerApi=async(action,extra={})=>{window.__calls.push([action,JSON.parse(JSON.stringify(extra))]);
   if(action==='manager_order_list'){const sups=[...new Set(items.filter(i=>i.active).map(i=>i.supplier))];const sup=extra.supplier||sups[0]||null;
    return{location:'Hawthorne',supplier:sup,suppliers:sups,items:items.filter(i=>i.active&&i.supplier===sup).sort((a,b)=>a.name.localeCompare(b.name)),orders:orders.filter(o=>o.supplier===sup).slice().reverse().slice(0,5)};}
   if(action==='manager_order_item_save'){const it=extra.item;if(it.id){const x=items.find(i=>i.id===it.id);x.active=it.active!==false;return{item:x};}
    const ex=items.find(i=>i.active&&i.supplier===it.supplier&&i.name.toLowerCase()===it.name.toLowerCase());if(ex)return{item:{...ex,existing:true}};
    const x={id:id(),supplier:it.supplier,name:it.name,unit:it.unit||null,active:true};items.push(x);return{item:x};}
   if(action==='manager_order_save'){const o={id:id(),...extra.order,by:'QA Kitchen Manager',created_at:new Date().toISOString()};orders.push(o);return{order:o};}
   if(action==='manager_roster_week')return{team:[],entries:[],services:[],leave:[]};
   return orig(action,extra);};
 });
 await page.locator('[data-manager-nav="operations"]').click();await page.locator('#operationsScreen').waitFor({state:'visible'});
 assert.equal(await page.locator('#managerMoreScreen [data-rm-go="rmOpenHubStock"]').count(),1,'Stock & Orders in More');
 await page.locator('#operationsScreen [data-rm-go="rmOpenHubStock"]').click();await page.locator('#hubStockScreen').waitFor({state:'visible'});
 assert.deepEqual(await page.locator('#hubStockMenu [data-rm-go]').evaluateAll(es=>es.map(e=>e.dataset.rmGo)),['stockCard','rmOpenOrders','rmOpenShopping']);
 await page.locator('#hubStockMenu [data-rm-go="rmOpenOrders"]').click();await page.locator('#orderScreen').waitFor({state:'visible'});
 await page.locator('#ordList').filter({hasText:'No items yet'}).waitFor();
 assert.equal(await page.locator('#ordSup').inputValue(),'Niko','Niko by default');
 assert.equal(await page.locator('#ordSend').isVisible(),false);
 // Paste many at once.
 await page.locator('#ordMany').fill('QA Tomatoes - Box\nQA Basil - bunch\nQA Lettuce\nQA Tomatoes - box');
 await page.locator('#ordAdd').click();
 await page.locator('#ordFormMsg').filter({hasText:'3 added to Niko (1 already on the list).'}).waitFor();
 await page.waitForFunction(()=>document.querySelectorAll('[data-ord-item]').length===3);
 // Units in small letters, however they were typed.
 assert.deepEqual(await page.locator('[data-ord-item] .ord-name small').allInnerTexts(),['bunch','box']);
 // Delivery: tomorrow by default; a day left from before (today or past) moves to tomorrow.
 const tomorrow=await page.evaluate(()=>{const t=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Brisbane'}).format(new Date());const d=new Date(t+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);});
 assert.equal(await page.locator('#ordDay').inputValue(),tomorrow,'tomorrow by default');
 await page.evaluate(()=>{document.getElementById('ordDay').value='2020-01-01';});
 await page.locator('#orderScreen [data-hub-back]').click();await page.locator('#hubStockMenu [data-rm-go="rmOpenOrders"]').click();await page.locator('#orderScreen').waitFor({state:'visible'});
 await page.waitForFunction(t=>document.getElementById('ordDay').value===t,tomorrow);
 // Quantities: + / − and typing.
 const rowOf=name=>page.locator('[data-ord-item]').filter({hasText:name});
 await rowOf('QA Tomatoes').locator('[data-ord-plus]').click();await rowOf('QA Tomatoes').locator('[data-ord-plus]').click();
 assert.equal(await rowOf('QA Tomatoes').locator('.ord-qty').inputValue(),'2');
 await rowOf('QA Tomatoes').locator('[data-ord-minus]').click();assert.equal(await rowOf('QA Tomatoes').locator('.ord-qty').inputValue(),'1');
 await rowOf('QA Basil').locator('.ord-qty').fill('3');
 assert.match(await page.locator('#ordCount').innerText(),/2 items to order/);
 await page.locator('#ordNote').fill('Please before 10am');
 await page.screenshot({path:`tmp/qa/${size}-orders.png`,fullPage:true});
 // PDF: saved first, then share or open.
 await page.locator('#ordPdf').click();await page.locator('#tempPdfDialog').waitFor({state:'visible'});
 const saved=await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_order_save').at(-1)[1].order);
 assert.equal(saved.supplier,'Niko');assert.equal(saved.note,'Please before 10am');
 assert.deepEqual(saved.lines,[{name:'QA Basil',unit:'bunch',qty:'3'},{name:'QA Tomatoes',unit:'box',qty:'1'}]);
 assert.match(await page.locator('#saveTempPdf').getAttribute('download'),/^Marinara-Order-Niko-\d{4}-\d{2}-\d{2}\.pdf$/);
 {const b64=await page.evaluate(async()=>{const r=await fetch(document.getElementById('saveTempPdf').href);const a=new Uint8Array(await r.arrayBuffer());let s='';for(const x of a)s+=String.fromCharCode(x);return btoa(s);});const buf=Buffer.from(b64,'base64');assert.equal(buf.subarray(0,5).toString(),'%PDF-');writeFileSync(`tmp/qa/${size}-order.pdf`,buf);}
 await page.locator('#closeTempPdf').click();await page.locator('#tempPdfDialog').waitFor({state:'detached'});
 assert.equal(await page.locator('.ord-qty').evaluateAll(els=>els.every(e=>!e.value)),true,'cleared after the order');
 await page.locator('#ordPast').filter({hasText:'QA Kitchen Manager · 2 items'}).waitFor();
 // Send as a message: the same order as text (share sheet), then saved.
 await page.evaluate(()=>{window.__shared=null;navigator.share=async d=>{window.__shared=d;};});
 await page.locator('#ordRepeat').click();
 await page.locator('#ordText').click();
 await page.locator('#ordMsg').filter({hasText:'Order saved and sent as a message.'}).waitFor();
 const shared=await page.evaluate(()=>window.__shared.text);
 assert.match(shared,/^Hi Niko, order for Marinara Hawthorne\nDelivery: \w+day \d+ \w+\n\n3 bunch QA Basil\n1 box QA Tomatoes\n\nThanks!$/);
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_order_save').length),2,'saved as an order too');
 // Cancelled share: nothing saved.
 await page.evaluate(()=>{navigator.share=async()=>{const e=new Error('x');e.name='AbortError';throw e;};});
 await page.locator('#ordRepeat').click();await page.locator('#ordText').click();
 await page.locator('#ordMsg').filter({hasText:'Not sent'}).waitFor();
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_order_save').length),2);
 // Repeat the last order.
 await page.locator('#ordRepeat').click();
 assert.equal(await rowOf('QA Basil').locator('.ord-qty').inputValue(),'3');
 // Remove an item (two taps).
 await page.locator('#ordEditBtn').click();
 const rm=rowOf('QA Lettuce').locator('[data-ord-remove]');await rm.click();assert.match(await rowOf('QA Lettuce').locator('[data-ord-remove]').innerText(),/Tap again/);
 await rowOf('QA Lettuce').locator('[data-ord-remove]').click();
 await page.waitForFunction(()=>document.querySelectorAll('[data-ord-item]').length===2);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no sideways scroll');
 // Back: Orders -> Stock & Orders -> Operations.
 await page.locator('#orderScreen [data-hub-back]').click();await page.locator('#hubStockScreen').waitFor({state:'visible'});
 await page.locator('#hubStockScreen [data-hub-back]').click();await page.locator('#operationsScreen').waitFor({state:'visible'});
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('marinara:session-reset')));
 assert.equal(await page.locator('[data-ord-item]').count(),0,'sign-out forgets it');
 assert.deepEqual(errors,[]);
 await context.close();
}
console.log(`PASS (${ENGINE}): orders: Niko by default, paste many items (no duplicates), quantities + − and typed, note, PDF saved first and shared, last orders, repeat last order, remove (two taps), no overflow, sign-out, no JavaScript errors.`);
}finally{await browser.close();server.close();}
