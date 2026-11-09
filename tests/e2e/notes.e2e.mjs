// Notes: Home card and Operations row; a Kitchen Manager sees only Kitchen
// notes (no switch, even if the phone remembers Floor); the Administrator
// switches Kitchen / Floor; add (keeps line breaks), pin, edit, remove (two
// taps), sign-out. Synthetic data; the server is replaced (checked in
// tests/integration/notes.mjs).
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
const stub=(role)=>{
 currentManagerRole=role;currentSessionToken='qa-token';document.querySelector('#loginScreen').classList.add('hidden');showOnlyManagerScreen('managerScreen');setManagerHeader('Hawthorne');setManagerNavActive('home');
 const notes=[];let n=0;const id=()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;
 const scope=role==='kitchen_manager'?'Kitchen':role==='floor_manager'?'Floor':null;
 window.__calls=[];const orig=managerApi;
 managerApi=async(action,extra={})=>{window.__calls.push([action,JSON.parse(JSON.stringify(extra))]);
  if(action==='manager_note_list'){if(scope&&extra.department&&extra.department!==scope)throw new Error('Access denied for this department');
   const dep=scope||extra.department||'Floor';
   return{location:'Hawthorne',department:dep,can_choose_department:!scope,notes:notes.filter(x=>x.department===dep).sort((a,b)=>(b.pinned-a.pinned)||(b.t-a.t))};}
  if(action==='manager_note_save'){const x=extra.note;if(scope&&x.department!==scope)throw new Error('Access denied for this department');
   if(x.id){const o=notes.find(y=>y.id===x.id);Object.assign(o,{body:x.body,pinned:!!x.pinned,updated_at:new Date().toISOString(),updated_by:'QA',t:++n});return{note:o};}
   const o={id:id(),department:x.department,body:x.body,pinned:!!x.pinned,created_at:new Date().toISOString(),created_by:'QA',t:++n};notes.push(o);return{note:o};}
  if(action==='manager_note_remove'){notes.splice(notes.findIndex(y=>y.id===extra.id),1);return{removed:true};}
  if(action==='manager_roster_week')return{team:[],entries:[],services:[],leave:[]};
  return orig(action,extra);};
};
try{
for(const [size,options] of [['iphone',devices['iPhone 13']],['desktop',{viewport:{width:1440,height:1000}}]]){
 const context=await browser.newContext({...options,serviceWorkers:'block'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.route('https://**/*',route=>route.abort());
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 // Kitchen Manager, on a phone that remembers "Floor" from the Administrator.
 await page.evaluate(()=>{try{localStorage.setItem('mh-notes-dept','Floor');}catch(_){}});
 await page.evaluate(stub,'kitchen_manager');
 assert.equal(await page.locator('#rmModules [data-rm-go="rmOpenNotes"]').count(),1,'card on Home');
 assert.deepEqual((await page.locator('#rmModules > [data-rm-go]').evaluateAll(es=>es.map(e=>e.dataset.rmGo))).slice(-2),['rmOpenNotes','rmOpenFoodSafety'],'Food Safety next to Notes on Home');
 await page.locator('#rmModules [data-rm-go="rmOpenFoodSafety"]').click();await page.locator('#foodSafetyScreen').waitFor({state:'visible'});await page.locator('[data-manager-nav="home"]').click();
 await page.locator('[data-manager-nav="operations"]').click();await page.locator('#operationsScreen').waitFor({state:'visible'});
 await page.locator('#operationsScreen [data-rm-go="rmOpenNotes"]').click();await page.locator('#notesScreen').waitFor({state:'visible'});
 await page.locator('#noteList').filter({hasText:'No Kitchen notes yet.'}).waitFor();
 assert.equal(await page.locator('#noteDept').isVisible(),false,'no switch for the Kitchen Manager');
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_note_list').every(c=>!c[1].department)),true,'never asks for Floor');
 assert.match(await page.locator('#noteSub').innerText(),/Kitchen notes · seen by the Kitchen Manager and the Administrator/);
 await page.locator('#noteSave').click();await page.locator('#noteMsg').filter({hasText:'Write the note first.'}).waitFor();
 await page.locator('#noteBody').fill('QA clean the fryer\nThursday');await page.locator('#noteSave').click();
 await page.locator('#noteMsg').filter({hasText:'Note added.'}).waitFor();
 await page.locator('#noteBody').fill('QA order gas');await page.locator('#noteSave').click();
 await page.waitForFunction(()=>document.querySelectorAll('.note-item').length===2);
 assert.deepEqual(await page.locator('.note-item .note-body').allInnerTexts(),['QA order gas','QA clean the fryer\nThursday'],'newest first, line breaks kept');
 // Pin the older one: it goes to the top.
 const fryer=page.locator('.note-item').filter({hasText:'QA clean the fryer'});
 await fryer.locator('[data-note-pin]').click();
 await page.waitForFunction(()=>document.querySelector('.note-item .note-body')?.textContent.startsWith('QA clean the fryer'));
 assert.equal(await page.locator('.note-item.pinned').count(),1);
 assert.equal(await fryer.locator('[data-note-pin]').innerText(),'Unpin');
 // Edit.
 await fryer.locator('[data-note-edit]').click();
 assert.equal(await page.locator('#noteSave').innerText(),'Save changes');
 assert.equal(await page.locator('#notePinned').isChecked(),true);
 await page.locator('#noteBody').fill('QA clean the fryer Friday');await page.locator('#noteSave').click();
 await page.locator('#noteMsg').filter({hasText:'Note saved.'}).waitFor();
 await page.locator('.note-item').filter({hasText:'QA clean the fryer Friday'}).filter({hasText:'Edited by QA'}).waitFor();
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_note_save').every(c=>c[1].note.department==='Kitchen')),true);
 await page.screenshot({path:`tmp/qa/${size}-notes.png`,fullPage:true});
 // Home: the pinned note is in Needs attention; tapping it opens Notes.
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('marinara:dashboard',{detail:{location:'Hawthorne',manager:{id:'qa-km',name:'QA'},counts:{unapproved_shifts:0},working:[],permissions:{}}})));
 await page.locator('[data-manager-nav="home"]').click();await page.locator('#managerScreen').waitFor({state:'visible'});
 const att=page.locator('#rmAttention [data-rm-go="rmOpenNotesKitchen"]');
 await att.waitFor();
 assert.match(await att.innerText(),/QA clean the fryer Friday[\s\S]*Pinned note · Kitchen/);
 assert.equal(await page.locator('#rmAttention').filter({hasText:'QA order gas'}).count(),0,'only pinned notes');
 await page.locator('#rmAttention').screenshot({path:`tmp/qa/${size}-home-notes.png`});
 await att.click();await page.locator('#notesScreen').waitFor({state:'visible'});
 await page.locator('.note-item').filter({hasText:'QA order gas'}).waitFor();
 // Unpin: it leaves Needs attention.
 await page.locator('.note-item').filter({hasText:'QA clean the fryer Friday'}).locator('[data-note-pin]').click();
 await page.waitForFunction(()=>(window.mhNotes?.pinned||[]).length===0);
 assert.equal(await page.locator('#rmAttention [data-rm-go^="rmOpenNotes"]').count(),0,'gone from Home once unpinned');
 // Remove (two taps).
 const gas=page.locator('.note-item').filter({hasText:'QA order gas'});
 await gas.locator('[data-note-remove]').click();assert.match(await gas.locator('[data-note-remove]').innerText(),/Tap again/);
 await gas.locator('[data-note-remove]').click();
 await page.locator('#noteMsg').filter({hasText:'Note removed.'}).waitFor();
 await page.waitForFunction(()=>document.querySelectorAll('.note-item').length===1);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no sideways scroll');
 // Sign-out forgets it; the Administrator can switch.
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('marinara:session-reset')));
 assert.equal(await page.locator('.note-item').count(),0,'sign-out forgets it');
 await page.evaluate(()=>{try{localStorage.setItem('mh-notes-dept','Kitchen');}catch(_){}});
 await page.evaluate(stub,'manager');
 await page.locator('#rmModules [data-rm-go="rmOpenNotes"]').click();await page.locator('#notesScreen').waitFor({state:'visible'});
 await page.locator('#noteList').filter({hasText:'No Kitchen notes yet.'}).waitFor();
 assert.equal(await page.locator('#noteDept').isVisible(),true,'switch for the Administrator');
 assert.equal(await page.locator('#noteDept [data-note-dept="Kitchen"]').evaluate(b=>b.classList.contains('selected')),true,'remembers Kitchen');
 await page.locator('#noteBody').fill('QA kitchen from admin');await page.locator('#noteSave').click();
 await page.locator('.note-item').filter({hasText:'QA kitchen from admin'}).waitFor();
 await page.locator('#noteDept [data-note-dept="Floor"]').click();
 await page.locator('#noteList').filter({hasText:'No Floor notes yet.'}).waitFor();
 await page.locator('#noteBody').fill('QA table 4');await page.locator('#notePinned').check();await page.locator('#noteSave').click();
 await page.locator('.note-item').filter({hasText:'QA table 4'}).waitFor();
 assert.equal(await page.locator('.note-item').count(),1,'Floor list only');
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c[0]==='manager_note_save').at(-1)[1].note.department),'Floor');
 assert.equal(await page.evaluate(()=>localStorage.getItem('mh-notes-dept')),'Floor');
 // The Administrator's Needs attention has the pinned notes of both lists.
 await page.locator('#noteDept [data-note-dept="Kitchen"]').click();await page.locator('.note-item').filter({hasText:'QA kitchen from admin'}).locator('[data-note-pin]').click();
 await page.waitForFunction(()=>(window.mhNotes?.pinned||[]).length===2);
 assert.deepEqual(await page.evaluate(()=>window.mhNotes.pinned.map(n=>n.department+': '+n.body)),['Kitchen: QA kitchen from admin','Floor: QA table 4']);
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('marinara:dashboard',{detail:{location:'Hawthorne',manager:{id:'qa-admin',name:'QA'},counts:{unapproved_shifts:0},working:[],permissions:{}}})));
 await page.locator('[data-manager-nav="home"]').click();
 await page.locator('#rmAttention [data-rm-go="rmOpenNotesFloor"]').click();await page.locator('#notesScreen').waitFor({state:'visible'});
 await page.locator('#noteList').filter({hasText:'QA table 4'}).waitFor();
 assert.equal(await page.locator('#noteDept [data-note-dept="Floor"]').evaluate(b=>b.classList.contains('selected')),true,'opens the Floor list');
 assert.deepEqual(errors,[]);
 await context.close();
}
console.log(`PASS (${ENGINE}): notes: Home card and Operations row, Kitchen Manager only Kitchen (no switch, never asks for Floor), add with line breaks, pin to top, pinned note in Needs attention (opens Notes; leaves when unpinned), edit, remove (two taps), Administrator switches Kitchen/Floor and the phone remembers it, no overflow, sign-out, no JavaScript errors.`);
}finally{await browser.close();server.close();}
