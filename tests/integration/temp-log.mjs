// Release check for the temperature records (Standard 3.2.2A), on a
// production-like database. Production at release time = everything up to the
// top products, served by the current main server (tests/edge/baseline-v55.ts).
// Synthetic suppliers, numbers and prices only: this repository is public.
// Run: node tests/integration/temp-log.mjs
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { startProdLikeDb, MIGRATION_A, MIGRATION_B, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "./edge-loader.mjs";
import { ID, PIN, reseed } from "./seed.mjs";

const BEFORE = [
  MIGRATION_A, MIGRATION_B,
  "supabase/migrations/20261020000000_student_visa.sql",
  "supabase/migrations/20261020010000_roster.sql",
  "supabase/migrations/20261020020000_leave.sql",
  "supabase/migrations/20261020030000_public_holidays.sql",
  "supabase/migrations/20261021000000_stock_par.sql",
  "supabase/migrations/20261021010000_roster_roles.sql",
  "supabase/migrations/20261021020000_roster_order.sql",
  "supabase/migrations/20261021030000_floor_services.sql",
  "supabase/migrations/20261021040000_push.sql",
  "supabase/migrations/20261021050000_push_badge.sql",
  "supabase/migrations/20261022000000_recipes.sql",
  "supabase/migrations/20261022010000_recipes_kids_pasta.sql",
  "supabase/migrations/20261022020000_recipes_dairy_kinds.sql",
  "supabase/migrations/20261022030000_invoices.sql",
  "supabase/migrations/20261022040000_ingredient_costs.sql",
  "supabase/migrations/20261027000000_invoice_price_book.sql",
  "supabase/migrations/20261027010000_manager_permissions.sql",
  "supabase/migrations/20261028000000_shopping_list.sql",
  "supabase/migrations/20261028010000_maintenance.sql",
  "supabase/migrations/20261028020000_photos_contacts.sql",
  "supabase/migrations/20261028030000_own_pin.sql",
  "supabase/migrations/20261028040000_top_products.sql",
];
const TEMP = "supabase/migrations/20261029000000_temp_log.sql";
const TEMP_DOWN = "supabase/rollback/20261029000000_temp_log.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v55.ts");

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
const one = async (db, sql) => (await db.admin.query(sql)).rows[0]?.[0];
const realConsole = { ...console };
async function quiet(fn) {
  for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = () => {};
  try { return await fn(); } finally { Object.assign(console, realConsole); }
}
const db = await startProdLikeDb();
try {
  for (const f of BEFORE) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  useDatabase(db.svc);
  await reseed(db);
  for (const f of BEFORE.slice(-13)) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
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
    const r = await api(vNew, 1, gm, { action: "manager_temp_today" });
    assert.ok(r.status >= 400 && r.body.error, JSON.stringify(r.body));
    assert.equal((await api(vNew, 1, gm, { action: "manager_dashboard" })).status, 200);
    return `today ${r.status}; Home 200`;
  });

  section("B. Migration");
  await check("applies; closed to the public keys; runs twice; production server keeps working", async () => {
    const r = db.psqlFile(TEMP); assert.ok(r.ok, r.stderr);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await one(db, `select has_table_privilege('${role}', 'public.temp_logs', 'select')`), "f", role);
      assert.equal(await one(db, `select has_function_privilege('${role}', 'public.manager_temp_record(uuid,jsonb)', 'execute')`), "f", role);
    }
    const again = db.psqlFile(TEMP); assert.ok(again.ok, again.stderr);
    const p = await login(vProd, 1);
    assert.equal((await api(vProd, 1, p, { action: "manager_dashboard" })).status, 200);
    return "server only";
  });

  section("C. Daily checks");
  const gm = await login(vNew, 1);
  const km = await login(vNew, 2);
  const fm = await login(vNew, 3);
  const eq = async (n, token, item) => api(vNew, n, token, { action: "manager_temp_equipment_save", item });
  const rec = (n, token, entry) => api(vNew, n, token, { action: "manager_temp_record", entry });
  const today = async (n = 1, token = gm) => (await api(vNew, n, token, { action: "manager_temp_today" })).body.data;
  let fridge, freezer, bain;
  await check("equipment added; today shows all three as not checked", async () => {
    fridge = (await eq(2, km, { name: "Test cool room", kind: "fridge" })).body.data.equipment;
    freezer = (await eq(1, gm, { name: "Test freezer", kind: "freezer" })).body.data.equipment;
    bain = (await eq(3, fm, { name: "Test bain-marie", kind: "hot" })).body.data.equipment;
    assert.ok(fridge?.id && freezer?.id && bain?.id);
    assert.equal((await eq(1, gm, { name: "", kind: "fridge" })).status, 400);
    assert.equal((await eq(1, gm, { name: "Test x", kind: "oven" })).status, 400);
    const d = await today();
    const afterTwo = new Date(Date.now() + 10 * 3600e3).getUTCHours() >= 14;
    assert.equal(d.missing, afterTwo ? 6 : 3, "opening checks, plus closing from 2 pm");
    assert.equal(d.equipment.length, 3);
    return `${d.missing} to check`;
  });
  await check("readings in range save with who and when; outside the range need a corrective action", async () => {
    let r = await rec(2, km, { kind: "equipment", equipment_id: fridge.id, slot: "opening", temp: "3.4" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.record.ok, true);
    assert.equal(r.body.data.record.recorded_by, "Test Kitchen Manager");
    r = await rec(1, gm, { kind: "equipment", equipment_id: freezer.id, slot: "opening", temp: -10 });
    assert.equal(r.status, 400); assert.equal(r.body.code, "ACTION_REQUIRED");
    r = await rec(1, gm, { kind: "equipment", equipment_id: freezer.id, slot: "opening", temp: -10, action: "Door left open; closed it and checked again in 30 min" });
    assert.equal(r.status, 200); assert.equal(r.body.data.record.ok, false);
    r = await rec(3, fm, { kind: "equipment", equipment_id: bain.id, slot: "opening", temp: 58 });
    assert.equal(r.body.code, "ACTION_REQUIRED");
    r = await rec(3, fm, { kind: "equipment", equipment_id: bain.id, slot: "opening", temp: 65 });
    assert.equal(r.body.data.record.ok, true);
    assert.equal((await rec(1, gm, { kind: "equipment", equipment_id: fridge.id, slot: "opening", temp: "hot" })).status, 400);
    assert.equal((await rec(1, gm, { kind: "equipment", equipment_id: fridge.id, slot: "opening", temp: 300 })).status, 400);
    assert.equal((await rec(1, gm, { kind: "equipment", equipment_id: fridge.id, temp: 3 })).status, 400, "opening or closing is required");
    const d = await today();
    assert.equal(d.equipment.every((e) => e.opening), true);
    assert.equal(d.today.length, 3);
    return "5°C, -15°C and 60°C limits";
  });
  await check("deliveries: chilled 5°C or below, frozen -15°C or below", async () => {
    let r = await rec(2, km, { kind: "receiving", item: "Test cream", supplier: "Test Wholesale", food: "chilled", temp: 4 });
    assert.equal(r.status, 200); assert.equal(r.body.data.record.ok, true);
    r = await rec(2, km, { kind: "receiving", item: "Test prawns", food: "frozen", temp: -8 });
    assert.equal(r.body.code, "ACTION_REQUIRED");
    r = await rec(2, km, { kind: "receiving", item: "Test prawns", food: "frozen", temp: -8, action: "Rejected, sent back with the driver" });
    assert.equal(r.status, 200);
    assert.equal((await rec(2, km, { kind: "receiving", item: "", food: "chilled", temp: 3 })).status, 400);
    return "2 deliveries";
  });
  await check("the weekly sheet: Monday to Sunday, the latest reading of each cell (a second reading replaces the cell, both kept)", async () => {
    await rec(2, km, { kind: "equipment", equipment_id: fridge.id, slot: "closing", temp: 4.1 });
    await rec(2, km, { kind: "equipment", equipment_id: fridge.id, slot: "closing", temp: 3.9 });
    const w = (await api(vNew, 1, gm, { action: "manager_temp_week" })).body.data;
    const start = new Date(`${w.start}T00:00:00Z`);
    assert.equal(start.getUTCDay(), 1, "starts on Monday");
    assert.equal(w.equipment.length, 3);
    const fc = w.cells.filter((c) => c.equipment_id === fridge.id && c.slot === "closing");
    assert.equal(fc.length, 1); assert.equal(Number(fc[0].temp), 3.9);
    assert.equal(w.cells.length, 4);
    const prev = (await api(vNew, 1, gm, { action: "manager_temp_week", start: "2020-01-08" })).body.data;
    assert.equal(prev.start, "2020-01-06"); assert.equal(prev.cells.length, 0);
    return `week of ${w.start}: 4 cells`;
  });
  await check("records cannot be changed or deleted, and there is no action for it", async () => {
    for (const action of ["manager_temp_delete", "manager_temp_edit"]) {
      const r = await api(vNew, 1, gm, { action });
      assert.ok(r.status >= 400, action);
    }
    assert.equal(Number(await one(db, `select count(*) from public.temp_logs`)), 7);
    return "7 records kept";
  });
  await check("history for the council; staff refused; other locations stay out", async () => {
    const h = (await api(vNew, 1, gm, { action: "manager_temp_history", days: 90 })).body.data;
    assert.equal(h.records.length, 7);
    assert.equal(h.records.filter((x) => !x.ok).every((x) => x.action), true);
    const st = await login(vNew, 4);
    assert.ok((await api(vNew, 4, st, { action: "manager_temp_today" })).status >= 400);
    const other = await one(db, `insert into public.temp_equipment (location, name, kind) values ('Test Elsewhere', 'Other fridge', 'fridge') returning id::text`);
    assert.equal((await rec(1, gm, { kind: "equipment", equipment_id: other, slot: "opening", temp: 3 })).status, 404);
    assert.equal((await today()).equipment.some((e) => e.name === "Other fridge"), false);
    return "90 days: 7 records";
  });
  await check("equipment taken off the list keeps its records", async () => {
    const r = await eq(1, gm, { id: bain.id, active: false });
    assert.equal(r.status, 200);
    const d = await today();
    assert.equal(d.equipment.length, 2);
    assert.equal((await api(vNew, 1, gm, { action: "manager_temp_history", days: 90 })).body.data.records.length, 7);
    return "2 on the list, 7 records";
  });

  section("D. Rollback");
  await check("rollback removes it; both servers still work", async () => {
    const r = db.psqlFile(TEMP_DOWN); assert.ok(r.ok, r.stderr);
    assert.equal((await api(vNew, 1, gm, { action: "manager_dashboard" })).status, 200);
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_dashboard" })).status, 200);
    return "Home 200 on both";
  });
} finally {
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL TEMPERATURE RECORD CHECKS PASSED");
process.exit(failures ? 1 : 0);
