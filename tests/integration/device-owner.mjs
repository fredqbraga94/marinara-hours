// The Administrator is the owner of every restaurant: they manage the devices of
// the unit they are looking at and are the only one who changes the device mode.
// Real PostgreSQL (production-like) and the current server; synthetic data only.
// Run: node tests/integration/device-owner.mjs
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {startProdLikeDb, root} from './pgenv.mjs';
import {loadHandler, useDatabase, call, newDeviceSecret} from './edge-loader.mjs';
import {ID, PIN, reseed} from './seed.mjs';

const db = await startProdLikeDb();
let failures = 0;
const check = async (name, fn) => {
  try { const note = await fn(); console.log(`  ✔ ${name}${note ? `\n      ${note}` : ''}`); }
  catch (e) { failures++; console.log(`  ✖ ${name}\n      ${String(e?.stack || e).split('\n').slice(0, 6).join('\n      ')}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=device owner ${name.slice(0, 60)}::${String(e?.message || e).slice(0, 800)}`); }
};
try {
  for (const f of readdirSync(resolve(root, 'supabase/migrations')).filter(f => f >= '20261013010000').sort()) db.mustFile(`supabase/migrations/${f}`);
  await reseed(db);
  // A Kitchen Manager working in Clayfield (synthetic).
  await db.admin.query(`update public.staff set location='Clayfield' where id='${ID(3)}'`);
  useDatabase(db.svc);
  const h = await loadHandler(resolve(root, 'supabase/functions/marinara-api-v2/Index.ts'));
  const dev = Object.fromEntries([1, 2, 3].map(n => [n, newDeviceSecret()]));
  const tokens = {};
  for (const n of [1, 2, 3]) {
    const r = await call(h, {action: 'login', pin: PIN[ID(n)], device: dev[n]});
    assert.equal(r.status, 200, JSON.stringify(r.body)); tokens[n] = r.body.session.token;
  }
  const api = (n, body) => call(h, {...body, token: tokens[n], device: dev[n]});
  const one = async sql => (await db.admin.query(sql)).rows[0]?.[0];

  await check('devices take the unit of the person who first used them', async () => {
    assert.equal(await one(`select management_location from public.auth_devices where last_staff_id='${ID(3)}'`), 'Clayfield');
    assert.equal(await one(`select management_location from public.auth_devices where last_staff_id='${ID(2)}'`), 'Hawthorne');
    return 'Clayfield / Hawthorne';
  });
  await check('looking at Hawthorne: only Hawthorne devices, no Clayfield names', async () => {
    const r = await api(1, {action: 'manager_devices'}); assert.equal(r.status, 200, JSON.stringify(r.body));
    const clay = await one(`select id::text from public.auth_devices where last_staff_id='${ID(3)}'`);
    assert.equal(r.body.data.devices.some(d => d.id === clay), false);
    assert.doesNotMatch(JSON.stringify(r.body), /Test Floor Manager/);
    assert.equal(r.body.data.can_change_mode, true, 'the owner can change the mode');
    return `${r.body.data.devices.length} devices`;
  });
  await check('looking at Clayfield: the owner sees, renames and unlocks Clayfield devices', async () => {
    assert.equal((await api(1, {action: 'manager_unit_set', location: 'Clayfield'})).status, 200);
    const clay = await one(`select id::text from public.auth_devices where last_staff_id='${ID(3)}'`);
    const r = await api(1, {action: 'manager_devices'});
    assert.equal(r.body.data.devices.some(d => d.id === clay), true);
    assert.equal((await api(1, {action: 'manager_device_rename', device_id: clay, label: 'Synthetic Clayfield tablet'})).status, 200);
    assert.equal((await api(1, {action: 'manager_device_unlock', device_id: clay})).status, 200);
    return 'Clayfield managed';
  });
  await check('a code made while looking at Paddington pairs a tablet into Paddington', async () => {
    assert.equal((await api(1, {action: 'manager_unit_set', location: 'Paddington'})).status, 200);
    const code = await api(1, {action: 'manager_device_code', label: 'Synthetic Paddington tablet'});
    assert.equal(code.status, 200, JSON.stringify(code.body));
    const paired = await call(h, {action: 'device_pair', device: newDeviceSecret(), code: code.body.data.code});
    assert.equal(paired.status, 200, JSON.stringify(paired.body));
    assert.equal(await one(`select management_location from public.auth_devices where label='Synthetic Paddington tablet'`), 'Paddington');
    assert.equal((await api(1, {action: 'manager_devices'})).body.data.devices.some(d => d.label === 'Synthetic Paddington tablet'), true);
    assert.equal((await api(1, {action: 'manager_unit_set', location: 'Hawthorne'})).status, 200);
    assert.equal((await api(1, {action: 'manager_devices'})).body.data.devices.some(d => d.label === 'Synthetic Paddington tablet'), false);
    return 'Paddington';
  });
  await check('only the owner changes the device mode (several units active); managers cannot manage devices', async () => {
    const k = await api(2, {action: 'manager_auth_mode', mode: 'enforce'});
    assert.equal(k.status, 403, JSON.stringify(k.body));
    assert.equal((await api(2, {action: 'manager_devices'})).status, 403);
    const r = await api(1, {action: 'manager_auth_mode', mode: 'enforce'});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await one('select device_mode from public.auth_settings'), 'enforce');
    assert.equal((await api(1, {action: 'manager_auth_mode', mode: 'grace'})).status, 200);
    return 'owner 200, Kitchen Manager 403';
  });
  await check('the owner\'s own phone notifications stay in their unit while looking at another one', async () => {
    assert.equal((await api(1, {action: 'manager_unit_set', location: 'Clayfield'})).status, 200);
    const sub = {endpoint: 'https://web.push.apple.com/QAownerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', p256dh: 'B' + 'x'.repeat(86), auth: 'a'.repeat(22)};
    const r = await api(1, {action: 'manager_push_subscribe', ...sub, label: 'QA phone'});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await one(`select location from public.push_subscriptions where staff_id='${ID(1)}'`), 'Hawthorne');
    assert.equal((await api(1, {action: 'manager_unit_set', location: 'Hawthorne'})).status, 200);
    return 'Hawthorne';
  });
} finally {
  db.stop();
}
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL DEVICE OWNER CHECKS PASSED');
process.exit(failures ? 1 : 0);
