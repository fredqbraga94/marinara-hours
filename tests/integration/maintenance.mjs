// Release check for maintenance (equipment that is broken or needs fixing), on a
// production-like database. Production at release time =
// everything up to permissions per manager, served by the current main server
// (tests/edge/baseline-v52.ts).
// Synthetic people and items only: this repository is public.
// Run: node tests/integration/maintenance.mjs
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
];
const MAINT = "supabase/migrations/20261028010000_maintenance.sql";
const MAINT_DOWN = "supabase/rollback/20261028010000_maintenance.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v52.ts");

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
  for (const f of BEFORE.slice(-8)) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  const vProd = await quiet(() => loadHandler(PROD_SERVER));
  const vNew = await quiet(() => loadHandler(NEW_SERVER));
  const dev = Object.fromEntries([1, 2, 3, 5].map((n) => [n, newDeviceSecret()]));
  const login = async (h, n) => {
    const r = await quiet(() => call(h, { action: "login", pin: PIN[ID(n)], device: dev[n] }));
    assert.equal(r.status, 200, `login ${n}: ${JSON.stringify(r.body)}`);
    return r.body.session.token;
  };
  const api = (h, n, token, body) => quiet(() => call(h, { ...body, token, device: dev[n] }));

  section("A. Before the migration");
  const fpBefore = await db.fingerprints();
  await check("new server answers clearly without the table (no crash)", async () => {
    const gm = await login(vNew, 1);
    const r = await api(vNew, 1, gm, { action: "manager_maintenance_list" });
    assert.ok(r.status >= 400 && r.body.error, JSON.stringify(r.body));
    assert.equal((await api(vNew, 1, gm, { action: "manager_shopping_list" })).status, 200, "shopping still works");
    return `list ${r.status}; shopping 200`;
  });

  section("B. Migration");
  await check("applies; nothing existing changed; closed to the public keys; runs twice", async () => {
    const r = db.psqlFile(MAINT); assert.ok(r.ok, r.stderr);
    const fp = await db.fingerprints();
    assert.deepEqual(Object.keys(fpBefore).filter((k) => fp[k] !== fpBefore[k]), []);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await one(db, `select has_table_privilege('${role}', 'public.maintenance_items', 'select')`), "f", role);
      assert.equal(await one(db, `select has_function_privilege('${role}', 'public.manager_maintenance_mark(uuid,uuid,text,text)', 'execute')`), "f", role);
    }
    const again = db.psqlFile(MAINT); assert.ok(again.ok, again.stderr);
    return "table and functions for the server only";
  });
  await check("current production server keeps working", async () => {
    const gm = await login(vProd, 1);
    assert.equal((await api(vProd, 1, gm, { action: "manager_dashboard" })).status, 200);
    return "Home 200";
  });

  section("C. New server");
  const gm = await login(vNew, 1);
  const km = await login(vNew, 2);
  const fm = await login(vNew, 3);
  const save = (n, token, item) => api(vNew, n, token, { action: "manager_maintenance_save", item });
  const mark = (n, token, id, status, note) => api(vNew, n, token, { action: "manager_maintenance_mark", id, status, note });
  const list = async (n, token) => (await api(vNew, n, token, { action: "manager_maintenance_list" })).body.data;

  let oven, light;
  await check("every manager reports problems; urgent first; who reported", async () => {
    const a = await save(3, fm, { equipment: "Test cool room light", problem: "Flickering", urgent: false });
    assert.equal(a.status, 200, JSON.stringify(a.body)); light = a.body.data.item;
    const b = await save(2, km, { equipment: "Test oven", problem: "Not heating on the left side", urgent: true });
    assert.equal(b.status, 200, JSON.stringify(b.body)); oven = b.body.data.item;
    const l = await list(1, gm);
    assert.deepEqual(l.open.map((i) => i.equipment), ["Test oven", "Test cool room light"]);
    assert.equal(l.open[0].created_by, "Test Kitchen Manager");
    assert.equal(l.open[0].status, "open");
    assert.deepEqual(l.fixed, []);
    return "2 problems, urgent oven first";
  });

  await check("edit; bad input refused and nothing saved", async () => {
    const e = await save(1, gm, { id: light.id, equipment: "Test cool room light", problem: "Off completely", urgent: true });
    assert.equal(e.status, 200, JSON.stringify(e.body)); assert.equal(e.body.data.item.problem, "Off completely");
    assert.equal((await save(1, gm, { equipment: "  " })).status, 400);
    assert.equal((await save(1, gm, { id: "nope", equipment: "x" })).status, 404);
    assert.equal((await mark(1, gm, oven.id, "broken")).status, 400);
    assert.equal(Number(await one(db, "select count(*) from public.maintenance_items")), 2);
    return "edited; blank 400; bad id 404; bad status 400";
  });

  await check("being fixed, then fixed with a note; reopen; remove", async () => {
    const s = await mark(2, km, oven.id, "in_progress");
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.data.item.started_by, "Test Kitchen Manager");
    let l = await list(1, gm);
    assert.equal(l.open.find((i) => i.id === oven.id).status, "in_progress", "still on the open list");
    const f = await mark(1, gm, oven.id, "fixed", "Technician replaced the element");
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.equal(f.body.data.item.done_by, "Test General Manager");
    assert.equal(f.body.data.item.fix_note, "Technician replaced the element");
    l = await list(3, fm);
    assert.deepEqual(l.open.map((i) => i.equipment), ["Test cool room light"]);
    assert.deepEqual(l.fixed.map((i) => i.equipment), ["Test oven"]);
    assert.equal((await save(1, gm, { id: oven.id, equipment: "x" })).status, 404, "a fixed item is not edited");
    const r = await mark(1, gm, oven.id, "open");
    assert.equal(r.status, 200); assert.equal(r.body.data.item.fix_note, null); assert.equal(r.body.data.item.started_by, null);
    assert.equal((await mark(1, gm, light.id, "removed")).status, 200);
    assert.equal((await mark(1, gm, light.id, "open")).status, 404, "a removed item stays removed");
    l = await list(1, gm);
    assert.deepEqual(l.open.map((i) => i.equipment), ["Test oven"]);
    return "in progress → fixed (note kept) → reopened; removed item gone";
  });

  await check("staff cannot use it; other locations stay separate", async () => {
    const st = await login(vNew, 5);
    assert.ok((await api(vNew, 5, st, { action: "manager_maintenance_list" })).status >= 400);
    assert.ok((await api(vNew, 5, st, { action: "manager_maintenance_save", item: { equipment: "x" } })).status >= 400);
    const other = await one(db, `insert into public.maintenance_items (location, equipment) values ('Test Elsewhere', 'Test other fryer') returning id::text`);
    assert.equal((await list(1, gm)).open.some((i) => i.equipment === "Test other fryer"), false);
    assert.equal((await mark(1, gm, other, "fixed")).status, 404);
    assert.equal(await one(db, `select status from public.maintenance_items where id = '${other}'`), "open");
    return "staff refused; another location's problem not shown and not changed";
  });

  section("D. Rollback");
  await check("rollback removes it; shopping and both servers still work", async () => {
    const r = db.psqlFile(MAINT_DOWN); assert.ok(r.ok, r.stderr);
    assert.deepEqual(Object.keys(await db.fingerprints()).sort(), Object.keys(fpBefore).sort());
    assert.equal((await api(vNew, 1, gm, { action: "manager_dashboard" })).status, 200);
    assert.equal((await api(vNew, 1, gm, { action: "manager_shopping_list" })).status, 200);
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_dashboard" })).status, 200);
    return "Home 200 on both; shopping 200";
  });
} finally {
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL MAINTENANCE RELEASE CHECKS PASSED");
process.exit(failures ? 1 : 0);
