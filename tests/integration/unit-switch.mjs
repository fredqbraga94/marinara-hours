// Release check for the unit switch: the Administrator can look at Paddington or
// Clayfield and everything then works in that unit; Kitchen/Floor Managers and
// staff stay in their own unit. Production-like database; production at release
// time = everything up to the temperature reminders, served by the current main
// server (tests/edge/baseline-v57.ts). Synthetic data only.
// Run: node tests/integration/unit-switch.mjs
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
  "supabase/migrations/20261029000000_temp_log.sql",
  "supabase/migrations/20261029010000_temp_reminder.sql",
];
const UNIT = "supabase/migrations/20261029020000_unit_switch.sql";
const UNIT_DOWN = "supabase/rollback/20261029020000_unit_switch.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v57.ts");

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
const sub = (n) => ({ endpoint: `https://web.push.apple.com/QA${n}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, p256dh: "B" + "x".repeat(86), auth: "a".repeat(22) });

const db = await startProdLikeDb();
try {
  for (const f of BEFORE) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  useDatabase(db.svc);
  await reseed(db);
  for (const f of BEFORE.slice(-15)) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  const vProd = await quiet(() => loadHandler(PROD_SERVER));
  const vNew = await quiet(() => loadHandler(NEW_SERVER));
  globalThis.__MH_PUSH_SEND = async () => ({ ok: true, gone: false, status: 201 });
  const dev = Object.fromEntries([1, 2, 3, 4, 9].map((n) => [n, newDeviceSecret()]));
  const login = async (h, n) => {
    const r = await quiet(() => call(h, { action: "login", pin: PIN[ID(n)], device: dev[n] }));
    assert.equal(r.status, 200, `login ${n}: ${JSON.stringify(r.body)}`);
    return r.body.session.token;
  };
  const api = (h, n, token, body) => quiet(() => call(h, { ...body, token, device: dev[n] }));

  section("A. Before the migration");
  await check("new server: the Administrator stays in their unit; switching answers clearly", async () => {
    const gm = await login(vNew, 1);
    const d = await api(vNew, 1, gm, { action: "manager_dashboard" });
    assert.equal(d.status, 200); assert.equal(d.body.data.location, "Hawthorne");
    const r = await api(vNew, 1, gm, { action: "manager_unit_set", location: "Paddington" });
    assert.ok(r.status >= 400 && r.body.error, JSON.stringify(r.body));
    return `Home ${d.status}; switch ${r.status}`;
  });

  section("B. Migration");
  await check("applies; closed to the public keys; runs twice; production server keeps working", async () => {
    const r = db.psqlFile(UNIT); assert.ok(r.ok, r.stderr);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await one(db, `select has_table_privilege('${role}', 'public.manager_unit_view', 'select')`), "f", role);
      assert.equal(await one(db, `select has_function_privilege('${role}', 'public.manager_unit_set(uuid,text)', 'execute')`), "f", role);
    }
    const again = db.psqlFile(UNIT); assert.ok(again.ok, again.stderr);
    const p = await login(vProd, 1);
    assert.equal((await api(vProd, 1, p, { action: "manager_dashboard" })).status, 200);
    return "server only";
  });

  section("C. The Administrator looks at Paddington");
  const gm = await login(vNew, 1);
  const km = await login(vNew, 2);
  const fm = await login(vNew, 3);
  let padPerson;
  await check("only the Administrator can switch; unknown units refused", async () => {
    for (const [n, t] of [[2, km], [3, fm]]) {
      const r = await api(vNew, n, t, { action: "manager_unit_set", location: "Paddington" });
      assert.equal(r.status, 403, `manager ${n}`);
    }
    assert.equal((await api(vNew, 1, gm, { action: "manager_unit_set", location: "Sydney" })).status, 400);
    const u = (await api(vNew, 1, gm, { action: "manager_units" })).body.data;
    assert.equal(u.home, "Hawthorne"); assert.equal(u.current, "Hawthorne");
    assert.deepEqual(u.units.map((x) => x.location), ["Hawthorne", "Paddington", "Clayfield"]);
    return "Kitchen/Floor Managers 403";
  });
  await check("switched: Home, team and hours show Paddington (empty), the own unit is kept", async () => {
    const r = await api(vNew, 1, gm, { action: "manager_unit_set", location: "Paddington" });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.data.current, "Paddington");
    const d = (await api(vNew, 1, gm, { action: "manager_dashboard" })).body.data;
    assert.equal(d.location, "Paddington"); assert.equal(d.home_location, "Hawthorne");
    assert.equal(d.team.length, 0, "no Hawthorne people"); assert.equal(d.working.length, 0);
    const t = (await api(vNew, 1, gm, { action: "manager_team" })).body.data;
    assert.equal((t.team || t).length, 0);
    return "Paddington: 0 people";
  });
  await check("a person added now belongs to Paddington; Hawthorne managers do not see them", async () => {
    const r = await api(vNew, 1, gm, { action: "manager_create_staff", name: "Test Paddington Cook", department: "Kitchen", staff_pin: "731942" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    padPerson = await one(db, `select id::text from public.staff where name = 'Test Paddington Cook'`);
    assert.equal(await one(db, `select location from public.staff where id = '${padPerson}'`), "Paddington");
    const k = (await api(vNew, 2, km, { action: "manager_team" })).body.data;
    assert.equal(JSON.stringify(k).includes("Test Paddington Cook"), false, "Kitchen Manager of Hawthorne");
    const d = (await api(vNew, 1, gm, { action: "manager_dashboard" })).body.data;
    assert.equal(d.team.length, 1);
    return "location Paddington";
  });
  await check("Paddington's people sign in and clock in; the Administrator sees and clocks them out there", async () => {
    PIN[padPerson] = "731942";
    dev.p = newDeviceSecret();
    const lr = await quiet(() => call(vNew, { action: "login", pin: "731942", device: dev.p }));
    assert.equal(lr.status, 200, JSON.stringify(lr.body));
    const tok = lr.body.session.token;
    const ci = await quiet(() => call(vNew, { action: "session_clock_in", token: tok, device: dev.p }));
    assert.equal(ci.status, 200, JSON.stringify(ci.body));
    const d = (await api(vNew, 1, gm, { action: "manager_dashboard" })).body.data;
    assert.equal(d.working.length, 1);
    const shift = d.working[0].shift_id;
    const co = await api(vNew, 1, gm, { action: "manager_clock_out_staff", shift_id: shift, clock_out: new Date().toISOString() });
    assert.equal(co.status, 200, JSON.stringify(co.body));
    const k = await api(vNew, 2, km, { action: "manager_clock_out_staff", shift_id: shift, clock_out: new Date().toISOString() });
    assert.ok(k.status >= 400, "Hawthorne Kitchen Manager cannot touch Paddington");
    return "clock in, clock out";
  });
  await check("temperatures, shopping and stock go to Paddington", async () => {
    const e = (await api(vNew, 1, gm, { action: "manager_temp_equipment_save", item: { name: "Test Paddington fridge", kind: "fridge" } })).body.data.equipment;
    assert.equal(await one(db, `select location from public.temp_equipment where id = '${e.id}'`), "Paddington");
    const kt = (await api(vNew, 2, km, { action: "manager_temp_today" })).body.data;
    assert.equal(kt.equipment.some((x) => x.name === "Test Paddington fridge"), false);
    const s = await api(vNew, 1, gm, { action: "manager_shopping_save", item: { name: "Test Paddington napkins" } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(await one(db, `select location from public.shopping_items where name = 'Test Paddington napkins'`), "Paddington");
    return "all Paddington";
  });
  await check("the Administrator's own phone notifications stay in Hawthorne", async () => {
    const r = await api(vNew, 1, gm, { action: "manager_push_subscribe", ...sub(1), label: "QA phone" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await one(db, `select location from public.push_subscriptions where staff_id = '${ID(1)}'`), "Hawthorne");
    return "Hawthorne";
  });
  await check("back to Hawthorne: everything as before", async () => {
    const r = await api(vNew, 1, gm, { action: "manager_unit_set", location: "Hawthorne" });
    assert.equal(r.body.data.current, "Hawthorne");
    assert.equal(Number(await one(db, `select count(*) from public.manager_unit_view`)), 0, "no row for the own unit");
    const d = (await api(vNew, 1, gm, { action: "manager_dashboard" })).body.data;
    assert.equal(d.location, "Hawthorne"); assert.ok(d.team.length > 5);
    assert.equal(d.team.some((m) => m.name === "Test Paddington Cook"), false);
    const audit = Number(await one(db, `select count(*) from public.staff_audit where action = 'manager_unit_set'`));
    assert.equal(audit, 2);
    return "Hawthorne; 2 audit rows";
  });
  await check("a Kitchen Manager cannot be moved by a view row (only the Administrator role counts)", async () => {
    await one(db, `insert into public.manager_unit_view (staff_id, location) values ('${ID(2)}', 'Clayfield') returning 1`);
    const d = (await api(vNew, 2, km, { action: "manager_dashboard" })).body.data;
    assert.equal(d.location, "Hawthorne");
    await one(db, `delete from public.manager_unit_view where staff_id = '${ID(2)}' returning 1`);
    return "Hawthorne";
  });

  section("D. Rollback");
  await check("rollback: everyone in their own unit; both servers still work", async () => {
    await api(vNew, 1, gm, { action: "manager_unit_set", location: "Clayfield" });
    const r = db.psqlFile(UNIT_DOWN); assert.ok(r.ok, r.stderr);
    const d = (await api(vNew, 1, gm, { action: "manager_dashboard" })).body.data;
    assert.equal(d.location, "Hawthorne");
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_dashboard" })).status, 200);
    return "Hawthorne";
  });
} finally {
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL UNIT SWITCH CHECKS PASSED");
process.exit(failures ? 1 : 0);
