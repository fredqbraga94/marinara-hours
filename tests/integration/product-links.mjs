// Release check for "Same product as" in Finance → Products (two names of one
// product joined), on a production-like database, with the production server
// (baseline-v71) still working before and after.
// Synthetic data only: this repository is public.
// Run: node tests/integration/product-links.mjs
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { startProdLikeDb, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "./edge-loader.mjs";
import { ID, PIN, reseed } from "./seed.mjs";

const NEW = "20261116000000_product_links.sql";
const MIG = `supabase/migrations/${NEW}`;
const DOWN = "supabase/rollback/20261116000000_product_links.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v71.ts");

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
  const today = new Date(Date.now() + 10 * 3600e3).toISOString().slice(0, 10);
  const daysAgo = (n) => new Date(Date.now() + 10 * 3600e3 - n * 864e5).toISOString().slice(0, 10);
  const L = (code, description, qty, unit, unit_price) => ({ code, description, qty, unit, unit_price, line_total: qty * unit_price, gst: 0 });
  const inv = (supplier, number, date, lines) => ({ supplier, number, kind: "invoice", date, checks_ok: true,
    subtotal: lines.reduce((a, l) => a + l.line_total, 0), gst: 0, total: lines.reduce((a, l) => a + l.line_total, 0), lines });
  const SUP = "Test Dairy Co";
  const link = (n, tok, product_key, same_as, extra = {}) => api(vNew, n, tok, { action: "manager_invoice_link_save", supplier: SUP, product_key, same_as, ...extra });
  const book = async (n, tok, department) => (await api(vNew, n, tok, { action: "manager_invoice_price_book", ...(department ? { department } : {}) })).body.data.products.filter((p) => p.supplier === SUP);
  const prod = async (n, tok, key) => (await book(n, tok)).find((p) => p.product_key === key);

  await check("before the migration: a clear 'not ready'; Products works", async () => {
    // Old code, then the same product under a new code (cheaper), and another product.
    assert.equal((await api(vNew, 2, km, { action: "manager_invoice_save", invoice: inv(SUP, "TD-1", daysAgo(20), [L("OLD1", "Test Big Blend Cheese (Test Brand) 2kg", 3, "Ctn [4]", 22.33), L("BUT1", "Test Butter 1kg", 1, "EA", 9)]) })).status, 200);
    assert.equal((await api(vNew, 2, km, { action: "manager_invoice_save", invoice: inv(SUP, "TD-2", daysAgo(5), [L("NEW1", "Test Big Blend Shredded Cheese 2kg", 2, "Ctn [4]", 19.65)]) })).status, 200);
    const r = await link(2, km, "OLD1", "NEW1");
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal((await book(2, km)).length, 3);
  });
  await check("migration applies, runs twice, closed to the public keys; production server keeps working", async () => {
    let r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await one(`select has_table_privilege('${role}', 'public.supplier_product_links', 'select')`), "f");
      assert.equal(await one(`select has_function_privilege('${role}', 'public.mh_product_link_save(uuid,text,jsonb)', 'execute')`), "f");
    }
    const p = await login(vProd, 2);
    for (const action of ["manager_invoice_price_book", "manager_invoice_list", "manager_ingredient_costs"]) assert.equal((await api(vProd, 2, p, { action })).status, 200, action);
    assert.equal((await book(2, km)).length, 3, "nothing joined yet");
  });
  await check("joined: one product with both prices, the change between them, and the other name", async () => {
    const r = await link(2, km, "OLD1", "NEW1");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = await book(2, km);
    assert.equal(b.length, 2);
    const p = b.find((x) => x.product_key === "NEW1");
    assert.equal(Number(p.last_price), 19.65);
    assert.equal(Number(p.previous_price), 22.33);
    assert.equal(Number(p.change_pct), -12);
    assert.equal(p.times, 2);
    assert.equal(p.history.length, 2);
    assert.deepEqual(p.merged, [{ product_key: "OLD1", code: "OLD1", description: "Test Big Blend Cheese (Test Brand) 2kg" }]);
    assert.equal(p.pack, 4);
    assert.equal((await prod(2, km, "BUT1")).merged, null);
    assert.equal(await one("select count(*) from public.supplier_invoice_lines where code = 'OLD1'"), "1", "invoices unchanged");
  });
  await check("links stay one step; a product cannot be joined to itself; staff and wrong list refused", async () => {
    // BUT1 joined to OLD1 (itself joined to NEW1) goes to NEW1.
    assert.equal((await link(2, km, "BUT1", "OLD1")).status, 200);
    assert.equal(await one("select same_as from public.supplier_product_links where product_key = 'BUT1'"), "NEW1");
    assert.equal((await link(2, km, "BUT1", null)).status, 200);
    // NEW1 joined to BUT1: OLD1 follows it.
    assert.equal((await link(1, gm, "NEW1", "BUT1", { department: "Kitchen" })).status, 200);
    assert.equal(await one("select same_as from public.supplier_product_links where product_key = 'OLD1'"), "BUT1");
    assert.equal((await book(2, km)).length, 1);
    assert.equal((await link(2, km, "NEW1", null)).status, 200);
    assert.equal((await link(2, km, "OLD1", "NEW1")).status, 200);
    assert.equal((await link(2, km, "NEW1", "NEW1")).status, 400);
    assert.ok((await link(2, km, "NEW1", "OLD1")).status >= 400, "joined to its own name");
    assert.equal((await api(vNew, 2, km, { action: "manager_invoice_link_save", product_key: "OLD1", same_as: "NEW1" })).status, 400);
    const st = await login(vNew, 4);
    assert.ok((await link(4, st, "OLD1", "NEW1")).status >= 400);
    assert.ok((await link(2, km, "OLD1", "NEW1", { department: "Floor" })).status >= 400, "Kitchen Manager not on Floor");
  });
  await check("Separate: two products again", async () => {
    assert.equal((await link(2, km, "OLD1", null)).status, 200);
    assert.equal((await book(2, km)).length, 3);
    assert.equal(await one("select count(*) from public.supplier_product_links"), "0");
  });
  await check("rollback removes it; both servers still work", async () => {
    assert.equal((await link(2, km, "OLD1", "NEW1")).status, 200);
    const r = db.psqlFile(DOWN); assert.ok(r.ok, r.stderr);
    assert.equal(await one(`select to_regclass('public.supplier_product_links') is null`), "t");
    assert.equal((await book(2, km)).length, 3);
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_invoice_price_book" })).status, 200);
  });
} finally {
  db.stop();
}
log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL SAME PRODUCT CHECKS PASSED");
process.exit(failures ? 1 : 0);
