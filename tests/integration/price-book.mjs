// Release check for the price book (every product bought, its price on each
// invoice, and whether it went up or down), on a production-like database.
// Production at release time = everything up to ingredient costs, served by the
// current main server (tests/edge/baseline-v49.ts).
// Synthetic suppliers, numbers and prices only: this repository is public.
// Run: node tests/integration/price-book.mjs
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
];
const BOOK = "supabase/migrations/20261027000000_invoice_price_book.sql";
const BOOK_DOWN = "supabase/rollback/20261027000000_invoice_price_book.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v49.ts");

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
const today = new Date(Date.now() + 10 * 3600000).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

// Synthetic invoices. Tomatoes have a code; basil has none (matched by its
// description); a fuel levy is a fee and never a product.
const invoice = (number, date, tomato, basil) => {
  const lines = [
    { code: "TST-TOM", description: "Test tomatoes", qty: 10, unit: "kg", unit_price: tomato, line_total: 10 * tomato, gst: 0 },
    { code: "", description: "Test basil bunch", qty: 2, unit: "ea", unit_price: basil, line_total: 2 * basil, gst: 0 },
    { code: "", description: "FUEL LEVY", qty: 1, unit: "", unit_price: 4, line_total: 4, gst: 0.4 },
  ];
  const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
  return { supplier: "Test Produce Co", number, kind: "invoice", date, subtotal, gst: 0.4, total: subtotal + 0.4, checks_ok: true, lines };
};

