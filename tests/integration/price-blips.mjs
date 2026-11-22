// Release check for price changes that ignore a one-off price (one invoice at a
// different price between two at the same price), on a production-like
// database. Server code is unchanged (production runs this Index.ts).
// Synthetic data only: this repository is public.
// Run: node tests/integration/price-blips.mjs
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { startProdLikeDb, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "./edge-loader.mjs";
import { ID, PIN, reseed } from "./seed.mjs";

const NEW = "20261117000000_price_blips.sql";
const MIG = `supabase/migrations/${NEW}`;
const DOWN = "supabase/rollback/20261117000000_price_blips.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");

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
  const book = async () => (await api(vNew, 2, km, { action: "manager_invoice_price_book" })).body.data.products.filter((p) => p.supplier === SUP);
  const changes = async () => ((await api(vNew, 2, km, { action: "manager_invoice_prices" })).body.data.changes || []).filter((c) => c.supplier === SUP);
  const save = async (n, date, lines) => assert.equal((await api(vNew, 2, km, { action: "manager_invoice_save", invoice: inv(SUP, n, date, lines) })).status, 200);
  const at = (key, list) => list.find((p) => p.product_key === key || p.code === key);

  await check("before: a one-off price shows as a change", async () => {
    // Cream: 113.01, 112.17 once, back to 113.01 (no real change).
    // Butter: 9.00, 9.50 once, 9.00, then 10.00 (a real rise from 9.00).
    // Milk: 2.00, then 2.20 on the last invoice (a real rise, kept).
    await save("TB-1", daysAgo(30), [L("CRM1", "Test Cream 2L", 3, "Ctn [3]", 113.01), L("BUT1", "Test Butter 1kg", 1, "EA", 9), L("MLK1", "Test Milk 2L", 6, "EA", 2)]);
    await save("TB-2", daysAgo(20), [L("CRM1", "Test Cream 2L", 3, "Ctn [3]", 112.17), L("BUT1", "Test Butter 1kg", 1, "EA", 9.5)]);
    await save("TB-3", daysAgo(10), [L("CRM1", "Test Cream 2L", 3, "Ctn [3]", 113.01), L("BUT1", "Test Butter 1kg", 1, "EA", 9)]);
    await save("TB-4", daysAgo(2), [L("BUT1", "Test Butter 1kg", 1, "EA", 10), L("MLK1", "Test Milk 2L", 6, "EA", 2.2)]);
    assert.equal(Number(at("CRM1", await book()).change_pct), 0.7);
  });
  await check("migration applies and runs twice", async () => {
    let r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await one(`select has_function_privilege('${role}', 'public.manager_invoice_price_book(uuid,text)', 'execute')`), "f");
      assert.equal(await one(`select has_function_privilege('${role}', 'public.manager_invoice_price_changes(uuid,text)', 'execute')`), "f");
    }
  });
  await check("after: the one-off is not a change; real changes still are; history keeps every price", async () => {
    const b = await book();
    const crm = at("CRM1", b), but = at("BUT1", b), mlk = at("MLK1", b);
    assert.equal(crm.change_pct, null, JSON.stringify(crm));
    assert.equal(crm.history.length, 3);
    assert.equal(Number(but.previous_price), 9);
    assert.equal(Number(but.change_pct), 11.1);
    assert.equal(Number(mlk.change_pct), 10);
    const c = await changes();
    assert.equal(at("CRM1", c), undefined, "cream not in price changes");
    assert.equal(Number(at("BUT1", c).previous_price), 9);
    assert.equal(Number(at("MLK1", c).change_pct), 10);
  });
  await check("a new price on the last invoice is a change even after a one-off", async () => {
    await save("TB-5", daysAgo(1), [L("CRM1", "Test Cream 2L", 3, "Ctn [3]", 115)]);
    const crm = at("CRM1", await book());
    assert.equal(Number(crm.previous_price), 113.01);
    assert.equal(Number(crm.change_pct), 1.8);
  });
  await check("Kitchen Manager and Floor list still separate; rollback brings back the old way", async () => {
    assert.equal((await api(vNew, 3, fm, { action: "manager_invoice_price_book" })).body.data.products.filter((p) => p.supplier === SUP).length, 0);
    const r = db.psqlFile(DOWN); assert.ok(r.ok, r.stderr);
    assert.equal((await api(vNew, 2, km, { action: "manager_invoice_price_book" })).status, 200);
    assert.equal((await api(vNew, 1, gm, { action: "manager_invoice_prices", department: "Kitchen" })).status, 200);
  });
} finally {
  db.stop();
}
log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL PRICE CHANGE CHECKS PASSED");
process.exit(failures ? 1 : 0);
