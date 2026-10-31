/* Activity: who changed what and when (Administrator only, read only). Lists
   what the app already records: hours, team, roster, time off, stock, kitchen,
   invoices, devices, food safety, shopping and maintenance. */
(() => {
const $=id=>document.getElementById(id);
const t=v=>escapeHtml(String(v??''));
const time=v=>new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',hour:'numeric',minute:'2-digit'}).format(new Date(v));
const dayLong=v=>new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',weekday:'long',day:'numeric',month:'short'}).format(new Date(v));
const ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>';
const state={data:null,days:7,who:'',area:'',gen:0};
const screen=document.createElement('section');screen.id='activityScreen';screen.className='hidden';
screen.innerHTML=`<div class="manager-top"><div><h2>Activity</h2><p>Who changed what, and when · read only</p></div></div>
<div class="act-filters">
 <select id="actDays" aria-label="Period"><option value="1">Today and yesterday</option><option value="7" selected>Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select>
 <select id="actWho" aria-label="Who"><option value="">Everyone</option></select>
 <select id="actArea" aria-label="Area"><option value="">All areas</option></select>
</div>
<p class="rm-data-note" id="actMsg" aria-live="polite"></p>
<div id="actList"><div class="card shop-card"><div class="empty-state">Loading…</div></div></div>
<p class="rm-data-note">Each person must use their own PIN: the list shows the name of the PIN that was used.</p>`;
document.querySelector('main').append(screen);MANAGER_SCREEN_IDS.push(screen.id);
const opener=document.createElement('button');opener.type='button';opener.id='rmOpenActivity';opener.hidden=true;
opener.onclick=()=>{if(currentManagerRole!=='manager')return;showOnlyManagerScreen(screen.id);setManagerNavActive('more');window.scrollTo(0,0);load().catch(e=>msg(e.message||'Unable to load.'));};
document.body.append(opener);
const row=`<button type="button" class="rm-row" data-rm-go="rmOpenActivity" data-act-row>${ICON}<span><strong>Activity</strong><small>Who changed what, and when</small></span><i aria-hidden="true">›</i></button>`;
{const menu=document.querySelector('#managerMoreScreen .rm-menu');const after=menu?.querySelector('[data-rm-go="rmOpenSettings"]');
 if(after)after.insertAdjacentHTML('afterend',row);else menu?.insertAdjacentHTML('beforeend',row);}
const sync=()=>{for(const r of document.querySelectorAll('[data-act-row]'))r.hidden=currentManagerRole!=='manager';};
sync();window.addEventListener('marinara:dashboard',sync);
const msg=(x)=>{const m=$('actMsg');m.textContent=x||'';m.style.color=x?'#b3261e':'';};

async function load(){
 const gen=++state.gen;msg('');
 $('actList').innerHTML='<div class="card shop-card"><div class="empty-state">Loading…</div></div>';
 const d=await managerApi('manager_activity',{days:state.days,...(state.who?{who:state.who}:{})});
 if(gen!==state.gen)return;state.data=d;render();
}
function render(){
 const d=state.data;if(!d)return;
 const who=$('actWho');const keep=state.who;
 if(!state.who)who.innerHTML='<option value="">Everyone</option>'+(d.people||[]).map(p=>`<option value="${t(p.id)}">${t(p.name)}</option>`).join('');
 who.value=keep;
 const areas=[...new Set((d.items||[]).map(i=>i.area))].sort();
 $('actArea').innerHTML='<option value="">All areas</option>'+areas.map(a=>`<option${a===state.area?' selected':''}>${t(a)}</option>`).join('');
 if(state.area&&!areas.includes(state.area))state.area='';
 const items=(d.items||[]).filter(i=>!state.area||i.area===state.area);
 if(!items.length){$('actList').innerHTML=`<div class="card shop-card"><div class="empty-state">Nothing in ${t(d.location||'this unit')} for this period.</div></div>`;return;}
 const byDay=new Map();for(const i of items){const k=dayLong(i.at);if(!byDay.has(k))byDay.set(k,[]);byDay.get(k).push(i);}
 $('actList').innerHTML=`<p class="rm-data-note">${t(d.location||'')} · ${items.length}${d.more?'+':''} change${items.length===1?'':'s'}${d.more?' (showing the newest 500)':''}</p>`+
  [...byDay].map(([k,rs])=>`<h4 class="tmp-day">${t(k)}</h4><div class="card shop-card">${rs.map(i=>`<div class="act-row"><span class="act-time">${t(time(i.at))}</span><span class="act-main"><strong>${t(i.who||'Someone')}</strong> <em class="act-area">${t(i.area)}</em><small>${t(i.what)}</small></span></div>`).join('')}</div>`).join('');
}
$('actDays').addEventListener('change',e=>{state.days=Number(e.target.value)||7;load().catch(x=>msg(x.message));});
$('actWho').addEventListener('change',e=>{state.who=e.target.value;load().catch(x=>msg(x.message));});
$('actArea').addEventListener('change',e=>{state.area=e.target.value;render();});
window.addEventListener('marinara:session-reset',()=>{state.gen++;Object.assign(state,{data:null,days:7,who:'',area:''});$('actDays').value='7';$('actWho').innerHTML='<option value="">Everyone</option>';$('actArea').innerHTML='<option value="">All areas</option>';$('actList').innerHTML='';msg('');sync();});
})();
