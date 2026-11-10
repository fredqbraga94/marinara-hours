// Release check for Invoices in two lists (Kitchen and Floor), on a
// production-like database, with the production server (baseline-v67) still
// working before and after. Synthetic data only: this repository is public.
// Run: node tests/integration/invoice-departments.mjs
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { startProdLikeDb, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "./edge-loader.mjs";
import { ID, PIN, reseed } from "./seed.mjs";

const NEW = "20261113000000_invoice_departments.sql";
const MIG = `supabase/migrations/${NEW}`;
const DOWN = "supabase/rollback/20261113000000_invoice_departments.down.sql";
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
  const saveInv = (n, tok, invoice, department) => api(vNew, n, tok, { action: "manager_invoice_save", invoice, ...(department ? { department } : {}) });
  const listOf = async (n, tok, department) => {
    const r = await api(vNew, n, tok, { action: "manager_invoice_list", from: daysAgo(60), to: today, ...(department ? { department } : {}) });
    return r.status === 200 ? r.body.data : r;
  };
  const numbers = (d) => d.invoices.map((i) => i.number).sort();

  await check("before the migration: the current server saves and lists as before", async () => {
    assert.equal((await saveInv(2, km, inv("Test Foods", "K-0", daysAgo(3), [L("F1", "Test flour 12.5kg", 1, "CTN", 15)]))).status, 200);
    const d = await listOf(2, km);
    assert.deepEqual(numbers(d), ["K-0"]);
    assert.ok((await api(vNew, 3, fm, { action: "manager_invoice_list" })).status >= 400, "no Floor invoices yet");
  });
  await check("migration applies, runs twice; old invoices stay in Kitchen; production server keeps working", async () => {
    let r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await one(`select has_function_privilege('${role}', 'public.manager_invoice_call(uuid,text,text,text,jsonb)', 'execute')`), "f");
      assert.equal(await one(`select has_function_privilege('${role}', 'public.manager_invoice_move(uuid,text,uuid,text)', 'execute')`), "f");
    }
    assert.equal(await one("select department from public.supplier_invoices where number = 'K-0'"), "Kitchen");
    const p = await login(vProd, 2);
    const old = await api(vProd, 2, p, { action: "manager_invoice_list", from: daysAgo(60), to: today });
    assert.equal(old.status, 200, JSON.stringify(old.body));
    assert.deepEqual(old.body.data.invoices.map((i) => i.number), ["K-0"]);
    for (const action of ["manager_invoice_price_book", "manager_ingredient_costs", "manager_dish_costs"]) assert.equal((await api(vProd, 2, p, { action })).status, 200, action);
  });
  await check("each manager saves into their own list; the Administrator chooses", async () => {
    let r = await saveInv(3, fm, inv("Test Drinks", "F-1", daysAgo(2), [L("W1", "Test wine 750ml", 12, "Btl", 10)]));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.invoice.department, "Floor");
    r = await saveInv(2, km, inv("Test Foods", "K-1", daysAgo(2), [L("F1", "Test flour 12.5kg", 2, "CTN", 16)]));
    assert.equal(r.body.data.invoice.department, "Kitchen");
    r = await saveInv(1, gm, inv("Test Drinks", "F-2", daysAgo(1), [L("W2", "Test beer 24x330ml", 1, "CTN", 60)]), "Floor");
    assert.equal(r.body.data.invoice.department, "Floor");
    r = await saveInv(1, gm, inv("Test Foods", "K-2", daysAgo(1), [L("F2", "Test cream 5L", 3, "CTN", 30)]));
    assert.equal(r.body.data.invoice.department, "Kitchen", "Administrator without a list: Kitchen");
    assert.equal((await saveInv(1, gm, inv("Test Drinks", "F-1", daysAgo(2), [L("W1", "Test wine 750ml", 1, "Btl", 10)]), "Kitchen")).status, 409, "the same invoice in the other list is refused");
  });
  await check("each list shows only its invoices, totals, prices and weekly use", async () => {
    const k = await listOf(2, km), f = await listOf(3, fm);
    assert.deepEqual(numbers(k), ["K-0", "K-1", "K-2"]); assert.equal(k.department, "Kitchen"); assert.equal(k.can_choose_department, false);
    assert.deepEqual(numbers(f), ["F-1", "F-2"]); assert.equal(Number(f.total), 180);
    assert.deepEqual(numbers(await listOf(1, gm, "Floor")), ["F-1", "F-2"]);
    assert.equal((await listOf(1, gm, "Kitchen")).can_choose_department, true);
    const pbF = (await api(vNew, 3, fm, { action: "manager_invoice_price_book" })).body.data;
    assert.deepEqual(pbF.products.map((p) => p.description).sort(), ["Test beer 24x330ml", "Test wine 750ml"]);
    assert.equal(pbF.department, "Floor");
    const pbK = (await api(vNew, 2, km, { action: "manager_invoice_price_book" })).body.data;
    assert.ok(!pbK.products.some((p) => /wine|beer/.test(p.description)));
    const uF = (await api(vNew, 3, fm, { action: "manager_invoice_usage", weeks: 8 })).body.data;
    assert.ok(uF.items.every((i) => i.supplier === "Test Drinks"), JSON.stringify(uF.items.map((i) => i.supplier)));
    assert.equal((await api(vNew, 3, fm, { action: "manager_invoice_top_products" })).status, 200);
    const ic = (await api(vNew, 2, km, { action: "manager_ingredient_costs" })).body.data;
    assert.ok(ic.products.length > 0 && !ic.products.some((p) => /wine|beer/i.test(p.description)));
  });
  await check("a manager cannot see or change the other list, or the costs", async () => {
    assert.equal((await api(vNew, 2, km, { action: "manager_invoice_list", department: "Floor" })).status, 403);
    assert.equal((await saveInv(3, fm, inv("Test X", "X-1", today, [L("X", "Test x", 1, "EA", 1)]), "Kitchen")).status, 403);
    const kid = (await listOf(2, km)).invoices[0].id, fid = (await listOf(3, fm)).invoices[0].id;
    assert.equal((await api(vNew, 3, fm, { action: "manager_invoice_get", id: kid })).status, 404);
    assert.equal((await api(vNew, 3, fm, { action: "manager_invoice_remove", id: kid })).status, 404);
    assert.equal((await api(vNew, 2, km, { action: "manager_invoice_get", id: fid })).status, 404);
    assert.equal((await api(vNew, 3, fm, { action: "manager_invoice_get", id: fid })).status, 200);
    assert.ok((await api(vNew, 3, fm, { action: "manager_ingredient_costs" })).status >= 400, "costs: Kitchen only");
    assert.ok((await api(vNew, 3, fm, { action: "manager_invoice_move", id: fid, department: "Kitchen" })).status >= 400);
    const st = await login(vNew, 4);
    assert.ok((await api(vNew, 4, st, { action: "manager_invoice_list" })).status >= 400, "staff refused");
  });
  await check("the Administrator moves an invoice to the other list", async () => {
    const k1 = (await listOf(2, km)).invoices.find((i) => i.number === "K-1");
    assert.equal((await api(vNew, 2, km, { action: "manager_invoice_move", id: k1.id, department: "Floor" })).status, 403, "Kitchen Manager cannot move");
    let r = await api(vNew, 1, gm, { action: "manager_invoice_move", id: k1.id, department: "Floor" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.invoice.department, "Floor");
    assert.ok(numbers(await listOf(3, fm)).includes("K-1"));
    assert.ok(!numbers(await listOf(2, km)).includes("K-1"));
    assert.equal((await api(vNew, 1, gm, { action: "manager_invoice_move", id: k1.id })).status, 400, "a list is needed");
  });
  await check("rollback removes it; both servers still work", async () => {
    const r = db.psqlFile(DOWN); assert.ok(r.ok, r.stderr);
    assert.equal(await one(`select count(*) from information_schema.columns where table_name = 'supplier_invoices' and column_name = 'department'`), "0");
    assert.equal((await api(vNew, 2, km, { action: "manager_invoice_list", from: daysAgo(60), to: today })).body.data.invoices.length, 5, "every invoice shows again (current server, old functions)");
    assert.equal((await api(vNew, 1, gm, { action: "manager_dashboard" })).status, 200);
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_dashboard" })).status, 200);
  });
} finally {
  db.stop();
}
log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL INVOICE DEPARTMENT CHECKS PASSED");
process.exit(failures ? 1 : 0);
