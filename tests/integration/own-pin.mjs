// Release check for own PINs (temporary PIN for a new person or a reset, the
// person chooses their own at first login), on a production-like database.
// Production at release time = everything up to the photos and contacts, served by the current main server
// (tests/edge/baseline-v53.ts).
// Synthetic people and items only: this repository is public.
// Run: node tests/integration/own-pin.mjs
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
];
const SHOP = "supabase/migrations/20261028030000_own_pin.sql";
const SHOP_DOWN = "supabase/rollback/20261028030000_own_pin.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v53.ts");

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
  for (const f of BEFORE.slice(-10)) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  const vProd = await quiet(() => loadHandler(PROD_SERVER));
  const vNew = await quiet(() => loadHandler(NEW_SERVER));
  const dev = Object.fromEntries([1, 2, 3, 4, 6].map((n) => [n, newDeviceSecret()]));
  const loginRaw = (h, n, pin) => quiet(() => call(h, { action: "login", pin, device: dev[n] }));
  const login = async (h, n) => {
    const r = await loginRaw(h, n, PIN[ID(n)]);
    assert.equal(r.status, 200, `login ${n}: ${JSON.stringify(r.body)}`);
    return r.body.session.token;
  };
  const api = (h, n, token, body) => quiet(() => call(h, { ...body, token, device: dev[n] }));

  section("A. Migration");
  await check("applies; closed to the public keys; runs twice; production server keeps working", async () => {
    const r = db.psqlFile(SHOP); assert.ok(r.ok, r.stderr);
    for (const role of ["anon", "authenticated"]) {
      for (const fn of ["mh_random_free_pin()", "manager_staff_temp_pin(uuid,uuid)", "staff_change_pin(uuid,text,text)", "mh_pin_must_change(uuid)"]) {
        assert.equal(await one(db, `select has_function_privilege('${role}', 'public.${fn}', 'execute')`), "f", `${role} ${fn}`);
      }
    }
    const again = db.psqlFile(SHOP); assert.ok(again.ok, again.stderr);
    const gm = await login(vProd, 1);
    assert.equal((await api(vProd, 1, gm, { action: "manager_dashboard" })).status, 200);
    return "functions for the server only; Home 200 on the current server";
  });

  section("B. New person with a temporary PIN");
  const gm = await login(vNew, 1);
  const km = await login(vNew, 2);
  let newStaff, tempPin, token;
  await check("a manager adds a person without a PIN: the app makes a temporary one", async () => {
    const r = await api(vNew, 1, gm, { action: "manager_create_staff", name: "Test New Person", department: "Floor" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    newStaff = r.body.data.staff;
    tempPin = r.body.data.temporary_pin;
    assert.match(tempPin, /^[0-9]{6}$/);
    assert.equal(await one(db, `select pin_must_change from public.staff where id = '${newStaff.id}'`), "t");
    assert.equal(await one(db, `select count(*) from public.staff where pin_hash = extensions.crypt('${tempPin}', pin_hash)`), "1");
    assert.equal(await one(db, `select count(*)::int from public.staff_audit where staff_ref = '${newStaff.id}'`) >= 1, true);
    return "6-digit temporary PIN, used by one person only";
  });
  await check("only the Administrator adds people who sign in (Kitchen Manager refused, nothing created)", async () => {
    const before = await one(db, `select count(*) from public.staff`);
    for (const body of [{ name: "Test KM Adds", department: "Kitchen" }, { name: "Test KM Adds", department: "Kitchen", staff_pin: "836152" }]) {
      const r = await api(vNew, 2, km, { action: "manager_create_staff", ...body });
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(r.body.code, "ADMIN_REQUIRED");
    }
    assert.equal(await one(db, `select count(*) from public.staff`), before);
    return "403 ADMIN_REQUIRED";
  });
  await check("with a PIN given, the old way still works and nothing must be changed", async () => {
    const r = await api(vNew, 1, gm, { action: "manager_create_staff", name: "Test Old Way", department: "Kitchen", staff_pin: "834251" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.temporary_pin, null);
    assert.equal(await one(db, `select pin_must_change from public.staff where id = '${r.body.data.staff.id}'`), "f");
    return "no temporary PIN";
  });
  dev[20] = newDeviceSecret();
  await check("first login says the PIN must be changed; everything else is refused until then", async () => {
    const r = await loginRaw(vNew, 20, tempPin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.must_change, true);
    token = r.body.session.token;
    const s = await api(vNew, 20, token, { action: "session_status" });
    assert.equal(s.status, 401, JSON.stringify(s.body));
    assert.match(s.body.error, /own PIN/);
    const m = await api(vNew, 20, token, { action: "manager_dashboard" });
    assert.ok(m.status >= 400);
    return "session_status 401 'Choose your own PIN'";
  });
  await check("wrong current PIN, simple PIN and a PIN someone else uses are refused with clear messages", async () => {
    const bad = (old, nw) => api(vNew, 20, token, { action: "change_pin", old_pin: old, new_pin: nw });
    let r = await bad("111111", "482913"); assert.equal(r.status, 400); assert.equal(r.body.code, "WRONG_OLD");
    r = await bad(tempPin, "1234"); assert.equal(r.status, 400); assert.equal(r.body.code, "TOO_SIMPLE");
    r = await bad(tempPin, "333333"); assert.equal(r.status, 400); assert.equal(r.body.code, "TOO_SIMPLE");
    r = await bad(tempPin, "abc"); assert.equal(r.status, 400);
    assert.equal(await one(db, `select pin_must_change from public.staff where id = '${newStaff.id}'`), "t");
    return "nothing changed";
  });
  await check("after 5 refused tries the 6th is refused even with a good PIN (no guessing other people's PINs)", async () => {
    // 3 refusals above counted (WRONG_OLD, 1234, 333333); one more weak, then the PIN of another person.
    let r = await api(vNew, 20, token, { action: "change_pin", old_pin: tempPin, new_pin: PIN[ID(4)] });
    assert.equal(r.status, 400); assert.equal(r.body.code, "TOO_SIMPLE");
    assert.equal(r.body.error.includes("another"), false);
    r = await api(vNew, 20, token, { action: "change_pin", old_pin: tempPin, new_pin: "999999" });
    assert.equal(r.body.code, "TOO_SIMPLE");
    r = await api(vNew, 20, token, { action: "change_pin", old_pin: tempPin, new_pin: "482913" });
    assert.equal(r.status, 429, JSON.stringify(r.body)); assert.equal(r.body.code, "TOO_MANY");
    await db.admin.query(`delete from public.auth_events where event = 'pin_change_rejected' and staff_id = '${newStaff.id}'`);
    return "429 after 5";
  });
  await check("a good new PIN: the person can work, the temporary PIN stops working", async () => {
    const r = await api(vNew, 20, token, { action: "change_pin", old_pin: tempPin, new_pin: "482913" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await api(vNew, 20, token, { action: "session_status" })).status, 200);
    assert.equal((await loginRaw(vNew, 20, tempPin)).status, 401);
    const l = await loginRaw(vNew, 20, "482913");
    assert.equal(l.status, 200); assert.equal(l.body.must_change, false);
    assert.equal(await one(db, `select pin_must_change from public.staff where id = '${newStaff.id}'`), "f");
    assert.ok(Number(await one(db, `select count(*) from public.staff_audit where staff_ref = '${newStaff.id}' and action = 'staff_change_pin'`)) === 1);
    return "own PIN works; temporary one refused";
  });

  section("C. Reset of a forgotten PIN");
  await check("a manager resets: new temporary PIN, open sessions end, must change again", async () => {
    const oldToken = (await loginRaw(vNew, 20, "482913")).body.session.token;
    const r = await api(vNew, 1, gm, { action: "manager_staff_temp_pin", staff_id: newStaff.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t2 = r.body.data.temporary_pin;
    assert.match(t2, /^[0-9]{6}$/); assert.notEqual(t2, tempPin);
    assert.equal((await api(vNew, 20, oldToken, { action: "session_status" })).status, 401);
    assert.equal((await loginRaw(vNew, 20, "482913")).status, 401);
    const l = await loginRaw(vNew, 20, t2);
    assert.equal(l.body.must_change, true);
    return "old PIN and old session stop working";
  });
  await check("limits: Kitchen Manager cannot reset Floor staff or the Administrator; nobody resets themselves; staff cannot", async () => {
    let r = await api(vNew, 2, km, { action: "manager_staff_temp_pin", staff_id: newStaff.id });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    r = await api(vNew, 2, km, { action: "manager_staff_temp_pin", staff_id: ID(1) });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    r = await api(vNew, 1, gm, { action: "manager_staff_temp_pin", staff_id: ID(1) });
    assert.ok(r.status >= 400, JSON.stringify(r.body));
    const st = await login(vNew, 4);
    r = await api(vNew, 4, st, { action: "manager_staff_temp_pin", staff_id: ID(5) });
    assert.ok(r.status >= 400);
    assert.equal(await one(db, `select pin_must_change from public.staff where id = '${ID(5)}'`), "f");
    return "refused";
  });
  await check("anyone can change their own PIN later (Kitchen Manager)", async () => {
    const r = await api(vNew, 2, km, { action: "change_pin", old_pin: PIN[ID(2)], new_pin: "715804" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await loginRaw(vNew, 2, "715804")).status, 200);
    assert.equal((await loginRaw(vNew, 2, PIN[ID(2)])).status, 401);
    return "new PIN works, old one does not";
  });
  await check("PINs are stored only as hashes", async () => {
    assert.equal(await one(db, `select count(*) from public.staff where pin_hash in ('482913', '715804') or pin_hash !~ '^[$]2'`), "0");
    return "bcrypt hashes";
  });

  section("D. Rollback");
  await check("rollback removes it; both servers still work for people with a normal PIN", async () => {
    const r = db.psqlFile(SHOP_DOWN); assert.ok(r.ok, r.stderr);
    assert.equal(await one(db, `select count(*) from information_schema.columns where table_name = 'staff' and column_name = 'pin_must_change'`), "0");
    const n = await login(vNew, 3);
    assert.equal((await api(vNew, 3, n, { action: "manager_dashboard" })).status, 200, "new server without the migration");
    const p = await login(vProd, 3);
    assert.equal((await api(vProd, 3, p, { action: "manager_dashboard" })).status, 200);
    return "Home 200 on the current server";
  });
} finally {
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL OWN-PIN RELEASE CHECKS PASSED");
process.exit(failures ? 1 : 0);
