// Release check for Suppliers (name, contact person, phone, email, note), on a
// production-like database, with the production server (baseline-v64) still
// working before and after. Synthetic data only: this repository is public.
// Run: node tests/integration/suppliers.mjs
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { startProdLikeDb, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "./edge-loader.mjs";
import { ID, PIN, reseed } from "./seed.mjs";

const NEW = "20261109000000_suppliers.sql";
const MIG = `supabase/migrations/${NEW}`;
const DOWN = "supabase/rollback/20261109000000_suppliers.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v64.ts");

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
    const r = await api(vNew, 2, km, { action: "manager_supplier_list" });
    assert.ok(r.status >= 400 && r.body.error);
    assert.equal((await api(vNew, 2, km, { action: "manager_dashboard" })).status, 200);
  });
  await check("migration applies, runs twice, closed to the public keys; production server keeps working", async () => {
    let r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await one(`select has_table_privilege('${role}', 'public.suppliers', 'select')`), "f");
      assert.equal(await one(`select has_function_privilege('${role}', 'public.manager_supplier_save(uuid,jsonb)', 'execute')`), "f");
      assert.equal(await one(`select has_function_privilege('${role}', 'public.manager_supplier_list(uuid)', 'execute')`), "f");
    }
    const p = await login(vProd, 1);
    assert.equal((await api(vProd, 1, p, { action: "manager_dashboard" })).status, 200);
  });
  let veg;
  await check("names used in Orders are suggested until saved; any manager adds one", async () => {
    await api(vNew, 2, km, { action: "manager_order_item_save", item: { supplier: "Test Veg Co", name: "Test tomatoes" } });
    let l = (await api(vNew, 2, km, { action: "manager_supplier_list" })).body.data;
    assert.deepEqual(l.suppliers, []);
    assert.ok(l.known.includes("Test Veg Co"), JSON.stringify(l.known));
    const r = await api(vNew, 3, fm, { action: "manager_supplier_save", supplier: {
      name: " Test Veg Co ", contact: "Test Person", phone: "0400 000 000", email: "Orders@Test-Veg.example", note: "Order by 2pm" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    veg = r.body.data.supplier;
    assert.deepEqual({ ...veg, id: undefined }, { id: undefined, name: "Test Veg Co", contact: "Test Person", phone: "0400 000 000", email: "orders@test-veg.example", note: "Order by 2pm" });
    await api(vNew, 1, gm, { action: "manager_supplier_save", supplier: { name: "Test Bakery" } });
    l = (await api(vNew, 2, km, { action: "manager_supplier_list" })).body.data;
    assert.deepEqual(l.suppliers.map((s) => s.name), ["Test Bakery", "Test Veg Co"]);
    assert.ok(!l.known.includes("Test Veg Co"), "no longer suggested once saved");
    assert.equal(l.location, "Hawthorne");
  });
  await check("bad input and a second supplier with the same name are refused", async () => {
    const save = (supplier) => api(vNew, 1, gm, { action: "manager_supplier_save", supplier });
    assert.equal((await save({ name: "" })).status, 400);
    assert.equal((await save({ name: "Test X", phone: "call me" })).status, 400);
    assert.equal((await save({ name: "Test X", email: "not-an-email" })).status, 400);
    const dup = await save({ name: "test veg co" });
    assert.equal(dup.status, 409); assert.equal(dup.body.code, "SUPPLIER_EXISTS");
    assert.equal((await save({ id: "nope", name: "Test X" })).status, 404);
  });
  await check("edit (same name kept, fields cleared), remove, then the name can be used again", async () => {
    let r = await api(vNew, 2, km, { action: "manager_supplier_save", supplier: { id: veg.id, name: "Test Veg Co", phone: "07 3000 0000" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.supplier.phone, "07 3000 0000"); assert.equal(r.body.data.supplier.email, null); assert.equal(r.body.data.supplier.contact, null);
    assert.equal((await api(vNew, 2, km, { action: "manager_supplier_remove", id: veg.id })).status, 200);
    assert.equal((await api(vNew, 2, km, { action: "manager_supplier_remove", id: veg.id })).status, 404);
    const l = (await api(vNew, 2, km, { action: "manager_supplier_list" })).body.data;
    assert.deepEqual(l.suppliers.map((s) => s.name), ["Test Bakery"]);
    assert.ok(l.known.includes("Test Veg Co"), "suggested again after removal");
    assert.equal((await api(vNew, 2, km, { action: "manager_supplier_save", supplier: { name: "Test Veg Co" } })).status, 200);
  });
  await check("staff refused; another unit has its own list", async () => {
    const st = await login(vNew, 4);
    assert.ok((await api(vNew, 4, st, { action: "manager_supplier_list" })).status >= 400);
    assert.equal((await api(vNew, 1, gm, { action: "manager_unit_set", location: "Paddington" })).status, 200);
    const l = (await api(vNew, 1, gm, { action: "manager_supplier_list" })).body.data;
    assert.deepEqual(l.suppliers, []);
    const bakery = (await api(vNew, 2, km, { action: "manager_supplier_list" })).body.data.suppliers[0];
    assert.equal((await api(vNew, 1, gm, { action: "manager_supplier_remove", id: bakery.id })).status, 404);
    assert.equal((await api(vNew, 1, gm, { action: "manager_unit_set", location: "Hawthorne" })).status, 200);
  });
  await check("rollback removes it; both servers still work", async () => {
    const r = db.psqlFile(DOWN); assert.ok(r.ok, r.stderr);
    assert.equal(await one(`select to_regclass('public.suppliers') is null`), "t");
    assert.equal((await api(vNew, 1, gm, { action: "manager_dashboard" })).status, 200);
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_dashboard" })).status, 200);
  });
} finally {
  db.stop();
}
log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL SUPPLIER CHECKS PASSED");
process.exit(failures ? 1 : 0);
