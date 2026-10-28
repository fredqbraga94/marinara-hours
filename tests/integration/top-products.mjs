// Release check for the most bought products (imported supplier history joined
// with the saved invoices, never counting an invoice twice), on a
// production-like database. Production at release time = everything up to own
// PINs, served by the current main server (tests/edge/baseline-v54.ts).
// Synthetic suppliers, numbers and prices only: this repository is public.
// Run: node tests/integration/top-products.mjs
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
  "supabase/migrations/20261027000000_invoice_price_book.sql",
  "supabase/migrations/20261027010000_manager_permissions.sql",
  "supabase/migrations/20261028000000_shopping_list.sql",
  "supabase/migrations/20261028010000_maintenance.sql",
  "supabase/migrations/20261028020000_photos_contacts.sql",
  "supabase/migrations/20261028030000_own_pin.sql",
];
const TOP = "supabase/migrations/20261028040000_top_products.sql";
const TOP_DOWN = "supabase/rollback/20261028040000_top_products.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v54.ts");

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

// Synthetic supplier "Test Wholesale". TW-1 is also inside the imported history
// (must not be counted twice); TW-2 and TW-3 are newer. Cream by the carton,
// basil by the unit with no code, a fuel levy that is never a product.
const SUP = "Test Wholesale";
const invoice = (number, date, cream, cartons) => {
  const lines = [
    { code: "TST-CREAM", description: "TEST · CREAM THICKENED · 2LT", qty: cartons, unit: "CTN", unit_price: cream, line_total: cartons * cream, gst: 0 },
    { code: "", description: "Test basil bunch", qty: 2, unit: "EA", unit_price: 3, line_total: 6, gst: 0 },
    { code: "", description: "FUEL LEVY", qty: 1, unit: "", unit_price: 5, line_total: 5, gst: 0.5 },
  ];
  const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
  return { supplier: SUP, number, kind: "invoice", date, subtotal, gst: 0.5, total: subtotal + 0.5, checks_ok: true, lines };
};

