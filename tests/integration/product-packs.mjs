// Release check for units in a carton typed in Finance → Products, on a
// production-like database, with the production server (baseline-v69) still
// working before and after.
// Synthetic data only: this repository is public.
// Run: node tests/integration/product-packs.mjs
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { startProdLikeDb, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "./edge-loader.mjs";
import { ID, PIN, reseed } from "./seed.mjs";

const NEW = "20261115000000_product_packs.sql";
const MIG = `supabase/migrations/${NEW}`;
const DOWN = "supabase/rollback/20261115000000_product_packs.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v69.ts");

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
  const pack = (n, tok, product_key, p, extra = {}) => api(vNew, n, tok, { action: "manager_invoice_pack_save", supplier: SUP, product_key, pack: p, ...extra });
  const prod = async (n, tok, key, department) => (await api(vNew, n, tok, { action: "manager_invoice_price_book", ...(department ? { department } : {}) })).body.data.products.find((p) => p.product_key === key);

  await check("before the migration: a clear 'not ready'; Products works", async () => {
    assert.equal((await api(vNew, 2, km, { action: "manager_invoice_save", invoice: inv(SUP, "TD-1", daysAgo(5), [L("BUT1", "Test Butter Unsalted 1kg", 2, "CTN", 181), L("CRM1", "Test Cream 5lt", 3, "Ctn [3]", 40)]) })).status, 200);
    const r = await pack(2, km, "BUT1", 10);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal((await prod(2, km, "CRM1")).pack, 3);
  });
  await check("migration applies, runs twice, closed to the public keys; production server keeps working", async () => {
    let r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await one(`select has_table_privilege('${role}', 'public.supplier_product_packs', 'select')`), "f");
      assert.equal(await one(`select has_function_privilege('${role}', 'public.mh_product_pack_save(uuid,text,jsonb)', 'execute')`), "f");
    }
    const p = await login(vProd, 2);
    for (const action of ["manager_invoice_price_book", "manager_invoice_list", "manager_ingredient_costs"]) assert.equal((await api(vProd, 2, p, { action })).status, 200, action);
  });
  await check("a manager types 10 in a ctn: Products gives it back (and it wins over the invoice's count)", async () => {
    let r = await pack(2, km, "BUT1", 10);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let b = await prod(2, km, "BUT1");
    assert.equal(b.pack, 10); assert.equal(b.pack_saved, true); assert.equal(Number(b.last_price), 181, "the price stays the carton's");
    r = await pack(1, gm, "CRM1", 4, { department: "Kitchen" });
    assert.equal(r.status, 200);
    assert.equal((await prod(2, km, "CRM1")).pack, 4);
    assert.equal((await prod(2, km, "CRM1")).pack_saved, true);
    r = await pack(2, km, "BUT1", 12);
    assert.equal((await prod(2, km, "BUT1")).pack, 12, "typed again: replaced");
    assert.equal(await one("select count(*) from public.supplier_product_packs where product_key = 'BUT1'"), "1");
  });
  await check("clear goes back to the invoice's count; bad numbers and staff refused", async () => {
    assert.equal((await pack(2, km, "CRM1", null)).status, 200);
    const c = await prod(2, km, "CRM1");
    assert.equal(c.pack, 3); assert.equal(c.pack_saved, false);
    for (const bad of [0, 1001, 2.5, "x"]) assert.equal((await pack(2, km, "BUT1", bad)).status, 400, String(bad));
    assert.equal((await api(vNew, 2, km, { action: "manager_invoice_pack_save", product_key: "BUT1", pack: 5 })).status, 400);
    const st = await login(vNew, 4);
    assert.ok((await pack(4, st, "BUT1", 5)).status >= 400);
    assert.ok((await pack(2, km, "BUT1", 5, { department: "Floor" })).status >= 400, "Kitchen Manager not on Floor");
    assert.equal((await pack(3, fm, "BUT1", 6)).status, 200, "Floor Manager on their own list");
  });
  await check("rollback removes it; both servers still work", async () => {
    const r = db.psqlFile(DOWN); assert.ok(r.ok, r.stderr);
    assert.equal(await one(`select to_regclass('public.supplier_product_packs') is null`), "t");
    assert.equal((await prod(2, km, "CRM1")).pack, 3);
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_invoice_price_book" })).status, 200);
  });
} finally {
  db.stop();
}
log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CARTON SIZE CHECKS PASSED");
process.exit(failures ? 1 : 0);
