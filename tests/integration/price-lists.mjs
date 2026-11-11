// Release check for supplier price lists (Finance → Products → Import price
// list), on a production-like database, with the production server
// (baseline-v68) still working before and after. A price list gives prices,
// not purchases: Products and dish costs use it; spending does not.
// Synthetic data only: this repository is public.
// Run: node tests/integration/price-lists.mjs
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { startProdLikeDb, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "./edge-loader.mjs";
import { ID, PIN, reseed } from "./seed.mjs";

const NEW = "20261114000000_price_lists.sql";
const MIG = `supabase/migrations/${NEW}`;
const DOWN = "supabase/rollback/20261114000000_price_lists.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v68.ts");

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
  const SUP = "Test Wholesale";
  const kitchenItems = [
    { code: "TB-6", description: "Test Bacon Diced 2.5kg", unit: "Ctn [6]", unit_price: 24, pack: 6 },
    { code: "TC-1", description: "Test Cream 5lt", unit: "Unit", unit_price: 40, pack: 1 },
  ];
  const floorItems = [{ code: "TW-12", description: "Test Wine Red 750ml [12]", unit: "Ctn [12]", unit_price: 9.5, pack: 1 }];
  const saveList = (n, tok, items, department, date = today) => api(vNew, n, tok, { action: "manager_invoice_price_list_save",
    list: { supplier: SUP, date, file_name: "test-list.csv", items }, ...(department ? { department } : {}) });
  const book = async (n, tok, department) => (await api(vNew, n, tok, { action: "manager_invoice_price_book", ...(department ? { department } : {}) })).body.data.products;

  await check("before the migration: a clear 'not ready'; invoices and Products work", async () => {
    assert.equal((await api(vNew, 2, km, { action: "manager_invoice_save", invoice: inv(SUP, "TW-1", daysAgo(20), [L("TB-6", "Test Bacon Diced 2.5kg", 6, "Ctn [6]", 22)]) })).status, 200);
    const r = await saveList(2, km, kitchenItems);
    assert.equal(r.status, 503, JSON.stringify(r.body)); assert.equal(r.body.code, "NOT_READY");
    assert.equal((await api(vNew, 2, km, { action: "manager_invoice_price_book" })).status, 200);
  });
  await check("migration applies, runs twice, closed to the public keys; production server keeps working", async () => {
    let r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await one(`select has_table_privilege('${role}', 'public.supplier_price_lists', 'select')`), "f");
      assert.equal(await one(`select has_table_privilege('${role}', 'public.supplier_price_list_items', 'select')`), "f");
      assert.equal(await one(`select has_function_privilege('${role}', 'public.mh_price_list_save(uuid,text,jsonb)', 'execute')`), "f");
    }
    const p = await login(vProd, 2);
    for (const action of ["manager_invoice_list", "manager_invoice_price_book", "manager_ingredient_costs", "manager_dish_costs", "manager_invoice_usage"]) {
      assert.equal((await api(vProd, 2, p, { action })).status, 200, action);
    }
  });
  await check("Kitchen Manager imports the Kitchen part: Products shows the list price as the latest, up from the invoice", async () => {
    const r = await saveList(2, km, kitchenItems);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual({ ...r.body.data.list, id: undefined }, { id: undefined, supplier: SUP, date: today, items: 2, department: "Kitchen", replaced: false });
    const b = await book(2, km);
    const bacon = b.find((p) => p.product_key === "TB-6"), cream = b.find((p) => p.product_key === "TC-1");
    assert.equal(Number(bacon.last_price), 24); assert.equal(bacon.last_from_list, true);
    assert.equal(Number(bacon.previous_price), 22); assert.equal(Number(bacon.change_pct), 9.1);
    assert.equal(bacon.times, 1, "bought once: the price list is not a purchase");
    assert.equal(bacon.pack, 6);
    assert.deepEqual(bacon.history.map((h) => [Number(h.price), h.list]), [[22, false], [24, true]]);
    assert.equal(cream.times, 0); assert.equal(cream.last_from_list, true);
  });
  await check("the Floor part: Floor Manager (own list) and Administrator; the Kitchen Manager cannot save on Floor", async () => {
    assert.equal((await saveList(2, km, floorItems, "Floor")).status, 403);
    assert.equal((await saveList(3, fm, floorItems)).status, 200);
    assert.deepEqual((await book(3, fm)).map((p) => p.product_key), ["TW-12"]);
    assert.ok(!(await book(2, km)).some((p) => p.product_key === "TW-12"), "drinks not in the Kitchen list");
    assert.ok((await book(1, gm, "Floor")).some((p) => p.product_key === "TW-12"));
    const l = (await api(vNew, 1, gm, { action: "manager_invoice_price_lists", department: "Floor" })).body.data;
    assert.deepEqual(l.lists.map((x) => [x.supplier, x.items]), [[SUP, 1]]);
  });
  await check("not spending: invoice totals, weekly use and Top stay as the invoices say", async () => {
    const list = (await api(vNew, 2, km, { action: "manager_invoice_list", from: daysAgo(60), to: today })).body.data;
    assert.equal(Number(list.total), 132);
    const use = (await api(vNew, 2, km, { action: "manager_invoice_usage", weeks: 8 })).body.data;
    assert.ok(!use.items.some((i) => i.code === "TC-1"), "a product only on the list is not 'used'");
    const top = (await api(vNew, 2, km, { action: "manager_invoice_top_products" })).body.data;
    assert.ok(!top.products.some((p) => p.code === "TC-1"));
  });
  await check("dish costs use the list price (Kitchen products include the list)", async () => {
    const d = (await api(vNew, 2, km, { action: "manager_ingredient_costs" })).body.data;
    const p = d.products.find((x) => x.product_key === "TC-1");
    assert.ok(p, JSON.stringify(d.products.map((x) => x.product_key)));
    assert.equal(Number(p.price), 40);
    assert.equal(Number(d.products.find((x) => x.product_key === "TB-6").price), 24, "newest price: the list");
    assert.ok(!d.products.some((x) => x.product_key === "TW-12"), "no drinks from the Floor list");
  });
  await check("the same supplier on the same day again replaces the list; bad input refused", async () => {
    const r = await saveList(1, gm, [{ ...kitchenItems[0], unit_price: 25 }], "Kitchen");
    assert.equal(r.status, 200); assert.equal(r.body.data.list.replaced, true);
    const b = await book(2, km);
    assert.equal(Number(b.find((p) => p.product_key === "TB-6").last_price), 25);
    assert.ok(!b.some((p) => p.product_key === "TC-1"), "the old list's products are gone");
    assert.equal((await saveList(2, km, [])).status, 400);
    assert.equal((await saveList(2, km, [{ description: "x", unit_price: 0 }])).status, 400);
    assert.equal((await api(vNew, 2, km, { action: "manager_invoice_price_list_save", list: { supplier: SUP, date: "nope", items: kitchenItems } })).status, 400);
    const st = await login(vNew, 4);
    assert.ok((await saveList(4, st, kitchenItems)).status >= 400, "staff refused");
  });
  await check("rollback removes it; both servers still work", async () => {
    const r = db.psqlFile(DOWN); assert.ok(r.ok, r.stderr);
    assert.equal(await one(`select to_regclass('public.supplier_price_lists') is null`), "t");
    assert.equal((await api(vNew, 2, km, { action: "manager_invoice_price_book" })).status, 200);
    assert.equal((await api(vNew, 2, km, { action: "manager_ingredient_costs" })).status, 200);
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_invoice_price_book" })).status, 200);
  });
} finally {
  db.stop();
}
log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL PRICE LIST CHECKS PASSED");
process.exit(failures ? 1 : 0);
