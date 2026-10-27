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
   window.dispatchEvent(new CustomEvent('marinara:dashboard',{detail:{location:'Hawthorne',manager:{name:'QA Manager'},counts:{unapproved_shifts:2},working:[{staff_id:'b',name:'QA Working',department:'Floor',status:'working',clock_in:new Date(Date.now()-3600e3).toISOString(),hours_so_far:1},{staff_id:'x',name:'QA Break',department:'Floor',status:'break',clock_in:new Date(Date.now()-7200e3).toISOString(),hours_so_far:2}]}}));
   for(let i=0;i<40&&document.getElementById('rmRosterCount').textContent==='—';i++)await new Promise(r=>setTimeout(r,50));
   const out={rostered:document.getElementById('rmRosterCount').textContent,late:document.getElementById('rmLateCount').textContent,note:document.getElementById('rmOverviewNote').textContent,attention:document.getElementById('rmAttention').innerText.replace(/\s+/g,' ')};
   managerApi=orig;return out;});
 assert.equal(home.rostered,'3');assert.equal(home.late,'1');assert.equal(home.note,'Late: QA Late');
 assert.match(home.attention,/1 late QA Late/);
 assert.equal(await page.locator('#rmBellBadge').innerText(),'3','bell = 1 late + 2 shifts');
 await page.evaluate(()=>showLeaveBadge(1));await page.waitForFunction(()=>document.getElementById('rmBellBadge').textContent==='4');
 assert.equal(await page.locator('#navMoreBadge').isVisible(),false,'no badge on More');await page.evaluate(()=>showLeaveBadge(0));assert.match(home.attention,/2 shifts awaiting approval/);
 assert.doesNotMatch(await page.locator('#rmHome').innerText(),/API|not supplied/i,'no technical text for the team');
 // Live dots and "who is it" under the overview.
 assert.equal(await page.locator('[data-rm-stat="working"]').evaluate(e=>e.classList.contains('live-work')),true,'green dot when someone works');
 assert.equal(await page.locator('[data-rm-stat="break"]').evaluate(e=>e.classList.contains('live-break')),true,'orange dot when someone is on break');
 assert.equal(await page.locator('[data-rm-stat="working"] .rm-live').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(31, 157, 85)');
 assert.equal(await page.locator('[data-rm-stat="break"] .rm-live').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(242, 153, 0)');
 await page.locator('[data-rm-stat="working"]').click();assert.match(await page.locator('#rmStatPanel').innerText(),/Working now[\s\S]*QA Working[\s\S]*in since/);assert.match(await page.locator('#rmStatPanel').innerText(),/\b1h\b/,'hours as 1h, not 1.00 hrs');assert.doesNotMatch(await page.locator('#rmStatPanel').innerText(),/QA Break/);
 await page.locator('[data-rm-stat="break"]').click();assert.match(await page.locator('#rmStatPanel').innerText(),/On break[\s\S]*QA Break/);
 await page.locator('[data-rm-stat="roster"]').click();const ros=await page.locator('#rmStatPanel').innerText();
 assert.match(ros,/QA Late[\s\S]*Late/);assert.match(ros,/QA Working[\s\S]*Working/);assert.doesNotMatch(ros,/QA Off/,'off today is not on the roster list');
 await page.locator('[data-rm-stat="late"]').click();assert.match(await page.locator('#rmStatPanel').innerText(),/QA Late[\s\S]*Not clocked in/);
 await page.screenshot({path:`tmp/qa/${size}-who.png`});
 await page.locator('[data-rm-stat="late"]').click();assert.equal(await page.locator('#rmStatPanel').isVisible(),false,'tap again closes');

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
 // Price book: all products, rises, history; Home shows recent rises and opens them.
 await page.evaluate(()=>{const d=n=>new Date(Date.now()+10*3600e3-n*864e5).toISOString().slice(0,10);const orig=managerApi;window.__origApi=orig;
   managerApi=async(action,...args)=>action==='manager_invoice_price_book'?{products:[
     {supplier:'Test Produce Co',product_key:'tst-tom',code:'TST-TOM',description:'Test tomatoes',unit:'KG',times:3,last_price:4.6,last_date:d(3),previous_price:4,previous_date:d(10),change_pct:15,history:[{date:d(17),price:4},{date:d(10),price:4},{date:d(3),price:4.6}]},
     {supplier:'Test Produce Co',product_key:'test basil',code:null,description:'Test basil',unit:'ea',times:2,last_price:2.7,last_date:d(3),previous_price:3,previous_date:d(10),change_pct:-10,history:[{date:d(10),price:3},{date:d(3),price:2.7}]},
     {supplier:'Other Test Supplier',product_key:'ot-1',code:'OT-1',description:'Test olive oil',unit:'ea',times:1,last_price:9,last_date:d(40),previous_price:null,previous_date:null,change_pct:null,history:[{date:d(40),price:9}]},
     {supplier:'Test Wholesale',product_key:'tw-chz',code:'TW-CHZ',description:'Test cheese blend 2kg',unit:'Bag',pack:4,times:2,last_price:22.33,last_date:d(20),previous_price:null,previous_date:null,change_pct:null,history:[{date:d(27),price:22.33},{date:d(20),price:22.33}]},
     {supplier:'Other Test Supplier',product_key:'ot-2',code:'OT-2',description:'Test flour',unit:'bag',times:4,last_price:30,last_date:d(30),previous_price:28,previous_date:d(37),change_pct:7.1,history:[{date:d(44),price:28},{date:d(37),price:28},{date:d(30),price:30}]}]}
     :action==='manager_dashboard'?{manager:{id:'m',name:'QA Manager',role:'manager'},location:'Hawthorne',working:[],counts:{}}:orig(action,...args);});
 await page.locator('[data-manager-nav="home"]').click();await page.evaluate(()=>{mhPricesReset();window.dispatchEvent(new CustomEvent('marinara:dashboard',{detail:{location:'Hawthorne',manager:{name:'QA'},counts:{},working:[]}}));});
 await page.waitForFunction(()=>/1 price went up/.test(document.getElementById('rmAttention').innerText));
 assert.match(await page.locator('#rmAttention').innerText(),/Test tomatoes \+15%/,'only the recent rise (flour rose 30 days ago)');
 await page.locator('#rmAttention [data-rm-go="rmOpenPriceUps"]').click();await page.locator('#invPricesView').waitFor({state:'visible'});
 await page.locator('.pb-row').first().waitFor();
 assert.equal(await page.locator('#pbChips [aria-pressed="true"]').innerText(),'Went up 2');assert.equal(await page.locator('.pb-row').count(),2);
 assert.match(await page.locator('.pb-row').first().innerText(),/Test tomatoes[\s\S]*\$4\.60[\s\S]*15%/);
 await page.locator('[data-pb-filter="all"]').click();assert.equal(await page.locator('.pb-row').count(),5);
 assert.match(await page.locator('.pb-row',{hasText:'Test cheese blend'}).innerText(),/\$89\.32[\s\S]*\/ctn[\s\S]*\$22\.33 each · 4 a ctn/,'carton price first');
 assert.deepEqual(await page.evaluate(()=>[invQtyText(12,'Ctn [4]'),invPriceText(22.33,'Ctn [4]'),invQtyText(2,'Bag'),invQtyText(30,'Ctn [6]'),invPriceText(4.5,'kg')]),['3 ctn × 4 (12 un)','$89.32 / ctn · $22.33 each','2 Bag','5 ctn × 6 (30 un)','$4.50 / kg']);
 assert.match(await page.locator('.pb-row').first().innerText(),/Test flour/,'most bought first');
 await page.locator('.pb-row',{hasText:'Test tomatoes'}).click();const hist=await page.locator('.pb-hist').innerText();
 assert.match(hist,/\$4\.00 → \$4\.60/);assert.match(hist,/\+\$0\.60/);assert.match(hist,/first time/);
 await page.locator('.pb-row',{hasText:'Test olive oil'}).click();assert.match(await page.locator('.pb-hist').innerText(),/Bought once/);
 await page.locator('#pbSearch').fill('basil');assert.equal(await page.locator('.pb-row').count(),1);
 assert.equal(await page.locator('[data-manager-nav="finance"]').getAttribute('aria-current'),'page');
 await page.screenshot({path:`tmp/qa/${size}-prices.png`,fullPage:true});
 await page.evaluate(()=>{managerApi=window.__origApi;});
 // Access per manager. Administrator: switches on a Kitchen Manager's page, saved to the server.
 await page.evaluate(()=>{const orig=managerApi;window.__permSet=null;window.__origPerm=orig;
   managerApi=async(action,args={})=>action==='manager_team'?{manager:{role:'manager',location:'QA fixture'},team:[{id:'00000000-0000-4000-8000-0000000000k1',name:'QA Kitchen Lead',department:'Kitchen',role:'kitchen_manager',active:true,roster_only:true},{id:'00000000-0000-4000-8000-0000000000f1',name:'QA Floor Lead',department:'Floor',role:'floor_manager',active:true}],visa_hours:[]}
     :action==='manager_permissions_list'?{managers:[{staff_id:'00000000-0000-4000-8000-0000000000k1',custom:false,hours:true,team:true,roster:true,time_off:true,stock:true,recipes:true,invoices:true},{staff_id:'00000000-0000-4000-8000-0000000000f1',custom:false,hours:true,team:true,roster:true,time_off:true,stock:true,recipes:true,invoices:true}]}
     :action==='manager_permissions_set'?(window.__permSet=args,{permissions:{staff_id:args.staff_id,...args.permissions}}):orig(action,args);});
 await page.locator('[data-manager-nav="team"]').click();await page.getByRole('button',{name:'QA Kitchen Lead',exact:true}).click();
 await page.locator('#rmPermCard .rm-perm').first().waitFor();
 assert.equal(await page.locator('#rmPermCard [data-perm]').count(),7);assert.equal(await page.locator('#rmPermCard [data-perm]:checked').count(),7,'starts with what the role gives');
 assert.equal(await page.locator('[data-perm-save]').isDisabled(),true,'nothing to save yet');
 for(const k of ['team','roster','time_off','stock','recipes','invoices'])await page.locator(`#rmPermCard .rm-perm:has([data-perm="${k}"])`).click();
 await page.locator('[data-perm-save]').click();await page.locator('.rm-perm-msg.ok').waitFor();
 assert.deepEqual(await page.evaluate(()=>window.__permSet),{staff_id:'00000000-0000-4000-8000-0000000000k1',permissions:{hours:true,team:false,roster:false,time_off:false,stock:false,recipes:false,invoices:false}});
 await page.screenshot({path:`tmp/qa/${size}-access.png`,fullPage:true});
 await page.locator('[data-employee-back]').click();await page.getByRole('button',{name:'QA Floor Lead',exact:true}).click();await page.locator('#rmPermCard .rm-perm').first().waitFor();
 assert.equal(await page.locator('#rmPermCard [data-perm="invoices"]').isDisabled(),true,'floor managers never get invoices');
 await page.locator('[data-employee-back]').click();
 // Becoming a Kitchen Manager in Edit: switches appear (Hours only) and go with the save.
 await page.evaluate(()=>{const base=managerApi;window.__upd=null;managerApi=async(action,args={})=>action==='manager_update_staff'?(window.__upd=args,{staff:{}}):action==='manager_team'?{manager:{role:'manager'},team:[{id:'00000000-0000-4000-8000-0000000000s1',name:'QA Cook',department:'Kitchen',role:'staff',active:true}],visa_hours:[]}:base(action,args);});
 await page.locator('[data-manager-nav="team"]').click();await page.getByRole('button',{name:'QA Cook',exact:true}).waitFor();
 const cook='[data-edit-panel="00000000-0000-4000-8000-0000000000s1"]';
 await page.locator('#teamList [data-team-row="00000000-0000-4000-8000-0000000000s1"] .team-edit-btn').click();
 assert.equal(await page.locator(`${cook} .rm-edit-access`).count(),0,'no switches while staying Staff');
 await page.locator(`${cook} .team-edit-role`).selectOption('kitchen_manager');
 await page.locator(`${cook} .rm-edit-access`).waitFor();
 assert.deepEqual(await page.locator(`${cook} [data-new-perm]`).evaluateAll(es=>es.filter(e=>e.checked).map(e=>e.dataset.newPerm)),['hours'],'starts with Hours only');
 await page.locator(`${cook} .rm-perm:has([data-new-perm="stock"])`).click();
 await page.screenshot({path:`tmp/qa/${size}-promote.png`,fullPage:true});
 await page.locator(`${cook} .team-save-edit-btn`).click();await page.waitForFunction(()=>window.__upd);
 assert.deepEqual(await page.evaluate(()=>window.__upd.permissions),{hours:true,team:false,roster:false,time_off:false,stock:true,recipes:false,invoices:false});
 assert.equal(await page.evaluate(()=>window.__upd.role),'kitchen_manager');
 // Back to Staff: switches go away and nothing extra is sent.
 await page.evaluate(()=>{window.__upd=null;});
 await page.locator('#teamList [data-team-row="00000000-0000-4000-8000-0000000000s1"] .team-edit-btn').click().catch(()=>{});
 if(await page.locator(`${cook}`).isVisible()){await page.locator(`${cook} .team-edit-role`).selectOption('staff');assert.equal(await page.locator(`${cook} .rm-edit-access`).count(),0);await page.locator(`${cook} .team-save-edit-btn`).click();await page.waitForFunction(()=>window.__upd);assert.equal(await page.evaluate(()=>'permissions' in window.__upd),false,'nothing extra when staying Staff');}
 await page.evaluate(()=>{managerApi=window.__origPerm;});
 // The restricted Kitchen Manager only sees hours.
 await page.evaluate(()=>{managerApi=window.__origPerm;currentManagerRole='kitchen_manager';window.dispatchEvent(new CustomEvent('marinara:dashboard',{detail:{location:'Hawthorne',manager:{name:'QA Lead'},counts:{},working:[],permissions:{hours:true,team:false,roster:false,time_off:false,stock:false,recipes:false,invoices:false}}}));});
 await page.locator('[data-manager-nav="home"]').click();
 const vis=sel=>page.locator(sel).first().isVisible();
 for(const sel of ['#teamCard','#stockCard','#recipesCard','#invoicesCard','#rmScanInvoice','[data-manager-nav="finance"]','[data-manager-nav="team"]','[data-rm-stat="roster"]','[data-rm-stat="late"]'])assert.equal(await vis(sel),false,`hidden: ${sel}`);
 assert.equal(await vis('[data-rm-stat="working"]'),true);
 await page.locator('[data-manager-nav="operations"]').click();
 assert.equal(await vis('#operationsScreen [data-rm-go="approvalsCard"]'),true,'approvals stay');assert.equal(await vis('#operationsScreen [data-rm-go="staffHoursCard"]'),true);assert.equal(await vis('#operationsScreen [data-rm-go="timesheetsCard"]'),true);
 for(const g of ['rosterCard','stockCard','recipesCard','timeOffCard'])assert.equal(await vis(`#operationsScreen [data-rm-go="${g}"]`),false,`hidden in Operations: ${g}`);
 await page.screenshot({path:`tmp/qa/${size}-restricted.png`,fullPage:true});
 await page.locator('[data-manager-nav="more"]').click();
 assert.equal(await vis('#managerMoreScreen [data-rm-go="rmOpenSettings"]'),false,'no Restaurant Settings for managers');
 assert.equal(await vis('#managerMoreScreen [data-rm-go="moreDevicesBtn"]'),false,'no device settings for managers');
 assert.equal(await vis('#managerMoreScreen [data-rm-go="approvalsCard"]'),true);
 assert.equal(await page.locator('#rmLocation').isDisabled(),true,'the unit name does not open settings');
 await page.evaluate(()=>document.querySelector('#operationsScreen [data-rm-go="rosterCard"]').click());
 assert.equal(await page.locator('#rosterScreen').isVisible(),false,'a hidden shortcut opens nothing');
 if(size==='iphone'){const xs=await page.locator('#managerBottomNav > button:visible').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return [r.left,r.right];}));assert.equal(xs.length,3);const W=await page.evaluate(()=>innerWidth);assert.ok(xs[0][0]<25&&xs[2][1]>W-25,'three tabs fill the bar '+JSON.stringify(xs)+' '+W);}
 await page.evaluate(()=>{currentManagerRole='manager';window.dispatchEvent(new CustomEvent('marinara:dashboard',{detail:{location:'Hawthorne',manager:{name:'QA'},counts:{},working:[]}}));});
 assert.equal(await vis('#stockCard'),false,'(Home not visible now)');await page.locator('[data-manager-nav="home"]').click();assert.equal(await vis('#stockCard'),true,'everything back without permissions');
 await page.locator('[data-manager-nav="more"]').click();assert.equal(await vis('#managerMoreScreen [data-rm-go="rmOpenSettings"]'),true,'Administrator keeps Restaurant Settings');assert.equal(await vis('#managerMoreScreen [data-rm-go="moreDevicesBtn"]'),true);assert.equal(await page.locator('#rmLocation').isDisabled(),false);
 // My Time Clock from More keeps the new look; More → Home goes back to the home, not the clock.
 await page.evaluate(()=>{managerApi=async action=>action==='manager_dashboard'?{manager:{id:'qa-clock',name:'QA Manager',role:'manager'},location:'QA fixture',working:[]}:{pending:0};});
 await page.locator('[data-manager-nav="more"]').click();await page.locator('#moreMyClockBtn').evaluate(b=>b.click());await page.locator('#managerClockSection').waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>document.body.classList.contains('rm-mode')),true,'clock keeps the new look');
 assert.equal(await page.locator('#managerBottomNav > button:visible').count(),5);
 const navTops=await page.locator('#managerBottomNav > button:visible').evaluateAll(es=>es.map(e=>Math.round(e.getBoundingClientRect().top)));assert.equal(new Set(navTops).size,1,'all five tabs on one line');
 await page.screenshot({path:`tmp/qa/${size}-clock.png`});
 assert.equal(await page.locator('#managerBottomNav .active').getAttribute('data-manager-nav'),'more','clock is opened from More');
 await page.locator('[data-manager-nav="more"]').click();await page.locator('#managerMoreScreen').waitFor({state:'visible'});
 await page.locator('[data-manager-nav="home"]').click();await page.locator('#rmHome').waitFor({state:'visible'});
 assert.equal(await page.locator('#managerClockSection').isVisible(),false,'Home shows the home, not the clock');
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
console.log(`PASS (${ENGINE}): roster/late overview and needs attention, five-tab navigation, screen isolation, roster access, quick action dialog, iPhone/desktop overflow and JavaScript errors.`);
}finally{await browser.close();server.close();}
