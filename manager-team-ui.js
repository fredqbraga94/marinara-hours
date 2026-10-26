/* Team presentation consumes only the permission-filtered existing team result. */
(() => {
const $=id=>document.getElementById(id);let people=[],visas={},filter='All',person=null,tab='Details',sequence=0;
const add=$('showAddStaffBtn');$('teamScreen').querySelector('.manager-top').append(add);add.textContent='+ Add Staff';$('backTeamBtn').classList.add('hidden');
const controls=document.createElement('div');controls.className='rm-team-controls';controls.innerHTML='<label class="rm-search"><span>Search staff</span><input id="rmTeamSearch" type="search" placeholder="Search by name or role" autocomplete="off"></label><div class="rm-tabs" id="rmTeamFilters"></div>';
$('teamScreen').insertBefore(controls,$('teamScreen').querySelector('.team-list-card'));
const details=document.createElement('section');details.id='employeeDetailsScreen';details.className='hidden';document.querySelector('main').append(details);MANAGER_SCREEN_IDS.push(details.id);
const search=$('rmTeamSearch');search.addEventListener('input',applyFilters);
$('rmTeamFilters').addEventListener('click',e=>{const b=e.target.closest('[data-team-filter]');if(!b)return;filter=b.dataset.teamFilter;if(filter==='Inactive'&&!teamShowInactive){teamShowInactive=true;loadTeamScreen();}else applyFilters();});
function matches(p,f){return f==='Inactive'?!p.active:p.active&&(f==='All'||(f==='Management'?p.role!=='staff':p.department===f));}
function applyFilters(){
 $('rmTeamFilters').innerHTML=['All','Kitchen','Floor','Management','Inactive'].map(f=>`<button type="button" data-team-filter="${f}" aria-pressed="${f===filter}">${f} <span>${people.filter(p=>matches(p,f)).length}</span></button>`).join('');
 const query=search.value.trim().toLowerCase();let shown=0;
 for(const p of people){const el=$('teamList').querySelector(`[data-team-row="${p.id}"]`);if(!el)continue;const match=matches(p,filter)&&[p.name,p.position,p.department,p.role].join(' ').toLowerCase().includes(query);el.classList.toggle('hidden',!match);shown+=Number(match);if(!match)$('teamList').querySelector(`[data-edit-panel="${p.id}"]`)?.classList.add('hidden');}
 let empty=$('rmTeamEmpty');if(!empty){empty=document.createElement('p');empty.id='rmTeamEmpty';empty.className='rm-data-note';$('teamList').append(empty);}empty.textContent=shown?'':'No staff match these filters.';
 $('teamList').querySelector('[data-team-inactive-toggle]')?.classList.add('hidden');
}
window.addEventListener('marinara:team',e=>{people=e.detail.team;visas=e.detail.visaById;for(const p of people){const el=$('teamList').querySelector(`[data-team-row="${p.id}"] .person-name`);if(el){const b=document.createElement('button');b.type='button';b.className='rm-staff-open';b.dataset.employee=p.id;b.textContent=p.name||'Staff';el.replaceChildren(b);const row=el.closest('[data-team-row]');const actions=row.querySelector('.team-person-actions');const badge=document.createElement('span');badge.className='rm-status'+(p.active?'':' inactive');badge.textContent=p.active?'● Active':'Inactive';actions.prepend(badge);row.querySelector('.hours-pill')?.remove();if(p.role==='manager'){const meta=row.querySelector('.person-meta');meta.textContent=['Manager',p.location||e.detail.location].filter(Boolean).join(' · ');}}}applyFilters();});
$('teamList').addEventListener('click',e=>{const b=e.target.closest('[data-employee]');if(!b)return;person=people.find(p=>p.id===b.dataset.employee);tab='Details';showOnlyManagerScreen(details.id);setManagerNavActive('team');render();window.scrollTo(0,0);});
const field=(key,value)=>`<dt>${key}</dt><dd>${escapeHtml(value==null||value===''?'Not recorded':String(value))}</dd>`;
async function render(){
 const revision=++sequence;const p=person;if(!p)return;
 details.innerHTML=`<div class="manager-top"><div class="rm-employee-heading">${whoAvatar(p.name,p.department)}<div><h2>${escapeHtml(p.name)}</h2><p>${escapeHtml([p.department,p.position||p.role].filter(Boolean).join(' · '))}</p></div></div><button type="button" class="back-btn" data-employee-back>Back</button></div><span class="rm-status ${p.active?'':'inactive'}">${p.active?'Active':'Inactive'}</span>${renderVisaBadge(p,visas[p.id])}<div class="rm-tabs" role="tablist">${['Details','Shifts','Time Off','History'].map(t=>`<button type="button" role="tab" aria-selected="${tab===t}" data-employee-tab="${t}">${t}</button>`).join('')}</div><div id="rmEmployeeContent" aria-live="polite"></div>`;
 const box=$('rmEmployeeContent');
 if(tab==='Details'){
 box.innerHTML=`<div class="card"><div class="rm-detail-title"><h3>Basic Information</h3><button type="button" class="back-btn" data-employee-edit>Edit</button><button type="button" class="back-btn" data-employee-status>${p.active?'Deactivate':'Activate'}</button></div><dl class="rm-fields">${field('Full name',p.name)+field('Role',p.position||p.role)+field('Status',p.active?'Active':'Inactive')+field('PIN','••••')+field('Start date',p.start_date)+field('Phone',p.phone)+field('Email',p.email)}</dl></div><div class="card"><h3>Time Clock & Access</h3><dl class="rm-fields">${field('Time Clock',p.roster_only?'Roster only':p.active?'Enabled':'Inactive account')+field('Role',p.role)+field('Department',p.department)+field('Student visa',p.student_visa?'Yes':'No')+field('Course break',p.visa_course_break?'Yes':'No')}</dl></div>`;
 // Edit remains the original role-aware form; no duplicate write path.
 box.querySelector('[data-employee-status]').disabled=!$('teamList').querySelector(`.team-toggle-btn[data-staff-id="${p.id}"]`);
 box.querySelector('[data-employee-edit]').disabled=!$('teamList').querySelector(`.team-edit-btn[data-staff-id="${p.id}"]`);
 return;
 }
 if(tab==='History'){box.innerHTML='<div class="card"><h3>Change history</h3><p class="rm-data-note">Employee audit history is not provided by the current API. No history has been inferred from account creation dates.</p></div>';return;}
 box.innerHTML='<div class="card">Loading…</div>';
 try{
 const data=await managerApi(tab==='Shifts'?'manager_hours':'manager_leave_list');if(revision!==sequence)return;
 const records=(tab==='Shifts'?(data.shifts||data.hours?.shifts||[]):[...(data.pending||[]),...(data.upcoming||[]),...(data.past||[])]).filter(r=>r.staff_id===p.id);
 box.innerHTML=records.length?records.map(r=>`<div class="card"><dl class="rm-fields">${tab==='Shifts'?field('Clock In',r.clock_in?formatBrisbaneDayTime(r.clock_in):null)+field('Clock Out',r.clock_out?formatBrisbaneDayTime(r.clock_out):'Open shift')+field('Hours',r.hours==null?null:formatHours(r.hours))+field('Status',r.approved?'Approved':'Pending'):field('Type',r.leave_type||r.kind||r.type)+field('Start',r.start_date)+field('End',r.end_date)+field('Status',r.status)+field('Reason',r.reason)}</dl></div>`).join(''):'<div class="card"><p class="rm-data-note">No records returned for this employee in the current period.</p></div>';
 }catch(error){if(revision===sequence)box.innerHTML=`<div class="message show error">${escapeHtml(error.message||'Unable to load records.')}</div>`;}
}
details.addEventListener('click',e=>{if(e.target.closest('[data-employee-status]')){showOnlyManagerScreen('teamScreen');setManagerNavActive('team');$('teamList').querySelector(`.team-toggle-btn[data-staff-id="${person.id}"]`)?.click();}if(e.target.closest('[data-employee-back]')){sequence++;showOnlyManagerScreen('teamScreen');setManagerNavActive('team');}const t=e.target.closest('[data-employee-tab]');if(t){tab=t.dataset.employeeTab;render();}if(e.target.closest('[data-employee-edit]')){sequence++;showOnlyManagerScreen('teamScreen');setManagerNavActive('team');const edit=$('teamList').querySelector(`.team-edit-btn[data-staff-id="${person.id}"]`);edit?.click();$('teamList').querySelector(`[data-edit-panel="${person.id}"]`)?.scrollIntoView({block:'start'});}});
})();
