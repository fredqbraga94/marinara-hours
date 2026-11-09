// Release check for Compare suppliers: packs, groups made by hand, "not the
// same", what was bought in 90 days, on a production-like database, with the
// production server (baseline-v67) still working before and after. Synthetic data only: this repository is public.
// Run: node tests/integration/supplier-compare.mjs
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { startProdLikeDb, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "./edge-loader.mjs";
import { ID, PIN, reseed } from "./seed.mjs";

const NEW = "20261111000000_supplier_compare.sql";
const MIG = `supabase/migrations/${NEW}`;
const DOWN = "supabase/rollback/20261111000000_supplier_compare.down.sql";
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
  const today = new Date(Date.now() + 10 * 3600e3).toISOString().slice(0, 10);
  const daysAgo = (n) => new Date(Date.now() + 10 * 3600e3 - n * 864e5).toISOString().slice(0, 10);
  const inv = (supplier, number, date, lines) => ({ supplier, number, kind: "invoice", date, checks_ok: true,
    subtotal: lines.reduce((a, l) => a + l.line_total, 0), gst: 0, total: lines.reduce((a, l) => a + l.line_total, 0), lines });
  const L = (code, description, qty, unit, unit_price) => ({ code, description, qty, unit, unit_price, line_total: qty * unit_price, gst: 0 });
  const cmp = async (n, tok) => (await api(vNew, n, tok, { action: "manager_supplier_compare" })).body.data;
  const save = (n, tok, data) => api(vNew, n, tok, { action: "manager_supplier_compare_save", data });

  await check("before the migration: clear answer; invoices still work", async () => {
    for (const [s, n, d, l] of [
      ["Test Wholesale A", "A-1", daysAgo(10), [L("A1", "TEST BRAND · BACON DICED · 2.5KG", 2, "CTN", 150), L("A2", "TEST · MILK FULL CREAM 2LT · 6Q", 3, "CTN", 24)]],
      ["Test Wholesale A", "A-2", daysAgo(200), [L("A1", "TEST BRAND · BACON DICED · 2.5KG", 5, "CTN", 140)]],
      ["Test Deli B", "B-1", daysAgo(5), [L("B1", "Test Brand Bacon Diced 2.5kg", 4, "Ctn [6]", 23.5), L("", "Test Mascarpone 1kg", 2, "Unit", 18)]],
    ]) assert.equal((await api(vNew, 1, gm, { action: "manager_invoice_save", invoice: inv(s, n, d, l) })).status, 200);
    const r = await api(vNew, 2, km, { action: "manager_supplier_compare" });
    assert.ok(r.status >= 400 && r.body.error);
  });
  await check("migration applies, runs twice, closed to the public keys; production server keeps working", async () => {
    let r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await one(`select has_table_privilege('${role}', 'public.supplier_product_compare', 'select')`), "f");
      assert.equal(await one(`select has_function_privilege('${role}', 'public.manager_supplier_compare_save(uuid,text,jsonb)', 'execute')`), "f");
    }
    const p = await login(vProd, 1);
    for (const action of ["manager_dashboard", "manager_invoice_price_book"]) assert.equal((await api(vProd, 1, p, { action })).status, 200, action);
  });
  await check("bought in the last 90 days, per product; nothing saved yet", async () => {
    const d = await cmp(2, km);
    assert.deepEqual(d.saved, []);
    const b = Object.fromEntries(d.bought.map((x) => [`${x.supplier}|${x.product_key}`, Number(x.qty_90d)]));
    assert.equal(b["Test Wholesale A|A1"], 2, "the 200-day-old invoice is not counted");
    assert.equal(b["Test Deli B|B1"], 4);
    assert.equal(b["Test Deli B|test mascarpone 1kg"], 2, "no code: the name is the key");
  });
  await check("save what one price buys; clear it", async () => {
    let r = await save(2, km, { supplier: "Test Wholesale A", product_key: "A1", pack: { count: 6, size: 2.5, unit: "kg" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.product.pack, { count: 6, size: 2.5, unit: "kg" });
    r = await save(2, km, { supplier: "Test Wholesale A", product_key: "A2", pack: { count: 6, size: 2, unit: "l" } });
    assert.equal(r.status, 200);
    r = await save(2, km, { supplier: "Test Wholesale A", product_key: "A2", pack: null });
    assert.equal(r.body.data.product.pack, null);
    const d = await cmp(2, km);
    assert.deepEqual(d.saved.find((x) => x.product_key === "A1").pack, { count: 6, size: 2.5, unit: "kg" });
  });
  await check("put two products together; take one out", async () => {
    let r = await save(1, gm, { supplier: "Test Deli B", product_key: "test mascarpone 1kg", group_with: { supplier: "Test Wholesale A", product_key: "A2" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const g = r.body.data.product.group_id;
    assert.ok(g);
    let d = await cmp(2, km);
    assert.equal(d.saved.find((x) => x.product_key === "A2").group_id, g, "both in the same group");
    r = await save(1, gm, { supplier: "Test Deli B", product_key: "test mascarpone 1kg", ungroup: true });
    assert.equal(r.body.data.product.group_id, null);
    assert.equal(r.body.data.product.not_grouped, true);
    r = await save(1, gm, { supplier: "Test Deli B", product_key: "B1", group_with: { supplier: "Test Wholesale A", product_key: "A1" } });
    assert.equal(r.status, 200);
    d = await cmp(2, km);
    assert.equal(d.saved.find((x) => x.product_key === "B1").group_id, d.saved.find((x) => x.product_key === "A1").group_id);
  });
  await check("refused: unknown product, itself, bad pack, Floor Manager, staff", async () => {
    assert.equal((await save(2, km, { supplier: "Test Wholesale A", product_key: "NOPE" })).status, 404);
    assert.equal((await save(2, km, { supplier: "Test Wholesale A", product_key: "A1", group_with: { supplier: "Test Wholesale A", product_key: "A1" } })).status, 400);
    assert.equal((await save(2, km, { supplier: "Test Wholesale A", product_key: "A1", group_with: { supplier: "Nobody", product_key: "X" } })).status, 404);
    for (const pack of [{ count: 0, size: 1, unit: "kg" }, { count: 1, size: 1, unit: "box" }, { count: "x", size: 1, unit: "kg" }]) {
      assert.equal((await save(2, km, { supplier: "Test Wholesale A", product_key: "A1", pack })).status, 400, JSON.stringify(pack));
    }
    assert.equal((await save(2, km, { supplier: "", product_key: "A1" })).status, 400);
    assert.ok((await api(vNew, 3, fm, { action: "manager_supplier_compare" })).status >= 400, "Floor Manager refused");
    const st = await login(vNew, 4);
    assert.ok((await api(vNew, 4, st, { action: "manager_supplier_compare" })).status >= 400, "staff refused");
    assert.deepEqual((await cmp(2, km)).saved.find((x) => x.product_key === "A1").pack, { count: 6, size: 2.5, unit: "kg" }, "unchanged");
  });
  await check("rollback removes it; both servers still work", async () => {
    const r = db.psqlFile(DOWN); assert.ok(r.ok, r.stderr);
    assert.equal(await one(`select to_regclass('public.supplier_product_compare') is null`), "t");
    assert.equal((await api(vNew, 2, km, { action: "manager_invoice_price_book" })).status, 200, "Prices still work");
    assert.equal((await api(vNew, 1, gm, { action: "manager_dashboard" })).status, 200);
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_dashboard" })).status, 200);
  });
} finally {
  db.stop();
}
log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL SUPPLIER COMPARE CHECKS PASSED");
process.exit(failures ? 1 : 0);
