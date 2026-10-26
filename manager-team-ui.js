/* Team presentation: list + employee details. It only reads the permission-filtered team
   result; every change still goes through the original Edit form and Activate/Deactivate. */
(() => {
const $=id=>document.getElementById(id);
let people=[],visas={},filter='All',person=null,tab='Details',sequence=0,editing=null,shiftWeek=0,pendingApprovals=0;
const svg=d=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON={search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',roster:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6M17 2v6M3 11h18"/>',check:'<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>',leave:'<path d="m3 11 8 2 2 8 3-6 5-12-12 5zM11 13l10-10"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',edit:'<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/>',doc:'<path d="M6 3h9l4 4v14H6zM15 3v4h4M9 12h6M9 16h6"/>',lock:'<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',user:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'};
const icon=n=>svg(ICON[n]||'');
const ROLE={manager:'Administrator',kitchen_manager:'Kitchen Manager',floor_manager:'Floor Manager',staff:'Staff'};
const isManager=p=>p.role&&p.role!=='staff';
const roleLine=p=>p.role==='manager'?'Administrator':[p.department,isManager(p)?ROLE[p.role]:(p.position||'Staff')].filter(Boolean).join(' · ');
const fmt=n=>{const m=Math.round(Math.max(0,n)*60);return m%60?`${Math.floor(m/60)}h ${m%60}m`:`${m/60}h`;};
function visaInfo(p){
 if(!p.student_visa||!p.active)return null;
 if(p.visa_course_break)return {level:'ok',short:'Student visa · course break',breakTime:true};
 const v=visas[p.id];if(!v)return null;
 const used=Number(v.hours_14d)||0,limit=Number(v.limit_hours)||48,left=Math.max(0,limit-used);
 const level=used>=limit?'over':used>=limit-8?'near':'ok';
 return {level,used,limit,left,short:used>=limit?'Student visa · over the limit':`Student visa · ${fmt(left)} left`};
}
const visaPill=p=>{const v=visaInfo(p);return v?`<span class="rm-visa rm-visa-${v.level}">${escapeHtml(v.short)}</span>`:'';};

/* ---------- List ---------- */
const screen=$('teamScreen');const top=screen.querySelector('.manager-top');
const add=$('showAddStaffBtn');add.textContent='+ Add Staff';$('backTeamBtn').classList.add('hidden');
const tools=document.createElement('div');tools.className='rm-team-tools';
tools.innerHTML=`<button type="button" class="rm-icon-btn" id="rmTeamSearchBtn" aria-label="Search staff" aria-expanded="false">${icon('search')}</button>`;
tools.append(add);top.append(tools);
const sub=document.createElement('p');sub.className='rm-team-sub';sub.textContent='Staff, roles and permissions';top.querySelector('h2')?.after(sub);
const controls=document.createElement('div');controls.className='rm-team-controls';
controls.innerHTML='<label class="rm-search hidden" id="rmTeamSearchBox"><span class="sr-only">Search staff</span><input id="rmTeamSearch" type="search" placeholder="Search by name or role" autocomplete="off"></label><div class="rm-chips" id="rmTeamFilters"></div>';
screen.insertBefore(controls,screen.querySelector('.team-list-card'));
const quick=document.createElement('div');quick.id='rmTeamQuick';
screen.querySelector('.team-list-card').after(quick);
const search=$('rmTeamSearch');search.addEventListener('input',applyFilters);
$('rmTeamSearchBtn').onclick=()=>{const box=$('rmTeamSearchBox');const open=box.classList.toggle('hidden')===false;$('rmTeamSearchBtn').setAttribute('aria-expanded',String(open));if(open)search.focus();else{search.value='';applyFilters();}};
$('rmTeamFilters').addEventListener('click',e=>{const b=e.target.closest('[data-team-filter]');if(!b)return;filter=b.dataset.teamFilter;if(filter==='Inactive'&&!teamShowInactive){teamShowInactive=true;loadTeamScreen();}else applyFilters();});
function matches(p,f){return f==='Inactive'?!p.active:p.active&&(f==='All'||(f==='Management'?isManager(p):p.department===f));}
function applyFilters(){
 $('rmTeamFilters').innerHTML=['All','Kitchen','Floor','Management','Inactive'].map(f=>`<button type="button" data-team-filter="${f}" aria-pressed="${f===filter}">${f} <span>${people.filter(p=>matches(p,f)).length}</span></button>`).join('');
 const query=search.value.trim().toLowerCase();let shown=0;
 for(const p of people){const el=$('teamList').querySelector(`[data-team-row="${p.id}"]`);if(!el)continue;const match=matches(p,filter)&&[p.name,p.position,p.department,ROLE[p.role]].join(' ').toLowerCase().includes(query);el.classList.toggle('hidden',!match);shown+=Number(match);if(!match)$('teamList').querySelector(`[data-edit-panel="${p.id}"]`)?.classList.add('hidden');}
 let empty=$('rmTeamEmpty');if(!empty){empty=document.createElement('p');empty.id='rmTeamEmpty';empty.className='rm-data-note';$('teamList').append(empty);}empty.textContent=shown?'':'No staff match these filters.';
 $('teamList').querySelector('[data-team-inactive-toggle]')?.classList.add('hidden');
}
function paintQuick(){
 const off=typeof deskTimeOffCount==='function'?deskTimeOffCount():0;
 quick.innerHTML=`<h3>Quick actions</h3><div class="rm-quick">${[['Roster','Plan shifts','rosterCard','roster'],['Approvals',pendingApprovals?`${pendingApprovals} pending`:'All done','approvalsCard','check'],['Time off',off?`${off} request${off===1?'':'s'}`:'No requests','timeOffCard','leave'],['Staff hours','This week','staffHoursCard','clock']].map(([t,s,go,ic])=>`<button type="button" data-rm-go="${go}">${icon(ic)}<strong>${t}</strong><small>${escapeHtml(s)}</small></button>`).join('')}</div>`;
}
window.addEventListener('marinara:dashboard',e=>{pendingApprovals=e.detail?.counts?.unapproved_shifts||0;paintQuick();});
window.addEventListener('marinara:team',e=>{
 people=e.detail.team;visas=e.detail.visaById||{};
 for(const p of people){
  const row=$('teamList').querySelector(`[data-team-row="${p.id}"]`);if(!row)continue;
  row.classList.add('rm-person');row.dataset.employee=p.id;
  const name=row.querySelector('.person-name');const b=document.createElement('button');b.type='button';b.className='rm-staff-open';b.dataset.employee=p.id;b.textContent=p.name||'Staff';name.replaceChildren(b);
  row.querySelector('.person-meta').textContent=roleLine(p);
  row.querySelector('.team-visa')?.remove();const v=visaPill(p);if(v)row.querySelector('.person-meta').insertAdjacentHTML('afterend',v);
  const actions=row.querySelector('.team-person-actions');row.querySelector('.hours-pill')?.remove();
  const badge=document.createElement('span');badge.className='rm-status'+(p.active?'':' inactive');badge.textContent=p.active?'Active':'Inactive';actions.prepend(badge);
  const edit=actions.querySelector('.team-edit-btn');if(edit){edit.textContent='⋯';edit.setAttribute('aria-label',`Edit ${p.name||'staff'}`);}
  const chev=document.createElement('i');chev.className='rm-chev';chev.setAttribute('aria-hidden','true');chev.textContent='›';actions.append(chev);
 }
 applyFilters();paintQuick();
 if(editing){const id=editing;stopEditing();const fresh=people.find(p=>p.id===id);if(fresh)openPerson(fresh);}
 else if(person&&!details.classList.contains('hidden')){person=people.find(p=>p.id===person.id)||person;render();}
});

/* Focused edit: only this person's row and the original edit form are shown. */
function startEditing(id){
 editing=id;screen.classList.add('rm-editing');
 $('teamList').querySelectorAll('[data-team-row]').forEach(r=>r.classList.toggle('rm-edit-target',r.dataset.teamRow===id));
 const p=people.find(x=>x.id===id);
 let back=$('rmEditBack');if(!back){back=document.createElement('button');back.type='button';back.id='rmEditBack';back.className='rm-back';screen.prepend(back);back.onclick=()=>{const pid=editing;$('teamList').querySelector(`[data-edit-panel="${pid}"]`)?.classList.add('hidden');stopEditing();const q=people.find(x=>x.id===pid);if(q)openPerson(q);};}
 back.textContent=`‹ ${p?.name||'Back'}`;
}
function stopEditing(){editing=null;screen.classList.remove('rm-editing');$('teamList').querySelectorAll('.rm-edit-target').forEach(r=>r.classList.remove('rm-edit-target'));}
$('teamList').addEventListener('click',e=>{
 const edit=e.target.closest('.team-edit-btn');
 if(edit){const panel=$('teamList').querySelector(`[data-edit-panel="${edit.dataset.staffId}"]`);setTimeout(()=>{if(panel&&!panel.classList.contains('hidden'))startEditing(edit.dataset.staffId);else if(editing){const id=editing;stopEditing();const q=people.find(x=>x.id===id);if(q)openPerson(q);}},0);return;}
 const cancel=e.target.closest('.team-cancel-edit-btn');
 if(cancel&&editing){const id=editing;setTimeout(()=>{stopEditing();const q=people.find(x=>x.id===id);if(q)openPerson(q);},0);return;}
 if(e.target.closest('button,input,select,label,.team-edit-panel')&&!e.target.closest('.rm-staff-open'))return;
 const row=e.target.closest('[data-employee]');if(!row)return;
 const p=people.find(x=>x.id===row.dataset.employee);if(p)openPerson(p);
});
// Leaving the Team area always ends a focused edit.
document.addEventListener('click',e=>{if(editing&&e.target.closest('[data-manager-nav]'))stopEditing();},true);

/* ---------- Details ---------- */
const details=document.createElement('section');details.id='employeeDetailsScreen';details.className='hidden';document.querySelector('main').append(details);MANAGER_SCREEN_IDS.push(details.id);
function openPerson(p){person=p;tab='Details';shiftWeek=0;showOnlyManagerScreen(details.id);setManagerNavActive('team');render();window.scrollTo(0,0);}
const field=(k,v,cls='')=>`<dt>${k}</dt><dd class="${cls}">${v==null||v===''?'—':v}</dd>`;
const t=v=>escapeHtml(String(v));
const dateOnly=v=>v?new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',day:'numeric',month:'short',year:'numeric'}).format(new Date(v)):'';
const canEdit=p=>!!$('teamList').querySelector(`.team-edit-btn[data-staff-id="${p.id}"]`);
const card=(ic,h,body,editBtn)=>`<div class="card rm-dcard"><div class="rm-detail-title"><h3>${icon(ic)}${h}</h3>${editBtn?`<button type="button" class="rm-edit" data-employee-edit>${icon('edit')}Edit</button>`:''}</div>${body}</div>`;
async function render(){
 const revision=++sequence;const p=person;if(!p)return;const editable=canEdit(p);
 details.innerHTML=`<button type="button" class="rm-back" data-employee-back>‹ Team</button>
 <div class="rm-emp-head">${whoAvatar(p.name,p.department)}<div class="rm-emp-name"><h2>${t(p.name||'Staff')}</h2><p>${t(roleLine(p))}</p>${visaPill(p)}</div><span class="rm-status ${p.active?'':'inactive'}">${p.active?'Active':'Inactive'}</span></div>
 <div class="rm-tabs" role="tablist">${['Details','Shifts','Time Off'].map(x=>`<button type="button" role="tab" aria-selected="${tab===x}" data-employee-tab="${x}">${x}</button>`).join('')}</div><div id="rmEmployeeContent" aria-live="polite"></div>`;
 const box=$('rmEmployeeContent');
 if(tab==='Details'){
  const v=visaInfo(p);
  let html=card('user','Basic Information',`<dl class="rm-fields">${field('Full name',t(p.name||'Staff'))+field('Department',p.role==='manager'?'All':t(p.department||''))+field('Role',t(isManager(p)?ROLE[p.role]:(p.position||'Staff')))+field('Status',p.active?'<span class="rm-dot"></span>Active':'Inactive')+field('PIN',`•••• ${editable?'<button type="button" class="rm-edit rm-mini" data-employee-edit>Reset</button>':''}`)+field('In the app since',t(dateOnly(p.created_at)))}</dl>`,editable);
  if(p.student_visa)html+=card('doc','Visa Information',`<dl class="rm-fields">${field('Visa type','Student visa')+(p.visa_course_break?field('Hours limit','No limit — course break'):field('Hours limit',`${t(fmt(v?.limit||48))} per fortnight`)+(v?field('Worked',`${t(fmt(v.used))} <small>last week + this week</small>`)+field('Hours remaining',t(fmt(v.left)),`rm-left-${v.level}`):''))}</dl>`,editable);
  html+=card('lock','Permissions',`<dl class="rm-fields">${field('Can clock in/out',p.roster_only?'No — roster only':'Yes')+field('On the roster','Yes')+field('Can request time off',p.roster_only?'—':'Yes')+field('Management access',isManager(p)?t(ROLE[p.role]):'No')}</dl>`,editable);
  if(editable)html+=`<button type="button" class="rm-deactivate${p.active?'':' on'}" data-employee-status>${p.active?'Deactivate':'Activate'} ${t(p.name||'staff')}</button>`;
  if(p.pin_conflict_at&&p.active)html=`<div class="message show error">PIN shared with someone else — set a new PIN.</div>`+html;
  box.innerHTML=html;return;
 }
 box.innerHTML='<div class="card">Loading…</div>';
 try{
  if(tab==='Shifts'){
   let extra={};
   if(shiftWeek){const base=await managerApi('manager_hours');const d=new Date(`${base.week_start_date}T00:00:00Z`);d.setUTCDate(d.getUTCDate()-7*shiftWeek);extra={week_start:d.toISOString().slice(0,10)};}
   const data=await managerApi('manager_hours',extra);if(revision!==sequence)return;
   const rows=(data.shifts||[]).filter(r=>r.staff_id===p.id).sort((a,b)=>String(a.clock_in).localeCompare(String(b.clock_in)));
   const total=rows.reduce((s,r)=>s+(Number(r.hours)||0),0);
   const time=v=>new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',hour:'numeric',minute:'2-digit',hour12:true}).format(new Date(v));
   const day=v=>new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',weekday:'short',day:'numeric',month:'short'}).format(new Date(v));
   box.innerHTML=`<div class="rm-chips rm-week">${['This week','Last week'].map((x,i)=>`<button type="button" data-shift-week="${i}" aria-pressed="${shiftWeek===i}">${x}</button>`).join('')}</div>
   <div class="card rm-dcard"><div class="rm-detail-title"><h3>${icon('clock')}${shiftWeek?'Last week':'This week'}</h3><strong>${t(formatHours(total))}</strong></div>${rows.length?`<div class="rm-shifts">${rows.map(r=>`<div class="rm-shift"><span><strong>${t(day(r.clock_in))}</strong><small>${t(time(r.clock_in))} – ${r.clock_out?t(time(r.clock_out)):'working now'}${r.break_minutes?` · ${t(r.break_minutes)} min break`:''}</small></span><span><strong>${r.clock_out?t(formatHours(r.hours)):'—'}</strong><small class="${r.approved?'ok':'wait'}">${r.clock_out?(r.approved?'Approved':'To approve'):'Open'}</small></span></div>`).join('')}</div>`:'<p class="rm-data-note">No shifts this week.</p>'}</div>`;
  }else{
   const data=await managerApi('manager_leave_list');if(revision!==sequence)return;
   const rows=[...(data.pending||[]),...(data.upcoming||[])].filter((r,i,a)=>r.staff_id===p.id&&a.findIndex(x=>x.id===r.id)===i);
   box.innerHTML=`<div class="card rm-dcard"><div class="rm-detail-title"><h3>${icon('leave')}Time off</h3></div>${rows.length?`<div class="rm-shifts">${rows.map(r=>`<div class="rm-shift"><span><strong>${t(TIMEOFF_LABEL[r.kind]||r.kind)}</strong><small>${t(timeOffRange(r))}${r.note?` · “${t(r.note)}”`:''}</small></span><span><small class="${r.status==='APPROVED'?'ok':'wait'}">${t(TIMEOFF_STATUS[r.status]||r.status)}</small></span></div>`).join('')}</div>`:'<p class="rm-data-note">No time off waiting or coming up.</p>'}<button type="button" class="rm-link" data-rm-go="timeOffCard">Open Time Off ›</button></div>`;
  }
 }catch(error){if(revision===sequence)box.innerHTML=`<div class="message show error">${escapeHtml(error.message||'Unable to load.')}</div>`;}
}
let confirmTimer=null;
details.addEventListener('click',e=>{
 if(e.target.closest('[data-employee-back]')){sequence++;showOnlyManagerScreen('teamScreen');setManagerNavActive('team');return;}
 const tb=e.target.closest('[data-employee-tab]');if(tb){tab=tb.dataset.employeeTab;render();return;}
 const wk=e.target.closest('[data-shift-week]');if(wk){shiftWeek=Number(wk.dataset.shiftWeek);render();return;}
 if(e.target.closest('[data-employee-edit]')){
  sequence++;const id=person.id;showOnlyManagerScreen('teamScreen');setManagerNavActive('team');
  const panel=$('teamList').querySelector(`[data-edit-panel="${id}"]`);
  if(panel?.classList.contains('hidden'))$('teamList').querySelector(`.team-edit-btn[data-staff-id="${id}"]`)?.click();
  startEditing(id);window.scrollTo(0,0);return;
 }
 const st=e.target.closest('[data-employee-status]');
 if(st){
  if(!st.dataset.confirm){st.dataset.confirm='1';st.textContent=`Tap again to ${person.active?'deactivate':'activate'}`;clearTimeout(confirmTimer);confirmTimer=setTimeout(()=>{if(st.isConnected){delete st.dataset.confirm;st.textContent=`${person.active?'Deactivate':'Activate'} ${person.name||'staff'}`;}},4000);return;}
  clearTimeout(confirmTimer);st.disabled=true;st.textContent='Saving…';
  const rev=sequence;
  $('teamList').querySelector(`.team-toggle-btn[data-staff-id="${person.id}"]`)?.click();
  // If the change failed, show the reason here instead of leaving "Saving…".
  setTimeout(()=>{if(rev===sequence&&st.isConnected&&st.disabled){const m=$('teamMessage').textContent;render().then(()=>{if(m)$('rmEmployeeContent').insertAdjacentHTML('afterbegin',`<div class="message show error">${escapeHtml(m)}</div>`);});}},8000);
 }
});
paintQuick();
})();
