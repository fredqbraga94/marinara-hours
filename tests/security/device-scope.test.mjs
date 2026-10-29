import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isolatedDb} from './isolated-db.mjs';
import {loadHandler,useDatabase,call,newDeviceSecret,settle} from '../integration/edge-loader.mjs';
import {ID,PIN,reseed} from '../integration/seed.mjs';
const db=await isolatedDb();after(async()=>{await settle();await db.close();});
await reseed(db);useDatabase(db.svc);
const h=await loadHandler(resolve('supabase/functions/marinara-api-v2/Index.ts'));
await db.admin.query(`insert into staff(id,name,pin_hash,department,location,role,active) values ('${ID(20)}','Test Clayfield GM',extensions.crypt('920020',extensions.gen_salt('bf',6)),'Kitchen','Clayfield','manager',true)`);
const dev={1:newDeviceSecret(),2:newDeviceSecret(),20:newDeviceSecret()},tokens={};
for(const n of [1,2,20]){const r=await call(h,{action:'login',pin:n===20?'920020':PIN[ID(n)],device:dev[n]});assert.equal(r.status,200,JSON.stringify(r.body));tokens[n]=r.body.session.token;}
const api=(n,body)=>call(h,{...body,token:tokens[n],device:dev[n]});
const one=async sql=>(await db.admin.query(sql)).rows[0]?.[0];
const foreign=await one(`select id from auth_devices where last_staff_id='${ID(20)}'`);
test('venue manager cannot list foreign devices or disclose foreign staff names',async()=>{
 const r=await api(1,{action:'manager_devices'});assert.equal(r.status,200);
 assert.doesNotMatch(JSON.stringify(r.body),/Test Clayfield GM/);
 assert.equal(r.body.data.devices.some(d=>d.id===foreign),false);
});
test('foreign device rename, unlock and revoke are denied, preserving foreign sessions',async()=>{
 for(const action of ['manager_device_rename','manager_device_unlock','manager_device_revoke']){
  const r=await api(1,{action,device_id:foreign,label:'Unauthorized'});assert.ok(r.status>=400,action+': '+JSON.stringify(r.body));
 }
 assert.equal((await api(20,{action:'session_test'})).status,200);
});
test('venue manager cannot change a security setting affecting other restaurants',async()=>{
 await db.admin.query("update auth_settings set device_mode='enforce'");
 const r=await api(1,{action:'manager_auth_mode',mode:'grace'});assert.equal(r.status,403);
 assert.equal(await one('select device_mode from auth_settings'),'enforce');
 assert.equal((await api(1,{action:'manager_devices'})).body.data.can_change_mode,false);
});
test('same-unit administration remains usable and revocation invalidates the target session',async()=>{
 const local=await one(`select id from auth_devices where last_staff_id='${ID(2)}'`);
 assert.equal((await api(1,{action:'manager_device_rename',device_id:local,label:'Synthetic kitchen phone'})).status,200);
 assert.equal((await api(1,{action:'manager_device_unlock',device_id:local})).status,200);
 assert.equal((await api(1,{action:'manager_device_revoke',device_id:local})).status,200);
 assert.equal((await api(2,{action:'session_test'})).status,401);
});

test('migration is repeatable; mixed-unit legacy devices require explicit owner assignment',async()=>{
 const hash='a'.repeat(64);
 await db.admin.query(`insert into auth_devices(device_hash,status,approved_via,approved_by,last_staff_id) values ('${hash}','approved','session','${ID(1)}','${ID(20)}'); update auth_devices set management_location=null where device_hash='${hash}'`);
 const migration=readFileSync('supabase/migrations/20261030020000_audit_device_scope.sql','utf8');
 await db.admin.query(migration);
 assert.equal(await one(`select management_location from auth_devices where device_hash='${hash}'`),null);
 const unassigned=await one(`select id from auth_devices where device_hash='${hash}'`);
 assert.equal((await api(1,{action:'manager_devices'})).body.data.devices.some(d=>d.id===unassigned),false);
 assert.ok((await api(1,{action:'manager_device_revoke',device_id:unassigned})).status>=400);
 for(const role of ['anon','authenticated'])assert.equal(await one(`select has_function_privilege('${role}','auth_revoke_device(uuid,uuid)','execute')`),'f');
});
test('foreign users of a locally owned shared device do not appear in its history',async()=>{
 const foreignLogin=await call(h,{action:'login',pin:'920020',device:dev[1]});assert.equal(foreignLogin.status,200);
 const r=await api(1,{action:'manager_devices'});assert.equal(r.status,200);
 assert.doesNotMatch(JSON.stringify(r.body),/Test Clayfield GM/);
});

