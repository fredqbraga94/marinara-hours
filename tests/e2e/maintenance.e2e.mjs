// Maintenance screen: report, edit, start fixing, fixed with a note, reopen,
// remove, the urgent row on Home, and the list forgotten when another person
// signs in. Synthetic data; the
// server is replaced by an in-memory list (the server itself is checked in
// tests/integration/maintenance.mjs).
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
  currentManagerRole='floor_manager';document.querySelector('#loginScreen').classList.add('hidden');showOnlyManagerScreen('managerScreen');setManagerHeader('Hawthorne');setManagerNavActive('home');
  const items=[];let n=0;const now=()=>new Date().toISOString();const me='QA Floor Manager';
  const orig=managerApi;window.__calls=[];
  managerApi=async(action,extra={})=>{
   window.__calls.push(action);
   if(action==='manager_maintenance_list')return{open:items.filter(i=>['open','in_progress'].includes(i.status)).sort((a,b)=>b.urgent-a.urgent).map(i=>({...i})),fixed:items.filter(i=>i.status==='fixed').map(i=>({...i}))};
   if(action==='manager_maintenance_save'){const it=extra.item;if(it.id){const i=items.find(x=>x.id===it.id);Object.assign(i,{equipment:it.equipment,problem:it.problem,urgent:it.urgent});return{item:{...i}};}
    const i={id:`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`,equipment:it.equipment,problem:it.problem||null,urgent:it.urgent,status:'open',fix_note:null,created_by:me,created_at:now(),started_by:null,started_at:null,done_by:null,done_at:null};items.push(i);return{item:{...i}};}
   if(action==='manager_maintenance_mark'){const i=items.find(x=>x.id===extra.id);const s=extra.status;i.status=s;
    if(s==='in_progress'){i.started_by=me;i.started_at=now();} if(s==='open'){i.started_by=null;i.started_at=null;}
    i.done_by=['fixed','removed'].includes(s)?me:null;i.done_at=['fixed','removed'].includes(s)?now():null;i.fix_note=s==='fixed'?(extra.note||null):s==='removed'?i.fix_note:null;return{item:{...i}};}
   if(action==='manager_shopping_list')return{open:[],bought:[]};
   if(action==='manager_roster_week')return{team:[],entries:[],services:[],leave:[]};
   return orig(action,extra);
  };
 });
 const dash=(name)=>page.evaluate(name=>window.dispatchEvent(new CustomEvent('marinara:dashboard',{detail:{location:'Hawthorne',manager:{id:name,name},counts:{unapproved_shifts:0},working:[],permissions:{}}})),name);
 await dash('QA Floor Manager');

 for(const where of ['#operationsScreen','#managerMoreScreen','#quickActionsDialog']){
  const order=await page.locator(`${where} [data-rm-go]`).evaluateAll(es=>es.map(e=>e.dataset.rmGo));
  assert.equal(order[order.indexOf('rmOpenShopping')+1],'rmOpenMaintenance',`${where}: Maintenance right after Shopping`);
 }
 await page.locator('[data-manager-nav="operations"]').click();await page.locator('#operationsScreen').waitFor({state:'visible'});
 await page.getByRole('button',{name:'Maintenance Equipment to fix'}).click();await page.locator('#maintenanceScreen').waitFor({state:'visible'});
 await page.locator('#mntOpen').filter({hasText:'Nothing to fix'}).waitFor();

 await page.locator('#mntSave').click();assert.match(await page.locator('#mntMsg').innerText(),/Write which equipment/);
 await page.locator('#mntEquipment').fill('QA cool room light');await page.locator('#mntProblem').fill('Flickering');await page.locator('#mntSave').click();
 await page.locator('#mntOpen .mnt-item').first().waitFor();
 await page.locator('#mntEquipment').fill('QA pizza oven');await page.locator('#mntProblem').fill('Not heating on the left');await page.locator('#mntUrgent').check();await page.locator('#mntSave').click();
 await page.waitForFunction(()=>document.querySelectorAll('#mntOpen .mnt-item').length===2);
 const first=page.locator('#mntOpen .mnt-item').first();
 assert.match(await first.innerText(),/QA pizza oven\s*Urgent[\s\S]*Not heating on the left[\s\S]*Reported by QA Floor Manager/i);
 assert.equal(await first.evaluate(e=>e.classList.contains('urgent')),true);

 // Edit.
 await page.locator('#mntOpen .mnt-item').nth(1).locator('[data-mnt-edit]').click();
 assert.equal(await page.locator('#mntEquipment').inputValue(),'QA cool room light');
 await page.locator('#mntProblem').fill('Off completely');await page.locator('#mntSave').click();
 await page.locator('#mntOpen').filter({hasText:'Off completely'}).waitFor();
 assert.equal(await page.locator('#mntOpen .mnt-item').count(),2,'edited, not added');

 // Start fixing → "Being fixed".
 await first.locator('[data-mnt-start]').click();
 await page.locator('#mntOpen').filter({hasText:'Started by QA Floor Manager'}).waitFor();
 assert.equal(await page.locator('#mntOpen .mnt-item').first().locator('[data-mnt-start]').count(),0,'no second start');
 mkdirSync('tmp/qa',{recursive:true});await page.screenshot({path:`tmp/qa/${size}-maintenance.png`,fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal overflow');

 // Home: urgent repair at the top in red.
 await page.locator('[data-manager-nav="home"]').click();await page.locator('#managerScreen').waitFor({state:'visible'});
 await page.locator('#rmAttention').filter({hasText:'1 repair needed now'}).waitFor();
 const top=page.locator('#rmAttention .rm-row').first();
 assert.match(await top.innerText(),/urgent\s*1 repair needed now[\s\S]*QA pizza oven · 1 more to fix/i);
 assert.equal(await top.evaluate(e=>e.classList.contains('rm-urgent')),true);
 await page.locator('#rmAttention').screenshot({path:`tmp/qa/${size}-home-repair.png`});
 await top.click();await page.locator('#maintenanceScreen').waitFor({state:'visible'});

 // Fixed with a note → moves to "Fixed"; Reopen brings it back.
 await page.locator('#mntOpen .mnt-item').first().locator('[data-mnt-fix]').click();
 await page.locator('#mntFixNote').fill('Technician replaced the element');await page.locator('[data-mnt-fix-save]').click();
 await page.locator('#mntFixed .mnt-item').first().waitFor();
 assert.match(await page.locator('#mntFixed').innerText(),/QA pizza oven[\s\S]*Technician replaced the element[\s\S]*Fixed by QA Floor Manager/);
 assert.equal(await page.locator('#mntOpen .mnt-item').count(),1);
 await page.locator('[data-manager-nav="home"]').click();
 await page.locator('#rmAttention').filter({hasText:'1 repair to do'}).waitFor();
 assert.equal(await page.locator('#rmAttention .rm-urgent').count(),0,'no red row once the urgent one is fixed');
 await page.locator('#rmAttention [data-rm-go="rmOpenMaintenance"]').click();await page.locator('#maintenanceScreen').waitFor({state:'visible'});
 await page.locator('#mntFixed [data-mnt-reopen]').click();
 await page.waitForFunction(()=>document.querySelectorAll('#mntOpen .mnt-item').length===2);

 // Remove needs two taps.
 const light=page.locator('#mntOpen .mnt-item').filter({hasText:'QA cool room light'});
 await light.locator('[data-mnt-remove]').click();assert.equal(await page.locator('#mntOpen .mnt-item').count(),2);
 await light.locator('[data-mnt-remove]').click();
 await page.waitForFunction(()=>document.querySelectorAll('#mntOpen .mnt-item').length===1);

 // Another person signs in: list forgotten, loaded again for them.
 await page.evaluate(()=>{window.__calls=[];});await dash('QA Other Manager');
 await page.waitForFunction(()=>window.__calls.includes('manager_maintenance_list'));

 assert.deepEqual(errors,[],'no JavaScript errors');
 await context.close();
}
console.log(`PASS (${ENGINE}): maintenance report, edit, start fixing, fixed with note, reopen, remove (two taps), urgent row on Home, menus, overflow, no JavaScript errors.`);
}finally{await browser.close();server.close();}
