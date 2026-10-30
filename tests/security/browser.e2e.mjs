// Real UI -> real Edge handler -> isolated PostgreSQL; iPhone viewport in Chromium.
// Does not claim to be native Safari or an installed iOS PWA.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
import {chromium,devices} from 'playwright';
import {isolatedDb} from './isolated-db.mjs';
import {loadHandler,useDatabase,call,settle} from '../integration/edge-loader.mjs';
import {ID,PIN,reseed} from '../integration/seed.mjs';
const db=await isolatedDb();await reseed(db);useDatabase(db.svc);
const handler=await loadHandler(resolve('supabase/functions/marinara-api-v2/Index.ts'));
const types={'.js':'text/javascript','.css':'text/css','.png':'image/png','.webmanifest':'application/manifest+json'};
const root=resolve('.');
const server=createServer((req,res)=>{try{const path=decodeURIComponent(new URL(req.url,'http://local').pathname);const file=resolve(root,'.'+(path==='/'?'/index.html':path));if(!file.startsWith(root+'/'))throw Error();res.setHeader('Content-Type',types[extname(file)]||'text/html');res.end(readFileSync(file));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
try {
 const context=await browser.newContext({...devices['iPhone 13']});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request();if(req.url().startsWith(origin))return route.continue();
  if(!req.url().includes('/functions/v1/marinara-api-v2'))return route.abort();
  const headers={'access-control-allow-origin':origin,'access-control-allow-headers':'authorization,apikey,content-type'};
  if(req.method()==='OPTIONS')return route.fulfill({status:200,headers});
  const r=await call(handler,JSON.parse(req.postData()||'{}'));
  return route.fulfill({status:r.status,headers,contentType:'application/json',body:JSON.stringify(r.body)});
 });
 await page.goto(origin);
 async function login(n,home){await page.fill('#pinInput',PIN[ID(n)]);await page.click('#loginBtn');await page.locator(home).waitFor({state:'visible'});}
 await login(4,'#homeScreen');
 for(const [selector,action] of [['#clockInBtn','session_clock_in'],['#startBreakBtn','session_start_break'],['#endBreakBtn','session_end_break'],['#clockOutBtn','session_clock_out']]){
  const result=page.waitForResponse(r=>{try{return r.request().postDataJSON()?.action===action;}catch{return false;}});
  await page.locator(selector).click();const r=await result;assert.equal(r.status(),200,action);
  await page.waitForFunction(()=>!document.querySelector('#actionMessage')?.textContent.includes('Saving'));
 }
 await page.evaluate(()=>signOutAll());await page.locator('#loginScreen').waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('marinara_session_token')),null);
 await login(1,'#managerScreen');await page.reload();await page.locator('#managerScreen').waitFor({state:'visible'});
 // Seed the old cache with synthetic private data, then activate the production push worker.
 await page.evaluate(async()=>{
  await(await caches.open('marinara-hours-shell-v1')).put('/synthetic-private',new Response('synthetic-private'));
  await caches.open('another-app-cache');
  const reg=await navigator.serviceWorker.register('./push-sw.js',{scope:'./'});
  await navigator.serviceWorker.ready;
  if(!reg.active)await new Promise(resolve=>reg.installing.addEventListener('statechange',()=>{if(reg.active)resolve();}));
 });
 await page.waitForFunction(async()=>!(await caches.keys()).includes('marinara-hours-shell-v1'));
 assert.ok((await page.evaluate(()=>caches.keys())).includes('another-app-cache'));
 await page.evaluate(()=>signOutAll());
 assert.equal(await page.locator('#managerScreen').isVisible(),false);
 assert.equal(await page.locator('#homeScreen').isVisible(),false);
 assert.equal(await page.locator('#loginScreen').isVisible(),true);
 assert.deepEqual(errors,[]);
 console.log('PASS: Chromium/iPhone viewport, employee + manager login, real SQL clock/break flow, session restore, logout privacy, PWA worker activation and legacy-cache cleanup; zero page errors.');
 await context.close();
}finally{await browser.close();server.close();await settle();await db.close();}
