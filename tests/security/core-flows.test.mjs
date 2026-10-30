import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {isolatedDb} from './isolated-db.mjs';
import {loadHandler,useDatabase,call,newDeviceSecret,settle} from '../integration/edge-loader.mjs';
import {ID,PIN,reseed} from '../integration/seed.mjs';
const db=await isolatedDb();
after(async()=>{await settle();await db.close();});
await reseed(db);useDatabase(db.svc);
const handler=await loadHandler(resolve('supabase/functions/marinara-api-v2/Index.ts'));
const devices=Object.fromEntries([1,2,3,4,20,21].map(n=>[n,newDeviceSecret()]));
const tokens={};
const one=async sql=>(await db.admin.query(sql)).rows[0]?.[0];
const api=(n,body)=>call(handler,{...body,token:tokens[n],device:devices[n]});
async function login(n,pin=PIN[ID(n)]) {const r=await api(n,{action:'login',pin});assert.equal(r.status,200,JSON.stringify(r.body));tokens[n]=r.body.session.token;return r;}
test('all versioned SQL migrations apply in isolated PostgreSQL',()=>{assert.ok(db.files.length>=30);});
test('employee and manager login; PIN hash and token never returned by data endpoints',async()=>{
 for(const n of [1,2,3,4])await login(n);
 const r=await api(4,{action:'session_my_hours'});assert.equal(r.status,200,JSON.stringify(r.body));
 assert.doesNotMatch(JSON.stringify(r.body),/pin_hash|token_hash|9104/);
});
test('clock in, duplicate refusal, break start/end, clock out and duplicate refusal',async()=>{
 for(const action of ['session_clock_in','session_start_break','session_end_break','session_clock_out']) {
  const r=await api(4,{action});assert.equal(r.status,200,action+': '+JSON.stringify(r.body));
  if(action==='session_clock_in')assert.ok((await api(4,{action})).status>=400);
 }
 assert.ok((await api(4,{action:'session_clock_out'})).status>=400);
 assert.equal(await one(`select count(*) from shifts where staff_id='${ID(4)}' and clock_out is null`),'0');
});
test('staff cannot invoke manager APIs or override self identity; forged tokens rejected',async()=>{
 for(const action of ['manager_team','manager_approve_shift','manager_device_code'])assert.equal((await api(4,{action,staff_id:ID(1)})).status,403);
 const r=await api(4,{action:'session_my_hours',staff_id:ID(1)});assert.equal(r.status,200);
 assert.doesNotMatch(JSON.stringify(r.body),/Test General Manager/);
 assert.equal((await call(handler,{action:'session_my_hours',token:'forged',device:devices[4]})).status,401);
});
test('managers cannot read or modify people in Clayfield or Paddington',async()=>{
 for(const [n,location] of [[20,'Clayfield'],[21,'Paddington']]){
  await db.admin.query(`insert into staff(id,name,pin_hash,department,location,role,active) values ('${ID(n)}','Test ${location}',extensions.crypt('${920000+n}',extensions.gen_salt('bf',6)),'Kitchen','${location}','manager',true)`);
  await login(n,String(920000+n));
  const team=await api(n,{action:'manager_team'});assert.equal(team.status,200,JSON.stringify(team.body));
  assert.doesNotMatch(JSON.stringify(team.body),/Test Kitchen A|Test General Manager/);
  const denied=await api(1,{action:'manager_update_staff',staff_id:ID(n),name:'Unauthorized',department:'Kitchen'});
  assert.ok(denied.status>=400,JSON.stringify(denied.body));
 }
});
test('roster creation/edit, approvals and public holidays retain authorized access',async()=>{
 for(const action of ['manager_dashboard','manager_roster_week','manager_hours','manager_approvals']) {
  const r=await api(1,{action});assert.equal(r.status,200,action+': '+JSON.stringify(r.body));
 }
 const week=(await api(1,{action:'manager_roster_week'})).body.data;
 assert.ok(week);
 for(const code of ['L','D','LD','OFF']) { const edit=await api(1,{action:'manager_roster_set',staff_id:ID(4),work_date:'2026-11-02',code});assert.equal(edit.status,200,JSON.stringify(edit.body)); }
 const r=await api(1,{action:'manager_approve_shift',shift_id:'20000000-0000-4000-8000-000000000003'});
 assert.equal(r.status,200,JSON.stringify(r.body));
});
test('logout revokes token; session cannot be reused',async()=>{
 assert.equal((await api(4,{action:'session_logout'})).status,200);
 assert.equal((await api(4,{action:'session_my_hours'})).status,401);
});
test('enforced devices block unknown browsers; known device PIN abuse is limited',async()=>{
 await db.admin.query("update auth_settings set device_mode='enforce'");
 const unknown=await call(handler,{action:'login',pin:PIN[ID(1)],device:newDeviceSecret()});assert.equal(unknown.status,403);
 let locked=false;
 for(let i=0;i<6;i++){const r=await api(2,{action:'login',pin:'000000'});if(r.status===429)locked=true;}
 assert.equal(locked,true);
 assert.equal((await api(3,{action:'manager_team'})).status,200,'other device unaffected');
});
test('public database roles cannot read staff or execute privileged functions',async()=>{
 assert.equal(await one("select count(*) from pg_proc where pronamespace='public'::regnamespace and (has_function_privilege('anon',oid,'execute') or has_function_privilege('authenticated',oid,'execute'))"),'0');
 assert.equal(await one("select count(*) from pg_class where relnamespace='public'::regnamespace and relkind='r' and not relrowsecurity"),'0');
});

