// Invoices in two lists, Kitchen and Floor: the Administrator's switch (each
// invoice call carries the list), Costs only on Kitchen, moving an invoice,
// and the note a Floor/Kitchen Manager sees. Synthetic data; the server is
// replaced at the network (what the server allows is checked in
// tests/integration/invoice-departments.mjs).
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
let failures=0;
async function check(name,fn){try{await fn();console.log(`  ✔ ${name}`);}catch(e){failures++;console.log(`  ✖ ${name}\n      ${String(e?.stack||e).split('\n').slice(0,6).join('\n      ')}`);}}

const INV={
 Kitchen:[{id:'k1',supplier:'Test Veg Co',kind:'invoice',number:'101',invoice_date:'2026-10-01',total:120,line_count:2,checks_ok:true,department:'Kitchen'}],
 Floor:[{id:'f1',supplier:'Test Drinks Co',kind:'invoice',number:'201',invoice_date:'2026-10-02',total:300,line_count:1,checks_ok:true,department:'Floor'}],
};
async function open(role,size){
 const options=size==='desktop'?{viewport:{width:1440,height:1000}}:devices['iPhone 13'];
 const context=await browser.newContext({...options,serviceWorkers:'block'});const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 const calls=[];
 await page.route('https://**/*',async route=>{
  const req=route.request();let body={};try{body=JSON.parse(req.postData()||'{}');}catch(_){}
  if(req.method()!=='POST'||!body.action)return route.abort();
  calls.push(body);
  const dep=body.department||(role==='floor_manager'?'Floor':'Kitchen');
  let data={};
  if(body.action==='manager_invoice_list'){const invs=INV[dep];data={location:'Hawthorne',department:dep,can_choose_department:role==='manager',total:invs.reduce((a,b)=>a+b.total,0),by_supplier:invs.map(i=>({supplier:i.supplier,count:1,total:i.total})),invoices:invs};}
  else if(body.action==='manager_invoice_get'){const inv=[...INV.Kitchen,...INV.Floor].find(i=>i.id===body.id);data={invoice:inv,lines:[{description:'Test line',qty:1,unit:'EA',unit_price:inv.total,line_total:inv.total,gst:0}]};}
  else if(body.action==='manager_invoice_move'){const from=body.department==='Floor'?'Kitchen':'Floor';const i=INV[from].findIndex(x=>x.id===body.id);const [x]=INV[from].splice(i,1);x.department=body.department;INV[body.department].push(x);data={moved:true};}
  else if(body.action==='manager_invoice_prices')data={changes:[]};
  else if(body.action==='manager_invoice_usage')data={items:[],weeks:[]};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,data})});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(r=>{try{localStorage.removeItem('mh-invoices-dept');}catch(_){}
  currentManagerRole=r;currentSessionToken='qa-token';document.querySelector('#loginScreen').classList.add('hidden');showOnlyManagerScreen('managerScreen');setManagerHeader('Hawthorne');setManagerNavActive('home');},role);
 await page.evaluate(()=>openInvoicesScreen());
 await page.locator('#invoicesScreen').waitFor({state:'visible'});
 return {page,calls,errors,close:()=>context.close()};
}
const lists=calls=>calls.filter(c=>c.action==='manager_invoice_list');

