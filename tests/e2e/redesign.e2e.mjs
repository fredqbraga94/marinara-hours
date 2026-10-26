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
 // Home overview from real roster data: rostered today, late, needs attention.
 const home=await page.evaluate(async()=>{
   const p=Object.fromEntries(new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(x=>[x.type,x.value]));
   const date=`${p.year}-${p.month}-${p.day}`;const now=Number(p.hour)*60+Number(p.minute);
   const hm=m=>{m=Math.max(0,Math.min(23*60+59,m));return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');};
   const team=[{id:'a',name:'QA Late',department:'Kitchen'},{id:'b',name:'QA Working',department:'Floor'},{id:'c',name:'QA Off',department:'Floor'},{id:'d',name:'QA Salaried',department:'Kitchen',roster_only:true}];
   const entries=[{staff_id:'a',work_date:date,code:'SHIFT',start_time:hm(now-60),end_time:hm(now+120)},{staff_id:'b',work_date:date,code:'SHIFT',start_time:hm(now-60),end_time:hm(now+120)},{staff_id:'c',work_date:date,code:'OFF'},{staff_id:'d',work_date:date,code:'SHIFT',start_time:hm(now-60),end_time:hm(now+120)}];
   const orig=managerApi;managerApi=async(action,...args)=>action==='manager_roster_week'?{team,entries,services:[],leave:[]}:orig(action,...args);
   window.dispatchEvent(new CustomEvent('marinara:dashboard',{detail:{location:'Hawthorne',manager:{name:'QA Manager'},counts:{unapproved_shifts:2},working:[{staff_id:'b',name:'QA Working',status:'working'}]}}));
   for(let i=0;i<40&&document.getElementById('rmRosterCount').textContent==='—';i++)await new Promise(r=>setTimeout(r,50));
   const out={rostered:document.getElementById('rmRosterCount').textContent,late:document.getElementById('rmLateCount').textContent,note:document.getElementById('rmOverviewNote').textContent,attention:document.getElementById('rmAttention').innerText.replace(/\s+/g,' ')};
   managerApi=orig;return out;});
 assert.equal(home.rostered,'3');assert.equal(home.late,'1');assert.equal(home.note,'Late: QA Late');
 assert.match(home.attention,/1 late QA Late/);assert.match(home.attention,/2 shifts awaiting approval/);
 assert.doesNotMatch(await page.locator('#rmHome').innerText(),/API|not supplied/i,'no technical text for the team');
 await page.evaluate(()=>document.querySelector('#managerMessage').textContent='QA: network blocked; no live staff data.');
 mkdirSync('tmp/qa',{recursive:true});await page.screenshot({path:`tmp/qa/${size}-home.png`,fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal overflow');
 await page.evaluate(()=>{const originalApi=managerApi;const now=new Date();managerApi=async(action,...args)=>action==='manager_team'?{manager:{role:'manager',location:'QA fixture'},team:[{id:'00000000-0000-4000-8000-000000000001',name:'QA Kitchen',department:'Kitchen',position:'Chef',role:'staff',active:true,student_visa:true,created_at:'2024-08-12T00:00:00Z'},{id:'00000000-0000-4000-8000-000000000002',name:'QA Floor',department:'Floor',role:'staff',active:true,roster_only:true}],visa_hours:[{staff_id:'00000000-0000-4000-8000-000000000001',hours_14d:39.35,limit_hours:48}]}:action==='manager_hours'?{week_start_date:'2026-10-26',shifts:[{staff_id:'00000000-0000-4000-8000-000000000001',clock_in:now.toISOString(),clock_out:new Date(now.getTime()+5*3600e3).toISOString(),hours:5,approved:false,break_minutes:30},{staff_id:'00000000-0000-4000-8000-000000000002',clock_in:now.toISOString(),clock_out:null,hours:0}]}:action==='manager_leave_list'?{pending:[{id:'l1',staff_id:'00000000-0000-4000-8000-000000000001',kind:'HOLIDAY',start_date:'2026-11-02',end_date:'2026-11-04',status:'PENDING'}],upcoming:[]}:originalApi(action,...args);});
 await page.locator('[data-manager-nav="team"]').click();await page.getByRole('button',{name:'QA Kitchen',exact:true}).waitFor();
 const kitchenRow=page.locator('#teamList [data-team-row="00000000-0000-4000-8000-000000000001"]');
 assert.match(await kitchenRow.innerText(),/Kitchen · Chef/);assert.match(await kitchenRow.innerText(),/Student visa · 8h 39m left/);assert.match(await kitchenRow.innerText(),/Active/);
 assert.equal(await page.locator('#rmTeamQuick [data-rm-go]').count(),4,'four quick actions under the team');
 await page.locator('#rmTeamSearchBtn').click();await page.locator('#rmTeamSearch').fill('Kitchen');assert.equal(await page.locator('#teamList [data-team-row]:visible').count(),1);
 await page.locator('#rmTeamSearchBtn').click();assert.equal(await page.locator('#teamList [data-team-row]:visible').count(),2,'closing search clears it');
 mkdirSync('tmp/qa',{recursive:true});await page.screenshot({path:`tmp/qa/${size}-team.png`,fullPage:true});
 await kitchenRow.locator('.person-meta').click();await page.locator('#employeeDetailsScreen').waitFor({state:'visible'});
 const det=await page.locator('#rmEmployeeContent').innerText();
 assert.match(det,/Basic Information/);assert.match(det,/••••/);assert.match(det,/12 Aug 2024/);assert.match(det,/Visa Information/);assert.match(det,/48h per fortnight/);assert.match(det,/8h 39m/);assert.match(det,/Can clock in\/out\s*Yes/);
 assert.doesNotMatch(await page.locator('#employeeDetailsScreen').innerText(),/API|not provided|Not recorded/i,'no technical text');
 await page.screenshot({path:`tmp/qa/${size}-employee.png`,fullPage:true});
 await page.getByRole('tab',{name:'Shifts',exact:true}).click();await page.locator('.rm-shift').first().waitFor();assert.equal(await page.locator('.rm-shift').count(),1,'only this person\'s shifts');assert.match(await page.locator('#rmEmployeeContent').innerText(),/To approve/);
 await page.getByRole('tab',{name:'Time Off',exact:true}).click();await page.locator('.rm-shift').first().waitFor();assert.match(await page.locator('#rmEmployeeContent').innerText(),/Holiday[\s\S]*Waiting/);
 await page.getByRole('tab',{name:'Details',exact:true}).click();
 await page.locator('#rmEmployeeContent [data-employee-edit]').first().click();await page.locator('[data-edit-panel="00000000-0000-4000-8000-000000000001"]').waitFor({state:'visible'});
 assert.equal(await page.locator('#teamList [data-team-row]:visible').count(),1,'edit shows only this person');assert.equal(await page.locator('#rmTeamQuick').isVisible(),false);
 await page.locator('[data-edit-panel="00000000-0000-4000-8000-000000000001"] .team-cancel-edit-btn').click();await page.locator('#employeeDetailsScreen').waitFor({state:'visible'});
 await page.locator('[data-employee-back]').click();assert.equal(await page.locator('#teamScreen').isVisible(),true);assert.equal(await page.locator('#teamList [data-team-row]:visible').count(),2);
 await page.locator('#teamList [data-team-row="00000000-0000-4000-8000-000000000002"] .team-edit-btn').click();await page.locator('#rmEditBack').waitFor({state:'visible'});
 await page.locator('#rmEditBack').click();await page.locator('#employeeDetailsScreen').waitFor({state:'visible'});assert.match(await page.locator('#rmEmployeeContent').innerText(),/No — roster only/);
 await page.locator('[data-manager-nav="operations"]').click();assert.equal(await page.locator('#employeeDetailsScreen').isVisible(),false);
 await page.evaluate(async()=>{const originalApi=managerApi;for(const status of ['working','break','off_shift']){managerApi=async action=>action==='manager_dashboard'?{manager:{id:'qa-clock',name:'QA Manager',role:'manager'},location:'QA fixture',working:status==='off_shift'?[]:[{staff_id:'qa-clock',name:'QA Manager',department:'Kitchen',status,shift_id:'qa-shift',clock_in:new Date().toISOString(),hours_so_far:0}]}:{pending:0};await loadManagerDashboard();const button=document.getElementById(status==='working'?'managerStartBreakBtn':status==='break'?'managerEndBreakBtn':'managerClockInBtn');if(button.classList.contains('hidden'))throw Error('Incorrect manager clock state: '+status);}managerApi=originalApi;});
 await page.evaluate(()=>signOutAll());
 assert.equal(await page.locator("#operationsScreen").isVisible(),false,"sign-out hides custom screens");
 assert.equal(await page.locator("#loginScreen").isVisible(),true);
 await page.evaluate(()=>{document.getElementById('loginScreen').classList.add('hidden');showOnlyManagerScreen('managerScreen');setManagerNavActive('home');document.body.style.setProperty('--rm-safe-top','0px');});
 const bounds=()=>page.evaluate(()=>['headerLogo','rmNotifications','rmProfile','rmLocation'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {top:r.top,bottom:r.bottom};}));
 const before=await bounds();await page.evaluate(()=>document.body.style.setProperty('--rm-safe-top','59px'));const after=await bounds();
 for(let i=0;i<before.length;i++){assert.ok(Math.abs(after[i].top-before[i].top-59)<1,'header control follows safe area');assert.ok(after[i].top>=59,'header stays below status bar');}
 await page.screenshot({path:`tmp/qa/${size}-safe-area.png`,fullPage:true});
 assert.deepEqual(errors,[]);await context.close();
}
console.log('PASS: roster/late overview and needs attention, five-tab navigation, screen isolation, roster access, quick action dialog, iPhone/desktop overflow and JavaScript errors.');
}finally{await browser.close();server.close();}
