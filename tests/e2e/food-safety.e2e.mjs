// Food temperatures and Cleaning: choose the check, type food and °C, cooling
// with its 2-hour and 6-hour readings, out of range needs an action, correct a
// reading of today, PDF; the cleaning sheet (tick today with who, undo, usual
// list, remove, PDF). Synthetic data; the server is replaced (checked in
// tests/integration/food-safety.mjs).
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
const savePdf=async(page,name)=>{const b64=await page.evaluate(async()=>{const r=await fetch(document.getElementById('saveTempPdf').href);const a=new Uint8Array(await r.arrayBuffer());let s='';for(const x of a)s+=String.fromCharCode(x);return btoa(s);});const buf=Buffer.from(b64,'base64');assert.equal(buf.subarray(0,5).toString(),'%PDF-');writeFileSync(`tmp/qa/${name}`,buf);};
try{
for(const [size,options] of [['iphone',devices['iPhone 13']],['desktop',{viewport:{width:1440,height:1000}}]]){
 const context=await browser.newContext({...options,serviceWorkers:'block'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.route('https://**/*',route=>route.abort());
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(()=>{
  currentManagerRole='kitchen_manager';currentSessionToken='qa-token';document.querySelector('#loginScreen').classList.add('hidden');showOnlyManagerScreen('managerScreen');setManagerHeader('Hawthorne');setManagerNavActive('home');
  let n=0;const id=()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Brisbane'}).format(new Date());
  const add=(iso,k)=>{const d=new Date(`${iso}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+k);return d.toISOString().slice(0,10);};
  const monday=iso=>add(iso,-((new Date(`${iso}T00:00:00Z`).getUTCDay()+6)%7));
  const people=[{id:'00000000-0000-4000-8000-0000000000aa',name:'QA Cook'}];
  const foods=[],tasks=[],ticks=[];
  const ok=(c,s,v,m)=>c==='cook'||c==='reheat'?v>=75:c==='hot'?v>=60:c==='cold'?v<=5:s===0?true:s===1?v<=21&&m<=125:v<=5&&m<=365;
  const minutes=f=>f.batch_id?Math.round((new Date(f.recorded_at)-new Date(foods.find(b=>b.id===f.batch_id).recorded_at))/60e3):null;
  const json=f=>({...f,minutes:minutes(f)});
  window.__calls=[];
  window.__age=(food,m)=>{const f=foods.find(x=>x.food===food&&x.stage===0);f.recorded_at=new Date(Date.now()-m*60e3).toISOString();};
  const orig=managerApi;
  managerApi=async(action,extra={})=>{
   window.__calls.push([action,JSON.parse(JSON.stringify(extra))]);
   if(action==='manager_food_day'){const day=extra.day||today;return{day,today,location:'Hawthorne',people,foods:[...new Set(foods.map(f=>f.food))],
     records:foods.filter(f=>f.day===day).map(json),
     cooling:foods.filter(b=>b.check==='cool'&&b.stage===0&&!foods.some(c=>c.batch_id===b.id&&c.stage===2)).map(b=>({start:json(b),next:Math.max(0,...foods.filter(c=>c.batch_id===b.id).map(c=>c.stage))+1}))};}
   if(action==='manager_food_record'){const e=extra.entry;let f;
    if(e.batch_id){const b=foods.find(x=>x.id===e.batch_id);const st=Math.max(0,...foods.filter(c=>c.batch_id===b.id).map(c=>c.stage))+1;const m=(Date.now()-new Date(b.recorded_at))/60e3;
     f={id:id(),food:b.food,check:'cool',stage:st,batch_id:b.id,temp:e.temp,ok:ok('cool',st,e.temp,m)};}
    else f={id:id(),food:e.food,check:e.check,stage:0,batch_id:null,temp:e.temp,ok:ok(e.check,0,e.temp,0)};
    if(!f.ok&&!e.action)throw new Error('The temperature is outside the safe range. Write what you did about it.');
    Object.assign(f,{action:e.action||null,day:today,recorded_at:new Date().toISOString(),recorded_by:'QA Kitchen Manager',checked_by:e.checked_by?'QA Cook':'QA Kitchen Manager',checked_by_id:e.checked_by||'me'});foods.push(f);return{record:json(f)};}
   if(action==='manager_food_edit'){const f=foods.find(x=>x.id===extra.id);const e=extra.entry;const good=ok(f.check,f.stage,e.temp,minutes(f)||0);if(!good&&!e.action)throw new Error('The temperature is outside the safe range. Write what you did about it.');
    if(!f.original)f.original={food:f.food,temp:f.temp,action:f.action,checked_by:f.checked_by};Object.assign(f,{food:f.stage?f.food:e.food,temp:e.temp,ok:good,action:e.action||null,edited_at:new Date().toISOString(),edited_by:'QA Floor Manager'});return{record:json(f)};}
   if(action==='manager_food_history')return{days:90,location:'Hawthorne',records:foods.map(json)};
   if(action==='manager_clean_week'){const start=monday(extra.start||today);const end=add(start,6);const w=ticks.filter(x=>x.day>=start&&x.day<=end);
    return{start,today,location:'Hawthorne',people,tasks:tasks.filter(x=>x.active||w.some(y=>y.task_id===x.id)).sort((a,b)=>(a.frequency==='daily'?0:1)-(b.frequency==='daily'?0:1)),done:w};}
   if(action==='manager_clean_task_save'){const it=extra.item;if(it.id){const x=tasks.find(y=>y.id===it.id);x.active=it.active!==false;return{task:x};}const x={id:id(),name:it.name,how:it.how||null,frequency:it.frequency,active:true};tasks.push(x);return{task:x};}
   if(action==='manager_clean_mark'){const i=ticks.findIndex(x=>x.task_id===extra.task_id&&x.day===today);if(i>=0)ticks.splice(i,1);
    if(extra.done!==false)ticks.push({task_id:extra.task_id,day:today,by:extra.checked_by?'QA Cook':'QA Kitchen Manager',recorded_by:'QA Kitchen Manager',recorded_at:new Date().toISOString()});return{done:extra.done!==false};}
   if(action==='manager_clean_history')return{days:90,location:'Hawthorne',records:[]};
   if(action==='manager_roster_week')return{team:[],entries:[],services:[],leave:[]};
   return orig(action,extra);};
  window.__seedYesterdayTick=()=>{const tk=tasks.find(x=>x.frequency==='daily');ticks.push({task_id:tk.id,day:add(today,-1),by:'QA Cook',recorded_by:'QA Kitchen Manager',recorded_at:new Date(Date.now()-864e5).toISOString()});};
 });
 await page.locator('[data-manager-nav="operations"]').click();await page.locator('#operationsScreen').waitFor({state:'visible'});
 assert.equal(await page.locator('#managerMoreScreen [data-rm-go="rmOpenFoodSafety"]').count(),1,'Food Safety in More');
 assert.equal(await page.locator('#operationsScreen [data-rm-go="rmOpenCleaning"]').count(),0,'inside Food Safety');
 // ---------- Food temperatures ----------
 await page.locator('#operationsScreen [data-rm-go="rmOpenFoodSafety"]').click();await page.locator('#foodSafetyScreen').waitFor({state:'visible'});
 assert.deepEqual(await page.locator('#fsMenu .rm-row strong').allInnerTexts(),['Temperatures','Deliveries','Food temperatures','Cleaning']);
 await page.locator('#fsMenu [data-rm-go="rmOpenFoodTemps"]').click();await page.locator('#foodTempScreen').waitFor({state:'visible'});
 await page.locator('#ftList').filter({hasText:'No food temperatures yet today'}).waitFor();
 assert.equal(await page.locator('[data-ft-check]').count(),5);
 assert.equal(await page.locator('[data-ft-check="cook"]').getAttribute('aria-pressed'),'true','cooking first');
 // Cooking in range.
 await page.locator('#ftFood').fill('QA Chicken');await page.locator('#ftTemp').fill('82');await page.locator('#ftSave').click();
 await page.locator('#ftMsg').filter({hasText:'QA Chicken · Cooking: 82.0°C saved.'}).waitFor();
 await page.locator('.ft-table').waitFor();
 assert.equal(await page.locator('#ftFood').inputValue(),'','form cleared');
 // Hot holding too low: the action box appears and is required.
 await page.locator('[data-ft-check="hot"]').click();
 await page.locator('#ftFood').fill('QA Sauce');await page.locator('#ftTemp').fill('55');
 assert.equal(await page.locator('#ftAction').isVisible(),true,'action box shows');
 await page.locator('#ftSave').click();
 assert.match(await page.locator('#ftMsg').innerText(),/outside the safe range for hot holding/);
 await page.locator('#ftAction').fill('Reheated to 80°C');await page.locator('#ftSave').click();
 await page.locator('#ftMsg').filter({hasText:'QA Sauce · Hot holding: 55.0°C saved.'}).waitFor();
 await page.locator('.ft-table tr.bad').filter({hasText:'Reheated to 80°C'}).waitFor();
 // Checked by an employee.
 await page.locator('#ftWho').selectOption({label:'QA Cook'});
 await page.locator('[data-ft-check="cold"]').click();await page.locator('#ftFood').fill('QA Salad');await page.locator('#ftTemp').fill('3');await page.locator('#ftSave').click();
 await page.locator('#ftMsg').filter({hasText:'QA Salad · Cold holding: 3.0°C saved.'}).waitFor();
 assert.match(await page.locator('.ft-table tbody tr').last().innerText(),/QA Cook/);
 assert.match(await page.locator('.ft-table tbody tr').last().innerText(),/typed by QA Kitchen Manager/);
 assert.equal(await page.locator('#ftWho').inputValue(),'00000000-0000-4000-8000-0000000000aa','who is kept for the next reading');
 await page.locator('#ftWho').selectOption({label:'Me'});
 // Cooling: start, then the 2-hour reading in "Cooling in progress".
 await page.locator('[data-ft-check="cool"]').click();await page.locator('#ftFood').fill('QA Bolognese');await page.locator('#ftTemp').fill('68');await page.locator('#ftSave').click();
 await page.locator('#ftMsg').filter({hasText:'QA Bolognese: cooling started at 68.0°C'}).waitFor();
 const cool=page.locator('[data-ft-batch]');await cool.waitFor();
 assert.match(await cool.innerText(),/2-hour reading/);
 await page.evaluate(()=>window.__age('QA Bolognese',100));
 await cool.locator('[data-ft-ctemp]').fill('20');await cool.locator('[data-ft-csave]').click();
 await page.locator('#ftMsg').filter({hasText:'QA Bolognese · Cooling 2 h: 20.0°C saved.'}).waitFor();
 await page.locator('[data-ft-batch]').filter({hasText:'6-hour reading'}).waitFor();
 // The 6-hour reading too late: action needed.
 await page.evaluate(()=>window.__age('QA Bolognese',400));
 await page.locator('[data-ft-ctemp]').fill('4');await page.locator('[data-ft-csave]').click();
 assert.match(await page.locator('#ftMsg').innerText(),/outside the safe range \(5°C or below within 6 h\)/);
 await page.locator('[data-ft-caction]').fill('Thrown away');await page.locator('[data-ft-csave]').click();
 await page.locator('#ftMsg').filter({hasText:'Cooling 6 h: 4.0°C saved.'}).waitFor();
 await page.waitForFunction(()=>!document.querySelector('[data-ft-batch]'));
 assert.equal(await page.locator('.ft-table tbody tr').count(),6);
 assert.match(await page.locator('.ft-table').innerText(),/Cooling 2 h/);
 const sent=await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_food_record').map(c=>c[1].entry));
 assert.deepEqual(sent.filter(e=>e.batch_id).map(e=>[e.temp,e.action]),[[20,''],[4,''],[4,'Thrown away']],'cooling readings sent with the batch (the server asked for the action)');
 assert.equal(sent[0].check,'cook');assert.equal(sent[0].temp,82);
 // Correct a reading: the first values stay.
 const chick=page.locator('.ft-table tbody tr').filter({hasText:'QA Chicken'});
 await chick.locator('[data-ft-edit]').click();
 const ef=page.locator('[data-ft-eform]');await ef.locator('[data-f="food"]').fill('QA Chicken thigh');await ef.locator('[data-f="temp"]').fill('84');await ef.locator('[data-ft-esave]').click();
 await page.locator('#ftMsg').filter({hasText:'QA Chicken thigh: change saved.'}).waitFor();
 assert.match(await page.locator('.ft-table tbody tr').filter({hasText:'QA Chicken thigh'}).innerText(),/Corrected by QA Floor Manager.*was: QA Chicken · 82.0°C/s);
 await page.screenshot({path:`tmp/qa/${size}-food-temps.png`,fullPage:true});
 // Yesterday: read only.
 await page.locator('#ftPrev').click();await page.locator('#ftList').filter({hasText:'No food temperatures this day.'}).waitFor();
 assert.equal(await page.locator('#ftForm').isVisible(),false,'no typing on past days');
 await page.locator('#ftToday').click();await page.locator('.ft-table').waitFor();
 // PDF.
 await page.locator('#ftPdf').click();await page.locator('#tempPdfDialog').waitFor({state:'visible'});
 assert.match(await page.locator('#saveTempPdf').getAttribute('download'),/^Marinara-Food-Temperatures-/);
 await savePdf(page,`${size}-food-temps.pdf`);await page.locator('#closeTempPdf').click();await page.locator('#tempPdfDialog').waitFor({state:'detached'});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'food: no sideways scroll');

 // ---------- Cleaning ----------
 await page.locator('#foodTempScreen .rm-back').click();await page.locator('#foodSafetyScreen').waitFor({state:'visible'});await page.locator('#fsMenu [data-rm-go="rmOpenCleaning"]').click();await page.locator('#cleanScreen').waitFor({state:'visible'});
 assert.equal(await page.locator('#foodTempScreen').isVisible(),false,'one screen at a time');
 await page.locator('#clSheet').filter({hasText:'Add your cleaning tasks'}).waitFor();
 await page.locator('#clUsual').click();
 await page.waitForFunction(()=>document.querySelectorAll('#clList [data-cl-remove]').length===16);
 assert.equal(await page.locator('#clUsual').isVisible(),false);
 assert.deepEqual((await page.locator('#clSheet .cl-groupcell').allInnerTexts()).map(x=>x.toUpperCase()),['EVERY DAY','ONCE A WEEK']);
 assert.equal(await page.locator('#clSheet thead th').count(),8,'Task, MON-SUN');
 assert.equal(await page.locator('#clSheet [data-cl-mark]').count(),16,'only today can be ticked');
 // Tick, by an employee.
 await page.locator('#clWho').selectOption({label:'QA Cook'});
 await page.locator('[data-cl-mark][aria-label="Benches and prep surfaces done today"]').click();
 await page.locator('#clMsg').filter({hasText:'Benches and prep surfaces: done.'}).waitFor();
 const on=page.locator('[data-cl-undo]').first();await on.waitFor();
 assert.match(await on.innerText(),/QC/,'initials of who did it');
 const mk=await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_clean_mark').at(-1)[1]);
 assert.equal(mk.done,true);assert.equal(mk.checked_by,'00000000-0000-4000-8000-0000000000aa');
 // Undo needs two taps.
 await on.click();assert.match(await page.locator('[data-cl-undo]').first().innerText(),/Undo\?/);
 await page.locator('[data-cl-undo]').first().click();
 await page.locator('#clMsg').filter({hasText:'tick removed'}).waitFor();
 assert.equal(await page.locator('[data-cl-undo]').count(),0);
 // A weekly task ticked shows "Done this week".
 await page.locator('[data-cl-mark][aria-label="Floor drains done today"]').click();
 await page.locator('#clSheet .cl-weekdone').waitFor();
 await page.locator('[data-cl-mark][aria-label="Kitchen floor done today"]').click();await page.locator('#clMsg').filter({hasText:'Kitchen floor: done.'}).waitFor();
 await page.screenshot({path:`tmp/qa/${size}-cleaning.png`,fullPage:true});
 // Last week: read only.
 await page.evaluate(()=>window.__seedYesterdayTick());
 await page.locator('#clPrev').click();await page.locator('#clThis').waitFor({state:'visible'});
 assert.equal(await page.locator('#clSheet [data-cl-mark]').count(),0,'past weeks read only');
 await page.locator('#clThis').click();await page.locator('#clThis').waitFor({state:'hidden'});
 // PDF.
 await page.locator('#clPdf').click();await page.locator('#tempPdfDialog').waitFor({state:'visible'});
 assert.match(await page.locator('#saveTempPdf').getAttribute('download'),/^Marinara-Cleaning-/);
 await savePdf(page,`${size}-cleaning.pdf`);await page.locator('#closeTempPdf').click();await page.locator('#tempPdfDialog').waitFor({state:'detached'});
 // Remove needs two taps.
 const rm=page.locator('#clList [data-cl-remove]').last();await rm.click();assert.match(await rm.innerText(),/Tap again/);await rm.click();
 await page.waitForFunction(()=>document.querySelectorAll('#clList [data-cl-remove]').length===15);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'cleaning: no sideways scroll');
 // Sign-out forgets it.
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('marinara:session-reset')));
 assert.equal(await page.locator('#clList').innerText(),'No tasks yet.');
 assert.deepEqual(errors,[]);
 await context.close();
}
console.log(`PASS (${ENGINE}): food temperatures (5 checks, out of range needs an action, checked by, cooling 2 h and 6 h with timing, correct today's reading, past days read only, PDF) and cleaning (usual list, tick with who, undo with two taps, weekly done, past weeks read only, PDF, remove), sign-out, no overflow, no JavaScript errors.`);
}finally{await browser.close();server.close();}
