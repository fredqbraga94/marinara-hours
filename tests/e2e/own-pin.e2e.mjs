// Own PIN screens: choose a PIN at first sign-in (forced), change it later from More,
// and the manager's one-time temporary PIN. Synthetic data; the server is replaced
// (the server itself is checked in tests/integration/own-pin.mjs).
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
  window.__sent=[];window.__rule='ok';
  postApi=async payload=>{window.__sent.push(payload);
   if(payload.action==='change_pin'){
    if(window.__rule==='wrong')return{response:{ok:false,status:400},result:{error:'The current PIN is not right.',code:'WRONG_OLD'}};
    return{response:{ok:true,status:200},result:{success:true}};}
   return{response:{ok:false,status:404},result:{}};};
  managerApi=async(action,extra)=>{window.__sent.push({action,...extra});if(action==='manager_staff_temp_pin')return{temporary_pin:'583920'};return{};};
 });
 // 1. Forced: choose own PIN at first sign-in.
 await page.evaluate(()=>{window.__result='pending';window.mhOwnPin.require('583920').then(()=>window.__result='done',e=>window.__result=e.message);});
 const dlg=page.locator('#ownPinDialog');await dlg.waitFor({state:'visible'});
 assert.equal(await page.locator('#opOldWrap').isVisible(),false,'no current PIN field when forced');
 await page.screenshot({path:`tmp/qa/${size}-own-pin-first.png`});
 // The 5-second background refresh runs while the person is thinking: the server answers
 // 403 PIN_CHANGE_REQUIRED and the dialog must stay open (this used to sign the person out).
 await page.evaluate(()=>{const was=postApi;window.__postBefore=was;postApi=async p=>{if(p.action==='change_pin')return was(p);window.__sent.push(p);return{response:{ok:false,status:403},result:{success:false,error:'Choose your own PIN to continue.',code:'PIN_CHANGE_REQUIRED'}};};});
 await page.evaluate(async()=>{await syncCurrentView();await syncCurrentView();});
 assert.equal(await dlg.isVisible(),true,'dialog stays open during background refresh');
 assert.equal(await page.evaluate(()=>currentSessionToken),'qa-token','session kept');
 await page.locator('#opNew').fill('12');await page.locator('#opNew2').fill('12');await page.locator('#opSave').click();
 assert.match(await page.locator('#opMsg').innerText(),/4 to 6 numbers/);
 await page.locator('#opNew').fill('482913');await page.locator('#opNew2').fill('482914');await page.locator('#opSave').click();
 assert.match(await page.locator('#opMsg').innerText(),/not the same/);
 await page.keyboard.press('Escape');assert.equal(await dlg.isVisible(),true,'cannot be dismissed with Escape when forced');
 await page.locator('#opNew2').fill('482913');await page.locator('#opSave').click();
 await page.waitForFunction(()=>window.__result==='done');
 // The refresh stub only belongs to the forced step: later background refreshes must not
 // keep answering PIN_CHANGE_REQUIRED (that reopened the forced dialog depending on timing).
 await page.evaluate(()=>{postApi=window.__postBefore;});
 const sent=await page.evaluate(()=>window.__sent.filter(s=>s.action==='change_pin'));
 assert.deepEqual(sent.map(s=>[s.old_pin,s.new_pin,s.token]),[['583920','482913','qa-token']]);
 assert.equal(await dlg.isVisible(),false);
 // Forced + cancel: rejects (signs out).
 await page.evaluate(()=>{window.__result='pending';window.mhOwnPin.require('583920').then(()=>window.__result='done',e=>window.__result=e.message);});
 await dlg.waitFor({state:'visible'});await page.locator('#opCancel').click();
 await page.waitForFunction(()=>/choose your own PIN/.test(window.__result));
 // 2. Later: More → Change my PIN.
 assert.equal(await page.locator('#managerMoreScreen [data-rm-go="rmOpenOwnPin"]').count(),1,'in More');
 await page.evaluate(()=>{window.mhOwnPin.change();});
 await dlg.waitFor({state:'visible'});assert.equal(await page.locator('#opOldWrap').isVisible(),true);
 await page.evaluate(()=>window.__rule='wrong');
 await page.locator('#opOld').fill('111111');await page.locator('#opNew').fill('482913');await page.locator('#opNew2').fill('482913');await page.locator('#opSave').click();
 await page.waitForFunction(()=>/current PIN is not right/.test(document.getElementById('opMsg').textContent));
 assert.equal(await dlg.isVisible(),true,'stays open on a wrong current PIN');
 await page.evaluate(()=>window.__rule='ok');
 await page.screenshot({path:`tmp/qa/${size}-own-pin-change.png`});
 await page.locator('#opSave').click();
 await page.waitForFunction(()=>/PIN was changed/.test(document.getElementById('opMsg').textContent));
 await dlg.waitFor({state:'hidden'});
 assert.equal(await page.locator('#opNew').inputValue(),'','fields cleared after closing');
 // 3. Manager: temporary PIN once.
 await page.evaluate(()=>{const p=document.createElement('div');p.className='team-edit-panel';p.id='qaPanel';p.style.cssText='position:fixed;top:80px;left:10px;z-index:99999;background:#fff';p.innerHTML='<div class="team-edit-message"></div><button type="button" class="btn team-temp-pin-btn" data-staff-id="30000000-0000-4000-8000-000000000001" data-staff-name="QA Person">Forgot PIN? Give a temporary PIN</button>';document.body.append(p);});
 const btn=page.locator('#qaPanel .team-temp-pin-btn');await btn.click();
 assert.match(await btn.innerText(),/Tap again/);
 assert.equal((await page.evaluate(()=>window.__sent.filter(s=>s.action==='manager_staff_temp_pin').length)),0,'first tap asks to confirm, nothing sent');
 await btn.click();
 await page.locator('#ownPinTemp').waitFor({state:'visible'});
 assert.equal(await page.locator('#otPin').innerText(),'583920');
 assert.match(await page.locator('#otFor').innerText(),/QA Person/);
 await page.screenshot({path:`tmp/qa/${size}-own-pin-temp.png`});
 await page.locator('#otDone').click();assert.equal(await page.locator('#otPin').innerText(),'','PIN erased from the screen after Done');
 // Overflow + errors.
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no sideways scroll');
 assert.deepEqual(errors,[]);
 await context.close();
}
console.log(`PASS (${ENGINE}): choose own PIN at first sign-in (cannot skip), change later with the current PIN, one-time temporary PIN, no overflow, no JavaScript errors.`);
}catch(e){if(process.env.GITHUB_ACTIONS)console.log(`::error title=own PIN e2e (${ENGINE})::${String(e?.stack||e).replace(/\r?\n/g,' | ').slice(0,1500)}`);throw e;}finally{await browser.close();server.close();}
