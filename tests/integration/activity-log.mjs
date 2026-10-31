// Release check for Activity (who changed what), Administrator only, on a
// production-like database with the current server. Synthetic data only.
// Run: node tests/integration/activity-log.mjs
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { startProdLikeDb, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "./edge-loader.mjs";
import { ID, SH, PIN, reseed } from "./seed.mjs";

const NEW = "20261031010000_activity_log.sql";
const MIG = `supabase/migrations/${NEW}`;
const DOWN = "supabase/rollback/20261031010000_activity_log.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v60.ts");

let failures = 0;
const log = (...a) => console.log(...a);
async function check(name, fn) {
  try { const note = await fn(); log(`  ✔ ${name}${note ? `\n      ${note}` : ""}`); }
  catch (e) {
    failures++;
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=${name.replace(/[:,\n]/g, " ")}::${String(e?.stack || e).replace(/\r?\n/g, " | ").slice(0, 900)}`);
    log(`  ✖ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 8).join("\n      ")}`);
  }
}
const realConsole = { ...console };
async function quiet(fn) {
  for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = () => {};
  try { return await fn(); } finally { Object.assign(console, realConsole); }
}

const db = await startProdLikeDb();
const one = async (sql) => (await db.admin.query(sql)).rows[0]?.[0];
try {
  for (const f of readdirSync(resolve(root, "supabase/migrations")).filter((f) => f >= "20261013010000" && f < NEW).sort()) db.mustFile(`supabase/migrations/${f}`);
  await reseed(db);
  useDatabase(db.svc);
  const vProd = await quiet(() => loadHandler(PROD_SERVER));
  const vNew = await quiet(() => loadHandler(NEW_SERVER));
  const dev = Object.fromEntries([1, 2, 3, 4].map((n) => [n, newDeviceSecret()]));
  const login = async (h, n) => {
    const r = await quiet(() => call(h, { action: "login", pin: PIN[ID(n)], device: dev[n] }));
    assert.equal(r.status, 200, `login ${n}: ${JSON.stringify(r.body)}`);
    return r.body.session.token;
  };
  const api = (h, n, token, body) => quiet(() => call(h, { ...body, token, device: dev[n] }));
  const gm = await login(vNew, 1), km = await login(vNew, 2), fm = await login(vNew, 3);

  await check("before the migration: clear answer; Home works", async () => {
    const r = await api(vNew, 1, gm, { action: "manager_activity" });
    assert.ok(r.status >= 400 && r.body.error);
    assert.equal((await api(vNew, 1, gm, { action: "manager_dashboard" })).status, 200);
    return `activity ${r.status}`;
  });
  await check("migration applies, runs twice, closed to the public keys; production server keeps working", async () => {
    let r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    for (const role of ["anon", "authenticated"]) assert.equal(await one(`select has_function_privilege('${role}', 'public.manager_activity(uuid,integer,uuid)', 'execute')`), "f");
    const p = await login(vProd, 1);
    assert.equal((await api(vProd, 1, p, { action: "manager_dashboard" })).status, 200);
  });

  // Things happen (synthetic).
  const at = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  await check("managers do things", async () => {
    assert.equal((await api(vNew, 2, km, { action: "manager_edit_shift", shift_id: SH(3), clock_in: at(26), clock_out: at(19), break_minutes: 30 })).status, 200);
    assert.equal((await api(vNew, 1, gm, { action: "manager_approve_shift", shift_id: SH(3) })).status, 200);
    assert.equal((await api(vNew, 3, fm, { action: "manager_shopping_save", item: { name: "Test napkins", urgent: true } })).status, 200);
    assert.equal((await api(vNew, 2, km, { action: "manager_food_record", entry: { food: "Test lasagne", check: "reheat", temp: 80, checked_by: ID(4) } })).status, 200);
    const task = (await api(vNew, 2, km, { action: "manager_clean_task_save", item: { name: "Test benches", frequency: "daily" } })).body.data.task;
    assert.equal((await api(vNew, 2, km, { action: "manager_clean_mark", task_id: task.id, done: true, checked_by: ID(5) })).status, 200);
  });
  let act;
  await check("the Administrator sees who did what, newest first, with the details", async () => {
    const r = await api(vNew, 1, gm, { action: "manager_activity", days: 7 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    act = r.body.data;
    assert.equal(act.location, "Hawthorne");
    const find = (re) => act.items.find((i) => re.test(i.what));
    const edit = find(/^Edited a shift: Test Kitchen A/);
    assert.ok(edit, JSON.stringify(act.items.map((i) => i.what)));
    assert.equal(edit.who, "Test Kitchen Manager"); assert.equal(edit.area, "Hours"); assert.match(edit.what, /\(was /);
    assert.equal(find(/^Approved hours: Test Kitchen A/).who, "Test General Manager");
    assert.equal(find(/^Added to shopping: Test napkins \(urgent\)/).who, "Test Floor Manager");
    assert.match(find(/^Food temperature Test lasagne/).what, /Reheating: 80(\.0)?°C · checked by Test Kitchen A/);
    assert.match(find(/^Cleaning done: Test benches/).what, /by Test Kitchen B/);
    const times = act.items.map((i) => i.at);
    assert.deepEqual(times, [...times].sort().reverse(), "newest first");
    assert.deepEqual(act.people.map((p) => p.name).sort(), ["Test Floor Manager", "Test General Manager", "Test Kitchen Manager"]);
    return `${act.items.length} items`;
  });
  await check("only what one person did", async () => {
    const r = (await api(vNew, 1, gm, { action: "manager_activity", days: 7, who: ID(3) })).body.data;
    assert.ok(r.items.length >= 1);
    assert.ok(r.items.every((i) => i.who === "Test Floor Manager"));
  });
  await check("Kitchen/Floor Managers and staff cannot see it", async () => {
    assert.equal((await api(vNew, 2, km, { action: "manager_activity" })).status, 403);
    assert.equal((await api(vNew, 3, fm, { action: "manager_activity" })).status, 403);
    const st = await login(vNew, 4);
    assert.ok((await api(vNew, 4, st, { action: "manager_activity" })).status >= 400);
    await assert.rejects(db.admin.query(`set role anon; select public.manager_activity('${ID(1)}', 7, null)`));
    await db.admin.query("reset role");
  });
  await check("looking at Paddington: nothing from Hawthorne", async () => {
    assert.equal((await api(vNew, 1, gm, { action: "manager_unit_set", location: "Paddington" })).status, 200);
    const r = (await api(vNew, 1, gm, { action: "manager_activity", days: 7 })).body.data;
    assert.equal(r.location, "Paddington");
    assert.equal(r.items.some((i) => /Test napkins|Test lasagne|Test Kitchen A/.test(i.what)), false);
    assert.equal((await api(vNew, 1, gm, { action: "manager_unit_set", location: "Hawthorne" })).status, 200);
  });
  await check("read only: nothing changes when it is read", async () => {
    const before = await one(`select count(*) from public.shift_audit`);
    await api(vNew, 1, gm, { action: "manager_activity", days: 90 });
    assert.equal(await one(`select count(*) from public.shift_audit`), before);
  });
  await check("rollback removes it; both servers still work", async () => {
    const r = db.psqlFile(DOWN); assert.ok(r.ok, r.stderr);
    assert.equal((await api(vNew, 1, gm, { action: "manager_dashboard" })).status, 200);
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_dashboard" })).status, 200);
  });
} finally {
  db.stop();
}
log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL ACTIVITY CHECKS PASSED");
process.exit(failures ? 1 : 0);
