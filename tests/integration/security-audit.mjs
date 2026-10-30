// Isolated PostgreSQL and real current Edge handler. Never contacts production.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {startProdLikeDb, root} from './pgenv.mjs';
import {loadHandler,useDatabase,call,newDeviceSecret} from './edge-loader.mjs';
import {ID,PIN,reseed} from './seed.mjs';
const db=await startProdLikeDb();
try {
  for(const f of readdirSync(resolve(root,'supabase/migrations')).filter(f=>f>='20261013010000').sort()) db.mustFile(`supabase/migrations/${f}`);
  await reseed(db);
  await db.admin.query(`update public.staff set location='Clayfield' where id in ('${ID(2)}','${ID(6)}'); update public.staff set department='Kitchen' where id='${ID(6)}'; update public.staff set location='Paddington' where id in ('${ID(3)}','${ID(7)}');`);
  useDatabase(db.svc);
  const h=await loadHandler(resolve(root,'supabase/functions/marinara-api-v2/Index.ts'));
  const dev=Object.fromEntries([1,2,3,4].map(n=>[n,newDeviceSecret()]));
  const tokens={};
  for(const n of [1,2,3,4]) {
    const r=await call(h,{action:'login',pin:PIN[ID(n)],device:dev[n]});
    assert.equal(r.status,200,JSON.stringify(r.body));tokens[n]=r.body.session.token;
  }
  const api=(n,body)=>call(h,{...body,token:tokens[n],device:dev[n]});
  for(const [n,allowed,blocked] of [[1,4,6],[2,6,4],[3,7,4]]) {
    const r=await api(n,{action:'manager_team',location:'Hawthorne'});
    assert.equal(r.status,200,JSON.stringify(r.body));
    assert.ok(r.body.data.team.some(s=>s.id===ID(allowed)));
    assert.ok(!r.body.data.team.some(s=>s.id===ID(blocked)));
    const denied=await api(n,{action:'manager_roster_set',staff_id:ID(blocked),work_date:'2026-11-02',code:'L'});
    assert.ok([403,404].includes(denied.status),JSON.stringify(denied));
  }
  console.log('PASS three-location team isolation and cross-location roster writes denied');
  assert.equal((await api(4,{action:'manager_team',role:'manager'})).status,403);
  for(const action of ['session_clock_in','session_start_break','session_end_break','session_clock_out']) {
    const r=await api(4,{action,staff_id:ID(7)});
    assert.equal(r.status,200,JSON.stringify(r.body));
  }
  const count=(await db.admin.query(`select count(*) from public.shifts where staff_id='${ID(7)}'`)).rows[0][0];
  assert.equal(count,'1','spoofed staff id must not create a shift for another employee');
  const invalid=await call(h,{action:'session_clock_in',token:'invalid',device:dev[4]});assert.equal(invalid.status,401);
  assert.equal((await api(4,{action:'session_logout'})).status,200);
  assert.equal((await api(4,{action:'session_test'})).status,401);
  console.log('PASS staff privilege escalation denied; own clock/break flow; invalid and revoked sessions denied');
  const pinDevices=[newDeviceSecret(),newDeviceSecret()];
  const pinSessions=[];
  for(const device of pinDevices) {
    const r=await call(h,{action:'login',pin:PIN[ID(5)],device});
    assert.equal(r.status,200);pinSessions.push(r.body.session.token);
  }
  const pinRequest={action:'change_pin',token:pinSessions[0],device:pinDevices[0],old_pin:PIN[ID(5)],new_pin:'486291'};
  assert.equal((await call(h,{...pinRequest,old_pin:'0000'})).status,400);
  assert.equal((await call(h,{action:'session_test',token:pinSessions[1],device:pinDevices[1]})).status,200,'failed PIN changes must preserve other sessions');
  // Fail revocation inside PostgreSQL: changing the PIN must roll back too.
  await db.admin.query(`create function public.test_revoke_failure() returns trigger language plpgsql as $$begin raise exception 'SYNTHETIC_REVOKE_FAILURE'; end$$; create trigger test_revoke_failure before update of revoked_at on public.staff_sessions for each row execute function public.test_revoke_failure();`);
  try {
    assert.equal((await call(h,pinRequest)).status,500);
    const unchanged=(await db.admin.query(`select pin_hash=extensions.crypt('9105',pin_hash) from public.staff where id='${ID(5)}'`)).rows[0][0];
    assert.equal(unchanged,'t','revocation failure must roll back PIN change');
  } finally {
    await db.admin.query('drop trigger test_revoke_failure on public.staff_sessions; drop function public.test_revoke_failure();');
  }
  const change=await call(h,{action:'change_pin',token:pinSessions[0],device:pinDevices[0],old_pin:PIN[ID(5)],new_pin:'486291'});
  assert.equal(change.status,200,JSON.stringify(change.body));
  assert.equal((await call(h,{action:'session_test',token:pinSessions[0],device:pinDevices[0]})).status,200,'keep the current session after PIN change');
  assert.equal((await call(h,{action:'session_test',token:pinSessions[1],device:pinDevices[1]})).status,401,'PIN change must revoke the other device session');
  console.log('PASS PIN change: wrong PIN preserves sessions; failed revocation rolls back PIN; success preserves current device and revokes others');
  // Hold a successful PIN change uncommitted while an old-PIN login starts.
  // The login must block on the same employee row, then recheck the new hash.
  const controller=await db.admin.acquire();
  let racingLogin; let loginFinished=false; let blocked=false;
  try {
    await controller.query('begin');
    const hash=createHash('sha256').update(pinSessions[0]).digest('hex');
    const changed=await controller.query(`select public.staff_change_pin_secure('${ID(5)}','486291','483719','${hash}')`);
    assert.equal(JSON.parse(changed.rows[0][0]).ok,true);
    racingLogin=call(h,{action:'login',pin:'486291',device:newDeviceSecret()}).then(r=>{loginFinished=true;return r;});
    for(let i=0;i<200;i++) {
      const r=await db.admin.query(`select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and query like 'select to_json(public.auth_pin_login(%' and wait_event_type='Lock')`);
      if(r.rows[0][0]==='t'){blocked=true;break;}
      if(loginFinished)break;
      await new Promise(r=>setTimeout(r,10));
    }
    assert.ok(blocked,'old-PIN login must wait for the PIN-change transaction, not issue a concurrent session');
    await controller.query('commit');
    assert.equal((await racingLogin).status,401,'old PIN must be rechecked after waiting');
  } finally {
    await controller.query('rollback');db.admin.release(controller);
    if(racingLogin)await racingLogin;
  }
  console.log('PASS concurrent old-PIN login waits for PIN change and is refused afterwards');
  const acl=(await db.admin.query(`select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))`)).rows[0][0];
  assert.equal(acl,'0');
  console.log('PASS public roles cannot execute application RPCs');
} finally {db.stop();}