test('approved Administrator unit switch remains usable; the owner manages the devices of the unit being looked at',async()=>{
 assert.equal((await api(1,{action:'manager_unit_set',location:'Clayfield'})).status,200);
 const team=await api(1,{action:'manager_team'});assert.equal(team.status,200);assert.match(JSON.stringify(team.body),/Test Clayfield/);assert.doesNotMatch(JSON.stringify(team.body),/Test Kitchen A/);
 const list=await api(1,{action:'manager_devices'});assert.equal(list.status,200);assert.doesNotMatch(JSON.stringify(list.body),/Test Kitchen A/,'no Hawthorne people while looking at Clayfield');
 assert.equal((await api(2,{action:'manager_unit_set',location:'Paddington'})).status,403);
 assert.equal((await api(1,{action:'manager_unit_set',location:'Hawthorne'})).status,200);
});
test('PIN change keeps initiating session and revokes the other session atomically',async()=>{
 await db.admin.query("update auth_settings set device_mode='grace'");
 const a=newDeviceSecret(),b=newDeviceSecret();
 const x=await call(handler,{action:'login',pin:PIN[ID(5)],device:a});const y=await call(handler,{action:'login',pin:PIN[ID(5)],device:b});assert.equal(x.status,200);assert.equal(y.status,200);
 const token=x.body.session.token,other=y.body.session.token;
 const failed=await call(handler,{action:'change_pin',token,device:a,old_pin:'0000',new_pin:'486291'});assert.equal(failed.status,400);
 assert.equal((await call(handler,{action:'session_test',token:other,device:b})).status,200);
 const changed=await call(handler,{action:'change_pin',token,device:a,old_pin:PIN[ID(5)],new_pin:'486291'});assert.equal(changed.status,200,JSON.stringify(changed.body));
 assert.equal((await call(handler,{action:'session_test',token,device:a})).status,200);
 assert.equal((await call(handler,{action:'session_test',token:other,device:b})).status,401);
});

test('notification registration, listing and unsubscribe stay in home unit while Administrator views Clayfield',async()=>{
 const key='A'.repeat(87),auth='B'.repeat(22);
 const local='https://fcm.googleapis.com/fcm/send/synthetic-home';
 const foreign='https://fcm.googleapis.com/fcm/send/synthetic-clayfield';
 assert.equal((await api(20,{action:'manager_push_subscribe',endpoint:foreign,p256dh:key,auth})).status,200);
 const before=await one(`select row_to_json(p)::text from push_subscriptions p where endpoint='${foreign}'`);
 const takeover=await api(1,{action:'manager_push_subscribe',endpoint:foreign,p256dh:'C'.repeat(87),auth:'D'.repeat(22)});assert.ok(takeover.status>=400,'foreign subscription upsert must be denied');
 assert.equal(await one(`select row_to_json(p)::text from push_subscriptions p where endpoint='${foreign}'`),before);
 assert.equal((await api(1,{action:'manager_unit_set',location:'Clayfield'})).status,200);
 const switchedTakeover=await api(1,{action:'manager_push_subscribe',endpoint:foreign,p256dh:'C'.repeat(87),auth:'D'.repeat(22)});assert.ok(switchedTakeover.status>=400);
 assert.equal(await one(`select row_to_json(p)::text from push_subscriptions p where endpoint='${foreign}'`),before);
 assert.equal((await api(1,{action:'manager_push_subscribe',endpoint:local,p256dh:key,auth})).status,200);
 assert.equal(await one(`select location from push_subscriptions where endpoint='${local}'`),'Hawthorne');
 const list=await api(1,{action:'manager_push_list'});assert.equal(list.status,200);assert.doesNotMatch(JSON.stringify(list.body),/synthetic-clayfield/);
 const refused=await api(1,{action:'manager_push_unsubscribe',endpoint:foreign});assert.equal(refused.status,200);assert.equal(refused.body.data.turned_off,0);
 assert.equal(await one(`select active from push_subscriptions where endpoint='${foreign}'`),'t');
 assert.equal((await api(1,{action:'manager_push_unsubscribe',endpoint:local})).body.data.turned_off,1);
 assert.equal((await api(1,{action:'manager_unit_set',location:'Hawthorne'})).status,200);
});
