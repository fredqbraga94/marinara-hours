// Release check for Suppliers in two lists (Kitchen and Floor), on a
// production-like database, with the production server (baseline-v67) still
// working before and after. Synthetic data only: this repository is public.
// Run: node tests/integration/supplier-departments.mjs
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { startProdLikeDb, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "./edge-loader.mjs";
import { ID, PIN, reseed } from "./seed.mjs";

const NEW = "20261112000000_supplier_departments.sql";
const MIG = `supabase/migrations/${NEW}`;
const DOWN = "supabase/rollback/20261112000000_supplier_departments.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v67.ts");

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

  const list = async (n, tok, department) => (await api(vNew, n, tok, { action: "manager_supplier_list", ...(department ? { department } : {}) })).body;
  const save = (n, tok, supplier) => api(vNew, n, tok, { action: "manager_supplier_save", supplier });
  const pSave = async (n, supplier) => { const p = await login(vProd, n); return api(vProd, n, p, { action: "manager_supplier_save", supplier }); };
  await check("before the migration: suppliers saved by the production server", async () => {
    assert.equal((await pSave(1, { name: "Test Old Supplier", phone: "0400 000 001" })).status, 200);
  });
  await check("migration applies, runs twice; old suppliers go to Kitchen; production server keeps working", async () => {
    let r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    for (const role of ["anon", "authenticated"]) assert.equal(await one(`select has_function_privilege('${role}', 'public.manager_supplier_list(uuid,text)', 'execute')`), "f");
    assert.equal(await one("select department from public.suppliers where name = 'Test Old Supplier'"), "Kitchen");
    const p = await login(vProd, 1);
    const old = await api(vProd, 1, p, { action: "manager_supplier_list" });
    assert.equal(old.status, 200, JSON.stringify(old.body));
    assert.ok(old.body.data.suppliers.some((x) => x.name === "Test Old Supplier"));
    assert.equal((await pSave(1, { name: "Test Saved By Old Server" })).status, 200, "old server can still add");
  });
  await check("each manager sees and adds in their own list; the Administrator both", async () => {
    let r = await save(3, fm, { name: "Test Drinks Co", phone: "0400 000 002" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.supplier.department, "Floor", "a Floor Manager adds to Floor");
    r = await save(2, km, { name: "Test Veg Co" });
    assert.equal(r.body.data.supplier.department, "Kitchen");
    const k = (await list(2, km)).data, f = (await list(3, fm)).data;
    assert.equal(k.department, "Kitchen"); assert.equal(k.can_choose_department, false);
    assert.ok(k.suppliers.some((x) => x.name === "Test Veg Co") && !k.suppliers.some((x) => x.name === "Test Drinks Co"));
    assert.deepEqual(f.suppliers.map((x) => x.name), ["Test Drinks Co"]);
    const a = (await list(1, gm, "Floor")).data;
    assert.equal(a.can_choose_department, true);
    assert.deepEqual(a.suppliers.map((x) => x.name), ["Test Drinks Co"]);
    // The same name in both lists (e.g. food and wine).
    r = await save(1, gm, { name: "Test Veg Co", department: "Floor" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await save(1, gm, { name: "test veg co", department: "Floor" })).status, 409);
  });
  await check("a manager cannot read, add, edit, move or remove the other list", async () => {
    assert.equal((await api(vNew, 2, km, { action: "manager_supplier_list", department: "Floor" })).status, 403);
    assert.equal((await save(2, km, { name: "Test Sneaky", department: "Floor" })).status, 403);
    const drinks = (await list(3, fm)).data.suppliers.find((x) => x.name === "Test Drinks Co");
    assert.equal((await save(2, km, { id: drinks.id, name: "Test Drinks Co" })).status, 404);
    assert.equal((await api(vNew, 2, km, { action: "manager_supplier_remove", id: drinks.id })).status, 404);
    const veg = (await list(2, km)).data.suppliers.find((x) => x.name === "Test Veg Co");
    assert.equal((await save(2, km, { id: veg.id, name: "Test Veg Co", department: "Floor" })).status, 403, "Kitchen Manager cannot move to Floor");
  });
  await check("the Administrator moves a supplier to the other list", async () => {
    const old = (await list(1, gm, "Kitchen")).data.suppliers.find((x) => x.name === "Test Old Supplier");
    const r = await save(1, gm, { id: old.id, name: old.name, phone: old.phone, department: "Floor" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.supplier.department, "Floor");
    assert.ok((await list(3, fm)).data.suppliers.some((x) => x.name === "Test Old Supplier"), "now in Floor");
    assert.ok(!(await list(2, km)).data.suppliers.some((x) => x.name === "Test Old Supplier"), "not in Kitchen");
  });
  await check("rollback (after taking out the name in both lists); both servers still work", async () => {
    await db.admin.query("update public.suppliers set active = false where name = 'Test Veg Co' and department = 'Floor'");
    const r = db.psqlFile(DOWN); assert.ok(r.ok, r.stderr);
    assert.equal(await one(`select count(*) from information_schema.columns where table_name = 'suppliers' and column_name = 'department'`), "0");
    const p0 = await login(vProd, 1);
    assert.equal((await api(vProd, 1, p0, { action: "manager_supplier_list" })).status, 200);
    assert.equal((await api(vNew, 1, gm, { action: "manager_dashboard" })).status, 200);
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_dashboard" })).status, 200);
  });
} finally {
  db.stop();
}
log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL SUPPLIER DEPARTMENT CHECKS PASSED");
process.exit(failures ? 1 : 0);
