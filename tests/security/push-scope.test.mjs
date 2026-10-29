// Real PL/pgSQL in embedded PostgreSQL, synthetic records; no production network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { loadApi, seed } from '../edge/harness.mjs';
const read = p => readFileSync(p, 'utf8');
const extract = (src, name) => {
 const start = src.toLowerCase().indexOf(`create or replace function public.${name}(`);
 assert.ok(start >= 0, name);
 const tag = src.slice(start).match(/as\s+(\$[a-z_]*\$)/i)[1];
 const end = src.indexOf(tag+';', src.indexOf(tag, start)+tag.length);
 return src.slice(start, end + tag.length+1);
};
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const endpoint = n => `https://fcm.googleapis.com/fcm/send/synthetic-${n}`;
const db = new PGlite();
after(async()=>db.close());
await db.exec(`create role anon; create role authenticated; create role service_role;
 create table staff(id uuid primary key, name text, role text, location text, active boolean);
 create table push_subscriptions(endpoint text primary key, staff_id uuid references staff(id), location text, active boolean default true, updated_at timestamptz);
 insert into staff values
 ('${id(1)}','Hawthorne GM','manager','Hawthorne',true),
 ('${id(2)}','Clayfield GM','manager','Clayfield',true),
 ('${id(3)}','Paddington GM','manager','Paddington',true),
 ('${id(4)}','Hawthorne KM','kitchen_manager','Hawthorne',true),
 ('${id(5)}','Worker','staff','Hawthorne',true);
 ${[1,2,3,4].map(n=>`insert into push_subscriptions(endpoint,staff_id,location) select '${endpoint(n)}',id,location from staff where id='${id(n)}';`).join('\n')}`);
await db.exec(extract(read('supabase/migrations/20261013010000_integrity_audit_privileges.sql'), 'mh_manager'));
const original = extract(read('supabase/migrations/20261021040000_push.sql'),'manager_push_unsubscribe');
await db.exec(original);
const migration = readdirSync('supabase/migrations').find(n=>n.endsWith('_audit_push_scope.sql'));
if(migration && !process.env.AUDIT_BASELINE) await db.exec(read('supabase/migrations/'+migration));
const api = await loadApi();
let current = 1;
const fake = seed();
fake.rpc.auth_session = async () => ({ok:true,staff:(await db.query('select * from staff where id=$1',[id(current)])).rows[0]});
fake.rpc.mh_pin_must_change = () => false;
fake.rpc.manager_permissions_mine = () => ({});
fake.rpc.manager_push_unsubscribe = async ({p_manager_id,p_endpoint}) => (await db.query('select public.manager_push_unsubscribe($1,$2) result',[p_manager_id,p_endpoint])).rows[0].result;
async function unsubscribe(n, target) {
 current=n;
 return api.call({action:'manager_push_unsubscribe',token:'synthetic-token',endpoint:endpoint(target)});
}
test('GM cannot disable a phone in either other restaurant through the real API and SQL', async()=>{
 for(const target of [2,3]) {
  const r=await unsubscribe(1,target);
  assert.equal(r.status,200);
  assert.equal(r.body.data.turned_off,0);
  assert.equal((await db.query('select active from push_subscriptions where endpoint=$1',[endpoint(target)])).rows[0].active,true);
 }
});
test('same-unit GM and own-phone KM retain unsubscribe and idempotency',async()=>{
 await db.exec('update push_subscriptions set active=true');
 assert.equal((await unsubscribe(1,4)).body.data.turned_off,1);
 assert.equal((await unsubscribe(4,1)).body.data.turned_off,0);
 assert.equal((await unsubscribe(4,4)).body.data.turned_off,1);
 assert.equal((await unsubscribe(1,1)).body.data.turned_off,1);
});
test('ordinary employee cannot invoke manager unsubscribe',async()=>{
 assert.equal((await unsubscribe(5,1)).status,403);
});
test('fixed SQL function is unavailable to public API roles',async()=>{
 if(!migration || process.env.AUDIT_BASELINE) return;
 const r=await db.query("select has_function_privilege('anon','manager_push_unsubscribe(uuid,text)','execute') a,has_function_privilege('authenticated','manager_push_unsubscribe(uuid,text)','execute') b,has_function_privilege('service_role','manager_push_unsubscribe(uuid,text)','execute') c");
 assert.deepEqual(r.rows[0],{a:false,b:false,c:true});
});
