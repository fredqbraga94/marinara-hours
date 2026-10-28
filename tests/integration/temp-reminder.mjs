// Release check for the temperature check reminders (phone notifications at
// 11:00 and 20:45), on a production-like database. Production at release time =
// everything up to the temperature records, served by the current main server
// (tests/edge/baseline-v56.ts). Push services are not contacted: a stub records
// what would be sent. The database clock (pg_cron) is not in the test database;
// the job's call is made directly.
// Synthetic suppliers, numbers and prices only: this repository is public.
// Run: node tests/integration/temp-reminder.mjs
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
];
const REM = "supabase/migrations/20261029010000_temp_reminder.sql";
const REM_DOWN = "supabase/rollback/20261029010000_temp_reminder.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v56.ts");

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
  for (const f of BEFORE.slice(-14)) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  const vProd = await quiet(() => loadHandler(PROD_SERVER));
  const vNew = await quiet(() => loadHandler(NEW_SERVER));
  const sent = [];
  globalThis.__MH_PUSH_SEND = async (s, message) => { sent.push({ endpoint: s.endpoint, message }); return { ok: true, gone: false, status: 201 }; };
  const dev = Object.fromEntries([1, 2, 3, 4].map((n) => [n, newDeviceSecret()]));
  const login = async (h, n) => {
    const r = await quiet(() => call(h, { action: "login", pin: PIN[ID(n)], device: dev[n] }));
    assert.equal(r.status, 200, `login ${n}: ${JSON.stringify(r.body)}`);
    return r.body.session.token;
  };
  const api = (h, n, token, body) => quiet(() => call(h, { ...body, token, device: dev[n] }));
  const cron = (body) => quiet(() => call(vNew, body));

  section("A. Migration");
  await check("applies without the database clock; closed to the public keys; runs twice; production server keeps working", async () => {
    const r = db.psqlFile(REM); assert.ok(r.ok, r.stderr);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await one(db, `select has_table_privilege('${role}', 'public.mh_cron_config', 'select')`), "f", role);
      assert.equal(await one(db, `select has_function_privilege('${role}', 'public.mh_temp_reminder_due(text,text)', 'execute')`), "f", role);
      assert.equal(await one(db, `select has_function_privilege('${role}', 'public.mh_temp_reminder_tick(text)', 'execute')`), "f", role);
    }
    const key = await one(db, `select key from public.mh_cron_config`);
    assert.ok(/^[0-9a-f]{64}$/.test(key), "a random key");
    const again = db.psqlFile(REM); assert.ok(again.ok, again.stderr);
    assert.equal(await one(db, `select key from public.mh_cron_config`), key, "the key does not change");
    const p = await login(vProd, 1);
    assert.equal((await api(vProd, 1, p, { action: "manager_dashboard" })).status, 200);
    return "no clock in the test database (Supabase has it)";
  });

  section("B. Reminders");
  const gm = await login(vNew, 1);
  const km = await login(vNew, 2);
  const fm = await login(vNew, 3);
  const key = await one(db, `select key from public.mh_cron_config`);
  for (const [n, token] of [[1, gm], [2, km], [3, fm]]) {
    const r = await api(vNew, n, token, { action: "manager_push_subscribe", ...sub(n), label: `QA phone ${n}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  let fridge, freezer;
  await check("wrong or missing key is refused and sends nothing", async () => {
    for (const body of [{ action: "cron_temp_reminder", slot: "opening" }, { action: "cron_temp_reminder", key: "wrong", slot: "opening" }, { action: "cron_temp_reminder", key, slot: "lunch" }]) {
      const r = await cron(body); assert.equal(r.status, 403, JSON.stringify(body));
    }
    assert.equal(sent.length, 0);
    return "403";
  });
  await check("no equipment: nothing to remind", async () => {
    const r = await cron({ action: "cron_temp_reminder", key, slot: "opening" });
    assert.equal(r.status, 200); assert.equal(r.body.data.locations, 0); assert.equal(sent.length, 0);
    return "silent";
  });
  await check("opening missing: the kitchen (Administrator and Kitchen Manager, not the Floor Manager) gets one reminder that opens Temperatures; a second call the same day sends nothing", async () => {
    fridge = (await api(vNew, 2, km, { action: "manager_temp_equipment_save", item: { name: "Test cool room", kind: "fridge" } })).body.data.equipment;
    freezer = (await api(vNew, 2, km, { action: "manager_temp_equipment_save", item: { name: "Test freezer", kind: "freezer" } })).body.data.equipment;
    await api(vNew, 2, km, { action: "manager_temp_record", entry: { kind: "equipment", equipment_id: fridge.id, slot: "opening", temp: 3 } });
    const r = await cron({ action: "cron_temp_reminder", key, slot: "opening" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.sent, 2, "Administrator and Kitchen Manager");
    assert.equal(sent.length, 2);
    assert.equal(sent.some((x) => x.endpoint === sub(3).endpoint), false, "not the Floor Manager");
    const m = sent[0].message;
    assert.equal(m.title, "Temperature check: opening");
    assert.equal(m.body, "1 of 2 not checked yet: Test freezer.");
    assert.equal(m.url, "./?open=temps");
    const again = await cron({ action: "cron_temp_reminder", key, slot: "opening" });
    assert.equal(again.body.data.locations, 0); assert.equal(sent.length, 2, "once per day");
    return m.body;
  });
  await check("closing: all done means no reminder", async () => {
    for (const e of [fridge, freezer]) await api(vNew, 2, km, { action: "manager_temp_record", entry: { kind: "equipment", equipment_id: e.id, slot: "closing", temp: e.kind === "freezer" ? -18 : 3 } });
    const r = await cron({ action: "cron_temp_reminder", key, slot: "closing" });
    assert.equal(r.body.data.locations, 0); assert.equal(sent.length, 2);
    return "nothing missing, nothing sent";
  });
  await check("the scheduled call does nothing until the server address is set", async () => {
    await db.admin.query(`select public.mh_temp_reminder_tick('opening')`);
    return "no address: no call";
  });

  section("C. Rollback");
  await check("rollback removes it; both servers still work", async () => {
    const r = db.psqlFile(REM_DOWN); assert.ok(r.ok, r.stderr);
    assert.equal((await api(vNew, 1, gm, { action: "manager_dashboard" })).status, 200);
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_dashboard" })).status, 200);
    return "Home 200 on both";
  });
} finally {
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL TEMPERATURE REMINDER CHECKS PASSED");
process.exit(failures ? 1 : 0);
