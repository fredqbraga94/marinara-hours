import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
function worker() {
 const handlers={},stored=[],deleted=[],waits=[];
 const cache={addAll:async()=>{},put:async(req)=>stored.push(req.url)};
 const scope='https://app.example/marinara-hours/';
 vm.runInNewContext(readFileSync('sw.js','utf8'),{
  self:{registration:{scope},location:new URL(scope+'sw.js'),addEventListener:(k,fn)=>handlers[k]=fn,skipWaiting(){},clients:{claim(){}}},
  URL,fetch:async()=>new Response('synthetic private data'),
  caches:{open:async()=>cache,match:async()=>undefined,keys:async()=>['marinara-hours-shell-v1','another-app-cache'],delete:async key=>deleted.push(key)}
 });
 return {handlers,stored,deleted,waits,async request(url){let p;handlers.fetch({request:new Request(url),respondWith:v=>p=v,waitUntil:v=>waits.push(v)});await p;await Promise.all(waits);await new Promise(r=>setImmediate(r));}};
}
test('legacy worker never caches API, reports, query URLs or cross-origin responses',async()=>{
 const w=worker();
 for(const url of ['https://api.example/rest/v1/staff','https://app.example/marinara-hours/private-report.pdf','https://app.example/marinara-hours/index.html?token=synthetic']) await w.request(url);
 assert.deepEqual(w.stored,[]);
});
test('activation removes only this app legacy caches',async()=>{
 const w=worker(); let p;w.handlers.activate({waitUntil:v=>p=v});await p;
 assert.deepEqual(w.deleted,['marinara-hours-shell-v1']);
});
