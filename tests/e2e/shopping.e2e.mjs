// Shopping list screen: add, edit, mark bought, undo, remove, the Home count,
// and the list forgotten when another person signs in. Synthetic data; the
// server is replaced by an in-memory list (the server itself is checked in
// tests/integration/shopping.mjs).
import {createServer} from 'node:http';
import {readFileSync,mkdirSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const pw=require(process.env.PLAYWRIGHT_PATH||'playwright');const {devices}=pw;
const ENGINE=process.env.E2E_BROWSER==='webkit'?'webkit':'chromium';
const server=createServer((req,res)=>{try{const p=resolve('.'+(req.url==='/'?'/index.html':req.url.split('?')[0]));res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.png':'image/png'})[extname(p)]||'text/html');res.end(readFileSync(p));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await pw[ENGINE].launch();
try{
for(const [size,options] of [['iphone',devices['iPhone 13']],['desktop',{viewport:{width:1440,height:1000}}]]){
 const context=await browser.newContext({...options,serviceWorkers:'block'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.route('https://**/*',route=>route.abort());
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(()=>{
  currentManagerRole='kitchen_manager';document.querySelector('#loginScreen').classList.add('hidden');showOnlyManagerScreen('managerScreen');setManagerHeader('Hawthorne');setManagerNavActive('home');
  // In-memory server.
  const items=[];let n=0;const now=()=>new Date().toISOString();
  const pub=i=>({...i});
  const orig=managerApi;
  window.__calls=[];
  managerApi=async(action,extra={})=>{
   window.__calls.push(action);
   if(action==='manager_shopping_list')return{open:items.filter(i=>i.status==='open').sort((a,b)=>b.urgent-a.urgent).map(pub),bought:items.filter(i=>i.status==='bought').map(pub)};
   if(action==='manager_shopping_save'){const it=extra.item;if(it.id){const i=items.find(x=>x.id===it.id);Object.assign(i,{name:it.name,qty:it.qty,note:it.note,urgent:it.urgent});return{item:pub(i)};}
    const i={id:`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`,name:it.name,qty:it.qty||null,note:it.note||null,urgent:it.urgent,status:'open',created_by:'QA Kitchen Manager',created_at:now(),done_by:null,done_at:null};items.push(i);return{item:pub(i)};}
   if(action==='manager_photo_set'){const i=items.find(x=>x.id===extra.item_id);if(!/^data:image\/jpeg;base64,/.test(extra.thumb)||!/^data:image\/jpeg;base64,/.test(extra.photo))throw new Error('not a jpeg');i.thumb=extra.thumb;i.__photo=extra.photo;window.__photoSizes=[extra.thumb.length,extra.photo.length];return{thumb:extra.thumb};}
   if(action==='manager_photo_get'){const i=items.find(x=>x.id===extra.item_id);return{photo:i.__photo};}
   if(action==='manager_photo_remove'){const i=items.find(x=>x.id===extra.item_id);i.thumb=null;i.__photo=null;return{removed:true};}
   if(action==='manager_shopping_mark'){const i=items.find(x=>x.id===extra.id);i.status=extra.status;i.done_by=extra.status==='open'?null:'QA Kitchen Manager';i.done_at=extra.status==='open'?null:now();return{item:pub(i)};}
   if(action==='manager_roster_week')return{team:[],entries:[],services:[],leave:[]};
   return orig(action,extra);
  };
 });
 const dash=(name)=>page.evaluate(name=>window.dispatchEvent(new CustomEvent('marinara:dashboard',{detail:{location:'Hawthorne',manager:{id:name,name},counts:{unapproved_shifts:0},working:[],permissions:{}}})),name);
 await dash('QA Kitchen Manager');

 // Operations → Shopping (also in More and the + menu).
 assert.equal(await page.locator('#managerMoreScreen [data-rm-go="rmOpenShopping"]').count(),1,'in More');
 assert.equal(await page.locator('#quickActionsDialog [data-rm-go="rmOpenShopping"]').count(),1,'in the + menu');
 await page.locator('[data-manager-nav="operations"]').click();await page.locator('#operationsScreen').waitFor({state:'visible'});
 await page.getByRole('button',{name:'Shopping Things to buy'}).click();await page.locator('#shoppingScreen').waitFor({state:'visible'});
 assert.equal(await page.locator('[data-manager-nav="operations"]').evaluate(b=>b.classList.contains('active')),true,'Operations tab stays lit');
 await page.locator('#shopOpen').filter({hasText:'Nothing to buy'}).waitFor();

 // Blank is refused on the phone.
 await page.locator('#shopSave').click();assert.match(await page.locator('#shopMsg').innerText(),/Write what needs to be bought/);
 // Add two; urgent first.
 await page.locator('#shopName').fill('QA chef knife');await page.locator('#shopQty').fill('1');await page.locator('#shopSave').click();
 await page.locator('#shopOpen .shop-item').first().waitFor();
 await page.locator('#shopName').fill('QA paper towels');await page.locator('#shopQty').fill('2 packs');await page.locator('#shopNote').fill('the big ones');await page.locator('#shopUrgent').check();await page.locator('#shopSave').click();
 await page.waitForFunction(()=>document.querySelectorAll('#shopOpen .shop-item').length===2);
 const names=await page.locator('#shopOpen .shop-main strong').allInnerTexts();
 assert.match(names[0],/QA paper towels\s*Urgent/i);
 assert.equal(await page.locator('#shopOpen .shop-item').first().evaluate(e=>e.classList.contains('urgent')),true,'urgent item in red');assert.equal(names[1],'QA chef knife');
 assert.match(await page.locator('#shopOpen').innerText(),/2 packs · the big ones[\s\S]*Asked by QA Kitchen Manager/);
 assert.equal(await page.locator('#shopOpenCount').innerText(),'(2)');
 assert.equal(await page.locator('#shopName').inputValue(),'','form cleared after adding');
 // Photo on an item: pick, preview in the list, tap opens the larger copy.
 const pic=await page.screenshot({type:'jpeg',quality:80});
 const chooser=page.waitForEvent('filechooser');
 await page.locator('#shopOpen .shop-item').nth(1).locator('[data-shop-addphoto]').click();
 await (await chooser).setFiles({name:'knife.jpg',mimeType:'image/jpeg',buffer:pic});
 await page.locator('#shopOpen .shop-item').nth(1).locator('.mh-thumb img').waitFor();
 const [thumbLen,photoLen]=await page.evaluate(()=>window.__photoSizes);
 assert.ok(thumbLen<40000&&photoLen<700000,`shrunk on the phone: ${thumbLen}/${photoLen}`);
 assert.equal(await page.locator('#shopOpen .shop-item').nth(1).locator('[data-shop-addphoto]').count(),0,'no Add photo once there is one');
 await page.locator('#shopOpen .shop-item').nth(1).locator('.mh-thumb').click();
 await page.locator('#mhPhotoViewer').waitFor({state:'visible'});
 await page.waitForFunction(()=>document.getElementById('mhPhotoImg').src.length>2000&&!document.getElementById('mhPhotoMsg').textContent);
 await page.screenshot({path:`tmp/qa/${size}-shopping-photo.png`});
 await page.locator('#mhPhotoClose').click();assert.equal(await page.locator('#mhPhotoViewer').isVisible(),false);
 // A photo chosen while adding is saved with the new item.
 await page.locator('#shopName').fill('QA mop');
 const chooser2=page.waitForEvent('filechooser');await page.locator('#shopPhotoBtn').click();
 await (await chooser2).setFiles({name:'mop.jpg',mimeType:'image/jpeg',buffer:pic});
 await page.locator('#shopPhotoPrev').waitFor({state:'visible'});
 await page.locator('#shopSave').click();
 await page.locator('#shopOpen .shop-item').filter({hasText:'QA mop'}).locator('.mh-thumb').waitFor();
 assert.equal(await page.locator('#shopPhotoPrev').isVisible(),false,'form photo cleared');
 // Remove the mop again (two taps) so the rest of the test sees two items.
 const mop=page.locator('#shopOpen .shop-item').filter({hasText:'QA mop'});
 await mop.locator('[data-shop-remove]').click();await mop.locator('[data-shop-remove]').click();
 await page.waitForFunction(()=>document.querySelectorAll('#shopOpen .shop-item').length===2);
 mkdirSync('tmp/qa',{recursive:true});await page.screenshot({path:`tmp/qa/${size}-shopping.png`,fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal overflow');

 // Edit.
 await page.locator('#shopOpen .shop-item').nth(1).locator('[data-shop-edit]').click();
 assert.equal(await page.locator('#shopName').inputValue(),'QA chef knife');assert.equal(await page.locator('#shopSave').innerText(),'Save changes');
 await page.locator('#shopName').fill('QA chef knife 24cm');await page.locator('#shopSave').click();
 await page.locator('#shopOpen').filter({hasText:'QA chef knife 24cm'}).waitFor();
 assert.equal(await page.locator('#shopSave').innerText(),'Add to list');assert.equal(await page.locator('#shopOpen .shop-item').count(),2,'edited, not added');

 // Bought → moves down; Undo → back.
 await page.getByRole('button',{name:'Mark QA paper towels as bought'}).click();
 await page.locator('#shopBought .shop-item').first().waitFor();
 assert.match(await page.locator('#shopBought').innerText(),/QA paper towels[\s\S]*Bought by QA Kitchen Manager/);
 assert.equal(await page.locator('#shopOpen .shop-item').count(),1);
 await page.locator('#shopBought [data-shop-undo]').click();
 await page.waitForFunction(()=>document.querySelectorAll('#shopOpen .shop-item').length===2);

 // Remove needs two taps.
 const knife=page.locator('#shopOpen .shop-item').filter({hasText:'QA chef knife 24cm'});
 await knife.locator('[data-shop-remove]').click();
 assert.equal(await page.locator('#shopOpen .shop-item').count(),2,'first tap only asks');
 assert.equal(await knife.locator('[data-shop-remove]').innerText(),'Tap again to remove');
 await knife.locator('[data-shop-remove]').click();
 await page.waitForFunction(()=>document.querySelectorAll('#shopOpen .shop-item').length===1);

 // Home: "1 thing to buy · 1 urgent", tap opens the list.
 await page.locator('[data-manager-nav="home"]').click();await page.locator('#managerScreen').waitFor({state:'visible'});
 await page.locator('#rmAttention').filter({hasText:'1 thing to buy now'}).waitFor();
 const first=page.locator('#rmAttention .rm-row').first();
 assert.match(await first.innerText(),/urgent\s*1 thing to buy now[\s\S]*QA paper towels/i,'urgent first');
 assert.equal(await first.evaluate(e=>e.classList.contains('rm-urgent')&&getComputedStyle(e).backgroundColor),'rgb(253, 236, 234)','urgent row in red');
 await page.locator('#rmAttention').screenshot({path:`tmp/qa/${size}-home-urgent.png`});
 assert.equal(await page.locator('#rmBellBadge').isVisible(),false,'not on the bell (nobody is waiting on the manager)');
 await page.locator('#rmAttention [data-rm-go="rmOpenShopping"]').click();await page.locator('#shoppingScreen').waitFor({state:'visible'});

 // Another person signs in on this phone: the list is forgotten, then loaded for them.
 await page.evaluate(()=>{window.__calls=[];});
 await dash('QA Other Manager');
 await page.waitForFunction(()=>window.__calls.includes('manager_shopping_list'));
 await page.locator('[data-manager-nav="home"]').click();
 await page.locator('#rmAttention').filter({hasText:'1 thing to buy'}).waitFor();

 assert.deepEqual(errors,[],'no JavaScript errors');
 await context.close();
}
console.log(`PASS (${ENGINE}): shopping list add, photo (shrunk, preview, open), edit, bought, undo, remove (two taps), Home count, menus, iPhone/desktop overflow, no JavaScript errors.`);
}finally{await browser.close();server.close();}
