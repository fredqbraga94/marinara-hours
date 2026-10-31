// Temperatures: add equipment, daily checks (out of range needs an action),
// deliveries, Home "checks to do", the 90-day records and print. Synthetic data;
// the server is replaced (checked in tests/integration/temp-log.mjs).
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
  const eq=[],logs=[];let n=0;const id=()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;
  const ok=(f,v)=>f==='fridge'||f==='chilled'?v<=5:f==='freezer'||f==='frozen'?v<=-15:v>=60;
  const json=l=>({...l,equipment:(eq.find(e=>e.id===l.equipment_id)||{}).name||null});
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Brisbane'}).format(new Date());
  const add=(iso,k)=>{const d=new Date(`${iso}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+k);return d.toISOString().slice(0,10);};
  const monday=iso=>add(iso,-((new Date(`${iso}T00:00:00Z`).getUTCDay()+6)%7));
  window.__seedPast=()=>{const e=eq[0];logs.push({id:id(),kind:'equipment',equipment_id:e.id,slot:'closing',day:add(monday(today),-3),food:e.kind,temp:9,ok:false,action:'QA moved stock',recorded_at:new Date(Date.now()-5*864e5).toISOString(),recorded_by:'QA Past Manager'});};
  window.__printed=0;window.print=()=>{window.__printed++;};
  window.__calls=[];
  const orig=managerApi;
  managerApi=async(action,extra={})=>{
   window.__calls.push([action,JSON.parse(JSON.stringify(extra))]);
   if(action==='manager_temp_today'){const act=eq.filter(e=>e.active);const last=(e,s)=>{const l=logs.filter(x=>x.equipment_id===e.id&&x.day===today&&x.slot===s).at(-1);return l?json(l):null;};
    return{day:today,people:[{id:'00000000-0000-4000-8000-0000000000aa',name:'QA Cook'}],equipment:act.map(e=>({id:e.id,name:e.name,kind:e.kind,opening:last(e,'opening'),closing:last(e,'closing')})),missing:act.filter(e=>!last(e,'opening')).length,today:logs.filter(x=>x.day===today).reverse().map(json)};}
   if(action==='manager_temp_week'){const start=monday(extra.start||today);const end=add(start,6);const inWeek=logs.filter(l=>l.kind==='equipment'&&l.day>=start&&l.day<=end);
    const m=new Map();for(const l of inWeek)m.set(`${l.equipment_id}|${l.day}|${l.slot}`,json(l));
    return{start,today,location:'Hawthorne',equipment:eq.filter(e=>e.active||inWeek.some(l=>l.equipment_id===e.id)),cells:[...m.values()]};}
   if(action==='manager_temp_equipment_save'){const it=extra.item;if(it.id){const e=eq.find(x=>x.id===it.id);e.active=it.active!==false;return{equipment:e};}const e={id:id(),name:it.name,kind:it.kind,active:true};eq.push(e);return{equipment:e};}
   if(action==='manager_temp_record'){if(window.__slow)await new Promise(r=>setTimeout(r,window.__slow));const x=extra.entry;const e=eq.find(q=>q.id===x.equipment_id);const food=x.kind==='equipment'?e.kind:x.food;const good=ok(food,x.temp);
    if(x.kind==='equipment'&&!['opening','closing'].includes(x.slot))throw new Error('Choose opening or closing.');
    if(!good&&!x.action){const er=new Error('The temperature is outside the safe range. Write what you did about it.');throw er;}
    const l={id:id(),kind:x.kind,equipment_id:x.equipment_id||null,slot:x.kind==='equipment'?x.slot:null,day:today,item:x.item||null,supplier:x.supplier||null,food,temp:x.temp,ok:good,action:x.action||null,recorded_at:new Date().toISOString(),recorded_by:'QA Kitchen Manager',checked_by:x.checked_by?'QA Cook':'QA Kitchen Manager',checked_by_id:x.checked_by||'me'};logs.push(l);return{record:json(l)};}
   if(action==='manager_temp_delivery_edit'){const l=logs.find(x=>x.id===extra.id&&x.kind==='receiving');if(!l)throw new Error('Item not found');const e=extra.entry;const good=ok(e.food,e.temp);if(!good&&!e.action)throw new Error('The temperature is outside the safe range. Write what you did about it.');
    if(!l.original)l.original={item:l.item,supplier:l.supplier,food:l.food,temp:l.temp,action:l.action};Object.assign(l,{item:e.item,supplier:e.supplier||null,food:e.food,temp:e.temp,ok:good,action:e.action||null,edited_at:new Date().toISOString(),edited_by:'QA Floor Manager'});return{record:json(l)};}
   if(action==='manager_temp_history')return{days:90,location:'Hawthorne',records:logs.slice().reverse().map(json)};
   if(action==='manager_roster_week')return{team:[],entries:[],services:[],leave:[]};
   return orig(action,extra);};
 });
 await page.locator('[data-manager-nav="operations"]').click();await page.locator('#operationsScreen').waitFor({state:'visible'});
 assert.equal(await page.locator('#managerMoreScreen [data-rm-go="rmOpenFoodSafety"]').count(),1,'Food Safety in More');assert.equal(await page.locator('#managerMoreScreen [data-rm-go="rmOpenTemps"]').count(),0,'inside Food Safety');
 // A tap on the reminder notification (?open=temps) opens Temperatures.
 await page.evaluate(()=>{pendingOpenScreen='temps';openPendingScreen();});await page.locator('#tempScreen').waitFor({state:'visible'});
 await page.locator('[data-manager-nav="operations"]').click();await page.locator('#operationsScreen').waitFor({state:'visible'});
 await page.locator('#operationsScreen [data-rm-go="rmOpenFoodSafety"]').click();await page.locator('#foodSafetyScreen').waitFor({state:'visible'});assert.equal(await page.locator('#fsMenu .rm-row').count(),4,'four council records');await page.locator('#fsMenu [data-rm-go="rmOpenTemps"]').click();await page.locator('#tempScreen').waitFor({state:'visible'});
 await page.locator('#tmpSheet').filter({hasText:'Add your fridges'}).waitFor();
 // The 7 from the paper sheet in one tap.
 await page.locator('#tmpSheetAdd').click();
 await page.waitForFunction(()=>document.querySelectorAll('#tmpSheet tbody tr').length===14);
 assert.equal(await page.locator('#tmpSheet thead th').count(),9,'Equipment, Time, MON-SUN');
 assert.deepEqual((await page.locator('#tmpSheet thead th').allInnerTexts()).slice(2).map(x=>x.split('\n')[0]),['MON','TUE','WED','THU','FRI','SAT','SUN']);
 assert.equal(await page.locator('#tmpSheet thead th.tmp-today').count(),1,'today highlighted');
 assert.equal(await page.locator('#tmpSheet [data-tmp-cell]').count(),14,'only today can be typed');
 assert.equal(await page.locator('#tmpSheetAdd').isVisible(),false);
 // Home shows the opening checks to do.
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('marinara:dashboard',{detail:{location:'Hawthorne',manager:{id:'qa',name:'QA Kitchen Manager'},counts:{unapproved_shifts:0},working:[],permissions:{}}})));
 await page.waitForFunction(()=>/temperature checks to do today/.test(document.getElementById('rmAttention').innerText));
 assert.match(await page.locator('#rmAttention').innerText(),/7 temperature checks to do today/);
 // In range: Pizza Prep Fridge, Opening.
 const cell=(name,slot)=>page.locator(`[data-tmp-cell][aria-label="${name} ${slot} today °C"]`);
 await page.evaluate(()=>{window.__slow=250;});await cell('Pizza Prep Fridge','Opening').fill('3.5');
 // Tap the next box straight away: it keeps the focus (the iPhone keyboard stays) while the first one saves.
 await cell('Pasta Prep Fridge','Opening').evaluate(el=>{window.__next=el;});await cell('Pasta Prep Fridge','Opening').click();
 await page.locator('#tmpEqMsg').filter({hasText:'Pizza Prep Fridge · Opening: 3.5°C saved.'}).waitFor();
 await page.locator('#tmpSheet .tmp-val').filter({hasText:'3.5'}).waitFor();
 assert.equal(await page.evaluate(()=>document.activeElement===window.__next&&document.contains(window.__next)),true,'the box tapped next keeps the focus');
 await page.evaluate(()=>{document.activeElement.blur();window.__slow=0;});
 const rec=await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_temp_record').at(-1)[1].entry);
 assert.equal(rec.slot,'opening');assert.equal(rec.temp,3.5);
 await page.locator('#tmpSheet .tmp-val').filter({hasText:'3.5'}).waitFor();
 assert.match(await page.locator('#tmpSheet .tmp-val').first().innerText(),/QKM/,'initials of who checked');
 // Checked by an employee: their initials on the sheet, the manager as who typed it.
 await page.locator('#tmpWho').selectOption({label:'QA Cook'});
 await cell('Bar Fridge','Opening').fill('2');await cell('Bar Fridge','Opening').press('Enter');
 await page.locator('#tmpEqMsg').filter({hasText:'Bar Fridge · Opening: 2.0°C saved.'}).waitFor();
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_temp_record').at(-1)[1].entry.checked_by),'00000000-0000-4000-8000-0000000000aa');
 assert.equal(await page.locator('#tmpWho').inputValue(),'00000000-0000-4000-8000-0000000000aa','choice kept');
 await page.locator('#tmpSheet .tmp-val').filter({hasText:'QC'}).click();
 assert.match(await page.locator('#tmpDetail').innerText(),/by QA Cook \(typed by QA Kitchen Manager\)/);
 await page.locator('#tmpWho').selectOption('');
 // Out of range: Freezer Closing -10 needs an action first.
 await cell('Freezer','Closing').fill('-10');await cell('Freezer','Closing').press('Enter');
 await page.locator('#tmpPending').waitFor({state:'visible'});
 assert.match(await page.locator('#tmpPending').innerText(),/Freezer · Closing: -10\.0°C is outside the safe range/);
 await page.screenshot({path:`tmp/qa/${size}-temps-action.png`});
 await page.locator('#tmpPendSave').click();assert.match(await page.locator('#tmpEqMsg').innerText(),/Write what you did/);
 await page.locator('#tmpPendAction').fill('Door left open; closed it, checked again in 30 min');await page.locator('#tmpPendSave').click();
 await page.locator('#tmpSheet td.bad .tmp-val').waitFor();
 assert.equal(await page.locator('#tmpPending').isVisible(),false);
 assert.match(await page.locator('#tmpNotes').innerText(),/Freezer · Closing[\s\S]*Door left open/);
 assert.match(await page.locator('#rmAttention').innerText(),/5 temperature checks to do today/);
 // Tap a reading: who and when; check again replaces it.
 await page.locator('#tmpSheet .tmp-val').filter({hasText:'3.5'}).click();
 assert.match(await page.locator('#tmpDetail').innerText(),/Pizza Prep Fridge · Opening[^\n]*3\.5°C at [^\n]* by QA Kitchen Manager/);
 await page.locator('[data-tmp-recheck]').click();
 await cell('Pizza Prep Fridge','Opening').fill('4');await cell('Pizza Prep Fridge','Opening').press('Enter');
 await page.locator('#tmpSheet .tmp-val').filter({hasText:'4.0'}).waitFor();
 assert.equal(await page.locator('#tmpSheet .tmp-val').filter({hasText:'3.5'}).count(),0);
 // iPhone number keypad has no minus: a freezer reading without it asks.
 await cell('Freezer','Opening').fill('18');await cell('Freezer','Opening').press('Enter');
 await page.locator('#tmpSignNeg').waitFor();assert.match(await page.locator('#tmpPending').innerText(),/Freezer · Opening: did you mean minus\?/);
 await page.locator('#tmpSignNeg').click();
 await page.locator('#tmpEqMsg').filter({hasText:'Freezer · Opening: -18.0°C saved.'}).waitFor();
 assert.equal(await page.locator('#tmpPending').isVisible(),false);
 // Print the week like the paper sheet.
 await page.locator('#tmpPrintWeek').click();
 await page.locator('#tempPdfDialog').waitFor({state:'visible'});
 {const b64=await page.evaluate(async()=>{const r=await fetch(document.getElementById('saveTempPdf').href);const a=new Uint8Array(await r.arrayBuffer());let s='';for(const x of a)s+=String.fromCharCode(x);return btoa(s);});const buf=Buffer.from(b64,'base64');assert.equal(buf.subarray(0,5).toString(),'%PDF-');writeFileSync(`tmp/qa/${size}-temps-week.pdf`,buf);}
 assert.equal(await page.evaluate(()=>window.__printed),0,'no window.print');
 await page.locator('#closeTempPdf').click();await page.locator('#tempPdfDialog').waitFor({state:'detached'});


 // Last week: read only, shows the earlier reading.
 await page.evaluate(()=>window.__seedPast());
 await page.locator('#tmpPrev').click();
 await page.locator('#tmpSheet .tmp-val').filter({hasText:'9.0'}).waitFor();
 assert.equal(await page.locator('#tmpSheet [data-tmp-cell]').count(),0,'past week cannot be typed');
 assert.match(await page.locator('#tmpNotes').innerText(),/QA moved stock/);
 assert.equal(await page.locator('#tmpThis').isVisible(),true);
 await page.locator('#tmpThis').click();await page.locator('#tmpSheet [data-tmp-cell]').first().waitFor();
 await page.screenshot({path:`tmp/qa/${size}-temps-sheet.png`});
 await page.waitForFunction(()=>{const w=document.getElementById('tmpSheetWrap'),th=w.querySelector('th.tmp-today'),r=th.getBoundingClientRect(),b=w.getBoundingClientRect();return r.right<=b.right+1&&r.left>=b.left;});
 // Deliveries: own screen; out of range needs an action; ± for the minus sign.
 assert.equal(await page.locator('#tempScreen #tmpDelivery').count(),0,'not on the temperature sheet');
 await page.locator('[data-manager-nav="operations"]').click();await page.locator('#operationsScreen').waitFor({state:'visible'});
 await page.locator('#operationsScreen [data-rm-go="rmOpenFoodSafety"]').click();await page.locator('#fsMenu [data-rm-go="rmOpenDeliveries"]').click();await page.locator('#deliveryScreen').waitFor({state:'visible'});
 await page.locator('#tmpDList').filter({hasText:'No deliveries in the last 7 days'}).waitFor();
 await page.locator('#tmpItem').fill('QA prawns');await page.locator('#tmpFood').selectOption('frozen');await page.locator('#tmpDTemp').fill('8');await page.locator('#deliveryScreen [data-tmp-sign="tmpDTemp"]').click();assert.equal(await page.locator('#tmpDTemp').inputValue(),'-8');
 assert.equal(await page.locator('#tmpDAction').isVisible(),true,'action field appears');
 await page.locator('#tmpDSave').click();assert.match(await page.locator('#tmpDMsg').innerText(),/Outside the safe range/);
 await page.locator('#tmpDAction').fill('Rejected, sent back with the driver');await page.locator('#tmpDSave').click();
 await page.locator('#tmpDMsg').filter({hasText:'QA prawns: -8.0°C saved.'}).waitFor();
 await page.locator('#tmpItem').fill('QA cream');await page.locator('#tmpSupplier').fill('QA Moço');await page.locator('#tmpFood').selectOption('chilled');await page.locator('#tmpDTemp').fill('3.5');await page.locator('#tmpDSave').click();
 await page.locator('#tmpDMsg').filter({hasText:'QA cream: 3.5°C saved.'}).waitFor();
 assert.equal(await page.locator('#tmpDList .tmp-rec').count(),2);
 assert.equal(await page.locator('#tmpSupList option').count(),1,'suppliers suggested');
 // Edit fixes a typo; the first values stay on record.
 await page.locator('#tmpDList .tmp-rec').filter({hasText:'QA cream'}).locator('[data-tmp-dedit]').click();
 const form=page.locator('[data-tmp-dform]');await form.locator('[data-f="supplier"]').fill('QA Moco');await form.locator('[data-tmp-dsave]').click();
 await page.locator('#tmpDMsg').filter({hasText:'QA cream: change saved.'}).waitFor();
 const creamRow=page.locator('#tmpDList .tmp-rec').filter({hasText:'QA cream'});
 assert.match(await creamRow.innerText(),/QA cream · QA Moco[\s\S]*Corrected by QA Floor Manager[\s\S]*was: QA cream · QA Moço/);
 const ed=await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_temp_delivery_edit').at(-1)[1]);
 assert.equal(ed.entry.supplier,'QA Moco');assert.equal(ed.entry.temp,3.5);
 // Edit to out of range needs the action.
 await creamRow.locator('[data-tmp-dedit]').click();await form.locator('[data-f="temp"]').fill('9');await form.locator('[data-tmp-dsave]').click();
 assert.match(await page.locator('#tmpDMsg').innerText(),/Outside the safe range/);await page.locator('[data-tmp-dcancel]').click();
 await page.screenshot({path:`tmp/qa/${size}-deliveries.png`,fullPage:true});
 await page.locator('#tmpDPdf').click();await page.locator('#tempPdfDialog').waitFor({state:'visible'});await page.locator('#closeTempPdf').click();
 await page.locator('[data-manager-nav="operations"]').click();await page.locator('#operationsScreen [data-rm-go="rmOpenFoodSafety"]').click();await page.locator('#fsMenu [data-rm-go="rmOpenTemps"]').click();await page.locator('#tempScreen').waitFor({state:'visible'});
 // Records and print.
 await page.locator('#tmpHistBtn').click();await page.locator('#tmpRecords').waitFor({state:'visible'});
 assert.match(await page.locator('#tmpRecHead').innerText(),/Hawthorne · last 90 days · 8 records/);
 await page.locator('#tmpPrint').click();
 await page.locator('#tempPdfDialog').waitFor({state:'visible'});
 {const b64=await page.evaluate(async()=>{const r=await fetch(document.getElementById('saveTempPdf').href);const a=new Uint8Array(await r.arrayBuffer());let s='';for(const x of a)s+=String.fromCharCode(x);return btoa(s);});const buf=Buffer.from(b64,'base64');assert.equal(buf.subarray(0,5).toString(),'%PDF-');writeFileSync(`tmp/qa/${size}-temps-records.pdf`,buf);}
 assert.equal(await page.evaluate(()=>window.__printed),0,'no window.print');
 await page.locator('#closeTempPdf').click();await page.locator('#tempPdfDialog').waitFor({state:'detached'});
 await page.screenshot({path:`tmp/qa/${size}-temps.png`,fullPage:true});
 // Remove needs two taps; records stay.
 const rm=page.locator('#tmpList [data-tmp-remove]').first();await rm.click();assert.match(await rm.innerText(),/Tap again/);await rm.click();
 await page.waitForFunction(()=>document.querySelectorAll('#tmpList [data-tmp-remove]').length===6);
 // Sign-out forgets it.
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('marinara:session-reset')));
 assert.equal(await page.locator('#tmpRecords').isVisible(),false);

 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no sideways scroll');
 assert.deepEqual(errors,[]);
 await context.close();
}
console.log(`PASS (${ENGINE}): temperatures: equipment, weekly sheet Opening/Closing × MON–SUN (only today typed, action required out of range, check again, past week read only, week PDF), deliveries on their own screen (edit keeps the first values, supplier suggestions, PDF), Home row, 90-day records, PDF (share or open), remove, sign-out, no overflow, no JavaScript errors.`);
}finally{await browser.close();server.close();}
