/* Own PIN. A person who has a temporary PIN chooses their own at the first
   sign-in; anyone can change their PIN later (More → Change my PIN); a manager
   gives a temporary PIN to a new person or after a forgotten PIN.
   window.mhOwnPin = { require(oldPin), change(), showTemp(name, pin) } */
(() => {
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ---- Choose / change my PIN ---- */
const dlg=document.createElement('dialog');dlg.id='ownPinDialog';dlg.className='op-dialog';
dlg.innerHTML=`<form method="dialog" id="opForm" class="op-box" autocomplete="off">
 <h3 id="opTitle">Choose your PIN</h3>
 <p id="opIntro" class="rm-data-note"></p>
 <label id="opOldWrap">Current PIN<input id="opOld" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></label>
 <label>New PIN<input id="opNew" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" placeholder="4–6 numbers"></label>
 <label>New PIN again<input id="opNew2" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password"></label>
 <p id="opMsg" class="op-msg" role="alert"></p>
 <div class="op-buttons"><button type="button" id="opCancel" class="btn">Cancel</button><button type="submit" id="opSave" class="btn primary">Save PIN</button></div>
</form>`;
document.body.append(dlg);
const $=id=>dlg.querySelector('#'+id);
let state=null; // {forced, oldPin, done, fail}
const msg=t=>{$('opMsg').textContent=t||'';};
function close(){if(dlg.open)dlg.close();$('opOld').value=$('opNew').value=$('opNew2').value='';msg('');}
function open(forced,oldPin){
 return new Promise((done,fail)=>{
  state={forced,oldPin:oldPin||'',done,fail};
  $('opTitle').textContent=forced?'Choose your own PIN':'Change my PIN';
  $('opIntro').textContent=forced?'You signed in with a temporary PIN. Choose a PIN that only you know. You will use it every time you sign in.':'Choose a new PIN. You will use it from the next time you sign in.';
  $('opOldWrap').hidden=forced;$('opCancel').textContent=forced?'Cancel and sign out':'Cancel';
  $('opOld').value=$('opNew').value=$('opNew2').value='';msg('');
  if(!dlg.open)dlg.showModal();
  setTimeout(()=>($(forced?'opNew':'opOld')).focus(),50);
 });
}
$('opCancel').addEventListener('click',()=>{const s=state;state=null;close();if(s){if(s.forced)s.fail(new Error('You need to choose your own PIN to continue.'));else s.done(false);}});
dlg.addEventListener('cancel',e=>{if(state?.forced)e.preventDefault();});
$('opForm').addEventListener('submit',async e=>{
 e.preventDefault();
 const s=state;if(!s)return;
 const oldPin=s.forced?s.oldPin:$('opOld').value.trim(),nw=$('opNew').value.trim(),nw2=$('opNew2').value.trim();
 if(!/^[0-9]{4,6}$/.test(nw)){msg('The new PIN must have 4 to 6 numbers.');return;}
 if(nw!==nw2){msg('The two new PINs are not the same.');return;}
 if(!s.forced&&!/^[0-9]{4,6}$/.test(oldPin)){msg('Type your current PIN.');return;}
 const b=$('opSave');b.disabled=true;b.textContent='Saving…';
 try{
  const {response,result}=await postApi({action:'change_pin',token:currentSessionToken,old_pin:oldPin,new_pin:nw});
  if(response.status===401){state=null;close();s.fail(new Error('Your session has ended. Please sign in again.'));return;}
  if(!response.ok||result.success!==true){msg(result.error||'Unable to change the PIN. Please try again.');return;}
  state=null;
  if(s.forced){close();s.done(true);}
  else{$('opMsg').style.color='#07613b';msg('Your PIN was changed.');setTimeout(()=>{$('opMsg').style.color='';close();s.done(true);},1200);}
 }catch(err){msg('Could not reach the server. Check the connection and try again.');}
 finally{b.disabled=false;b.textContent='Save PIN';}
});

/* ---- Temporary PIN shown once to the manager ---- */
const tdlg=document.createElement('dialog');tdlg.id='ownPinTemp';tdlg.className='op-dialog';
tdlg.innerHTML=`<div class="op-box"><h3>Temporary PIN</h3>
 <p id="otFor" class="rm-data-note"></p>
 <div id="otPin" class="op-big" aria-live="polite"></div>
 <p class="rm-data-note">Tell it to them now or write it down: it is shown only once. They choose their own PIN the first time they sign in.</p>
 <div class="op-buttons"><button type="button" id="otDone" class="btn primary">Done</button></div></div>`;
document.body.append(tdlg);
tdlg.querySelector('#otDone').addEventListener('click',()=>{tdlg.querySelector('#otPin').textContent='';tdlg.close();});
tdlg.addEventListener('close',()=>{tdlg.querySelector('#otPin').textContent='';});
function showTemp(name,pin){
 tdlg.querySelector('#otFor').innerHTML=`For <strong>${esc(name)}</strong>`;
 tdlg.querySelector('#otPin').textContent=pin;
 if(!tdlg.open)tdlg.showModal();
}

/* ---- More → Change my PIN ---- */
const opener=document.createElement('button');opener.type='button';opener.id='rmOpenOwnPin';opener.hidden=true;
opener.onclick=()=>{open(false);};
document.body.append(opener);
const KEY='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/></svg>';
const row=`<button type="button" class="rm-row" data-rm-go="rmOpenOwnPin">${KEY}<span><strong>Change my PIN</strong><small>Choose a PIN only you know</small></span><i aria-hidden="true">›</i></button>`;
document.querySelector('#managerMoreScreen .rm-menu')?.insertAdjacentHTML('beforeend',row);

/* ---- Edit person → Give a temporary PIN ---- */
document.addEventListener('click',async e=>{
 const b=e.target.closest('.team-temp-pin-btn');if(!b)return;
 const id=b.dataset.staffId,name=b.dataset.staffName||'this person';
 if(b.dataset.confirm!=='1'){b.dataset.confirm='1';b.textContent='Tap again to give a new temporary PIN';setTimeout(()=>{b.dataset.confirm='';b.textContent='Forgot PIN? Give a temporary PIN';},5000);return;}
 b.dataset.confirm='';b.disabled=true;b.textContent='Working…';
 const note=b.closest('.team-edit-panel')?.querySelector('.team-edit-message');
 try{
  const d=await managerApi('manager_staff_temp_pin',{staff_id:id});
  if(note)note.textContent='';
  showTemp(name,d.temporary_pin);
 }catch(err){if(note)note.textContent=err.message||'Unable to give a temporary PIN.';}
 finally{b.disabled=false;b.textContent='Forgot PIN? Give a temporary PIN';}
});

window.mhOwnPin={require:oldPin=>open(true,oldPin),change:()=>open(false),showTemp};
window.addEventListener('marinara:session-reset',()=>{state=null;close();if(tdlg.open)tdlg.close();});
})();
