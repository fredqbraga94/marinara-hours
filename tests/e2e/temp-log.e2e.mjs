// Temperatures: add equipment, daily checks (out of range needs an action),
// deliveries, Home "checks to do", the 90-day records and print. Synthetic data;
// the server is replaced (checked in tests/integration/temp-log.mjs).
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
  currentManagerRole='kitchen_manager';currentSessionToken='qa-token';document.querySelector('#loginScreen').classList.add('hidden');showOnlyManagerScreen('managerScreen');setManagerHeader('Hawthorne');setManagerNavActive('home');
  const eq=[],logs=[];let n=0;const id=()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;
  const ok=(f,v)=>f==='fridge'||f==='chilled'?v<=5:f==='freezer'||f==='frozen'?v<=-15:v>=60;
  const json=l=>({...l,equipment:(eq.find(e=>e.id===l.equipment_id)||{}).name||null});
  window.__printed=0;window.print=()=>{window.__printed++;};
  const orig=managerApi;
  managerApi=async(action,extra={})=>{
   if(action==='manager_temp_today'){const act=eq.filter(e=>e.active);return{day:'x',equipment:act.map(e=>({id:e.id,name:e.name,kind:e.kind,today:(()=>{const l=logs.filter(x=>x.equipment_id===e.id).at(-1);return l?json(l):null;})()})),missing:act.filter(e=>!logs.some(x=>x.equipment_id===e.id)).length,today:logs.slice().reverse().map(json)};}
   if(action==='manager_temp_equipment_save'){const it=extra.item;if(it.id){const e=eq.find(x=>x.id===it.id);e.active=it.active!==false;return{equipment:e};}const e={id:id(),name:it.name,kind:it.kind,active:true};eq.push(e);return{equipment:e};}
   if(action==='manager_temp_record'){const x=extra.entry;const e=eq.find(q=>q.id===x.equipment_id);const food=x.kind==='equipment'?e.kind:x.food;const good=ok(food,x.temp);
    if(!good&&!x.action){const er=new Error('The temperature is outside the safe range. Write what you did about it.');throw er;}
    const l={id:id(),kind:x.kind,equipment_id:x.equipment_id||null,item:x.item||null,supplier:x.supplier||null,food,temp:x.temp,ok:good,action:x.action||null,recorded_at:new Date().toISOString(),recorded_by:'QA Kitchen Manager'};logs.push(l);return{record:json(l)};}
   if(action==='manager_temp_history')return{days:90,location:'Hawthorne',records:logs.slice().reverse().map(json)};
   if(action==='manager_roster_week')return{team:[],entries:[],services:[],leave:[]};
   return orig(action,extra);};
 });
 await page.locator('[data-manager-nav="operations"]').click();await page.locator('#operationsScreen').waitFor({state:'visible'});
 assert.equal(await page.locator('#managerMoreScreen [data-rm-go="rmOpenTemps"]').count(),1,'in More');
 await page.getByRole('button',{name:'Temperatures Daily checks for the council'}).click();await page.locator('#tempScreen').waitFor({state:'visible'});
 await page.locator('#tmpEquip').filter({hasText:'Add your fridges'}).waitFor();
 // Add equipment.
 await page.locator('#tmpEqName').fill('QA cool room');await page.locator('#tmpEqKind').selectOption('fridge');await page.locator('#tmpEqSave').click();
 await page.locator('#tmpEquip .tmp-eq').first().waitFor();
 await page.locator('#tmpEqName').fill('QA freezer');await page.locator('#tmpEqKind').selectOption('freezer');await page.locator('#tmpEqSave').click();
 await page.waitForFunction(()=>document.querySelectorAll('#tmpEquip .tmp-eq').length===2);
 assert.equal(await page.locator('#tmpCount').innerText(),'(0 of 2 checked)');
 // Home shows the checks to do.
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('marinara:dashboard',{detail:{location:'Hawthorne',manager:{id:'qa',name:'QA Kitchen Manager'},counts:{unapproved_shifts:0},working:[],permissions:{}}})));
 await page.waitForFunction(()=>/temperature checks to do today/.test(document.getElementById('rmAttention').innerText));
 assert.match(await page.locator('#rmAttention').innerText(),/2 temperature checks to do today/);
 // In range.
 const eqRows=page.locator('#tmpEquip .tmp-eq');
 const fridgeRow=eqRows.filter({hasText:'QA cool room'});
 await fridgeRow.locator('[data-tmp-temp]').fill('3,5');await fridgeRow.locator('[data-tmp-save]').click();
 await page.locator('#tmpEquip .tmp-eq').filter({hasText:'QA cool room'}).filter({hasText:'✓ 3.5°C'}).waitFor();
 // Out of range: needs an action first.
 const fz=()=>page.locator('#tmpEquip .tmp-eq').filter({hasText:'QA freezer'});
 await fz().locator('[data-tmp-temp]').fill('-10');await fz().locator('[data-tmp-save]').click();
 await fz().locator('.tmp-need').waitFor();
 assert.match(await fz().locator('.tmp-need').innerText(),/-10\.0°C is outside the safe range/);
 await page.screenshot({path:`tmp/qa/${size}-temps-action.png`});
 await fz().locator('[data-tmp-action]').fill('Door left open; closed it, checked again in 30 min');await fz().locator('[data-tmp-save]').click();
 await page.locator('#tmpEquip .tmp-eq').filter({hasText:'QA freezer'}).filter({hasText:'⚠ -10.0°C'}).waitFor();
 assert.equal(await page.locator('#tmpCount').innerText(),'(2 of 2 checked)');
 assert.doesNotMatch(await page.locator('#rmAttention').innerText(),/temperature check/,'Home row gone when all checked');
 // Delivery out of range needs an action.
 await page.locator('#tmpItem').fill('QA prawns');await page.locator('#tmpFood').selectOption('frozen');await page.locator('#tmpDTemp').fill('-8');
 assert.equal(await page.locator('#tmpDAction').isVisible(),true,'action field appears');
 await page.locator('#tmpDSave').click();assert.match(await page.locator('#tmpDMsg').innerText(),/Outside the safe range/);
 await page.locator('#tmpDAction').fill('Rejected, sent back with the driver');await page.locator('#tmpDSave').click();
 await page.locator('#tmpDMsg').filter({hasText:'QA prawns: -8.0°C saved.'}).waitFor();
 assert.equal(await page.locator('#tmpToday .tmp-rec').count(),3);
 assert.equal(await page.locator('#tmpToday .tmp-rec.bad').count(),2);
 // Records and print.
 await page.locator('#tmpHistBtn').click();await page.locator('#tmpRecords').waitFor({state:'visible'});
 assert.match(await page.locator('#tmpRecHead').innerText(),/Hawthorne · last 90 days · 3 records/);
 await page.locator('#tmpPrint').click();assert.equal(await page.evaluate(()=>window.__printed),1);
 await page.screenshot({path:`tmp/qa/${size}-temps.png`,fullPage:true});
 // Remove needs two taps; records stay.
 const rm=page.locator('#tmpList [data-tmp-remove]').first();await rm.click();assert.match(await rm.innerText(),/Tap again/);await rm.click();
 await page.waitForFunction(()=>document.querySelectorAll('#tmpEquip .tmp-eq').length===1);
 // Sign-out forgets it.
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('marinara:session-reset')));
 assert.equal(await page.locator('#tmpRecords').isVisible(),false);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no sideways scroll');
 assert.deepEqual(errors,[]);
 await context.close();
}
console.log(`PASS (${ENGINE}): temperatures: equipment, checks (action required out of range), deliveries, Home row, 90-day records, print, remove, sign-out, no overflow, no JavaScript errors.`);
}finally{await browser.close();server.close();}
