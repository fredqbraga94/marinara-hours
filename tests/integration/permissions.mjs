// Release check for permissions per manager (the Administrator switches areas
// off for a Kitchen/Floor Manager), on a production-like database. Production at
// release time = everything up to the price book, served by the current main
// server (tests/edge/baseline-v50.ts).
// Synthetic people and data only: this repository is public.
// Run: node tests/integration/permissions.mjs
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
];
const PERMS = "supabase/migrations/20261027010000_manager_permissions.sql";
const PERMS_DOWN = "supabase/rollback/20261027010000_manager_permissions.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v50.ts");

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

// Every area a Kitchen Manager can use today, one read per area.
const AREA_READS = {
  hours: { action: "manager_hours" },
  approvals: { action: "manager_approvals" },
  team: { action: "manager_team" },
  roster: { action: "manager_roster_week" },
  time_off: { action: "manager_leave_list" },
  stock: { action: "manager_stock_list", department: "Kitchen" },
  recipes: { action: "manager_recipe_list" },
  invoices: { action: "manager_invoice_list" },
  prices: { action: "manager_invoice_price_book" },
  costs: { action: "manager_ingredient_costs" },
};

const db = await startProdLikeDb();
try {
  for (const f of BEFORE) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  useDatabase(db.svc);
  await reseed(db);
  for (const f of BEFORE.slice(-6)) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  const vProd = await quiet(() => loadHandler(PROD_SERVER));
  const vNew = await quiet(() => loadHandler(NEW_SERVER));
  const dev = Object.fromEntries([1, 2, 3].map((n) => [n, newDeviceSecret()]));
  const login = async (h, n) => {
    const r = await quiet(() => call(h, { action: "login", pin: PIN[ID(n)], device: dev[n] }));
    assert.equal(r.status, 200, `login ${n}: ${JSON.stringify(r.body)}`);
    return r.body.session.token;
  };
  const api = (h, n, token, body) => quiet(() => call(h, { ...body, token, device: dev[n] }));
  const statuses = async (h, n, token) => {
    const out = {};
    for (const [k, body] of Object.entries(AREA_READS)) out[k] = (await api(h, n, token, body)).status;
    return out;
  };
  const allOk = (s) => Object.values(s).every((x) => x === 200);

  section("A. Before the migration");
  const fpBefore = await db.fingerprints();
  await check("new server: every manager keeps what the role gives; permissions answer clearly", async () => {
    const km = await login(vNew, 2);
    const s = await statuses(vNew, 2, km);
    assert.ok(allOk(s), JSON.stringify(s));
    const d = (await api(vNew, 2, km, { action: "manager_dashboard" })).body.data;
    assert.equal(d.permissions.invoices, true);
    const gm = await login(vNew, 1);
    const r = await api(vNew, 1, gm, { action: "manager_permissions_list" });
    assert.ok(r.status >= 400, String(r.status));
    return `kitchen manager: ${Object.keys(s).length} areas 200; permissions list ${r.status}`;
  });

  section("B. Migration");
  await check("applies; nothing existing changed; closed to the public keys; runs twice", async () => {
    const r = db.psqlFile(PERMS); assert.ok(r.ok, r.stderr);
    const fp = await db.fingerprints();
    assert.deepEqual(Object.keys(fpBefore).filter((k) => fp[k] !== fpBefore[k]), []);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await one(db, `select has_table_privilege('${role}', 'public.manager_permissions', 'select')`), "f", role);
      assert.equal(await one(db, `select has_function_privilege('${role}', 'public.manager_permissions_set(uuid,uuid,jsonb)', 'execute')`), "f", role);
    }
    const again = db.psqlFile(PERMS); assert.ok(again.ok, again.stderr);
    return "table and functions for the server only";
  });
  await check("current production server keeps working", async () => {
    const km = await login(vProd, 2);
    const s = await statuses(vProd, 2, km);
    assert.ok(allOk(s), JSON.stringify(s));
    return "kitchen manager: every area 200";
  });

  section("C. New server");
  const gm = await login(vNew, 1);
  const km = await login(vNew, 2);
  const fm = await login(vNew, 3);
  const set = (n, token, staff, permissions) => api(vNew, n, token, { action: "manager_permissions_set", staff_id: staff, permissions });

  await check("with no choice made, nothing changes", async () => {
    const s = await statuses(vNew, 2, km);
    assert.ok(allOk(s), JSON.stringify(s));
    const list = (await api(vNew, 1, gm, { action: "manager_permissions_list" })).body.data.managers;
    const k = list.find((m) => m.staff_id === ID(2));
    assert.equal(k.custom, false); assert.equal(k.invoices, true);
    assert.equal(list.some((m) => m.staff_id === ID(1) || m.staff_id === ID(4)), false, "only kitchen/floor managers listed");
    return "every area 200; list shows the two managers";
  });

  await check("only the Administrator can choose; only for Kitchen/Floor Managers; bad input refused", async () => {
    assert.equal((await set(2, km, ID(2), { invoices: true })).status, 403, "kitchen manager cannot change permissions");
    assert.equal((await set(3, fm, ID(2), { invoices: false })).status, 403, "floor manager cannot change permissions");
    assert.equal((await api(vNew, 2, km, { action: "manager_permissions_list" })).status, 403);
    assert.equal((await set(1, gm, ID(4), { hours: false })).status, 400, "not for staff");
    assert.equal((await set(1, gm, ID(1), { hours: false })).status, 400, "not for the Administrator");
    assert.equal((await set(1, gm, ID(2), { hours: "yes" })).status, 400);
    assert.equal((await set(1, gm, ID(2), { payroll: false })).status, 400);
    assert.equal(Number(await one(db, "select count(*) from public.manager_permissions")), 0, "nothing saved");
    return "403 for managers, 400 for staff/Administrator/bad input";
  });

  await check("Kitchen Manager with hours only: hours work, everything else is refused by the server", async () => {
    const r = await set(1, gm, ID(2), { hours: true, team: false, roster: false, time_off: false, stock: false, recipes: false, invoices: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = await statuses(vNew, 2, km);
    assert.deepEqual(s, { hours: 200, approvals: 200, team: 200, roster: 403, time_off: 403, stock: 403, recipes: 403, invoices: 403, prices: 403, costs: 403 });
    const no = await api(vNew, 2, km, { action: "manager_stock_list", department: "Kitchen" });
    assert.equal(no.body.code, "NO_PERMISSION");
    const ap = await api(vNew, 2, km, { action: "manager_approve_shift", shift_id: "00000000-0000-4000-8000-0000000000a3" });
    const shift3 = await one(db, "select id from public.shifts where staff_id = '" + ID(4) + "' and clock_out is not null limit 1");
    const ap2 = await api(vNew, 2, km, { action: "manager_approve_shift", shift_id: shift3 });
    assert.equal(ap2.status, 200, `approve: ${JSON.stringify(ap2.body)} (${ap.status})`);
    assert.equal((await api(vNew, 2, km, { action: "manager_update_staff", staff_id: ID(5), name: "Test Kitchen B2", department: "Kitchen" })).status, 403, "cannot edit staff");
    assert.equal((await api(vNew, 2, km, { action: "manager_leave_count" })).status, 403);
    const d = (await api(vNew, 2, km, { action: "manager_dashboard" })).body.data;
    assert.deepEqual(d.permissions, { hours: true, team: false, roster: false, time_off: false, stock: false, recipes: false, invoices: false });
    return "hours/approvals/team names 200; roster, time off, stock, recipes, invoices, prices, costs 403; approved a kitchen shift";
  });

  await check("hours switched off too: no hours on the dashboard, no team list", async () => {
    assert.equal((await set(1, gm, ID(2), { hours: false })).status, 200);
    const d = (await api(vNew, 2, km, { action: "manager_dashboard" })).body.data;
    assert.equal(d.hours.shifts.length, 0); assert.equal(d.counts.unapproved_shifts, 0);
    assert.equal((await api(vNew, 2, km, { action: "manager_team" })).status, 403);
    assert.equal((await api(vNew, 2, km, { action: "manager_hours" })).status, 403);
    assert.equal((await api(vNew, 2, km, { action: "manager_dashboard" })).status, 200, "Home still opens");
    return "dashboard 200 without hours; team and hours 403";
  });

  await check("a switch never gives more than the role: Floor Manager with invoices on still cannot see invoices", async () => {
    assert.equal((await set(1, gm, ID(3), { invoices: true })).status, 200);
    assert.equal((await api(vNew, 3, fm, { action: "manager_invoice_list" })).status, 403);
    assert.equal((await api(vNew, 3, fm, { action: "manager_roster_week" })).status, 200);
    return "floor manager: invoices 403, roster 200";
  });

  await check("the Administrator always has everything; every change is in the audit with who made it", async () => {
    assert.ok(allOk(await statuses(vNew, 1, gm)));
    const rows = (await db.admin.query(`select staff_ref::text as staff_ref, changed_by::text as changed_by, action from public.staff_audit where action = 'permissions' order by changed_at`)).rows;
    assert.deepEqual(rows.map((r) => [r[0], r[1]]), [[ID(2), ID(1)], [ID(2), ID(1)], [ID(3), ID(1)]]);
    return "3 changes recorded, all by the Administrator";
  });

  await check("switching back on restores access", async () => {
    assert.equal((await set(1, gm, ID(2), { hours: true, team: true, roster: true, time_off: true, stock: true, recipes: true, invoices: true })).status, 200);
    assert.ok(allOk(await statuses(vNew, 2, km)));
    return "every area 200 again";
  });

  section("D. Rollback");
  await check("rollback: managers get what the role gives; both servers still work", async () => {
    assert.equal((await set(1, gm, ID(2), { stock: false })).status, 200);
    assert.equal((await api(vNew, 2, km, { action: "manager_stock_list", department: "Kitchen" })).status, 403);
    const r = db.psqlFile(PERMS_DOWN); assert.ok(r.ok, r.stderr);
    assert.deepEqual(Object.keys(await db.fingerprints()).sort(), Object.keys(fpBefore).sort());
    assert.equal((await api(vNew, 2, km, { action: "manager_stock_list", department: "Kitchen" })).status, 200);
    const m = await login(vProd, 2);
    assert.ok(allOk(await statuses(vProd, 2, m)));
    return "stock 200 again (new server), every area 200 (production server)";
  });
} finally {
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL PERMISSION RELEASE CHECKS PASSED");
process.exit(failures ? 1 : 0);
