import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadApi,seed,captureConsole} from '../edge/harness.mjs';
const api=await loadApi();
test('authentication database failures never log internal messages or row details',async()=>{
 const db=seed();db.rpc.auth_session=()=>{throw Error('SYNTHETIC_PRIVATE_EMPLOYEE_DETAIL');};
 const logs=captureConsole();
 try{const r=await api.call({action:'session_test',token:'synthetic'});assert.equal(r.status,500);assert.doesNotMatch(logs.lines.join('\n'),/SYNTHETIC_PRIVATE/);assert.doesNotMatch(JSON.stringify(r.body),/SYNTHETIC_PRIVATE/);}
 finally{logs.restore();}
});
test('manager database errors log only a stable code while retaining a generic response',async()=>{
 const db=seed();db.rpc.auth_session=()=>({ok:true,staff:db.tables.staff[0]});db.rpc.mh_pin_must_change=()=>false;
 db.rpc.manager_push_unsubscribe=()=>{throw Error('SYNTHETIC_PRIVATE_EMPLOYEE_DETAIL');};
 const logs=captureConsole();
 try{const r=await api.call({action:'manager_push_unsubscribe',token:'synthetic',endpoint:'https://fcm.googleapis.com/synthetic'});assert.ok(r.status>=400);assert.doesNotMatch(logs.lines.join('\n'),/SYNTHETIC_PRIVATE/);assert.doesNotMatch(JSON.stringify(r.body),/SYNTHETIC_PRIVATE/);}
 finally{logs.restore();}
});
