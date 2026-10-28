// Real Edge handler; only the database/network boundary is replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadHandler } from '../integration/edge-loader.mjs';
const handler = await loadHandler(resolve('supabase/functions/marinara-api-v2/Index.ts'));
const marker = 'SYNTHETIC_PRIVATE_EMPLOYEE_VALUE';
const request = body => new Request('http://isolated.local/', {
  method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body),
});
test('API responses prohibit storage even on authentication errors', async () => {
  globalThis.__PG_CREATE_CLIENT = () => ({rpc: async () => ({data: {ok:false}, error:null})});
  for (const body of [{}, {action:'session_test',token:'synthetic-invalid-token'}]) {
    const res = await handler(request(body));
    assert.match(res.headers.get('cache-control') || '', /no-store/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
});
test('session failures do not copy database messages or details to logs or responses', async () => {
  globalThis.__PG_CREATE_CLIENT = () => ({rpc: async () => ({data:null, error:{
    code:'XX000', message:marker, details:marker, hint:marker,
  }})});
  const logs=[]; const original=console.error;
  console.error=(...args)=>logs.push(JSON.stringify(args));
  try {
    for (const action of ['session_test','session_my_hours','session_clock_in','manager_dashboard']) {
      const res=await handler(request({action,token:'synthetic-token'}));
      assert.equal(res.status,500);
      assert.ok(!(await res.text()).includes(marker));
    }
  } finally { console.error=original; }
  assert.ok(logs.length > 0);
  assert.ok(!logs.join('\n').includes(marker), 'database error content leaked to logs');
  assert.ok(logs.join('\n').includes('XX000'), 'keep a diagnostic code');
});
