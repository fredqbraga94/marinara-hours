import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage();
 await page.route('**/*',r=>r.fulfill({status:200,contentType:'text/html',body:readFileSync('index.html','utf8')}));
 await page.goto('http://localhost:31499/');
 page.on('dialog',d=>d.accept());
 const result=await page.evaluate(async()=>{
  document.querySelector('#managerScreen').classList.remove('hidden');
  const id='00000000-0000-4000-8000-000000000099';
  workingList.innerHTML=`<div class="staff-clockout-panel" id="clockout-${id}" data-name="Synthetic" data-clock-in="2026-01-01T06:00:00Z"><input class="staff-clockout-input" value="2026-01-01T22:00"><div class="staff-clockout-error"></div><button data-confirm-clockout="${id}">Confirm Clock Out</button></div>`;
  let writes=0;
  managerApi=async(action)=>{
   if(action==='manager_clock_out_staff'){writes++;return {shift:{hours:6}};}
   if(action==='manager_dashboard')return {manager:{role:'manager',status:'off_shift'},counts:{working_now:0,unapproved_shifts:1},working:[],hours:{summary:[]}};
   return [];
  };
  document.querySelector('[data-confirm-clockout]').click();
  await new Promise(r=>setTimeout(r,100));
  return {writes, saving:workingList.textContent.includes('Saving'),working:workingNowCount.textContent,pending:pendingCount.textContent};
 });
 assert.equal(result.writes,1); assert.equal(result.saving,false,'successful Clock Out must never remain Saving');
 assert.equal(result.working,'0');assert.equal(result.pending,'1');
 console.log('PASS manager Clock Out refresh and loading regression');
} finally {await browser.close();}
