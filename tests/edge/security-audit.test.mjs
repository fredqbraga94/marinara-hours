import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadApi, seed, captureConsole } from './harness.mjs';

// Production handler, with synthetic transport only. No Supabase requests.
test('API responses forbid storage of session and employee data', async () => {
  seed();
  const api = await loadApi();
  for (const method of ['GET','POST']) {
    const response = await api.handle(new Request('https://isolated.test/', {
      method, ...(method === 'POST' ? {body:'null'} : {})
    }));
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  }
});

function worker(file) {
  const listeners = {}, opened = [];
  const scope = 'https://example.test/marinara-hours/';
  const context = vm.createContext({URL, console,
    fetch:async()=>({clone(){return this;}}),
    self: {addEventListener:(n,fn)=>listeners[n]=fn, skipWaiting(){},
      registration:{scope}, clients:{claim(){}, matchAll:async()=>[],openWindow:async u=>opened.push(u)}},
    caches:{keys:async()=>[],delete:async()=>true,open:async()=>({put:async()=>{}})},
  });
  vm.runInContext(readFileSync(file,'utf8'),context);
  return {listeners, opened, scope};
}

test('legacy worker never intercepts API/private GET requests', () => {
  const w=worker('sw.js');
  let intercepted=false;
  w.listeners.fetch?.({request:{method:'GET',url:'https://api.example.test/private'},respondWith(){intercepted=true;}});
  assert.equal(intercepted,false);
});

test('push click rejects external and script destinations', async () => {
  for (const url of ['https://evil.test/phish','javascript:alert(1)','//evil.test/path','https://example.test/other-app/']) {
    const w=worker('push-sw.js');let pending;
    w.listeners.notificationclick({notification:{close(){},data:{url}},waitUntil(p){pending=p;}});
    await pending;
    assert.equal(w.opened[0],w.scope);
  }
});

test('push click preserves in-app destinations', async () => {
  const w=worker('push-sw.js');let pending;
  w.listeners.notificationclick({notification:{close(){},data:{url:'./?tab=roster'}},waitUntil(p){pending=p;}});
  await pending;
  assert.equal(w.opened[0],w.scope+'?tab=roster');
});

// Auth RPC is a controlled boundary here; these verify Edge authorization,
// not the SQL implementation (that requires the PostgreSQL integration suite).
function authenticatedDb(id) {
  const db=seed();
  db.rpc.auth_session=()=>({ok:true,staff:db.tables.staff.find(s=>s.id===id),expires_at:'2099-01-01T00:00:00Z'});
  db.rpc.mh_pin_must_change=()=>false;
  db.rpc.manager_permissions_mine=()=>({});
  return db;
}

test('employee cannot invoke manager endpoints by forging role/location', async () => {
  const api=await loadApi();
  const db=authenticatedDb('k1');
  for (const action of ['manager_team','manager_hours','manager_delete_shift','manager_roster_week']) {
    const r=await api.call({action,token:'synthetic',role:'manager',location:'Clayfield',staff_id:'gm'});
    assert.equal(r.status,403,action);
  }
  assert.equal(db.rpcCalls.some(c=>c.name==='manager_delete_shift'),false);
});

test('staff clock operations derive employee ID from authenticated session', async () => {
  const api=await loadApi();const db=authenticatedDb('k1');
  for (const [action,rpc] of [['session_clock_in','clock_in_by_id'],['session_clock_out','clock_out_by_id'],['session_start_break','start_break_by_id'],['session_end_break','end_break_by_id']]) {
    db.rpc[rpc]=args=>({staff_id:args.p_staff_id});
    const r=await api.call({action,token:'synthetic',staff_id:'o1',location:'Paddington'});
    assert.equal(r.status,200,action);
    assert.equal(r.body.data.staff_id,'k1');
  }
});

test('manager team ignores requested location and filters to session venue', async () => {
  const api=await loadApi();authenticatedDb('gm');
  const r=await api.call({action:'manager_team',token:'synthetic',location:'Clayfield'});
  assert.equal(r.status,200);
  const people=r.body.data.team;
  assert.ok(Array.isArray(people));assert.ok(people.length>0);
  assert.ok(people.every(p=>p.location==='Hawthorne'));
  assert.ok(!people.some(p=>p.id==='o1'));
});

test('active push worker removes old app caches while preserving other applications', async () => {
  const listeners={},deleted=[];
  vm.runInNewContext(readFileSync('push-sw.js','utf8'),{
    self:{addEventListener:(n,f)=>listeners[n]=f,clients:{claim:async()=>{}},skipWaiting(){}},
    caches:{keys:async()=>['marinara-hours-shell-v1','other-app-cache'],delete:async k=>deleted.push(k)},
  });
  let pending;listeners.activate({waitUntil(p){pending=p;}});await pending;
  assert.deepEqual(deleted,['marinara-hours-shell-v1']);
});


test('session failures log a diagnostic code without database messages or employee data', async () => {
  const api=await loadApi();const db=seed();
  db.rpc.auth_session=()=>{throw new Error('Synthetic Employee Private token=synthetic-secret');};
  const logs=captureConsole();
  let r;
  try {r=await api.call({action:'session_test',token:'synthetic'});} finally {logs.restore();}
  assert.equal(r.status,500);
  assert.ok(logs.lines.length>0);
  assert.ok(!logs.lines.join(' ').includes('Synthetic Employee Private'));
  assert.ok(!logs.lines.join(' ').includes('synthetic-secret'));
});

const source=readFileSync('supabase/functions/marinara-api-v2/Index.ts','utf8');
const actionBlock=source.slice(source.indexOf('const managerActions ='),source.indexOf('if (!managerActions.has(action))'));
const managerActions=[...new Set([...actionBlock.matchAll(/"(manager_[a-z_]+)"/g)].map(m=>m[1]))];
assert.ok(managerActions.length>50,'manager action inventory must be found');

test('every registered manager operation rejects missing sessions', async () => {
  const api=await loadApi();const db=seed();
  for(const action of managerActions){
    const missing=await api.call({action});assert.equal(missing.status,400,action);
    const pinOnly=await api.call({action,pin:'0000'});assert.equal(pinOnly.status,401,action);
  }
  assert.equal(db.rpcCalls.length,0,'no privileged SQL before authentication');
});

test('every registered manager operation rejects employee privilege escalation', async () => {
  const api=await loadApi();const db=authenticatedDb('k1');
  for(const action of managerActions){
    const r=await api.call({action,token:'synthetic',role:'manager',manager_id:'gm'});
    assert.equal(r.status,403,action);
  }
  assert.ok(db.rpcCalls.every(c=>['auth_session','mh_pin_must_change'].includes(c.name)));
});
