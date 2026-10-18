import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
test('Export creates a PDF instead of opening a print window',async()=>{
 const html=readFileSync('index.html','utf8');
 const code=html.slice(html.indexOf('exportTimesheetsPdfBtn.addEventListener("click"'),html.indexOf('/* TEAM */'));
 let handler,opened=false,generated=false;
 const context={exportTimesheetsPdfBtn:{addEventListener:(n,h)=>handler=h},currentTimesheetsData:{summary:[],shifts:[{staff_id:'a',status:'completed',approved:true,clock_out:'2026-10-12'}]},timesheetsMessage:{},timesheetsWeek:{textContent:'Week'},escapeHtml:s=>s,window:{open(){opened=true;return null;},MarinaraPdf:{async open(){generated=true;}}},document:{querySelector:()=>({src:''})},Date,Set};
 vm.runInNewContext(code,context);await handler();assert.equal(opened,false);assert.equal(generated,true);
});
