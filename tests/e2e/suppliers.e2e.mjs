// Suppliers: open from Stock & Orders, add one (name suggested from the names
// already used), call and email buttons, checks on phone/email and same name,
// edit, remove (two taps), back, sign-out. Synthetic data; the server is
// replaced (checked in tests/integration/suppliers.mjs).
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
  const list=[];let n=0;const id=()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;
  window.__calls=[];const orig=managerApi;
  managerApi=async(action,extra={})=>{window.__calls.push([action,JSON.parse(JSON.stringify(extra))]);
   if(action==='manager_supplier_list'){const names=list.map(s=>s.name.toLowerCase());
    return{location:'Hawthorne',suppliers:list.slice().sort((a,b)=>a.name.localeCompare(b.name)),known:['QA Veg Co','QA Dairy'].filter(k=>!names.includes(k.toLowerCase()))};}
   if(action==='manager_supplier_save'){const s=extra.supplier;const clean=v=>v||null;
    const row={name:s.name,contact:clean(s.contact),phone:clean(s.phone),email:clean(s.email),note:clean(s.note)};
    if(s.id){Object.assign(list.find(x=>x.id===s.id),row);return{supplier:list.find(x=>x.id===s.id)};}
    const x={id:id(),...row};list.push(x);return{supplier:x};}
   if(action==='manager_supplier_remove'){list.splice(list.findIndex(x=>x.id===extra.id),1);return{removed:true};}
   if(action==='manager_roster_week')return{team:[],entries:[],services:[],leave:[]};
   return orig(action,extra);};
 });
 await page.locator('[data-manager-nav="operations"]').click();await page.locator('#operationsScreen').waitFor({state:'visible'});
 await page.locator('#operationsScreen [data-rm-go="rmOpenHubStock"]').click();await page.locator('#hubStockScreen').waitFor({state:'visible'});
 assert.deepEqual(await page.locator('#hubStockMenu [data-rm-go]').evaluateAll(es=>es.map(e=>e.dataset.rmGo)),['stockCard','rmOpenOrders','rmOpenSuppliers','rmOpenShopping']);
 assert.equal(await page.locator('#managerMoreScreen [data-rm-go="rmOpenSuppliers"]').count(),0,'More shows the group, not the row');
 await page.locator('#hubStockMenu [data-rm-go="rmOpenSuppliers"]').click();await page.locator('#supplierScreen').waitFor({state:'visible'});
 await page.locator('#supList').filter({hasText:'No suppliers yet'}).waitFor();
 assert.equal(await page.locator('#supForm').isVisible(),false);
 // Add: the names already used are offered.
 await page.locator('#supAdd').click();
 assert.deepEqual(await page.locator('#supKnown option').evaluateAll(es=>es.map(e=>e.value)),['QA Veg Co','QA Dairy']);
 await page.locator('#supName').fill('QA Veg Co');await page.locator('#supContact').fill('QA Person');
 await page.locator('#supPhone').fill('call me');await page.locator('#supSave').click();
 await page.locator('#supFormMsg').filter({hasText:'numbers only'}).waitFor();
 await page.locator('#supPhone').fill('0400 000 000');await page.locator('#supEmail').fill('Orders@QA-Veg');await page.locator('#supSave').click();
 await page.locator('#supFormMsg').filter({hasText:'does not look right'}).waitFor();
 await page.locator('#supEmail').fill('Orders@QA-Veg.example');await page.locator('#supNote').fill('Order by 2pm');
 await page.locator('#supSave').click();
 await page.locator('#supMsg').filter({hasText:'Supplier added: QA Veg Co'}).waitFor();
 const saved=await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_supplier_save').at(-1)[1].supplier);
 assert.deepEqual(saved,{name:'QA Veg Co',contact:'QA Person',phone:'0400 000 000',email:'orders@qa-veg.example',note:'Order by 2pm'});
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_supplier_save').length),1,'bad phone/email never sent');
 const row=page.locator('.sup-item').filter({hasText:'QA Veg Co'});
 await row.waitFor();
 assert.equal(await row.locator('a[href^="tel:"]').getAttribute('href'),'tel:0400000000');
 assert.equal(await row.locator('a[href^="mailto:"]').getAttribute('href'),'mailto:orders@qa-veg.example');
 assert.match(await row.innerText(),/QA Person · 0400 000 000 · orders@qa-veg\.example/);
 assert.match(await row.innerText(),/Order by 2pm/);
 assert.deepEqual(await page.locator('#supKnown option').evaluateAll(es=>es.map(e=>e.value)),['QA Dairy'],'no longer suggested');
 // The same name again: told to edit the one on the list.
 await page.locator('#supAdd').click();await page.locator('#supName').fill('qa veg co');await page.locator('#supSave').click();
 await page.locator('#supFormMsg').filter({hasText:'already on the list'}).waitFor();
 await page.locator('#supCancel').click();
 // A supplier with only a name: no call or email buttons.
 await page.locator('#supAdd').click();await page.locator('#supName').fill('QA Dairy');await page.locator('#supSave').click();
 const dairy=page.locator('.sup-item').filter({hasText:'QA Dairy'});await dairy.waitFor();
 assert.equal(await dairy.locator('a').count(),0);
 assert.deepEqual(await page.locator('.sup-item strong').allInnerTexts(),['QA Dairy','QA Veg Co'],'by name');
 await page.screenshot({path:`tmp/qa/${size}-suppliers.png`,fullPage:true});
 // Edit: the form opens with what was saved.
 await row.locator('[data-sup-edit]').click();
 assert.equal(await page.locator('#supEmail').inputValue(),'orders@qa-veg.example');
 assert.equal(await page.locator('#supSave').innerText(),'Save changes');
 await page.locator('#supEmail').fill('');await page.locator('#supSave').click();
 await page.locator('#supMsg').filter({hasText:'Supplier saved.'}).waitFor();
 await page.waitForFunction(()=>![...document.querySelectorAll('.sup-item a')].some(a=>a.href.startsWith('mailto:')));
 // Remove (two taps).
 await dairy.locator('[data-sup-remove]').click();
 assert.match(await dairy.locator('[data-sup-remove]').innerText(),/Tap again/);
 await dairy.locator('[data-sup-remove]').click();
 await page.locator('#supMsg').filter({hasText:'Removed: QA Dairy'}).waitFor();
 await page.waitForFunction(()=>document.querySelectorAll('.sup-item').length===1);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no sideways scroll');
 // Back: Suppliers -> Stock & Orders.
 await page.locator('#supplierScreen [data-hub-back]').click();await page.locator('#hubStockScreen').waitFor({state:'visible'});
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('marinara:session-reset')));
 assert.equal(await page.locator('.sup-item').count(),0,'sign-out forgets it');
 assert.deepEqual(errors,[]);
 await context.close();
}
console.log(`PASS (${ENGINE}): suppliers: in Stock & Orders, add with suggested names, phone/email checks, call and email buttons, same name refused, edit, remove (two taps), back, no overflow, sign-out, no JavaScript errors.`);
}finally{await browser.close();server.close();}
