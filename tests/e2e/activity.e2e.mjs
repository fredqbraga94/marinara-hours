// Activity (who changed what): Administrator only, in More; period, person and
// area filters; grouped by day. Synthetic data; the server is replaced
// (checked in tests/integration/activity-log.mjs).
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
 for(const role of ['kitchen_manager','manager']){
  const context=await browser.newContext({...options,serviceWorkers:'block'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.route('https://**/*',route=>route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(role=>{
   currentManagerRole=role;currentSessionToken='qa-token';document.querySelector('#loginScreen').classList.add('hidden');showOnlyManagerScreen('managerScreen');setManagerHeader('Hawthorne');setManagerNavActive('home');
   const now=Date.now();const P={a:'00000000-0000-4000-8000-0000000000a1',b:'00000000-0000-4000-8000-0000000000b2'};
   const all=[
    {at:new Date(now-5*60e3).toISOString(),who_id:P.a,who:'QA Kitchen Manager',area:'Hours',what:'Edited a shift: QA Cook · Fri 30 Oct 10:00–15:30 (was Fri 30 Oct 10:00–15:00)'},
    {at:new Date(now-30*60e3).toISOString(),who_id:P.b,who:'QA Floor Manager',area:'Shopping',what:'Added to shopping: QA napkins (urgent)'},
    {at:new Date(now-26*3600e3).toISOString(),who_id:P.a,who:'QA Kitchen Manager',area:'Food safety',what:'Temperature QA Fridge · Opening: 3.0°C'}];
   window.__calls=[];
   const orig=managerApi;
   managerApi=async(action,extra={})=>{window.__calls.push([action,extra]);
    if(action==='manager_activity'){const items=all.filter(i=>!extra.who||i.who_id===extra.who);return{location:'Hawthorne',days:extra.days,people:[{id:P.a,name:'QA Kitchen Manager'},{id:P.b,name:'QA Floor Manager'}],items,more:false};}
    if(action==='manager_roster_week')return{team:[],entries:[],services:[],leave:[]};
    return orig(action,extra);};
   window.dispatchEvent(new CustomEvent('marinara:dashboard',{detail:{location:'Hawthorne',manager:{id:'qa',name:'QA'},counts:{unapproved_shifts:0},working:[],permissions:{}}}));
  },role);
  await page.locator('[data-manager-nav="more"]').click();await page.locator('#managerMoreScreen').waitFor({state:'visible'});
  const row=page.locator('#managerMoreScreen [data-rm-go="rmOpenActivity"]');
  if(role!=='manager'){
   assert.equal(await row.isVisible(),false,'not for Kitchen/Floor Managers');
   await page.evaluate(()=>document.getElementById('rmOpenActivity').click());
   assert.equal(await page.locator('#activityScreen').isVisible(),false);
   assert.equal(await page.evaluate(()=>window.__calls.some(c=>c[0]==='manager_activity')),false);
   assert.deepEqual(errors,[]);await context.close();continue;
  }
  await row.click();await page.locator('#activityScreen').waitFor({state:'visible'});
  await page.locator('.act-row').first().waitFor();
  assert.equal(await page.locator('.act-row').count(),3);
  assert.equal(await page.locator('[data-manager-nav="more"]').getAttribute('class').then(c=>/active/.test(c)),true,'More stays highlighted');
  assert.equal(await page.locator('#activityScreen .tmp-day').count(),2,'grouped by day');
  assert.match(await page.locator('.act-row').first().innerText(),/QA Kitchen Manager[\s\S]*HOURS[\s\S]*Edited a shift: QA Cook/i);
  // Person filter asks the server; area filter works on the list.
  await page.locator('#actWho').selectOption({label:'QA Floor Manager'});
  await page.waitForFunction(()=>document.querySelectorAll('.act-row').length===1);
  assert.equal(await page.evaluate(()=>window.__calls.at(-1)[1].who),'00000000-0000-4000-8000-0000000000b2');
  await page.locator('#actWho').selectOption('');await page.waitForFunction(()=>document.querySelectorAll('.act-row').length===3);
  await page.locator('#actArea').selectOption('Food safety');
  assert.equal(await page.locator('.act-row').count(),1);
  await page.locator('#actArea').selectOption('');
  await page.locator('#actDays').selectOption('30');
  await page.waitForFunction(()=>window.__calls.at(-1)[1].days===30);
  await page.screenshot({path:`tmp/qa/${size}-activity.png`,fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no sideways scroll');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('marinara:session-reset')));
  assert.equal(await page.locator('.act-row').count(),0,'sign-out forgets it');
  assert.deepEqual(errors,[]);
  await context.close();
 }
}
console.log(`PASS (${ENGINE}): activity for the Administrator only (hidden and blocked for Kitchen Manager), grouped by day, person/area/period filters, no overflow, sign-out, no JavaScript errors.`);
}finally{await browser.close();server.close();}