const db = await startProdLikeDb();
try {
  for (const f of BEFORE) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  useDatabase(db.svc);
  await reseed(db);
  for (const f of BEFORE.slice(-5)) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  const vProd = await quiet(() => loadHandler(PROD_SERVER));
  const vNew = await quiet(() => loadHandler(NEW_SERVER));
  const dev = Object.fromEntries([1, 2, 3].map((n) => [n, newDeviceSecret()]));
  const login = async (h, n) => {
    const r = await quiet(() => call(h, { action: "login", pin: PIN[ID(n)], device: dev[n] }));
    assert.equal(r.status, 200, `login ${n}: ${JSON.stringify(r.body)}`);
    return r.body.session.token;
  };
  const api = (h, n, token, body) => quiet(() => call(h, { ...body, token, device: dev[n] }));

  // Three invoices: tomatoes 4.00 → 4.00 → 4.60 (up 15%), basil 3.00 → 2.70 → 2.70 (down 10%).
  const gm0 = await login(vNew, 1);
  for (const [n, d, t, b] of [["PB-1", daysAgo(20), 4, 3], ["PB-2", daysAgo(13), 4, 2.7], ["PB-3", daysAgo(6), 4.6, 2.7]]) {
    const r = await api(vNew, 1, gm0, { action: "manager_invoice_save", invoice: invoice(n, d, t, b) });
    assert.equal(r.status, 200, `${n}: ${JSON.stringify(r.body)}`);
  }

  section("A. Before the migration");
  const fpBefore = await db.fingerprints();
  await check("new server answers clearly while the price book is not installed; the rest works", async () => {
    const r = await api(vNew, 1, gm0, { action: "manager_invoice_price_book" });
    assert.ok(r.status >= 400 && r.status < 600, String(r.status));
    assert.equal((await api(vNew, 1, gm0, { action: "manager_invoice_prices" })).status, 200);
    return `price book ${r.status}; price changes 200`;
  });

  section("B. Migration");
  await check("applies; nothing existing changed; closed to the public keys; runs twice", async () => {
    const r = db.psqlFile(BOOK); assert.ok(r.ok, r.stderr);
    const fp = await db.fingerprints();
    assert.deepEqual(Object.keys(fpBefore).filter((k) => fp[k] !== fpBefore[k]), []);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await one(db, `select has_function_privilege('${role}', 'public.manager_invoice_price_book(uuid,text)', 'execute')`), "f", role);
    }
    const again = db.psqlFile(BOOK); assert.ok(again.ok, again.stderr);
    return "read-only function, server only";
  });
  await check("current production server keeps working", async () => {
    const m = await login(vProd, 1);
    for (const action of ["manager_dashboard", "manager_invoice_list", "manager_invoice_prices", "manager_ingredient_costs"]) {
      assert.equal((await api(vProd, 1, m, { action })).status, 200, action);
    }
    return "200";
  });

  section("C. New server");
  const gm = await login(vNew, 1);
  const km = await login(vNew, 2);
  const fm = await login(vNew, 3);

  await check("only the Administrator and the Kitchen Manager can see prices", async () => {
    assert.equal((await api(vNew, 3, fm, { action: "manager_invoice_price_book" })).status, 403);
    assert.equal((await api(vNew, 2, km, { action: "manager_invoice_price_book" })).status, 200);
    return "floor 403, kitchen 200";
  });

  await check("every product with its price history; fees left out; no code matched by description", async () => {
    const r = await api(vNew, 1, gm, { action: "manager_invoice_price_book" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const list = r.body.data.products;
    assert.deepEqual(list.map((p) => p.description), ["Test basil bunch", "Test tomatoes"], "sorted by name, no fuel levy");
    const tom = list.find((p) => p.code === "TST-TOM");
    assert.equal(tom.times, 3);
    assert.equal(Number(tom.last_price), 4.6); assert.equal(tom.last_date, daysAgo(6));
    assert.equal(Number(tom.previous_price), 4); assert.equal(tom.previous_date, daysAgo(13));
    assert.equal(Number(tom.change_pct), 15);
    assert.deepEqual(tom.history.map((h) => Number(h.price)), [4, 4, 4.6]);
    const basil = list.find((p) => p.description === "Test basil bunch");
    assert.equal(basil.code, null);
    assert.equal(basil.times, 3);
    assert.equal(Number(basil.change_pct), -10, "latest 2.70 against the last different price 3.00");
    assert.equal(basil.previous_date, daysAgo(20));
    return "tomatoes +15% (3 invoices), basil -10% (no code)";
  });

  await check("a product bought once has no change; removed invoices are not counted", async () => {
    const once = { supplier: "Other Test Supplier", number: "PB-9", kind: "invoice", date: daysAgo(2), subtotal: 9, gst: 0, total: 9, checks_ok: true,
      lines: [{ code: "OT-1", description: "Test olive oil", qty: 1, unit: "ea", unit_price: 9, line_total: 9, gst: 0 }] };
    const s = await api(vNew, 1, gm, { action: "manager_invoice_save", invoice: once });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    let list = (await api(vNew, 1, gm, { action: "manager_invoice_price_book" })).body.data.products;
    const oil = list.find((p) => p.code === "OT-1");
    assert.equal(oil.times, 1); assert.equal(oil.change_pct, null); assert.equal(oil.previous_price, null);
    const rm = await api(vNew, 1, gm, { action: "manager_invoice_remove", id: s.body.data.invoice.id });
    assert.equal(rm.status, 200, JSON.stringify(rm.body));
    list = (await api(vNew, 1, gm, { action: "manager_invoice_price_book" })).body.data.products;
    assert.equal(list.some((p) => p.code === "OT-1"), false);
    return "once: no change; removed: gone";
  });

  await check("units counted singly with the carton size: pack found even when the latest line is not in cartons", async () => {
    const mk = (number, date, qty, unit) => ({ supplier: "Test Wholesale", number, kind: "invoice", date, subtotal: qty * 22.33, gst: 0, total: qty * 22.33, checks_ok: true,
      lines: [{ code: "TW-CHZ", description: "Test cheese blend 2kg", qty, unit, unit_price: 22.33, line_total: qty * 22.33, gst: 0 }] });
    const a = await api(vNew, 1, gm, { action: "manager_invoice_save", invoice: mk("PB-C1", daysAgo(9), 12, "Ctn [4]") });
    const b = await api(vNew, 1, gm, { action: "manager_invoice_save", invoice: mk("PB-C2", daysAgo(2), 2, "Bag") });
    assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(b.status, 200, JSON.stringify(b.body));
    const chz = (await api(vNew, 1, gm, { action: "manager_invoice_price_book" })).body.data.products.find((p) => p.code === "TW-CHZ");
    assert.equal(chz.pack, 4); assert.equal(chz.unit, "Bag"); assert.equal(Number(chz.last_price), 22.33); assert.equal(chz.times, 2);
    const tom = (await api(vNew, 1, gm, { action: "manager_invoice_price_book" })).body.data.products.find((p) => p.code === "TST-TOM");
    assert.equal(tom.pack, null, "kg lines have no carton size");
    for (const r of [a, b]) assert.equal((await api(vNew, 1, gm, { action: "manager_invoice_remove", id: r.body.data.invoice.id })).status, 200);
    return "pack 4 from the 'Ctn [4]' line; price stays per unit";
  });

  await check("everything else still works on the new server", async () => {
    for (const action of ["manager_dashboard", "manager_invoice_list", "manager_invoice_usage", "manager_invoice_prices", "manager_ingredient_costs"]) {
      assert.equal((await api(vNew, 1, gm, { action })).status, 200, action);
    }
    return "200";
  });

  section("D. Rollback");
  await check("rollback removes the price book; invoices stay; both servers still work", async () => {
    const r = db.psqlFile(BOOK_DOWN); assert.ok(r.ok, r.stderr);
    assert.deepEqual(Object.keys(await db.fingerprints()).sort(), Object.keys(fpBefore).sort());
    assert.equal(Number(await one(db, "select count(*) from public.supplier_invoices where active")), 3);
    const a = await api(vNew, 1, gm, { action: "manager_invoice_list" });
    const m = await login(vProd, 1);
    const b = await api(vProd, 1, m, { action: "manager_invoice_prices" });
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    return "invoices 200 (new), price changes 200 (production)";
  });
} finally {
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL PRICE BOOK RELEASE CHECKS PASSED");
process.exit(failures ? 1 : 0);
