// PostgreSQL/WASM fallback for restricted runners. Real SQL, one serialized
// connection. This cannot validate multi-connection races or pg_cron delivery.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync, readdirSync } from 'node:fs';
export async function isolatedDb() {
 const pg = new PGlite({extensions:{pgcrypto,btree_gist}});
 let tail=Promise.resolve();
 const wire=v=>v==null?null:typeof v==='boolean'?(v?'t':'f'):typeof v==='object'?JSON.stringify(v):String(v);
 const pool=role=>({query(sql){
  const run=tail.then(async()=>{
   await pg.exec(`set role ${role}; set timezone to 'UTC'`);
   try {
    const results=await pg.exec(sql);const r=results.at(-1);
    return {rows:(r?.rows||[]).map(row=>r.fields.map(f=>([114,3802].includes(f.dataTypeID)?JSON.stringify(row[f.name]):wire(row[f.name]))))};
   } catch(e){e.pg={code:e.code,message:e.message,details:e.detail,hint:e.hint};throw e;}
   finally {await pg.exec('reset role');}
  });
  tail=run.catch(()=>{});return run;
 }});
 const files=['tests/db/schema_snapshot.sql','supabase/migrations/20261012000000_add_manager_clock_out_staff.sql','tests/integration/prod_manager_functions.sql','tests/db/prod_acl.sql',...readdirSync('supabase/migrations').sort().filter(n=>n>='20261013010000' && (!process.env.AUDIT_BASELINE || !/_audit_(push|device)_scope\.sql$/.test(n))).map(n=>'supabase/migrations/'+n)];
 for(const file of files) await pg.exec(readFileSync(file,'utf8'));
 return {admin:pool('postgres'),svc:pool('service_role'),pg,files,async close(){await tail;await pg.close();}};
}
