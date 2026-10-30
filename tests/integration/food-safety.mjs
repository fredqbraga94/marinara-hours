// Release check for Food temperatures and Cleaning (Standard 3.2.2A), on a
// production-like database. Production at release time = every migration
// before this one, served by the current main server (tests/edge/baseline-v59.ts).
// Synthetic foods and names only: this repository is public.
// Run: node tests/integration/food-safety.mjs
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { startProdLikeDb, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "./edge-loader.mjs";
import { ID, PIN, reseed } from "./seed.mjs";

const NEW = "20261031000000_food_safety.sql";
const MIG = `supabase/migrations/${NEW}`;
const DOWN = "supabase/rollback/20261031000000_food_safety.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v59.ts");

let failures = 0;
const log = (...a) => console.log(...a);
async function check(name, fn) {
  try {
    const note = await fn();
    log(`  ✔ ${name}${note ? `\n      ${note}` : ""}`);
  } catch (e) {
    failures++;
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=${name.replace(/[:,\n]/g, " ")}::${String(e?.stack || e).replace(/\r?\n/g, " | ").slice(0, 900)}`);
    log(`  ✖ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 8).join("\n      ")}`);
  }
}
const section = (t) => log(`\n== ${t} ==`);
const realConsole = { ...console };
async function quiet(fn) {
  for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = () => {};
  try { return await fn(); } finally { Object.assign(console, realConsole); }
}

const db = await startProdLikeDb();
const one = async (sql) => (await db.admin.query(sql)).rows[0]?.[0];
try {
  const before = readdirSync(resolve(root, "supabase/migrations")).filter((f) => f >= "20261013010000" && f < NEW).sort();
  for (const f of before) db.mustFile(`supabase/migrations/${f}`);
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

  section("A. Before the migration");
  await check("new server answers clearly without the tables; Home still works", async () => {
    const gm = await login(vNew, 1);
    const r = await api(vNew, 1, gm, { action: "manager_food_day" });
    assert.ok(r.status >= 400 && r.body.error, JSON.stringify(r.body));
    const c = await api(vNew, 1, gm, { action: "manager_clean_week" });
    assert.ok(c.status >= 400 && c.body.error, JSON.stringify(c.body));
    assert.equal((await api(vNew, 1, gm, { action: "manager_dashboard" })).status, 200);
    return `food ${r.status}, cleaning ${c.status}; Home 200`;
  });

  section("B. Migration");
  await check("applies; closed to the public keys; runs twice; production server keeps working", async () => {
    const r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    for (const role of ["anon", "authenticated"]) {
      for (const tb of ["food_temps", "cleaning_tasks", "cleaning_logs"]) {
        assert.equal(await one(`select has_table_privilege('${role}', 'public.${tb}', 'select')`), "f", `${role} ${tb}`);
      }
      for (const fn of ["manager_food_record(uuid,jsonb)", "manager_food_day(uuid,date)", "manager_clean_mark(uuid,uuid,boolean,text)", "manager_clean_week(uuid,date)"]) {
        assert.equal(await one(`select has_function_privilege('${role}', 'public.${fn}', 'execute')`), "f", `${role} ${fn}`);
      }
    }
    const again = db.psqlFile(MIG); assert.ok(again.ok, again.stderr);
    const p = await login(vProd, 1);
    assert.equal((await api(vProd, 1, p, { action: "manager_dashboard" })).status, 200);
    return "server only";
  });

  section("C. Food temperatures");
  const gm = await login(vNew, 1);
  const km = await login(vNew, 2);
  const fm = await login(vNew, 3);
  const rec = (n, token, entry) => api(vNew, n, token, { action: "manager_food_record", entry });
  const day = async (n = 1, token = gm, extra = {}) => (await api(vNew, n, token, { action: "manager_food_day", ...extra })).body.data;
  await check("cooking, reheating, hot and cold holding: limits; outside the range needs an action", async () => {
    let r = await rec(2, km, { food: "Test chicken", check: "cook", temp: "82" });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.data.record.ok, true);
    assert.equal(r.body.data.record.recorded_by, "Test Kitchen Manager");
    r = await rec(2, km, { food: "Test chicken", check: "cook", temp: 70 });
    assert.equal(r.status, 400); assert.equal(r.body.code, "ACTION_REQUIRED");
    r = await rec(2, km, { food: "Test chicken", check: "cook", temp: 70, action: "Cooked longer, then 80°C" });
    assert.equal(r.status, 200); assert.equal(r.body.data.record.ok, false);
    assert.equal((await rec(3, fm, { food: "Test soup", check: "reheat", temp: 74.9 })).body.code, "ACTION_REQUIRED");
    assert.equal((await rec(3, fm, { food: "Test soup", check: "reheat", temp: 75 })).body.data.record.ok, true);
    assert.equal((await rec(1, gm, { food: "Test sauce", check: "hot", temp: 61 })).body.data.record.ok, true);
    assert.equal((await rec(1, gm, { food: "Test sauce", check: "hot", temp: 59 })).body.code, "ACTION_REQUIRED");
    assert.equal((await rec(1, gm, { food: "Test salad", check: "cold", temp: 4 })).body.data.record.ok, true);
    assert.equal((await rec(1, gm, { food: "Test salad", check: "cold", temp: 6 })).body.code, "ACTION_REQUIRED");
    assert.equal((await rec(1, gm, { food: "", check: "cook", temp: 80 })).status, 400);
    assert.equal((await rec(1, gm, { food: "Test x", check: "fry", temp: 80 })).status, 400);
    assert.equal((await rec(1, gm, { food: "Test x", check: "cook", temp: "hot" })).status, 400);
    assert.equal((await rec(1, gm, { food: "Test x", check: "cook", temp: 300 })).status, 400);
    const d = await day();
    assert.equal(d.records.length, 5); assert.equal(d.day, d.today);
    assert.deepEqual(d.foods.slice(0, 1), ["Test chicken"], "most used food first");
    assert.ok(d.people.some((p) => p.id === ID(4)));
    return "75 / 60 / 5°C limits";
  });
  let batch;
  await check("cooling: start, 2-hour (21°C) and 6-hour (5°C) readings, timed from the start", async () => {
    let r = await rec(2, km, { food: "Test bolognese", check: "cool", temp: 68 });
    assert.equal(r.status, 200); batch = r.body.data.record; assert.equal(batch.stage, 0); assert.equal(batch.ok, true);
    let d = await day();
    assert.equal(d.cooling.length, 1); assert.equal(d.cooling[0].next, 1);
    // 1 h 50 min later: 20°C is in time.
    await one(`update public.food_temps set recorded_at = now() - interval '110 minutes' where id = '${batch.id}'`);
    r = await rec(2, km, { batch_id: batch.id, temp: 20 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.record.stage, 1); assert.equal(r.body.data.record.food, "Test bolognese"); assert.equal(r.body.data.record.ok, true);
    assert.equal(r.body.data.record.minutes, 110);
    d = await day(); assert.equal(d.cooling[0].next, 2);
    // 6 h 30 min after the start: too late, even at 4°C.
    await one(`update public.food_temps set recorded_at = now() - interval '390 minutes' where id = '${batch.id}'`);
    assert.equal((await rec(2, km, { batch_id: batch.id, temp: 4 })).body.code, "ACTION_REQUIRED");
    r = await rec(2, km, { batch_id: batch.id, temp: 4, action: "Thrown away" });
    assert.equal(r.status, 200); assert.equal(r.body.data.record.ok, false);
    assert.equal((await rec(2, km, { batch_id: batch.id, temp: 3 })).status, 409, "only two readings after the start");
    d = await day(); assert.equal(d.cooling.length, 0, "finished");
    // A late 2-hour reading is outside the safe range.
    const b2 = (await rec(1, gm, { food: "Test stock", check: "cool", temp: 70 })).body.data.record;
    await one(`update public.food_temps set recorded_at = now() - interval '3 hours' where id = '${b2.id}'`);
    assert.equal((await rec(1, gm, { batch_id: b2.id, temp: 15 })).body.code, "ACTION_REQUIRED");
    assert.equal((await rec(1, gm, { batch_id: "not-an-id", temp: 15 })).status, 404);
    return "2 h and 6 h rules";
  });
  await check("who did the check: an employee of the location; others refused", async () => {
    let r = await rec(1, gm, { food: "Test pasta", check: "hot", temp: 65, checked_by: ID(4) });
    assert.equal(r.status, 200); assert.equal(r.body.data.record.checked_by_id, ID(4));
    assert.notEqual(r.body.data.record.checked_by, r.body.data.record.recorded_by);
    assert.equal((await rec(1, gm, { food: "Test pasta", check: "hot", temp: 65, checked_by: "x" })).status, 400);
    const other = await one(`insert into public.staff (id, name, pin_hash, department, location, role, active, created_at) select gen_random_uuid(), 'Test Other Place', 'unused-' || gen_random_uuid(), department, 'Test Elsewhere', 'staff', true, now() from public.staff where id = '${ID(4)}' returning id::text`);
    assert.equal((await rec(1, gm, { food: "Test pasta", check: "hot", temp: 65, checked_by: other })).status, 400);
    return "checked by the employee";
  });
  await check("a reading of today can be corrected; the first values stay; older ones cannot", async () => {
    const d = await day();
    const soup = d.records.find((x) => x.food === "Test soup");
    const edit = (n, token, id, entry) => api(vNew, n, token, { action: "manager_food_edit", id, entry });
    let r = await edit(3, fm, soup.id, { food: "Test minestrone", temp: 78 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.record.food, "Test minestrone"); assert.equal(Number(r.body.data.record.temp), 78);
    assert.equal(r.body.data.record.original.food, "Test soup"); assert.equal(r.body.data.record.edited_by, "Test Floor Manager");
    assert.equal((await edit(3, fm, soup.id, { food: "Test minestrone", temp: 60 })).body.code, "ACTION_REQUIRED");
    r = await edit(1, gm, soup.id, { food: "Test minestrone", temp: 77 });
    assert.equal(r.body.data.record.original.food, "Test soup", "the first values are never overwritten");
    // The 6-hour reading of the batch keeps its food and its timing.
    const six = d.records.find((x) => x.batch_id === batch.id && x.stage === 2);
    r = await edit(2, km, six.id, { food: "Other", temp: 4, action: "Thrown away" });
    assert.equal(r.status, 200); assert.equal(r.body.data.record.food, "Test bolognese"); assert.equal(r.body.data.record.ok, false);
    // Renaming the start renames the batch.
    r = await edit(2, km, batch.id, { food: "Test ragu", temp: 68 });
    assert.equal(r.status, 200);
    assert.equal(Number(await one(`select count(*) from public.food_temps where batch_id = '${batch.id}' and food = 'Test ragu'`)), 2);
    await one(`update public.food_temps set recorded_at = now() - interval '2 days' where id = '${soup.id}'`);
    assert.equal((await edit(1, gm, soup.id, { food: "Test minestrone", temp: 80 })).status, 404, "only today");
    assert.equal((await edit(1, gm, "not-an-id", { food: "x", temp: 80 })).status, 404);
    const y = new Date(Date.now() + 10 * 3600e3 - 2 * 864e5).toISOString().slice(0, 10);
    const old = await day(1, gm, { day: y });
    assert.equal(old.day, y); assert.ok(old.records.some((x) => x.id === soup.id), "shown on its day");
    return "food and °C fixed; original kept";
  });
  await check("history for the council; staff refused; other locations stay out", async () => {
    const h = (await api(vNew, 1, gm, { action: "manager_food_history", days: 90 })).body.data;
    const n = Number(await one(`select count(*) from public.food_temps`));
    assert.equal(h.records.length, n);
    assert.equal(h.records.filter((x) => !x.ok).every((x) => x.action), true);
    const st = await login(vNew, 4);
    assert.ok((await api(vNew, 4, st, { action: "manager_food_day" })).status >= 400);
    const other = await one(`insert into public.food_temps (location, food, check_type, temp, ok, recorded_by) values ('Test Elsewhere', 'Other food', 'cool', 70, true, '${ID(1)}') returning id::text`);
    assert.equal((await rec(1, gm, { batch_id: other, temp: 20 })).status, 404);
    assert.equal(JSON.stringify(await day()).includes("Other food"), false);
    return `${n} records`;
  });

  section("D. Cleaning");
  const save = (n, token, item) => api(vNew, n, token, { action: "manager_clean_task_save", item });
  const mark = (n, token, body) => api(vNew, n, token, { action: "manager_clean_mark", ...body });
  const week = async (extra = {}) => (await api(vNew, 1, gm, { action: "manager_clean_week", ...extra })).body.data;
  let benches, drains;
  await check("tasks added (every day / once a week); invalid refused", async () => {
    benches = (await save(2, km, { name: "Test benches", how: "Wash, rinse, sanitise", frequency: "daily" })).body.data.task;
    drains = (await save(3, fm, { name: "Test drains", frequency: "weekly" })).body.data.task;
    assert.ok(benches?.id && drains?.id);
    assert.equal(benches.how, "Wash, rinse, sanitise");
    assert.equal((await save(1, gm, { name: "", frequency: "daily" })).status, 400);
    assert.equal((await save(1, gm, { name: "Test x", frequency: "monthly" })).status, 400);
    const w = await week();
    assert.equal(new Date(`${w.start}T00:00:00Z`).getUTCDay(), 1, "starts on Monday");
    assert.deepEqual(w.tasks.map((x) => x.name), ["Test benches", "Test drains"], "every day first");
    return "2 tasks";
  });
  await check("tick today with who did it; a second tick replaces it; undo today", async () => {
    let r = await mark(2, km, { task_id: benches.id, done: true, checked_by: ID(4) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let w = await week();
    assert.equal(w.done.length, 1); assert.equal(w.done[0].by, "Test Kitchen A"); assert.equal(w.done[0].recorded_by, "Test Kitchen Manager");
    assert.equal(w.done[0].day, w.today);
    r = await mark(1, gm, { task_id: benches.id, done: true });
    w = await week(); assert.equal(w.done.length, 1); assert.equal(w.done[0].by, "Test General Manager");
    await mark(3, fm, { task_id: drains.id, done: true });
    assert.equal((await mark(1, gm, { task_id: drains.id, done: false })).status, 200);
    w = await week(); assert.equal(w.done.length, 1);
    assert.equal((await mark(1, gm, { task_id: benches.id, done: true, checked_by: "x" })).status, 400);
    assert.equal((await mark(1, gm, { task_id: "not-an-id" })).status, 404);
    return "ticked, replaced, undone";
  });
  await check("past days cannot be changed; removed tasks keep their ticks", async () => {
    await one(`insert into public.cleaning_logs (location, task_id, day, done_by, recorded_by) values ('Hawthorne', '${benches.id}', (now() at time zone 'Australia/Brisbane')::date - 1, '${ID(5)}', '${ID(2)}')`);
    assert.equal((await mark(1, gm, { task_id: benches.id, done: false })).status, 200);
    assert.equal(Number(await one(`select count(*) from public.cleaning_logs where task_id = '${benches.id}'`)), 1, "yesterday's tick stays");
    await mark(1, gm, { task_id: benches.id, done: true });
    assert.equal((await save(1, gm, { id: benches.id, active: false })).status, 200);
    assert.equal((await mark(1, gm, { task_id: benches.id, done: true })).status, 404, "not on the list");
    const w = await week();
    assert.ok(w.tasks.some((x) => x.id === benches.id && !x.active), "still on this week's sheet");
    const h = (await api(vNew, 1, gm, { action: "manager_clean_history", days: 90 })).body.data;
    assert.equal(h.records.length, 2); assert.ok(h.records.every((x) => x.task === "Test benches"));
    const old = await week({ start: "2020-01-08" });
    assert.equal(old.start, "2020-01-06"); assert.equal(old.done.length, 0);
    assert.equal(old.tasks.some((x) => x.id === benches.id), false, "removed and not ticked that week");
    return "2 ticks kept";
  });
  await check("staff refused; other locations stay out", async () => {
    const st = await login(vNew, 4);
    assert.ok((await api(vNew, 4, st, { action: "manager_clean_week" })).status >= 400);
    const other = await one(`insert into public.cleaning_tasks (location, name, frequency) values ('Test Elsewhere', 'Other task', 'daily') returning id::text`);
    assert.equal((await mark(1, gm, { task_id: other, done: true })).status, 404);
    assert.equal((await save(1, gm, { id: other, active: false })).status, 404);
    assert.equal(JSON.stringify(await week()).includes("Other task"), false);
    return "unit only";
  });

  section("E. The Administrator looking at Paddington");
  await check("food and cleaning follow the viewed unit", async () => {
    assert.equal((await api(vNew, 1, gm, { action: "manager_unit_set", location: "Paddington" })).status, 200);
    const d = await day(); assert.equal(d.location, "Paddington"); assert.equal(d.records.length, 0);
    const w = await week(); assert.equal(w.location, "Paddington"); assert.equal(w.tasks.length, 0);
    const r = await rec(1, gm, { food: "Test pad soup", check: "hot", temp: 70 });
    assert.equal(r.status, 200);
    assert.equal(await one(`select location from public.food_temps where food = 'Test pad soup'`), "Paddington");
    assert.equal(JSON.stringify(await day(2, km)).includes("Test pad soup"), false, "Hawthorne does not see it");
    assert.equal((await api(vNew, 1, gm, { action: "manager_unit_set", location: "Hawthorne" })).status, 200);
    return "Paddington separate";
  });

  section("F. Rollback");
  await check("rollback removes it; both servers still work", async () => {
    const r = db.psqlFile(DOWN); assert.ok(r.ok, r.stderr);
    assert.equal(await one(`select to_regclass('public.food_temps') is null`), "t");
    assert.equal((await api(vNew, 1, gm, { action: "manager_dashboard" })).status, 200);
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_dashboard" })).status, 200);
    return "Home 200 on both";
  });
} finally {
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL FOOD TEMPERATURE AND CLEANING CHECKS PASSED");
process.exit(failures ? 1 : 0);
