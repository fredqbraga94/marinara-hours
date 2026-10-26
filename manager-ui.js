/* Test-only administrative shell. Existing actions, auth, clock and PDF functions remain authoritative. */
(() => {
  const $ = id => document.getElementById(id);
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({home:'<path d="m3 10 9-7 9 7v11h-6v-7H9v7H3z"/>',team:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5"/>',stock:'<path d="m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10M7 4l9 5"/>',kitchen:'<path d="M6 13a4 4 0 0 1-2-7 4 4 0 0 1 5-2 4 4 0 0 1 6 0 4 4 0 0 1 5 2 4 4 0 0 1-2 7v8H6zM6 16h12"/>',finance:'<path d="M5 3h10l4 4v14H5zM15 3v5h4M9 12h6M9 16h6"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',roster:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6M17 2v6M3 11h18"/>',check:'<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>',more:'<circle cx="4" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="20" cy="12" r="1"/>',scan:'<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M3 12h18M8 7h8v10H8"/>',bell:'<path d="M5 9a7 7 0 0 1 14 0v7l2 2H3l2-2zM9 21h6"/>',settings:'<circle cx="12" cy="12" r="4"/><path d="m9 2-1 3-3 1-3 3 2 3-2 3 3 3 3 1 1 3h6l1-3 3-1 3-3-2-3 2-3-3-3-3-1-1-3z"/>',leave:'<path d="m3 11 8 2 2 8 3-6 5-12-12 5zM11 13l10-10"/>',coffee:'<path d="M3 8h13v7a6 6 0 0 1-12 0V8M16 9h2a3 3 0 0 1 0 6h-2M6 3v2M11 3v2M2 22h18"/>'})[name] || '<path d="M12 4v16M4 12h16"/>'}</svg>`;
  const go = (id) => { const button=$(id); if(button && !button.disabled) button.click(); };
  const row = (title,subtitle,target,glyph) => `<button type="button" class="rm-row" data-rm-go="${target}">${icon(glyph)}<span><strong>${title}</strong><small>${subtitle}</small></span><i aria-hidden="true">›</i></button>`;
  const manager = $('managerScreen');
  const original = document.createElement('div');original.id='rmLegacyHome';
  while(manager.firstChild) original.append(manager.firstChild);
  manager.append(original);
  const home=document.createElement('div');home.id='rmHome';
  home.innerHTML=`<div class="rm-intro"><div id="rmGreetingSlot"></div><button id="quickActionsBtn" aria-label="Quick actions" type="button">+</button></div><div id="rmMessageSlot"></div>
  <button class="rm-scan" id="rmScanInvoice" type="button">${icon('scan')}<span><strong>Scan Invoice</strong><small>Upload a supplier PDF</small></span><i>›</i></button>
  <h3>Restaurant Management</h3><div class="rm-modules" id="rmModules"></div>
  <h3>Restaurant Overview <button class="rm-link" id="rmWorkingToggle" aria-expanded="false">View all</button></h3>
  <div class="rm-overview">${[['roster','On roster','rmRosterCount'],['team','Working','rmWorkingCount'],['coffee','On break','rmBreakCount'],['clock','Late','rmLateCount']].map(([ic,label,id])=>`<div class="rm-stat">${icon(ic)}<strong id="${id}">—</strong><small>${label}</small></div>`).join('')}</div><p class="rm-data-note" id="rmOverviewNote"></p>
  <h3>Needs Attention</h3><div class="rm-attention" id="rmAttention"><p class="rm-data-note" style="padding:0 12px">Loading…</p></div>
  <div id="rmWorkingPanel" class="hidden"><h3>Who's Working</h3><div id="rmWorkingSlot"></div></div>`;
  manager.prepend(home);
  for(const id of ['managerGreeting','managerRoleLine']) $('rmGreetingSlot').append($(id));
  $('rmMessageSlot').append($('managerMessage'),$('managerHolidayNotice'));
  $('rmWorkingSlot').append($('workingList'));
  for(const [id,name,sub,glyph] of [['teamCard','Team','Staff, roster and approvals','team'],['stockCard','Stock','Inventory and orders','stock'],['recipesCard','Kitchen','Recipes and allergens','kitchen'],['invoicesCard','Invoices','Supplier invoices and expenses','finance']]){
    const b=$(id); b.className='rm-module';b.innerHTML=`${icon(glyph)}<span><strong>${name}</strong><small>${sub}</small></span><i>›</i>`;$('rmModules').append(b);
  }
  // Keep source elements used by established refresh and permissions code.
  for(const id of ['teamText','recipesCardLabel','recipesCardSub'])if(!$(id)){const s=document.createElement('span');s.id=id;original.append(s);}
  manager.append($('managerClockSection'));
  const nav=$('managerBottomNav');
  const approvals=nav.querySelector('[data-manager-nav="approvals"]');approvals.classList.add('hidden');approvals.removeAttribute('data-manager-nav');approvals.id='rmApprovalsNav';
  for(const [target,label,glyph] of [['finance','Finance','finance'],['operations','Operations','stock']]){
    const b=document.createElement('button');b.type='button';b.className='manager-nav-item';b.dataset.managerNav=target;b.innerHTML=`${icon(glyph)}<span>${label}</span>`;nav.insertBefore(b,nav.querySelector('[data-manager-nav="team"]'));
  }
  for(const [name,glyph] of [['home','home'],['team','team'],['more','more']])nav.querySelector(`[data-manager-nav="${name}"] .manager-nav-icon`).innerHTML=icon(glyph);
  const operations=document.createElement('section');operations.id='operationsScreen';operations.className='hidden';operations.innerHTML=`<div class="manager-top"><div><h2>Operations</h2><p>Plan and manage your restaurant</p></div></div><div class="rm-menu">${[['Roster','Plan and manage shifts','rosterCard','roster'],['Stock','Inventory and orders','stockCard','stock'],['Kitchen','Recipes, ingredients and allergens','recipesCard','kitchen'],['Approvals','Review completed shifts','approvalsCard','check'],['Staff Hours','View worked hours','staffHoursCard','clock'],['Time Off','Holidays and leave requests','timeOffCard','leave'],['Timesheets','Weekly reports and payroll','timesheetsCard','finance'],['My Time Clock','Open your existing time clock','moreMyClockBtn','clock']].map(a=>row(...a)).join('')}</div>`;
  document.querySelector('main').append(operations);MANAGER_SCREEN_IDS.push('operationsScreen');
  const settings=document.createElement('section');settings.id='restaurantSettingsScreen';settings.className='hidden';settings.innerHTML=`<div class="manager-top"><div><h2>Restaurant Settings</h2><p>Business details and preferences</p></div></div><div class="rm-tabs" role="tablist">${['General','Locations','Hours','Public Holidays'].map((t,i)=>`<button type="button" role="tab" aria-selected="${!i}" data-rm-settings="${t}">${t}</button>`).join('')}</div><div class="card" id="rmSettingsContent"></div>`;document.querySelector('main').append(settings);MANAGER_SCREEN_IDS.push(settings.id);
  const moreLegacy=document.createElement('div');moreLegacy.id='rmLegacyMore';while($('managerMoreScreen').firstChild)moreLegacy.append($('managerMoreScreen').firstChild);$('managerMoreScreen').append(moreLegacy);
  const moreMenu=document.createElement('div');moreMenu.className='rm-menu';moreMenu.innerHTML=row('Restaurant Settings','Business details, locations, hours','rmOpenSettings','settings')+[['Staff','Manage employees and access','teamCard','team'],['Roster','Plan and manage shifts','rosterCard','roster'],['Approvals','Review and approve hours','approvalsCard','check'],['Staff Hours','View and manage worked hours','staffHoursCard','clock'],['Timesheets','Weekly reports and payroll','timesheetsCard','finance'],['Time Off','Holidays and leave requests','timeOffCard','leave'],['Stock','Inventory and supplies','stockCard','stock'],['Kitchen','Recipes and allergens','recipesCard','kitchen'],['Invoices','Supplier documents and costs','invoicesCard','finance'],['My Time Clock','Open your time clock','moreMyClockBtn','clock'],['Settings','Devices and account access','moreDevicesBtn','settings'],['Sign Out','End this session','moreSignOutBtn','leave']].map(a=>row(...a)).join('');
  $('managerMoreScreen').prepend(moreMenu);
  const moreTitle=document.createElement('div');moreTitle.className='manager-top';moreTitle.innerHTML='<div><h2>More</h2><p>Manage your restaurant</p></div>';$('managerMoreScreen').prepend(moreTitle);
  const settingsBtn=document.createElement('button');settingsBtn.id='rmOpenSettings';settingsBtn.hidden=true;settingsBtn.onclick=()=>{showOnlyManagerScreen(settings.id);setManagerNavActive('more');renderSettings('General');};manager.append(settingsBtn);
  function renderSettings(tab){
    settings.querySelectorAll('[role="tab"]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.rmSettings===tab)));
    const place=$('managerLocation').textContent;
    $('rmSettingsContent').innerHTML=tab==='General'?`<h3>Business Information</h3><dl><dt>Restaurant</dt><dd>Marinara Ristorante Cafe</dd><dt>Unit</dt><dd>${escapeHtml(place)}</dd></dl><p class="rm-data-note">Address, phone and ABN will be added here later.</p>`:tab==='Locations'?`<h3>${escapeHtml(place)}</h3><p>This is the unit associated with your current session.</p><p class="rm-data-note">Paddington and Clayfield will appear here when they join the app.</p>`:tab==='Hours'?'<h3>Service times</h3><p class="rm-data-note">Lunch and dinner times are set in the Roster.</p>'+row('Roster','View weekly shifts','rosterCard','roster'):`<h3>Public Holidays</h3>${$('managerHolidayNotice').innerHTML || '<p class="rm-data-note">No holiday information has been loaded. Open Home to refresh.</p>'}`;
  }
  settings.addEventListener('click',e=>{const b=e.target.closest('[data-rm-settings]');if(b)renderSettings(b.dataset.rmSettings);});
  const dialog=document.createElement('dialog');dialog.id='quickActionsDialog';dialog.innerHTML=`<div class="rm-handle"></div><h2>Actions</h2><div class="rm-actions">${[['Upload invoice','Choose the supplier PDF','rmScanInvoice','scan'],['Stock','Count and order','stockCard','stock'],['Add Staff','Create staff member','rmAddStaff','team'],['Create Shift','Open weekly roster','rosterCard','roster'],['Kitchen','Recipes and allergens','recipesCard','kitchen'],['Reports','Weekly timesheets','timesheetsCard','finance'],['Time Clock','Open time clock','moreMyClockBtn','clock'],['Settings','Restaurant information','rmOpenSettings','settings']].map(a=>row(...a)).join('')}</div><button type="button" id="rmCloseActions">Close</button>`;document.body.append(dialog);
  $('quickActionsBtn').onclick=()=>dialog.showModal();$('rmCloseActions').onclick=()=>dialog.close();dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
  $('rmWorkingToggle').onclick=()=>{const open=$('rmWorkingPanel').classList.toggle('hidden')===false;$('rmWorkingToggle').setAttribute('aria-expanded',String(open));};
  document.addEventListener('click',e=>{const b=e.target.closest('[data-rm-go]');if(!b)return;dialog.close();if(b.dataset.rmGo==='rmAddStaff'){go('teamCard');if($('addStaffPanel').classList.contains('hidden'))go('showAddStaffBtn');}else go(b.dataset.rmGo);});
  nav.addEventListener('click',e=>{const b=e.target.closest('[data-manager-nav]');if(!b)return;const key=b.dataset.managerNav;if(key==='finance'||key==='operations'){e.stopImmediatePropagation();if(key==='finance')go('invoicesCard');else{showOnlyManagerScreen('operationsScreen');setManagerNavActive('operations');}window.scrollTo(0,0);}},true);
  const header=document.querySelector('.app > .header');
  $('headerLogo').src=document.querySelector('.login-original-logo').src;
  const tools=document.createElement('div');tools.className='rm-header-tools';tools.innerHTML=`<button type="button" id="rmNotifications" aria-label="View pending tasks">${icon('bell')}</button><button type="button" id="rmProfile" aria-label="Manager profile">M</button>`;header.append(tools);
  $('rmNotifications').onclick=()=>{nav.querySelector('[data-manager-nav="home"]').click();$('rmAttention').scrollIntoView({block:'center'});};$('rmProfile').onclick=()=>openManagerMore();
  const placeButton=document.createElement('button');placeButton.id='rmLocation';placeButton.type='button';placeButton.textContent='Current unit ⌄';placeButton.onclick=()=>{settingsBtn.click();renderSettings('Locations');};header.append(placeButton);
  const originalSet=setManagerNavActive;
  setManagerNavActive=function(target='home'){originalSet(target);syncShell();};
  function syncShell(){
    const visible=MANAGER_SCREEN_IDS.find(id=>!$(id)?.classList.contains('hidden'));
    const signedIn=!nav.classList.contains('hidden');const clock=visible==='managerScreen'&&!$('managerClockSection').classList.contains('hidden');
    document.body.classList.toggle('rm-mode',signedIn&&!clock);document.body.classList.toggle('rm-clock',signedIn&&clock);
    const active=visible==='managerScreen'?'home':['teamScreen','employeeDetailsScreen'].includes(visible)?'team':visible==='invoicesScreen'?'finance':['managerMoreScreen','devicesScreen','restaurantSettingsScreen'].includes(visible)?'more':'operations';
    nav.querySelectorAll('[data-manager-nav]').forEach(b=>{b.classList.toggle('active',b.dataset.managerNav===active);if(b.dataset.managerNav===active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
    const canInvoice=['manager','kitchen_manager'].includes(currentManagerRole);nav.querySelector('[data-manager-nav="finance"]').disabled=!canInvoice;document.querySelectorAll('[data-rm-go="invoicesCard"], [data-rm-go="rmScanInvoice"], #rmScanInvoice').forEach(b=>{b.disabled=!canInvoice;b.hidden=!canInvoice&&b.id==='rmScanInvoice';b.title=canInvoice?'':'Finance is restricted to authorised managers';});
    $('rmLocation').textContent=($('managerLocation').textContent||'Current unit')+' ⌄';
  }
  for(const id of [...MANAGER_SCREEN_IDS,'managerBottomNav','managerClockSection'])new MutationObserver(syncShell).observe($(id),{attributes:true,attributeFilter:['class']});
  // Payload is supplied only after a successful, authorised dashboard request.
  // Today from the roster: who is rostered, and who is late (rostered start
  // passed by more than 10 minutes, still inside their shift, not clocked in).
  const roster={at:0,data:null,loading:false};
  const brisbaneNow=()=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(x=>[x.type,x.value]));return{date:`${p.year}-${p.month}-${p.day}`,min:Number(p.hour)*60+Number(p.minute)};};
  const toMin=t=>{const m=/^(\d{1,2}):(\d{2})/.exec(t||'');return m?Number(m[1])*60+Number(m[2]):null;};
  async function loadRoster(){
    if(roster.loading||Date.now()-roster.at<60000)return;
    roster.loading=true;
    try{roster.data=await managerApi('manager_roster_week');roster.at=Date.now();}catch(_){roster.data=null;}
    finally{roster.loading=false;}
    paint();
  }
  function today(){
    const d=roster.data;if(!d)return null;
    const now=brisbaneNow();
    const team=Object.fromEntries((d.team||[]).map(m=>[m.id,m]));
    const svc=(dep,code)=>(d.services||[]).find(s=>s.department===dep&&s.service===code);
    const onLeave=new Set((d.leave||[]).filter(l=>l.status==='APPROVED'&&l.start_date<=now.date&&l.end_date>=now.date).map(l=>l.staff_id));
    const entries=(d.entries||[]).filter(e=>e.work_date===now.date&&e.code!=='OFF'&&team[e.staff_id]&&!onLeave.has(e.staff_id));
    const working=new Set(lastWorking.map(p=>p.staff_id));
    const late=[];
    for(const e of entries){
      const m=team[e.staff_id];if(m.roster_only||working.has(e.staff_id))continue;
      const windows=e.code==='SHIFT'?[[e.start_time,e.end_time]]:(e.code==='LD'?['L','D']:[e.code]).map(c=>{const sv=svc(m.department,c);return[e.start_time&&e.code!=='LD'?e.start_time:sv?.start_time,sv?.end_time||e.end_time];});
      for(const [a,b] of windows){const st=toMin(a),en=toMin(b);if(st==null)continue;if(now.min>st+10&&(en==null||now.min<en)){late.push(m.name);break;}}
    }
    return{rostered:new Set(entries.map(e=>e.staff_id)).size,late};
  }
  let lastWorking=[],lastDash=null;
  function paint(){
    const d=lastDash;if(!d)return;
    const t=today();
    $('rmRosterCount').textContent=t?t.rostered:'—';
    $('rmLateCount').textContent=t?t.late.length:'—';
    $('rmLateCount').closest('.rm-stat').classList.toggle('alert',!!t&&t.late.length>0);
    $('rmOverviewNote').textContent=t&&t.late.length?`Late: ${t.late.join(', ')}`:'';
    const n=d.counts?.unapproved_shifts||0;
    const off=Number($('homeTimeOffCount')?.textContent||0)||0;
    const toOrder=typeof deskExtra!=='undefined'?deskExtra.toOrder:null;
    const rows=[];
    if(t&&t.late.length)rows.push(row(`${t.late.length} late`,t.late.join(', ')+' – rostered but not clocked in','teamCard','clock'));
    if(n)rows.push(row(`${n} shift${n===1?'':'s'} awaiting approval`,'Review completed shifts','approvalsCard','check'));
    if(off)rows.push(row(`${off} time off request${off===1?'':'s'}`,'Someone is waiting for an answer','timeOffCard','leave'));
    if(toOrder)rows.push(row(`${toOrder} item${toOrder===1?'':'s'} to order`,'Below par at the last stock count','stockCard','stock'));
    $('rmAttention').innerHTML=rows.length?rows.join(''):`<div class="rm-row rm-ok">${icon('check')}<span><strong>All caught up</strong><small>Nothing waiting for you right now.</small></span></div>`;
  }
  // Payload is supplied only after a successful, authorised dashboard request.
  window.addEventListener('marinara:dashboard',e=>{
    const d=e.detail;const working=d.working||[];lastDash=d;lastWorking=working;
    $('rmWorkingCount').textContent=working.filter(p=>p.status!=='break').length;$('rmBreakCount').textContent=working.filter(p=>p.status==='break').length;
    $('managerRoleLine').textContent=`Here's what's happening at ${d.location||'your restaurant'}.`;
    $('rmProfile').textContent=String(d.manager?.name||'M').slice(0,1).toUpperCase();syncShell();
    paint();loadRoster();setTimeout(paint,2500);
  });
  $('rmScanInvoice').onclick=()=>{dialog.close();go('invoicesCard');$('invFiles')?.click();};
  syncShell();
})();
