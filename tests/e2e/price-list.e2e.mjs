// Import a price list in Finance → Products: the CSV is read on the phone,
// drinks go to Floor and the rest to Kitchen, the Administrator saves both, a
// manager only their own; the products then show "price list". Synthetic data;
// the server is replaced at the network (what it allows is checked in
// tests/integration/price-lists.mjs).
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


const CSV=['Item #,Item Name,Description,Pack Size,Price,Per Unit Price,Qty,Total',
 'QA-B6,QA Diced Bacon 2.5kg,"QA SKU: 1 | Brand: QA',
 '1 Carton(s) = 6 Unit",6,141,23.5,1,141',
 'QA-B6,QA Diced Bacon 2.5kg,"QA SKU: 1 | Brand: QA',
 '1 Carton(s) = 6 Unit",1,23.5,23.5,1,23.5',
 '11112222,"QA Flour, Bakers 12.5kg",QA SKU: 2 | Brand: QA,1,15.06,15.06,1,15.06',
 '55556666,QA Milk Full Cream [6x2lt] CTN,QA SKU: 4,1,21.5,21.5,1,21.5',
 '33334444,QA Shiraz Test Valley 750ml [6],"Valid liquor license required',
 '* GST applicable',
 'QA SKU: 3",1,14.15,14.15,1,14.15',''].join('\n');
async function open(role,size){
 const options=size==='desktop'?{viewport:{width:1440,height:1000}}:devices['iPhone 13'];
 const context=await browser.newContext({...options,serviceWorkers:'block'});const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 const calls=[];const saved={Kitchen:[],Floor:[]};
 await page.route('https://**/*',async route=>{
  const req=route.request();let body={};try{body=JSON.parse(req.postData()||'{}');}catch(_){}
  if(req.method()!=='POST'||!body.action)return route.abort();
  calls.push(body);
  const dep=body.department||(role==='floor_manager'?'Floor':'Kitchen');
  let data={};
  if(body.action==='manager_invoice_list')data={location:'Hawthorne',department:dep,can_choose_department:role==='manager',total:0,by_supplier:[],invoices:[]};
  else if(body.action==='manager_invoice_price_list_save'){saved[dep]=body.list.items.map(i=>({...i,date:body.list.date,supplier:body.list.supplier}));data={list:{supplier:body.list.supplier,date:body.list.date,items:body.list.items.length,department:dep,replaced:false}};}
  else if(body.action==='manager_invoice_price_book')data={products:saved[dep].map(i=>({supplier:i.supplier,product_key:i.code,code:i.code,description:i.description,unit:i.unit,pack:/\[(\d+)\]/.test(i.unit)?Number(i.unit.match(/\[(\d+)\]/)[1]):null,times:0,last_price:i.unit_price,last_date:i.date,last_from_list:true,history:[{date:i.date,price:i.unit_price,list:true}]})),department:dep};
  else if(body.action==='manager_supplier_list')data={suppliers:[],known:[]};
  else if(body.action==='manager_invoice_usage')data={items:[],weeks:[]};
  else if(body.action==='manager_invoice_top_products')data={products:[]};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,data})});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(r=>{try{localStorage.removeItem('mh-invoices-dept');}catch(_){}
  currentManagerRole=r;currentSessionToken='qa-token';document.querySelector('#loginScreen').classList.add('hidden');showOnlyManagerScreen('managerScreen');setManagerHeader('Hawthorne');setManagerNavActive('home');},role);
 await page.evaluate(async()=>{await openInvoicesScreen();invShowTab('prices');});
 await page.locator('#invPricesView').waitFor({state:'visible'});
 return {page,calls,errors,close:()=>context.close()};
}
const pick=async page=>{await page.locator('#pbImportFile').setInputFiles({name:'qa-price-list.csv',mimeType:'text/csv',buffer:Buffer.from(CSV)});await page.locator('#pbImportBox h3').waitFor();};
const saves=calls=>calls.filter(c=>c.action==='manager_invoice_price_list_save');

try{
 for(const size of ['iphone','desktop']){
  await check(`${size}: Administrator imports: drinks to Floor, the rest to Kitchen; prices show as "price list"`,async()=>{
   const {page,calls,errors,close}=await open('manager',size);
   await pick(page);
   const txt=await page.locator('#pbImportBox').innerText();
   assert.match(txt,/4 products: 3 Kitchen \(food, cleaning\) and 2 Floor \(drinks, and 1 milk on both\)/);
   assert.match(txt,/not count as spending/);
   assert.equal(await page.locator('#plSupplier').inputValue(),'','no supplier guessed for an unknown file');
   await page.screenshot({path:`tmp/qa/${size}-price-list.png`,fullPage:true});
   await page.locator('[data-pl-save]').click();
   await page.locator('#invMessage').filter({hasText:'Write the supplier name.'}).waitFor();
   assert.equal(saves(calls).length,0);
   await page.locator('#plSupplier').fill('QA Wholesale');
   await page.locator('[data-pl-save]').click();
   await page.locator('#invMessage.ok').filter({hasText:'Price list saved: 3 Kitchen and 2 Floor prices.'}).waitFor();
   const s=saves(calls);
   assert.deepEqual(s.map(c=>[c.department,c.list.supplier,c.list.items.length]),[['Kitchen','QA Wholesale',3],['Floor','QA Wholesale',2]]);
   assert.deepEqual(s[0].list.items.map(i=>[i.code,i.description,i.unit,i.unit_price,i.pack]),[['QA-B6','QA Diced Bacon 2.5kg','Ctn [6]',23.5,6],['11112222','QA Flour, Bakers 12.5kg','Unit',15.06,1],['55556666','QA Milk Full Cream [6x2lt] CTN','Unit',21.5,1]],'one row per product, carton kept, comma in a name');
   assert.deepEqual(s[1].list.items.map(i=>[i.description,i.unit,i.unit_price]),[['QA Milk Full Cream [6x2lt] CTN','Unit',21.5],['QA Shiraz Test Valley 750ml [6]','Ctn [6]',14.15]],'milk on both lists');
   assert.equal(await page.locator('#pbImportBox').isVisible(),false);
   await page.locator('#pbList .pb-row').filter({hasText:'QA Flour'}).filter({hasText:/price list/}).waitFor();
   assert.deepEqual(errors,[]);
   await close();
  });
  await check(`${size}: only the Administrator sees Import price list`,async()=>{
   for(const role of ['kitchen_manager','floor_manager']){
    const {page,errors,close}=await open(role,size);
    await page.locator('#pbList').waitFor();
    await page.waitForFunction(()=>!/Loading/.test(document.getElementById('pbList').textContent));
    assert.equal(await page.locator('#pbImportBtn').isVisible(),false,role);
    assert.deepEqual(errors,[]);
    await close();
   }
   const {page,close}=await open('manager',size);
   await page.locator('#pbImportBtn').waitFor({state:'visible'});
   await close();
  });
  await check(`${size}: a file that is not a CSV gets a clear message`,async()=>{
   const {page,close}=await open('manager',size);
   await page.locator('#pbImportFile').setInputFiles({name:'list.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF')});
   await page.locator('#pbImportBox').filter({hasText:'Choose the price list as a CSV file'}).waitFor();
   await page.locator('[data-pl-cancel]').click();
   assert.equal(await page.locator('#pbImportBox').isVisible(),false);
   await close();
  });
 }
}finally{await browser.close();server.close();}
console.log(failures?`\n${failures} CHECK(S) FAILED`:'\nALL PRICE LIST BROWSER CHECKS PASSED');
process.exit(failures?1:0);
