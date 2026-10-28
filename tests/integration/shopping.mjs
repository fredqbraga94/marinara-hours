// Release check for the shopping list (things to buy that do not come from the
// suppliers), on a production-like database. Production at release time =
// everything up to permissions per manager, served by the current main server
// (tests/edge/baseline-v52.ts).
// Synthetic people and items only: this repository is public.
// Run: node tests/integration/shopping.mjs
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
];
const SHOP = "supabase/migrations/20261028000000_shopping_list.sql";
const SHOP_DOWN = "supabase/rollback/20261028000000_shopping_list.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v52.ts");

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

const db = await startProdLikeDb();
try {
  for (const f of BEFORE) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  useDatabase(db.svc);
  await reseed(db);
  for (const f of BEFORE.slice(-7)) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  const vProd = await quiet(() => loadHandler(PROD_SERVER));
  const vNew = await quiet(() => loadHandler(NEW_SERVER));
  const dev = Object.fromEntries([1, 2, 3, 5].map((n) => [n, newDeviceSecret()]));
  const login = async (h, n) => {
    const r = await quiet(() => call(h, { action: "login", pin: PIN[ID(n)], device: dev[n] }));
    assert.equal(r.status, 200, `login ${n}: ${JSON.stringify(r.body)}`);
    return r.body.session.token;
  };
  const api = (h, n, token, body) => quiet(() => call(h, { ...body, token, device: dev[n] }));

  section("A. Before the migration");
  const fpBefore = await db.fingerprints();
  await check("new server answers clearly without the table (no crash)", async () => {
    const gm = await login(vNew, 1);
    const r = await api(vNew, 1, gm, { action: "manager_shopping_list" });
    assert.ok(r.status >= 400 && r.body.error, JSON.stringify(r.body));
    assert.equal((await api(vNew, 1, gm, { action: "manager_dashboard" })).status, 200);
    return `list ${r.status}; Home 200`;
  });

  section("B. Migration");
  await check("applies; nothing existing changed; closed to the public keys; runs twice", async () => {
    const r = db.psqlFile(SHOP); assert.ok(r.ok, r.stderr);
    const fp = await db.fingerprints();
    assert.deepEqual(Object.keys(fpBefore).filter((k) => fp[k] !== fpBefore[k]), []);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await one(db, `select has_table_privilege('${role}', 'public.shopping_items', 'select')`), "f", role);
      assert.equal(await one(db, `select has_function_privilege('${role}', 'public.manager_shopping_save(uuid,jsonb)', 'execute')`), "f", role);
    }
    const again = db.psqlFile(SHOP); assert.ok(again.ok, again.stderr);
    return "table and functions for the server only";
  });
  await check("current production server keeps working", async () => {
    const gm = await login(vProd, 1);
    assert.equal((await api(vProd, 1, gm, { action: "manager_dashboard" })).status, 200);
    return "Home 200";
  });

  section("C. New server");
  const gm = await login(vNew, 1);
  const km = await login(vNew, 2);
  const fm = await login(vNew, 3);
  const save = (n, token, item) => api(vNew, n, token, { action: "manager_shopping_save", item });
  const mark = (n, token, id, status) => api(vNew, n, token, { action: "manager_shopping_mark", id, status });
  const list = async (n, token) => (await api(vNew, n, token, { action: "manager_shopping_list" })).body.data;

  let knife, towels;
  await check("every manager adds items; the list shows urgent first and who asked", async () => {
    const a = await save(2, km, { name: "Test chef knife", qty: "1", urgent: false });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    knife = a.body.data.item;
    const b = await save(3, fm, { name: "Test paper towels", qty: "2 packs", note: "the big ones", urgent: true });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    towels = b.body.data.item;
    const l = await list(1, gm);
    assert.deepEqual(l.open.map((i) => i.name), ["Test paper towels", "Test chef knife"]);
    assert.equal(l.open[0].created_by, "Test Floor Manager");
    assert.equal(l.open[1].created_by, "Test Kitchen Manager");
    assert.deepEqual(l.bought, []);
    return "Administrator sees 2 items, urgent first";
  });

  await check("edit an item; bad input refused and nothing saved", async () => {
    const e = await save(1, gm, { id: knife.id, name: "Test chef knife 24cm", qty: "1", urgent: true });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    assert.equal(e.body.data.item.name, "Test chef knife 24cm");
    assert.equal((await save(1, gm, { name: "   " })).status, 400);
    assert.equal((await save(1, gm, { id: "not-a-uuid", name: "x" })).status, 404);
    assert.equal((await save(1, gm, { id: "00000000-0000-4000-8000-00000000ffff", name: "x" })).status, 404);
    assert.equal((await mark(1, gm, knife.id, "lost")).status, 400);
    assert.equal(Number(await one(db, "select count(*) from public.shopping_items")), 2);
    return "renamed; blank 400; unknown id 404; bad status 400";
  });

  await check("mark bought keeps who and when; back to buy; remove", async () => {
    const b = await mark(2, km, towels.id, "bought");
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.data.item.done_by, "Test Kitchen Manager");
    let l = await list(3, fm);
    assert.deepEqual(l.open.map((i) => i.name), ["Test chef knife 24cm"]);
    assert.deepEqual(l.bought.map((i) => i.name), ["Test paper towels"]);
    assert.equal((await save(1, gm, { id: towels.id, name: "changed" })).status, 404, "a bought item is not edited");
    assert.equal((await mark(1, gm, towels.id, "open")).status, 200);
    l = await list(1, gm);
    assert.equal(l.open.length, 2); assert.equal(l.open.find((i) => i.id === towels.id).done_by, null);
    assert.equal((await mark(1, gm, knife.id, "removed")).status, 200);
    assert.equal((await mark(1, gm, knife.id, "open")).status, 404, "a removed item stays removed");
    l = await list(1, gm);
    assert.deepEqual(l.open.map((i) => i.name), ["Test paper towels"]);
    return "bought by the Kitchen Manager; reopened; removed item gone";
  });

  await check("staff cannot use it; other locations stay separate", async () => {
    const st = await login(vNew, 5);
    assert.ok((await api(vNew, 5, st, { action: "manager_shopping_list" })).status >= 400);
    assert.ok((await api(vNew, 5, st, { action: "manager_shopping_save", item: { name: "x" } })).status >= 400);
    const other = await one(db, `insert into public.shopping_items (location, name) values ('Test Elsewhere', 'Test other item') returning id::text`);
    const l = await list(1, gm);
    assert.equal(l.open.some((i) => i.name === "Test other item"), false);
    assert.equal((await mark(1, gm, other, "bought")).status, 404);
    assert.equal(await one(db, `select status from public.shopping_items where id = '${other}'`), "open");
    return "staff refused; another location's item not shown and not changed";
  });

  section("D. Rollback");
  await check("rollback removes it; both servers still work", async () => {
    const r = db.psqlFile(SHOP_DOWN); assert.ok(r.ok, r.stderr);
    assert.deepEqual(Object.keys(await db.fingerprints()).sort(), Object.keys(fpBefore).sort());
    assert.equal((await api(vNew, 1, gm, { action: "manager_dashboard" })).status, 200);
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_dashboard" })).status, 200);
    return "Home 200 on both";
  });
} finally {
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL SHOPPING RELEASE CHECKS PASSED");
process.exit(failures ? 1 : 0);
