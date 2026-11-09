// Typed invoice (no PDF, e.g. Niko's paper invoices): the form, the checks,
// and what is sent to the server (same as a PDF invoice). Synthetic data;
// the server is replaced (manager_invoice_save is checked in the invoice
// release checks).
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
try{
for(const [size,options] of [['iphone',devices['iPhone 13']],['desktop',{viewport:{width:1440,height:1000}}]]){
 const context=await browser.newContext({...options,serviceWorkers:'block'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.route('https://**/*',route=>route.abort());
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(()=>{
  currentManagerRole='kitchen_manager';currentSessionToken='qa-token';document.querySelector('#loginScreen').classList.add('hidden');showOnlyManagerScreen('managerScreen');setManagerHeader('Hawthorne');setManagerNavActive('home');
  const saved=[];
  window.__calls=[];const orig=managerApi;
  managerApi=async(action,extra={})=>{window.__calls.push([action,JSON.parse(JSON.stringify(extra))]);
   if(action==='manager_invoice_price_book')return{products:[{supplier:'Test Veg Co',product_key:'swiss brown mushrooms',description:'Swiss brown mushrooms',unit:'box',price:46},{supplier:'Test Dairy',product_key:'m1',description:'Test Milk 2L',unit:'EA',price:2}]};
   if(action==='manager_invoice_list')return{invoices:saved.map(x=>({id:x.number,supplier:x.supplier,kind:x.kind,number:x.number,invoice_date:x.date,total:x.total,lines:x.lines.length})),totals:[]};
   if(action==='manager_invoice_save'){if(saved.some(x=>x.supplier===extra.invoice.supplier&&x.number===extra.invoice.number)){const er=new Error('Already saved');er.code='INVOICE_DUPLICATE';throw er;}saved.push(extra.invoice);return{invoice:{id:'x'}};}
   if(action==='manager_dish_costs')return{location:'Hawthorne',recipes:[],ingredients:[],products:[]};
   if(action==='manager_roster_week')return{team:[],entries:[],services:[],leave:[]};
   return orig(action,extra);};
 });
 await page.evaluate(()=>openInvoicesScreen());
 await page.locator('#invoicesScreen').waitFor({state:'visible'});
 await page.locator('#invTypeOpen').click();
 await page.locator('#invTyped').waitFor({state:'visible'});
 assert.equal(await page.locator('#invTypeOpen').isVisible(),false);
 assert.equal(await page.locator('#invTypedLines [data-tl]').count(),3);
 await page.waitForFunction(()=>document.querySelectorAll('#invTypedSuppliers option').length===2);
 // Nothing typed: told what is missing.
 await page.locator('#invTypedSave').click();
 await page.locator('#invMessage.error').filter({hasText:'Write the supplier, the invoice number and the date.'}).waitFor();
 await page.locator('#invTypedSupplier').fill('Test Veg Co');
 assert.deepEqual(await page.locator('#invTypedProducts option').evaluateAll(es=>es.map(e=>e.value)),['Swiss brown mushrooms'],'products of that supplier');
 await page.locator('#invTypedNumber').fill('11026');await page.locator('#invTypedDate').fill('2026-10-01');
 const L=n=>page.locator(`#invTypedLines [data-tl="${n}"]`);
 await L(0).locator('.q').fill('2');await L(0).locator('.d').fill('Swiss brown mushrooms');
 assert.equal(await L(0).locator('.u').inputValue(),'box','unit from the product typed before');
 await L(0).locator('.m').fill('96');
 await L(1).locator('.q').fill('10');await L(1).locator('.u').fill('bunch');await L(1).locator('.d').fill('Shallots');await L(1).locator('.m').fill('$24.00');
 await L(2).locator('.d').fill('Tomatoes');
 await page.locator('#invTypedSave').click();
 await page.locator('#invMessage.error').filter({hasText:'Tomatoes: write the line total'}).waitFor();
 await L(2).locator('.q').fill('1');await L(2).locator('.u').fill('box');await L(2).locator('.m').fill('35');
 await page.locator('#invTypedAdd').click();
 assert.equal(await page.locator('#invTypedLines [data-tl]').count(),4);
 assert.equal(await page.locator('#invTypedSupplier').inputValue(),'Test Veg Co','kept when a line is added');
 assert.equal(await L(0).locator('.m').inputValue(),'96','lines kept');
 await L(3).locator('.x').click();
 assert.equal(await page.locator('#invTypedLines [data-tl]').count(),3);
 await page.locator('#invTypedTotal').fill('150');
 await page.locator('#invTypedCheck .inv-flag.warn').filter({hasText:'The lines come to $155.00, the paper says $150.00'}).waitFor();
 await page.locator('#invTypedSave').click();
 await page.locator('#invMessage.error').filter({hasText:'Save anyway'}).waitFor();
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_invoice_save').length),0,'not saved yet');
 await page.locator('#invTypedTotal').fill('155');
 await page.locator('#invTypedCheck .inv-flag.ok').filter({hasText:'Adds up: 3 lines match the total $155.00'}).waitFor();
 await page.screenshot({path:`tmp/qa/${size}-typed-invoice.png`,fullPage:true});
 await page.locator('#invTypedSave').click();
 await page.locator('#invMessage.ok').filter({hasText:'Saved: Test Veg Co #11026 · 3 lines · $155.00.'}).waitFor();
 const sent=await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_invoice_save').at(-1)[1].invoice);
 assert.deepEqual(sent,{supplier:'Test Veg Co',number:'11026',kind:'invoice',date:'2026-10-01',subtotal:155,gst:0,total:155,checks_ok:true,file_name:'Typed in the app',lines:[
  {code:'',description:'Swiss brown mushrooms',qty:2,unit:'box',unit_price:48,line_total:96,gst:0},
  {code:'',description:'Shallots',qty:10,unit:'bunch',unit_price:2.4,line_total:24,gst:0},
  {code:'',description:'Tomatoes',qty:1,unit:'box',unit_price:35,line_total:35,gst:0}]});
 assert.equal(await page.locator('#invTyped').isVisible(),false,'form closed');
 // The same invoice again: told it is already saved.
 await page.locator('#invTypeOpen').click();
 await page.locator('#invTypedSupplier').fill('Test Veg Co');await page.locator('#invTypedNumber').fill('11026');
 await L(0).locator('.d').fill('Basil');await L(0).locator('.m').fill('16');
 await page.locator('#invTypedSave').click();
 await page.locator('#invMessage.error').filter({hasText:'Test Veg Co #11026 is already saved.'}).waitFor();
 await page.locator('#invTypedCancel').click();
 assert.equal(await page.locator('#invTyped').isVisible(),false);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no sideways scroll');
 assert.deepEqual(errors,[]);
 await context.close();
}
console.log(`PASS (${ENGINE}): typed invoice (no PDF): supplier and products offered, unit from a product typed before, missing fields told, add/remove lines, total checked against the paper (Save anyway), saved with unit prices, duplicate told, cancel, no overflow, no JavaScript errors.`);
}finally{await browser.close();server.close();}