try{
 for(const size of ['iphone','desktop']){
  await check(`${size}: Administrator switches Kitchen/Floor; each list call says which; Costs only on Kitchen`,async()=>{
   const {page,calls,errors,close}=await open('manager',size);
   await page.locator('#invDept').waitFor({state:'visible'});
   await page.locator('#invList').filter({hasText:'Test Veg Co'}).waitFor();
   assert.equal(lists(calls).at(-1).department,'Kitchen');
   assert.equal(await page.locator('#invDept [data-inv-dept="Kitchen"].selected').count(),1);
   assert.equal(await page.locator('#invTabs [data-inv-tab="costs"]').isVisible(),true);
   assert.equal(await page.locator('#invDeptNote').isVisible(),false);
   await page.locator('#invDept [data-inv-dept="Floor"]').click();
   await page.locator('#invList').filter({hasText:'Test Drinks Co'}).waitFor();
   assert.equal(lists(calls).at(-1).department,'Floor');
   assert.equal(await page.locator('#invList').filter({hasText:'Test Veg Co'}).count(),0,'Kitchen invoices not shown on Floor');
   assert.equal(await page.locator('#invTabs [data-inv-tab="costs"]').isVisible(),false,'Costs hidden on Floor');
   assert.equal(await page.evaluate(()=>localStorage.getItem('mh-invoices-dept')),'Floor','remembered on the phone');
   await page.screenshot({path:`tmp/qa/${size}-invoice-departments.png`,fullPage:true});
   assert.deepEqual(errors,[]);
   await close();
  });
  await check(`${size}: Administrator moves an invoice to the other list (two taps)`,async()=>{
   const {page,calls,close}=await open('manager',size);
   await page.locator('[data-inv-open="k1"]').click();
   const mv=page.locator('[data-inv-move="k1"]');
   await mv.waitFor({state:'visible'});
   assert.equal((await mv.textContent()).trim(),'Move to the Floor list');
   await mv.click();
   assert.equal((await mv.textContent()).trim(),'Tap again to move to Floor');
   assert.equal(calls.filter(c=>c.action==='manager_invoice_move').length,0,'not moved on the first tap');
   await mv.click();
   await page.locator('#invMessage.ok').filter({hasText:'Invoice moved to the Floor list.'}).waitFor();
   const sent=calls.filter(c=>c.action==='manager_invoice_move');
   assert.equal(sent.length,1);assert.equal(sent[0].id,'k1');assert.equal(sent[0].department,'Floor');
   await page.locator('#invDept [data-inv-dept="Floor"]').click();
   await page.locator('#invList').filter({hasText:'Test Veg Co'}).waitFor();
   // Move it back so the next size starts the same.
   await page.locator('[data-inv-open="k1"]').click();
   const back=page.locator('[data-inv-move="k1"]');
   await back.waitFor({state:'visible'});
   assert.equal((await back.textContent()).trim(),'Move to the Kitchen list');
   await back.click();await back.click();
   await page.locator('#invMessage.ok').filter({hasText:'Invoice moved to the Kitchen list.'}).waitFor();
   await close();
  });
  for(const [role,dep] of [['floor_manager','Floor'],['kitchen_manager','Kitchen']]){
   await check(`${size}: ${role} sees only the ${dep} list: no switch, no move, a note; calls name no list (the server uses theirs)`,async()=>{
    const {page,calls,errors,close}=await open(role,size);
    await page.locator('#invList').filter({hasText:dep==='Floor'?'Test Drinks Co':'Test Veg Co'}).waitFor();
    assert.equal(await page.locator('#invDept').isVisible(),false);
    await page.locator('#invDeptNote').filter({hasText:`${dep} invoices: only you and the Administrator see them.`}).waitFor();
    assert.equal(await page.locator('#invTabs [data-inv-tab="costs"]').isVisible(),dep==='Kitchen');
    assert.ok(lists(calls).every(c=>!('department' in c)),JSON.stringify(lists(calls)));
    const id=dep==='Floor'?'f1':'k1';
    await page.locator(`[data-inv-open="${id}"]`).click();
    await page.locator(`[data-inv-remove="${id}"]`).waitFor({state:'visible'});
    assert.equal(await page.locator('[data-inv-move]').count(),0);
    assert.deepEqual(errors,[]);
    await close();
   });
  }
 }
}finally{await browser.close();server.close();}
console.log(failures?`\n${failures} CHECK(S) FAILED`:'\nALL INVOICE DEPARTMENT BROWSER CHECKS PASSED');
process.exit(failures?1:0);
