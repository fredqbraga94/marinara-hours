// Evidence for an OPEN finding, not a regression success test. Synthetic only.
// Exit 2 means the authorization gap was reproduced; exit 0 means not reproduced.
import {resolve} from 'node:path';
import {isolatedDb} from './isolated-db.mjs';
import {loadHandler,useDatabase,call,newDeviceSecret,settle} from '../integration/edge-loader.mjs';
import {ID,PIN,reseed} from '../integration/seed.mjs';
const db=await isolatedDb();
try {
 await reseed(db);useDatabase(db.svc);
 await db.admin.query(`insert into staff(id,name,pin_hash,department,location,role,active) values ('${ID(20)}','Test Clayfield GM',extensions.crypt('920020',extensions.gen_salt('bf',6)),'Kitchen','Clayfield','manager',true)`);
 const h=await loadHandler(resolve('supabase/functions/marinara-api-v2/Index.ts'));
 const dev1=newDeviceSecret(),dev2=newDeviceSecret();
 const a=await call(h,{action:'login',pin:PIN[ID(1)],device:dev1});
 const b=await call(h,{action:'login',pin:'920020',device:dev2});
 if(a.status!==200||b.status!==200)throw Error('Fixture login failed');
 const token=a.body.session.token;
 const listing=await call(h,{action:'manager_devices',token,device:dev1});
 const foreign=listing.body.data?.devices?.find(d=>d.last_staff==='Test Clayfield GM');
 const revoked=foreign?await call(h,{action:'manager_device_revoke',token,device:dev1,device_id:foreign.id}):null;
 const denied=await call(h,{action:'session_test',token:b.body.session.token,device:dev2});
 const result={finding:'AUDIT-01',status:foreign?'OPEN':'NOT_REPRODUCED',foreign_device_listed:!!foreign,foreign_staff_name_disclosed:!!foreign,foreign_device_revoke_status:revoked?.status,foreign_session_after_revoke:denied.status};
 console.log(JSON.stringify(result,null,2));
 if(foreign&&revoked?.status===200&&denied.status===401)process.exitCode=2;
} finally {await settle();await db.close();}
