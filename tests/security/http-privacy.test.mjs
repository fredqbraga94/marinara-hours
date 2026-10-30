import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {loadHandler} from '../integration/edge-loader.mjs';
const h=await loadHandler(resolve('supabase/functions/marinara-api-v2/Index.ts'));
globalThis.__PG_CREATE_CLIENT=()=>({});
test('API responses prohibit storage by browser and intermediary caches',async()=>{
 const r=await h(new Request('https://isolated.local/api',{method:'GET'}));
 assert.equal(r.status,405);
 assert.equal(r.headers.get('cache-control'),'no-store');
 assert.equal(r.headers.get('x-content-type-options'),'nosniff');
});
