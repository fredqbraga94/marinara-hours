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
   if(action==='manager_supplier_list'){const dep=extra.department||'Floor';const here=list.filter(s=>s.department===dep);const names=here.map(s=>s.name.toLowerCase());
    return{location:'Hawthorne',department:dep,can_choose_department:true,suppliers:here.slice().sort((a,b)=>a.name.localeCompare(b.name)),known:['QA Veg Co','QA Dairy'].filter(k=>!names.includes(k.toLowerCase()))};}
   if(action==='manager_supplier_save'){const s=extra.supplier;const clean=v=>v||null;
    const row={name:s.name,contact:clean(s.contact),phone:clean(s.phone),email:clean(s.email),note:clean(s.note),department:s.department};
    if(s.id){Object.assign(list.find(x=>x.id===s.id),row);return{supplier:list.find(x=>x.id===s.id)};}
    const x={id:id(),...row};list.push(x);return{supplier:x};}
   if(action==='manager_supplier_remove'){list.splice(list.findIndex(x=>x.id===extra.id),1);return{removed:true};}
   if(action==='manager_invoice_price_book')return{products:[
    {supplier:'QA Veg Co Pty',product_key:'qa mushrooms',description:'QA Swiss brown mushrooms',unit:'box',pack:null,times:4,last_price:48,last_date:'2026-10-01',change_pct:4.3},
    {supplier:'QA Veg Co Pty',product_key:'qa basil',description:'QA Basil',unit:'bunch',pack:null,times:2,last_price:4,last_date:'2026-09-09',change_pct:null},
    {supplier:'QA Wholesale',product_key:'b1',description:'QA Bacon 2.5kg',unit:'Ctn [6]',pack:6,times:1,last_price:23.5,last_date:'2026-10-08',change_pct:null}]};
   if(action==='manager_invoice_list')return{invoices:[],by_supplier:[],totals:[]};
   if(action==='manager_roster_week')return{team:[],entries:[],services:[],leave:[]};
   return orig(action,extra);};
 });
 await page.locator('[data-manager-nav="operations"]').click();await page.locator('#operationsScreen').waitFor({state:'visible'});
 await page.locator('#operationsScreen [data-rm-go="rmOpenHubStock"]').click();await page.locator('#hubStockScreen').waitFor({state:'visible'});
 assert.deepEqual(await page.locator('#hubStockMenu [data-rm-go]').evaluateAll(es=>es.map(e=>e.dataset.rmGo)),['stockCard','rmOpenOrders','rmOpenSuppliers','rmOpenShopping']);
 assert.equal(await page.locator('#managerMoreScreen [data-rm-go="rmOpenSuppliers"]').count(),0,'More shows the group, not the row');
 await page.locator('#hubStockMenu [data-rm-go="rmOpenSuppliers"]').click();await page.locator('#supplierScreen').waitFor({state:'visible'});
 await page.locator('#supList').filter({hasText:'No Floor suppliers yet'}).waitFor();
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
 assert.deepEqual(saved,{name:'QA Veg Co',contact:'QA Person',phone:'0400 000 000',email:'orders@qa-veg.example',note:'Order by 2pm',department:'Floor'});
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
 // Prices: the button opens Finance → Prices on that supplier and its list
 // ("QA Veg Co" matches "QA Veg Co Pty"); products and prices are no longer here.
 assert.equal(await page.locator('[data-sup-products]').count(),0);
 await row.locator('[data-sup-prices]').click();
 await page.locator('#invoicesScreen').waitFor({state:'visible'});
 await page.locator('#invPricesView').waitFor({state:'visible'});
 await page.waitForFunction(()=>document.querySelectorAll('#pbList .pb-row').length===2);
 assert.equal(await page.locator('#pbSup').inputValue(),'QA Veg Co');
 assert.equal(await page.evaluate(()=>window.mhInvDept()),'Floor','the same list as the supplier');
 assert.deepEqual(await page.locator('#pbList .pb-main strong').allInnerTexts(),['QA Swiss brown mushrooms','QA Basil'],'most bought first, only this supplier');
 assert.match(await page.locator('#pbList .pb-row').first().innerText(),/\$48\.00[\s\S]*\/box[\s\S]*4\.3%/);
 assert.deepEqual(await page.locator('#pbSup option').allInnerTexts(),['All suppliers (3)','QA Veg Co (2)','QA Wholesale (1)','QA Dairy (0)']);
 await page.screenshot({path:`tmp/qa/${size}-supplier-products.png`,fullPage:true});
 await page.locator('#pbSup').selectOption('');
 await page.waitForFunction(()=>document.querySelectorAll('#pbList .pb-row').length===3);
 assert.equal(await page.locator('#pbSupBar').isVisible(),false);
 // A supplier with no invoices: type one of their invoices, the form opens with its name.
 await page.locator('#pbSup').selectOption('QA Dairy');
 await page.locator('#pbSupBar').filter({hasText:'No products from QA Dairy yet'}).waitFor();
 await page.locator('#pbSupBar [data-pb-type]').click();
 await page.locator('#invTyped').waitFor({state:'visible'});
 assert.equal(await page.locator('#invTypedSupplier').inputValue(),'QA Dairy');
 await page.locator('#invTypedCancel').click();
 await page.locator('[data-manager-nav="operations"]').click();await page.locator('#operationsScreen [data-rm-go="rmOpenHubStock"]').click();
 await page.locator('#hubStockMenu [data-rm-go="rmOpenSuppliers"]').click();await page.locator('#supplierScreen').waitFor({state:'visible'});
 await page.locator('.sup-item').filter({hasText:'QA Dairy'}).waitFor();
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
 // Kitchen and Floor lists (Administrator): switch, move a supplier.
 await page.locator('[data-manager-nav="operations"]').click();await page.locator('#operationsScreen [data-rm-go="rmOpenHubStock"]').click();
 await page.locator('#hubStockMenu [data-rm-go="rmOpenSuppliers"]').click();
 await page.locator('.sup-item').filter({hasText:'QA Veg Co'}).waitFor();
 assert.equal(await page.locator('#supDept').isVisible(),true);
 assert.match(await page.locator('#supSub').innerText(),/Floor suppliers/);
 await page.locator('.sup-item').filter({hasText:'QA Veg Co'}).locator('[data-sup-edit]').click();
 assert.equal(await page.locator('#supDeptSel').inputValue(),'Floor');
 await page.locator('#supDeptSel').selectOption('Kitchen');await page.locator('#supSave').click();
 await page.locator('#supMsg').filter({hasText:'QA Veg Co is now in the Kitchen list.'}).waitFor();
 await page.locator('#supList').filter({hasText:'No Floor suppliers yet'}).waitFor();
 await page.locator('#supDept [data-sup-dept="Kitchen"]').click();
 await page.locator('.sup-item').filter({hasText:'QA Veg Co'}).waitFor();
 assert.equal(await page.evaluate(()=>localStorage.getItem('mh-suppliers-dept')),'Kitchen','remembered on this phone');
 assert.deepEqual(errors,[]);
 await context.close();
}
console.log(`PASS (${ENGINE}): suppliers: in Stock & Orders, add with suggested names, phone/email checks, call and email buttons, Prices opens Finance → Prices on that supplier, type an invoice for a supplier with none, same name refused, Kitchen/Floor lists (switch, move), edit, remove (two taps), back, no overflow, sign-out, no JavaScript errors.`);
}finally{await browser.close();server.close();}
