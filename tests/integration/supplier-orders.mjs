// Release check for supplier Orders (list of items, quantities, saved orders),
// on a production-like database with the current server. Synthetic data only.
// Run: node tests/integration/supplier-orders.mjs
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { startProdLikeDb, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "./edge-loader.mjs";
import { ID, PIN, reseed } from "./seed.mjs";

const NEW = "20261102000000_supplier_orders.sql";
const MIG = `supabase/migrations/${NEW}`;
const DOWN = "supabase/rollback/20261102000000_supplier_orders.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v61.ts");

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
    const r = await api(vNew, 2, km, { action: "manager_order_list" });
    assert.ok(r.status >= 400 && r.body.error);
    assert.equal((await api(vNew, 2, km, { action: "manager_dashboard" })).status, 200);
  });
  await check("migration applies, runs twice, closed to the public keys; production server keeps working", async () => {
    let r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await one(`select has_table_privilege('${role}', 'public.supplier_orders', 'select')`), "f");
      assert.equal(await one(`select has_function_privilege('${role}', 'public.manager_order_save(uuid,jsonb)', 'execute')`), "f");
    }
    const p = await login(vProd, 1);
    assert.equal((await api(vProd, 1, p, { action: "manager_dashboard" })).status, 200);
  });
  const SUP = "Test Veg Supplier";
  let tomato;
  await check("items added (no duplicates); list per supplier, by name", async () => {
    tomato = (await api(vNew, 2, km, { action: "manager_order_item_save", item: { supplier: SUP, name: "Test tomatoes", unit: "box" } })).body.data.item;
    await api(vNew, 3, fm, { action: "manager_order_item_save", item: { supplier: SUP, name: "Test basil", unit: "bunch" } });
    const dup = await api(vNew, 1, gm, { action: "manager_order_item_save", item: { supplier: SUP, name: "test TOMATOES" } });
    assert.equal(dup.body.data.item.existing, true);
    await api(vNew, 1, gm, { action: "manager_order_item_save", item: { supplier: "Test Other", name: "Test bread" } });
    assert.equal((await api(vNew, 1, gm, { action: "manager_order_item_save", item: { supplier: SUP, name: "" } })).status, 400);
    const l = (await api(vNew, 2, km, { action: "manager_order_list", supplier: SUP })).body.data;
    assert.deepEqual(l.items.map((i) => i.name), ["Test basil", "Test tomatoes"]);
    assert.deepEqual(l.suppliers, ["Test Other", SUP].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    assert.equal(l.location, "Hawthorne");
  });
  await check("an order is saved with who and when; empty quantities left out; empty order refused", async () => {
    const r = await api(vNew, 2, km, { action: "manager_order_save", order: { supplier: SUP, deliver_on: "2026-11-03", note: "Before 10am", lines: [{ name: "Test tomatoes", unit: "box", qty: "2" }, { name: "Test basil", unit: "bunch", qty: "" }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.order.lines.length, 1);
    assert.equal((await api(vNew, 2, km, { action: "manager_order_save", order: { supplier: SUP, lines: [{ name: "Test basil", qty: "" }] } })).status, 400);
    assert.equal((await api(vNew, 2, km, { action: "manager_order_save", order: { supplier: SUP, deliver_on: "nope", lines: [{ name: "Test basil", qty: "1" }] } })).status, 200, "a bad date is left out");
    const l = (await api(vNew, 1, gm, { action: "manager_order_list", supplier: SUP })).body.data;
    assert.equal(l.orders.length, 2);
    const first = l.orders[1];
    assert.equal(first.by, "Test Kitchen Manager"); assert.equal(first.note, "Before 10am"); assert.equal(first.deliver_on, "2026-11-03");
    assert.deepEqual(first.lines, [{ name: "Test tomatoes", unit: "box", qty: "2" }]);
  });
  await check("an item taken off the list; staff refused; other units separate", async () => {
    assert.equal((await api(vNew, 1, gm, { action: "manager_order_item_save", item: { id: tomato.id, active: false } })).status, 200);
    let l = (await api(vNew, 1, gm, { action: "manager_order_list", supplier: SUP })).body.data;
    assert.deepEqual(l.items.map((i) => i.name), ["Test basil"]);
    const st = await login(vNew, 4);
    assert.ok((await api(vNew, 4, st, { action: "manager_order_list" })).status >= 400);
    assert.equal((await api(vNew, 1, gm, { action: "manager_unit_set", location: "Paddington" })).status, 200);
    l = (await api(vNew, 1, gm, { action: "manager_order_list", supplier: SUP })).body.data;
    assert.equal(l.items.length, 0); assert.equal(l.orders.length, 0);
    assert.equal((await api(vNew, 1, gm, { action: "manager_order_item_save", item: { id: tomato.id, active: true } })).status, 404);
    assert.equal((await api(vNew, 1, gm, { action: "manager_unit_set", location: "Hawthorne" })).status, 200);
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
log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL ORDER CHECKS PASSED");
process.exit(failures ? 1 : 0);