const db = await startProdLikeDb();
try {
  for (const f of BEFORE) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  useDatabase(db.svc);
  await reseed(db);
  for (const f of BEFORE.slice(-12)) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  const vProd = await quiet(() => loadHandler(PROD_SERVER));
  const vNew = await quiet(() => loadHandler(NEW_SERVER));
  const dev = Object.fromEntries([1, 2, 3].map((n) => [n, newDeviceSecret()]));
  const login = async (h, n) => {
    const r = await quiet(() => call(h, { action: "login", pin: PIN[ID(n)], device: dev[n] }));
    assert.equal(r.status, 200, `login ${n}: ${JSON.stringify(r.body)}`);
    return r.body.session.token;
  };
  const api = (h, n, token, body) => quiet(() => call(h, { ...body, token, device: dev[n] }));

  const gm0 = await login(vNew, 1);
  for (const [n, d, c, q] of [["TW-1", daysAgo(30), 100, 3], ["TW-2", daysAgo(10), 104, 2], ["TW-3", daysAgo(3), 105, 4]]) {
    const r = await api(vNew, 1, gm0, { action: "manager_invoice_save", invoice: invoice(n, d, c, q) });
    assert.equal(r.status, 200, `${n}: ${JSON.stringify(r.body)}`);
  }

  section("A. Before the migration");
  await check("new server answers clearly while it is not installed; the price book still works", async () => {
    const r = await api(vNew, 1, gm0, { action: "manager_invoice_top_products" });
    assert.ok(r.status >= 400 && r.status < 600, String(r.status));
    assert.equal((await api(vNew, 1, gm0, { action: "manager_invoice_price_book" })).status, 200);
    return `top products ${r.status}; price book 200`;
  });

  section("B. Migration");
  await check("applies; closed to the public keys; runs twice; production server keeps working", async () => {
    const r = db.psqlFile(TOP); assert.ok(r.ok, r.stderr);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await one(db, `select has_table_privilege('${role}', 'public.supplier_history_products', 'select')`), "f", role);
      assert.equal(await one(db, `select has_table_privilege('${role}', 'public.supplier_history_imports', 'select')`), "f", role);
      assert.equal(await one(db, `select has_function_privilege('${role}', 'public.manager_invoice_top_products(uuid,text)', 'execute')`), "f", role);
    }
    const again = db.psqlFile(TOP); assert.ok(again.ok, again.stderr);
    const p = await login(vProd, 1);
    assert.equal((await api(vProd, 1, p, { action: "manager_dashboard" })).status, 200);
    return "server only";
  });

  section("C. Saved invoices only");
  const gm = await login(vNew, 1);
  const top = async (n = 1, token = gm) => (await api(vNew, n, token, { action: "manager_invoice_top_products" })).body.data;
  await check("without history: ranking from the three saved invoices; fuel levy left out", async () => {
    const d = await top();
    const cream = d.products.find((p) => p.code === "TST-CREAM");
    assert.equal(cream.orders, 3);
    assert.equal(Number(cream.spend), 300 + 208 + 420);
    assert.equal(Number(cream.last_price), 105);
    assert.equal(Number(cream.change_pct), 5);
    assert.equal(d.products.some((p) => /fuel/i.test(p.description)), false);
    assert.equal(d.products[0].code, "TST-CREAM", "highest spend first");
    return `cream 3 orders, $928, +5%`;
  });

  section("D. With an imported history");
  await check("history joins the saved invoices; TW-1 (inside the history) is not counted twice", async () => {
    const id = await one(db, `insert into public.supplier_history_imports (location, supplier, period_from, period_to, source, invoice_numbers)
      values ('Hawthorne', '${SUP}', '${daysAgo(365)}', '${daysAgo(25)}', 'Test online account', array['TW-1','TW-0']) returning id::text`);
    await db.admin.query(`insert into public.supplier_history_products (import_id, code, brand, description, orders, cartons, units, carton_label, unit_label, spend, last_date, last_carton_price, last_unit_price, first_price, first_kind, first_date) values
      ('${id}', 'TST-CREAM', 'Test', 'Cream Thickened', 10, 30, 0, 'Carton', 'Bottle', 2850, '${daysAgo(30)}', 100, null, 90, 'carton', '${daysAgo(360)}'),
      ('${id}', 'TST-OLD', 'Test', 'Old Biscuit', 2, 0, 5, 'Carton', 'Pack', 40, '${daysAgo(200)}', null, 8, 8, 'unit', '${daysAgo(300)}')`);
    const d = await top();
    const cream = d.products.find((p) => p.code === "TST-CREAM");
    assert.equal(cream.orders, 10 + 2, "history 10 + TW-2 + TW-3 (TW-1 is in the history)");
    assert.equal(Number(cream.spend), 2850 + 208 + 420);
    assert.equal(Number(cream.last_price), 105);
    assert.equal(cream.description, "Cream Thickened");
    assert.equal(Number(cream.change_pct), Number(((105 - 90) / 90 * 100).toFixed(1)));
    assert.equal(cream.from_history, true);
    const old = d.products.find((p) => p.code === "TST-OLD");
    assert.equal(old.orders, 2); assert.equal(Number(old.last_price), 8); assert.equal(Number(old.change_pct), 0);
    const basil = d.products.find((p) => /basil/i.test(p.description));
    assert.equal(basil.orders, 2, "basil from TW-2 and TW-3 only");
    assert.equal(d.period_from, daysAgo(365));
    assert.equal(Number(d.total), 2850 + 208 + 420 + 40 + 12);
    return `cream 12 orders, $${cream.spend}, +${cream.change_pct}%`;
  });
  await check("an old invoice scanned later that the history already covers is still not counted twice", async () => {
    const r = await api(vNew, 1, gm, { action: "manager_invoice_save", invoice: invoice("TW-0", daysAgo(40), 99, 1) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const cream = (await top()).products.find((p) => p.code === "TST-CREAM");
    assert.equal(cream.orders, 12);
    return "still 12";
  });
  await check("Kitchen Manager sees it; Floor Manager and staff do not; other locations stay out", async () => {
    const km = await login(vNew, 2);
    assert.equal((await api(vNew, 2, km, { action: "manager_invoice_top_products" })).status, 200);
    const fm = await login(vNew, 3);
    assert.equal((await api(vNew, 3, fm, { action: "manager_invoice_top_products" })).status, 403);
    const other = await one(db, `insert into public.supplier_history_imports (location, supplier, period_from, period_to, source) values ('Test Elsewhere', '${SUP}', '${daysAgo(10)}', '${daysAgo(5)}', 'x') returning id::text`);
    await db.admin.query(`insert into public.supplier_history_products (import_id, code, description, orders, spend) values ('${other}', 'TST-ELSE', 'Elsewhere item', 1, 999)`);
    assert.equal((await top()).products.some((p) => p.code === "TST-ELSE"), false);
    return "KM 200, FM 403";
  });

  section("E. Rollback");
  await check("rollback removes it; saved invoices untouched; both servers still work", async () => {
    const r = db.psqlFile(TOP_DOWN); assert.ok(r.ok, r.stderr);
    assert.equal(Number(await one(db, `select count(*) from public.supplier_invoices where supplier = '${SUP}' and active`)), 4);
    assert.equal((await api(vNew, 1, gm, { action: "manager_invoice_price_book" })).status, 200);
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_dashboard" })).status, 200);
    return "4 invoices kept";
  });
} finally {
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL TOP PRODUCTS RELEASE CHECKS PASSED");
process.exit(failures ? 1 : 0);
