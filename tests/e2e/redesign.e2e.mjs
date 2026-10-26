import {createServer} from 'node:http';
import {readFileSync,mkdirSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
import {chromium,devices} from 'playwright';
const server=createServer((req,res)=>{try{const p=resolve('.'+(req.url==='/'?'/index.html':req.url.split('?')[0]));res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.png':'image/png'})[extname(p)]||'text/html');res.end(readFileSync(p));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch();
try{
for(const [size,options] of [['iphone',devices['iPhone 13']],['desktop',{viewport:{width:1440,height:1000}}]]){
 const context=await browser.newContext({...options,serviceWorkers:'block'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.route('https://**/*',route=>route.abort());
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(()=>{currentManagerRole='manager';sessionStorage.setItem('marinara_staff_identity',JSON.stringify({name:'QA Manager',role:'manager'}));document.querySelector('#loginScreen').classList.add('hidden');showOnlyManagerScreen('managerScreen');setManagerHeader('Hawthorne');setManagerNavActive('home');});
 assert.deepEqual(await page.locator('#managerBottomNav > [data-manager-nav]').evaluateAll(es=>es.map(e=>e.dataset.managerNav)),['home','finance','operations','team','more']);
 assert.equal(await page.locator('#managerBottomNav > button:visible').count(),5,'exactly five visible navigation buttons');
 await page.locator('[data-manager-nav="operations"]').click();await page.locator('#operationsScreen').waitFor({state:'visible'});
 await page.getByRole('button',{name:'Roster Plan and manage shifts'}).click();await page.locator('#rosterScreen').waitFor({state:'visible'});
 await page.locator('[data-manager-nav="more"]').click();await page.locator('#managerMoreScreen').waitFor({state:'visible'});
 assert.equal(await page.locator('#rosterScreen').isVisible(),false);
 await page.locator('[data-manager-nav="home"]').click();await page.locator('#managerScreen').waitFor({state:'visible'});
 await page.locator('#quickActionsBtn').click();await page.locator('#quickActionsDialog').waitFor({state:'visible'});await page.keyboard.press('Escape');
 assert.equal(await page.locator('#quickActionsDialog').isVisible(),false);
 await page.evaluate(()=>document.querySelector('#managerMessage').textContent='QA: network blocked; no live staff data.');
 mkdirSync('tmp/qa',{recursive:true});await page.screenshot({path:`tmp/qa/${size}-home.png`,fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal overflow');
 await page.evaluate(()=>{const originalApi=managerApi;managerApi=async(action,...args)=>action==='manager_team'?{manager:{role:'manager',location:'QA fixture'},team:[{id:'00000000-0000-4000-8000-000000000001',name:'QA Kitchen',department:'Kitchen',role:'staff',active:true},{id:'00000000-0000-4000-8000-000000000002',name:'QA Floor',department:'Floor',role:'staff',active:true}],visa_hours:[]}:originalApi(action,...args);});
 await page.locator('[data-manager-nav="team"]').click();await page.getByRole('button',{name:'QA Kitchen',exact:true}).waitFor();
 await page.locator('#rmTeamSearch').fill('Kitchen');assert.equal(await page.locator('#teamList [data-team-row]:visible').count(),1);
 await page.getByRole('button',{name:'QA Kitchen',exact:true}).click();await page.locator('#employeeDetailsScreen').waitFor({state:'visible'});assert.match(await page.locator('#rmEmployeeContent').textContent(),/••••/);
 await page.getByRole('tab',{name:'History',exact:true}).click();assert.match(await page.locator('#rmEmployeeContent').textContent(),/not provided/);
 await page.locator('[data-employee-back]').click();assert.equal(await page.locator('#teamScreen').isVisible(),true);
 await page.locator('[data-manager-nav="operations"]').click();assert.equal(await page.locator('#employeeDetailsScreen').isVisible(),false);
 await page.evaluate(async()=>{const originalApi=managerApi;for(const status of ['working','break','off_shift']){managerApi=async action=>action==='manager_dashboard'?{manager:{id:'qa-clock',name:'QA Manager',role:'manager'},location:'QA fixture',working:status==='off_shift'?[]:[{staff_id:'qa-clock',name:'QA Manager',department:'Kitchen',status,shift_id:'qa-shift',clock_in:new Date().toISOString(),hours_so_far:0}]}:{pending:0};await loadManagerDashboard();const button=document.getElementById(status==='working'?'managerStartBreakBtn':status==='break'?'managerEndBreakBtn':'managerClockInBtn');if(button.classList.contains('hidden'))throw Error('Incorrect manager clock state: '+status);}managerApi=originalApi;});
 await page.evaluate(()=>signOutAll());
 assert.equal(await page.locator("#operationsScreen").isVisible(),false,"sign-out hides custom screens");
 assert.equal(await page.locator("#loginScreen").isVisible(),true);
 assert.deepEqual(errors,[]);await context.close();
}
console.log('PASS: five-tab navigation, screen isolation, roster access, quick action dialog, iPhone/desktop overflow and JavaScript errors.');
}finally{await browser.close();server.close();}