test('single-unit mode control remains functional; SQL rollback and reapply preserve staff and shifts',async()=>{
 await db.admin.query(`update staff set active=false where id='${ID(20)}'`);
 assert.equal((await api(1,{action:'manager_auth_mode',mode:'enforce'})).status,200);
 await db.admin.query(`update staff set active=true where id='${ID(20)}'`);
 const state=()=>one("select md5((select string_agg(id::text||pin_hash||name||role||location,',' order by id) from staff)||coalesce((select string_agg(id::text||staff_id::text||clock_in::text||coalesce(clock_out::text,''),',' order by id) from shifts),''))");
 const before=await state();
 await db.admin.query(readFileSync('supabase/rollback/20261030020000_audit_device_scope.down.sql','utf8'));
 assert.equal(await state(),before);
 await db.admin.query(readFileSync('supabase/migrations/20261030020000_audit_device_scope.sql','utf8'));
 assert.equal(await state(),before);
 assert.ok((await api(1,{action:'manager_device_revoke',device_id:foreign})).status>=400);
});
test('foreign pairing codes cannot bypass device revocation or rewrite ownership',async()=>{
 const local=await one(`select id from auth_devices where last_staff_id='${ID(2)}'`);
 const issued=await api(20,{action:'manager_device_code',label:'Foreign code'});assert.equal(issued.status,200);
 const oldLabel=await one(`select label from auth_devices where id='${local}'`);
 const r=await call(h,{action:'device_pair',device:dev[2],code:issued.body.data.code,label:'Unauthorized rename'});
 assert.ok(r.status>=400,JSON.stringify(r.body));
 assert.equal(await one(`select status from auth_devices where id='${local}'`),'revoked');
 assert.equal(await one(`select label from auth_devices where id='${local}'`),oldLabel);
 const codeHash=createHash('sha256').update(issued.body.data.code.replace(/[^A-Z0-9]/g,'')).digest('hex');
 assert.equal(await one(`select used_at is null from auth_pairing_codes where code_hash='${codeHash}'`),'t');
 const own=await api(1,{action:'manager_device_code',label:'Own-unit code'});assert.equal(own.status,200);
 const paired=await call(h,{action:'device_pair',device:dev[2],code:own.body.data.code});assert.equal(paired.status,200,JSON.stringify(paired.body));
 assert.equal(await one(`select management_location from auth_devices where id='${local}'`),'Hawthorne');
});
test('inactive issuers cannot authorize new devices; owner recovery stays available',async()=>{
 const issued=await api(20,{action:'manager_device_code',label:'Issuer deactivated'});assert.equal(issued.status,200);
 await db.admin.query(`update staff set active=false where id='${ID(20)}'`);
 const r=await call(h,{action:'device_pair',device:newDeviceSecret(),code:issued.body.data.code});assert.ok(r.status>=400,JSON.stringify(r.body));
 await db.admin.query(`update staff set active=true where id='${ID(20)}'`);
 const ownerCode=await one("select public.auth_owner_pairing_code('Synthetic owner recovery')");
 const recovered=await call(h,{action:'device_pair',device:dev[2],code:ownerCode});assert.equal(recovered.status,200,JSON.stringify(recovered.body));
});
