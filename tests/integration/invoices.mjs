// Release check for supplier invoices (Administrator only), on a production-like
// database. Production at release time = everything up to recipes (dairy kinds),
// served by the current main server (tests/edge/baseline-v47.ts).
// Synthetic suppliers, numbers and prices only: this repository is public.
// Run: node tests/integration/invoices.mjs
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
];
const INVOICES = "supabase/migrations/20261022030000_invoices.sql";
const INVOICES_DOWN = "supabase/rollback/20261022030000_invoices.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v47.ts");

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

// Synthetic invoices (made-up supplier "Test Produce Co").
const invoice = (number, date, tomatoPrice, extra = {}) => ({
  supplier: "Test Produce Co", number, kind: "invoice", date,
  subtotal: 10 * tomatoPrice + 12.5, gst: 1.25, total: 10 * tomatoPrice + 13.75, checks_ok: true, file_name: `${number}.pdf`,
  lines: [
    { code: "TST-TOM", description: "Test tomatoes", qty: 10, unit: "kg", unit_price: tomatoPrice, line_total: 10 * tomatoPrice, gst: 0 },
    { code: "TST-BAG", description: "Test paper bags", qty: 1, unit: "ctn", unit_price: 12.5, line_total: 12.5, gst: 1.25 },
  ],
  ...extra,
});

