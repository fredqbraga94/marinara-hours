/* Operations and More in groups, like Food Safety: one row per group, and a
   screen with the group's rows. Team & Hours: Roster, Approvals, Staff Hours,
   Time Off, Timesheets, My Time Clock. Stock & Orders: Stock, Orders, Shopping.
   The rows keep working as before (same buttons, same permissions). */
(() => {
const $=id=>document.getElementById(id);
const svg=p=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const GROUPS=[
 {id:'hubTeam',title:'Team & Hours',sub:'Roster, approvals, hours, time off, timesheets',
  icon:svg('<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3"/><circle cx="18" cy="15" r="3.2"/><path d="M18 13.4V15l1 .8"/>'),
  rows:['rosterCard','approvalsCard','staffHoursCard','timeOffCard','timesheetsCard','moreMyClockBtn']},
 {id:'hubStock',title:'Stock & Orders',sub:'Stock count, orders to suppliers, shopping',
  icon:svg('<path d="m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10"/>'),
  rows:['stockCard','rmOpenOrders','rmOpenShopping']},
];
const ops=document.querySelector('#operationsScreen .rm-menu');
const more=document.querySelector('#managerMoreScreen .rm-menu');
for(const g of GROUPS){
 const screen=document.createElement('section');screen.id=`${g.id}Screen`;screen.className='hidden';
 screen.innerHTML=`<div class="manager-top"><div><h2>${g.title}</h2><p>${g.sub}</p></div></div><div class="rm-menu" id="${g.id}Menu"></div>`;
 document.querySelector('main').append(screen);MANAGER_SCREEN_IDS.push(screen.id);
 const opener=document.createElement('button');opener.type='button';opener.id=`rmOpen${g.id[0].toUpperCase()}${g.id.slice(1)}`;opener.hidden=true;
 opener.onclick=()=>{showOnlyManagerScreen(screen.id);setManagerNavActive('operations');window.scrollTo(0,0);};
 document.body.append(opener);
 const row=`<button type="button" class="rm-row" data-rm-go="${opener.id}" data-rm-hub="${g.id}">${g.icon}<span><strong>${g.title}</strong><small>${g.sub}</small></span><i aria-hidden="true">›</i></button>`;
 // Operations: the rows move into the group screen, the group row takes the place of the first one.
 const present=g.rows.map(go=>ops?.querySelector(`[data-rm-go="${go}"]`)).filter(Boolean);
 if(present[0])present[0].insertAdjacentHTML('beforebegin',row);else ops?.insertAdjacentHTML('afterbegin',row);
 for(const go of g.rows){const r=ops?.querySelector(`[data-rm-go="${go}"]`);if(r)$(`${g.id}Menu`).append(r);}
 // More: one group row instead of the same rows again.
 if(more){const first=g.rows.map(go=>more.querySelector(`[data-rm-go="${go}"]`)).find(Boolean);
  if(first)first.insertAdjacentHTML('beforebegin',row);else more.insertAdjacentHTML('beforeend',row);
  for(const go of g.rows)more.querySelector(`[data-rm-go="${go}"]`)?.remove();}
}
// Operations order: the groups first, then Food Safety, Kitchen, Maintenance.
if(ops)for(const go of ['rmOpenHubTeam','rmOpenHubStock','rmOpenFoodSafety','recipesCard','rmOpenMaintenance']){const r=ops.querySelector(`[data-rm-go="${go}"]`);if(r)ops.append(r);}
// A group row is hidden when the person can open none of its rows.
function syncHubs(){
 for(const g of GROUPS){const kids=[...document.querySelectorAll(`#${g.id}Menu [data-rm-go]`)];const none=kids.length&&kids.every(k=>k.classList.contains('rm-no-access'));
  document.querySelectorAll(`[data-rm-hub="${g.id}"]`).forEach(r=>r.classList.toggle('rm-hub-empty',none));}
}
window.addEventListener('marinara:dashboard',()=>setTimeout(syncHubs,0));
window.addEventListener('marinara:session-reset',()=>setTimeout(syncHubs,0));
})();