const db = await startProdLikeDb();
try {
  for (const f of BEFORE) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  useDatabase(db.svc);
  await reseed(db);
  for (const f of BEFORE.slice(-3)) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  const vProd = await quiet(() => loadHandler(PROD_SERVER));
  const vNew = await quiet(() => loadHandler(NEW_SERVER));
  const dev = Object.fromEntries([1, 2, 3, 4].map((n) => [n, newDeviceSecret()]));
  const login = async (h, n) => {
    const r = await quiet(() => call(h, { action: "login", pin: PIN[ID(n)], device: dev[n] }));
    assert.equal(r.status, 200, `login ${n}: ${JSON.stringify(r.body)}`);
    return r.body.session.token;
  };
  const api = (h, n, token, body) => quiet(() => call(h, { ...body, token, device: dev[n] }));

  section("A. Before the migration");
  const fpBefore = await db.fingerprints();
  await check("new server answers clearly while invoices are not installed", async () => {
    const gm = await login(vNew, 1);
    const r = await api(vNew, 1, gm, { action: "manager_invoice_list" });
    assert.ok(r.status >= 400 && r.status < 600, String(r.status));
    assert.equal((await api(vNew, 1, gm, { action: "manager_dashboard" })).status, 200);
    assert.equal((await api(vNew, 1, gm, { action: "manager_recipe_list" })).status, 200);
    return `invoices ${r.status}; dashboard and recipes 200`;
  });

  section("B. Migration");
  await check("applies; nothing existing changed; closed to the public keys; runs twice", async () => {
    const r = db.psqlFile(INVOICES); assert.ok(r.ok, r.stderr);
    const fp = await db.fingerprints();
    assert.deepEqual(Object.keys(fpBefore).filter((k) => fp[k] !== fpBefore[k]), []);
    for (const t of ["supplier_invoices", "supplier_invoice_lines"]) {
      for (const role of ["anon", "authenticated"]) {
        assert.equal(await one(db, `select has_table_privilege('${role}', 'public.${t}', 'select')`), "f", `${role} ${t}`);
      }
    }
    for (const f of ["manager_invoice_save(uuid,text,jsonb)", "manager_invoice_list(uuid,text,date,date)", "manager_invoice_price_changes(uuid,text)"]) {
      assert.equal(await one(db, `select has_function_privilege('anon', 'public.${f}', 'execute')`), "f", f);
    }
    const again = db.psqlFile(INVOICES); assert.ok(again.ok, again.stderr);
    return "tables locked to the server";
  });
  await check("current production server keeps working", async () => {
    const m = await login(vProd, 1);
    for (const action of ["manager_dashboard", "manager_team", "manager_stock_list", "manager_recipe_list"]) {
      assert.equal((await api(vProd, 1, m, { action })).status, 200, action);
    }
    return "200";
  });

  section("C. New server");
  const gm = await login(vNew, 1);
  const km = await login(vNew, 2);
  const fm = await login(vNew, 3);
  let firstId;

  await check("only the Administrator can see or save invoices", async () => {
    for (const [n, t] of [[2, km], [3, fm]]) {
      for (const action of ["manager_invoice_list", "manager_invoice_prices"]) {
        const r = await api(vNew, n, t, { action });
        assert.equal(r.status, 403, `${n} ${action} ${JSON.stringify(r.body)}`);
      }
      const s = await api(vNew, n, t, { action: "manager_invoice_save", invoice: invoice("T-0", today, 4) });
      assert.equal(s.status, 403);
    }
    const staff = await login(vNew, 4);
    const r = await api(vNew, 4, staff, { action: "manager_invoice_list" });
    assert.ok(r.status === 401 || r.status === 403, String(r.status));
    assert.equal(await one(db, "select count(*) from public.supplier_invoices"), "0");
    return "Kitchen and Floor managers 403; staff refused";
  });

  await check("saves an invoice with its lines; the same invoice can't be saved twice", async () => {
    const r = await api(vNew, 1, gm, { action: "manager_invoice_save", invoice: invoice("T-1001", daysAgo(10), 4) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    firstId = r.body.data.invoice.id;
    assert.ok(firstId);
    assert.equal(await one(db, "select count(*) from public.supplier_invoice_lines"), "2");
    const dup = await api(vNew, 1, gm, { action: "manager_invoice_save", invoice: invoice("T-1001", daysAgo(10), 4) });
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
    assert.match(dup.body.error, /already saved/);
    assert.equal(await one(db, "select count(*) from public.supplier_invoices"), "1");
    assert.ok(Number(await one(db, "select count(*) from public.staff_audit where action like '%invoice%'")) > 0);
    return "409 on the duplicate";
  });

  await check("rejects incomplete invoices", async () => {
    for (const bad of [
      { ...invoice("T-X", today, 4), number: "" },
      { ...invoice("T-X", today, 4), date: "21/10/2026" },
      { ...invoice("T-X", today, 4), lines: [] },
      { ...invoice("T-X", today, 4), total: "abc" },
      { ...invoice("T-X", today, 4), lines: [{ description: "", line_total: 1 }] },
    ]) {
      const r = await api(vNew, 1, gm, { action: "manager_invoice_save", invoice: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    return "400 for missing number, bad date, no lines, bad total, empty line";
  });

  await check("list by period, totals by supplier, credit notes subtract", async () => {
    let r = await api(vNew, 1, gm, { action: "manager_invoice_save", invoice: invoice("T-1002", daysAgo(2), 4.5) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api(vNew, 1, gm, { action: "manager_invoice_save", invoice: {
      supplier: "Test Produce Co", number: "C-1", kind: "credit", date: daysAgo(1), subtotal: -9, gst: 0, total: -9, checks_ok: true,
      lines: [{ code: "TST-TOM", description: "Test tomatoes (damaged)", qty: -2, unit: "kg", unit_price: 4.5, line_total: -9, gst: 0 }],
    } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api(vNew, 1, gm, { action: "manager_invoice_save", invoice: { ...invoice("D-1", daysAgo(1), 3), supplier: "Test Dairy Pty" } });
    assert.equal(r.status, 200);
    const list = await api(vNew, 1, gm, { action: "manager_invoice_list", from: daysAgo(7), to: today });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const d = list.body.data;
    assert.equal(d.invoices.length, 3);
    assert.ok(!d.invoices.some((i) => i.number === "T-1001"), "outside the period");
    const produce = d.by_supplier.find((s) => s.supplier === "Test Produce Co");
    assert.equal(Number(produce.total), 58.75 - 9);
    assert.equal(Number(d.total), 58.75 - 9 + 43.75);
    const got = await api(vNew, 1, gm, { action: "manager_invoice_get", id: firstId });
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.data.invoice.lines.map((l) => l.code), ["TST-TOM", "TST-BAG"]);
    return `week total ${d.total}; credit note subtracts`;
  });

  await check("price changes compare the same product across invoices", async () => {
    const r = await api(vNew, 1, gm, { action: "manager_invoice_prices" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ch = r.body.data.changes;
    assert.equal(ch.length, 1, JSON.stringify(ch));
    assert.equal(ch[0].code, "TST-TOM");
    assert.equal(Number(ch[0].previous_price), 4);
    assert.equal(Number(ch[0].latest_price), 4.5);
    assert.equal(Number(ch[0].change_pct), 12.5);
    return "tomatoes +12.5% (bags unchanged, credit note ignored)";
  });

  await check("remove hides the invoice and allows saving it again", async () => {
    const r = await api(vNew, 1, gm, { action: "manager_invoice_remove", id: firstId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const list = await api(vNew, 1, gm, { action: "manager_invoice_list", from: daysAgo(30), to: today });
    assert.ok(!list.body.data.invoices.some((i) => i.id === firstId));
    assert.equal(await one(db, `select active from public.supplier_invoices where id = '${firstId}'`), "f");
    assert.equal((await api(vNew, 1, gm, { action: "manager_invoice_get", id: firstId })).status, 404);
    const again = await api(vNew, 1, gm, { action: "manager_invoice_save", invoice: invoice("T-1001", daysAgo(10), 4) });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    return "soft remove kept for audit";
  });

  await check("everything else still works on the new server", async () => {
    for (const action of ["manager_dashboard", "manager_team", "manager_stock_list", "manager_recipe_list", "manager_leave_list"]) {
      assert.equal((await api(vNew, 1, gm, { action })).status, 200, action);
    }
    return "200";
  });

  section("D. Rollback");
  await check("rollback removes invoices; both servers still work", async () => {
    const r = db.psqlFile(INVOICES_DOWN); assert.ok(r.ok, r.stderr);
    assert.deepEqual(Object.keys(await db.fingerprints()).sort(), Object.keys(fpBefore).sort());
    const a = await api(vNew, 1, gm, { action: "manager_dashboard" });
    const m = await login(vProd, 1);
    const b = await api(vProd, 1, m, { action: "manager_dashboard" });
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    return "dashboard 200 (new and production)";
  });
} finally {
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL INVOICE RELEASE CHECKS PASSED");
process.exit(failures ? 1 : 0);
