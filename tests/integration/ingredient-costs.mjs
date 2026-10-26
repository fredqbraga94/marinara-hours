// Release check for ingredient costs (link recipe ingredients to invoice
// products), on a production-like database. Production at release time =
// everything up to supplier invoices, served by the current main server
// (tests/edge/baseline-v48.ts).
// Synthetic suppliers, numbers and prices only: this repository is public.
// Run: node tests/integration/ingredient-costs.mjs
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
];
const COSTS = "supabase/migrations/20261022040000_ingredient_costs.sql";
const COSTS_DOWN = "supabase/rollback/20261022040000_ingredient_costs.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v48.ts");

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
  for (const f of BEFORE.slice(-4)) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  const vProd = await quiet(() => loadHandler(PROD_SERVER));
  const vNew = await quiet(() => loadHandler(NEW_SERVER));
  const dev = Object.fromEntries([1, 2, 3].map((n) => [n, newDeviceSecret()]));
  const login = async (h, n) => {
    const r = await quiet(() => call(h, { action: "login", pin: PIN[ID(n)], device: dev[n] }));
    assert.equal(r.status, 200, `login ${n}: ${JSON.stringify(r.body)}`);
    return r.body.session.token;
  };
  const api = (h, n, token, body) => quiet(() => call(h, { ...body, token, device: dev[n] }));
  const cream = await one(db, "select id from public.recipe_ingredients where name = 'Cream' and location = 'Hawthorne'");
  assert.ok(cream, "the recipes seed has Cream");
  const saveInv = (h, n, t, number, date, price) => api(h, n, t, { action: "manager_invoice_save", invoice: {
    supplier: "Test Dairy Pty", number, kind: "invoice", date, subtotal: price + 5, gst: 0.5, total: price + 5.5, checks_ok: true,
    lines: [
      { code: "900", description: "TEST DAIRY · CREAM THICKENED · 5LT", qty: 1, unit: "CTN", unit_price: price, line_total: price, gst: 0 },
      { code: "", description: "FUEL LEVY", qty: 1, unit: "", unit_price: 5, line_total: 5, gst: 0.5 },
    ] } });

  section("A. Before the migration");
  const fpBefore = await db.fingerprints();
  await check("new server answers clearly while ingredient costs are not installed", async () => {
    const gm = await login(vNew, 1);
    const r = await api(vNew, 1, gm, { action: "manager_ingredient_costs" });
    assert.ok(r.status >= 400 && r.status < 600, String(r.status));
    assert.equal((await api(vNew, 1, gm, { action: "manager_invoice_list" })).status, 200);
    return `costs ${r.status}; invoices 200`;
  });

  section("B. Migration");
  await check("applies; nothing existing changed; closed to the public keys; runs twice", async () => {
    const r = db.psqlFile(COSTS); assert.ok(r.ok, r.stderr);
    const fp = await db.fingerprints();
    assert.deepEqual(Object.keys(fpBefore).filter((k) => fp[k] !== fpBefore[k]), []);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await one(db, `select has_table_privilege('${role}', 'public.recipe_ingredient_costs', 'select')`), "f", role);
      assert.equal(await one(db, `select has_function_privilege('${role}', 'public.manager_ingredient_costs(uuid,text)', 'execute')`), "f", role);
    }
    const again = db.psqlFile(COSTS); assert.ok(again.ok, again.stderr);
    return "table locked to the server";
  });
  await check("current production server keeps working", async () => {
    const m = await login(vProd, 1);
    for (const action of ["manager_dashboard", "manager_recipe_list", "manager_invoice_list", "manager_invoice_usage"]) {
      assert.equal((await api(vProd, 1, m, { action })).status, 200, action);
    }
    return "200";
  });

  section("C. New server");
  const gm = await login(vNew, 1);
  const km = await login(vNew, 2);
  const fm = await login(vNew, 3);

  await check("Administrator and Kitchen Manager only", async () => {
    assert.equal((await api(vNew, 3, fm, { action: "manager_ingredient_costs" })).status, 403);
    assert.equal((await api(vNew, 3, fm, { action: "manager_ingredient_cost_save", ingredient_id: cream, link: null })).status, 403);
    assert.equal((await api(vNew, 2, km, { action: "manager_ingredient_costs" })).status, 200);
    return "Floor Manager 403; Kitchen Manager 200";
  });

  await check("lists every ingredient and the products from invoices (fees left out)", async () => {
    assert.equal((await saveInv(vNew, 1, gm, "D-1", daysAgo(9), 100)).status, 200);
    const d = (await api(vNew, 1, gm, { action: "manager_ingredient_costs" })).body.data;
    assert.equal(d.ingredients.length, Number(await one(db, "select count(*) from public.recipe_ingredients where location = 'Hawthorne'")));
    assert.deepEqual(d.products.map((p) => p.description), ["TEST DAIRY · CREAM THICKENED · 5LT"]);
    assert.equal(Number(d.products[0].price), 100);
    const c = d.ingredients.find((i) => i.id === cream);
    assert.equal(c.link, null);
    assert.ok(c.used_in >= 1);
    return `${d.ingredients.length} ingredients; 1 product`;
  });

  await check("link Cream to the product: 4 x 5 l for $100 = $5 per litre, follows the newest invoice", async () => {
    let r = await api(vNew, 2, km, { action: "manager_ingredient_cost_save", ingredient_id: cream, link: {
      supplier: "Test Dairy Pty", product_key: "900", label: "TEST DAIRY · CREAM THICKENED · 5LT", pack_count: 4, pack_size: 5, pack_unit: "l" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let c = (await api(vNew, 1, gm, { action: "manager_ingredient_costs" })).body.data.ingredients.find((i) => i.id === cream);
    assert.equal(Number(c.link.cost_per_unit), 5);
    assert.equal(c.link.base_unit, "l");
    assert.equal(Number(c.link.latest_price), 100);
    assert.equal((await saveInv(vNew, 1, gm, "D-2", daysAgo(2), 120)).status, 200);
    c = (await api(vNew, 1, gm, { action: "manager_ingredient_costs" })).body.data.ingredients.find((i) => i.id === cream);
    assert.equal(Number(c.link.cost_per_unit), 6);
    // grams: 500 g for $3 = $6 per kg
    const mozz = await one(db, "select id from public.recipe_ingredients where name = 'Mozzarella' and location = 'Hawthorne'");
    r = await api(vNew, 1, gm, { action: "manager_ingredient_cost_save", ingredient_id: mozz, link: {
      supplier: "Test Dairy Pty", product_key: "900", label: "x", pack_count: 1, pack_size: 500, pack_unit: "g" } });
    assert.equal(r.status, 200);
    const m = (await api(vNew, 1, gm, { action: "manager_ingredient_costs" })).body.data.ingredients.find((i) => i.id === mozz);
    assert.equal(Number(m.link.cost_per_unit), 240); assert.equal(m.link.base_unit, "kg");
    return "$5/l, then $6/l after a dearer invoice; grams work out per kg";
  });

  await check("re-link replaces, unlink clears; every change kept in the audit", async () => {
    let r = await api(vNew, 1, gm, { action: "manager_ingredient_cost_save", ingredient_id: cream, link: {
      supplier: "Test Dairy Pty", product_key: "900", label: "TEST DAIRY · CREAM THICKENED · 5LT", pack_count: 2, pack_size: 5, pack_unit: "l" } });
    assert.equal(r.status, 200);
    assert.equal(await one(db, `select count(*) from public.recipe_ingredient_costs where ingredient_id = '${cream}' and active`), "1");
    r = await api(vNew, 1, gm, { action: "manager_ingredient_cost_save", ingredient_id: cream, link: null });
    assert.equal(r.status, 200);
    const c = (await api(vNew, 1, gm, { action: "manager_ingredient_costs" })).body.data.ingredients.find((i) => i.id === cream);
    assert.equal(c.link, null);
    assert.equal(await one(db, `select count(*) from public.recipe_ingredient_costs where ingredient_id = '${cream}'`), "2");
    assert.equal(await one(db, `select count(*) from public.recipe_audit where kind = 'ingredient_cost' and ref = '${cream}'`), "3");
    return "2 rows kept (off), 3 audit entries";
  });

  await check("rejects bad input", async () => {
    const good = { supplier: "Test Dairy Pty", product_key: "900", label: "x", pack_count: 1, pack_size: 1, pack_unit: "kg" };
    for (const link of [{ ...good, pack_count: 0 }, { ...good, pack_size: -1 }, { ...good, pack_unit: "cup" }, { ...good, supplier: "" }, { ...good, pack_count: "abc" }]) {
      const r = await api(vNew, 1, gm, { action: "manager_ingredient_cost_save", ingredient_id: cream, link });
      assert.equal(r.status, 400, JSON.stringify(link));
    }
    assert.equal((await api(vNew, 1, gm, { action: "manager_ingredient_cost_save", ingredient_id: "00000000-0000-0000-0000-000000000000", link: good })).status, 404);
    assert.equal((await api(vNew, 1, gm, { action: "manager_ingredient_cost_save", ingredient_id: "nope", link: good })).status, 404);
    return "400 / 404";
  });

  await check("made in the kitchen: Pizza dough becomes its own Prep recipe; dishes keep allergens and checked state", async () => {
    const dough = await one(db, "select id from public.recipe_ingredients where name = 'Pizza dough' and location = 'Hawthorne'");
    const usedBefore = Number(await one(db, `select count(distinct recipe_id) from public.recipe_lines where ingredient_id = '${dough}' and active`));
    assert.ok(usedBefore > 5, String(usedBefore));
    const snap = async () => Object.fromEntries((await api(vNew, 3, fm, { action: "manager_recipe_list" })).body.data.recipes
      .map((r) => [r.name, JSON.stringify([r.allergens, r.all_checked])]));
    const before = await snap();
    // linked by mistake to flour first: the link is switched off
    assert.equal((await api(vNew, 1, gm, { action: "manager_ingredient_cost_save", ingredient_id: dough, link: {
      supplier: "Test Dairy Pty", product_key: "900", label: "x", pack_count: 1, pack_size: 1, pack_unit: "kg" } })).status, 200);
    assert.equal((await api(vNew, 3, fm, { action: "manager_ingredient_make_recipe", ingredient_id: dough })).status, 403);
    const r = await api(vNew, 2, km, { action: "manager_ingredient_make_recipe", ingredient_id: dough });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.recipes_using_it, usedBefore);
    const after = await snap();
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    assert.deepEqual(changed, [], "allergens / checked of every recipe unchanged");
    assert.ok(after["Pizza dough"], "the Prep recipe is listed");
    const marg = (await api(vNew, 1, gm, { action: "manager_recipe_list" })).body.data.recipes.find((x) => x.name === "Margherita");
    const line = marg.lines.find((l) => l.name === "Pizza dough");
    assert.equal(line.is_recipe, true);
    let c = (await api(vNew, 1, gm, { action: "manager_ingredient_costs" })).body.data.ingredients.find((i) => i.id === dough);
    assert.equal(c.link, null);
    assert.equal(c.made_here.used_in, usedBefore);
    assert.equal(c.made_here.empty_lines, true);
    assert.equal(c.used_in, 0);
    // twice: nothing new
    const again = await api(vNew, 1, gm, { action: "manager_ingredient_make_recipe", ingredient_id: dough });
    assert.equal(again.body.data.recipes_using_it, 0);
    assert.equal(await one(db, "select count(*) from public.recipes where name = 'Pizza dough' and active"), "1");
    // a dish with the same name can't be made a Prep recipe
    const can = await one(db, "select id from public.recipe_ingredients where name = 'Cannelloni' and location = 'Hawthorne'");
    const no = await api(vNew, 1, gm, { action: "manager_ingredient_make_recipe", ingredient_id: can });
    assert.equal(no.status, 409, JSON.stringify(no.body));
    // the kitchen fills it in later in Recipes
    const save = await api(vNew, 2, km, { action: "manager_recipe_save", recipe: { id: c.made_here.recipe_id, name: "Pizza dough", category: "Prep",
      makes: "40 balls", lines: [{ name: "Test flour", quantity: "12.5 kg" }, { name: "Butter", quantity: "250 g" }, { name: "Water", quantity: "7 l" }] } });
    assert.equal(save.status, 200, JSON.stringify(save.body));
    c = (await api(vNew, 1, gm, { action: "manager_ingredient_costs" })).body.data.ingredients.find((i) => i.id === dough);
    assert.equal(c.made_here.empty_lines, false);
    const marg2 = (await api(vNew, 1, gm, { action: "manager_recipe_list" })).body.data.recipes.find((x) => x.name === "Margherita");
    assert.ok(marg2.lines.some((l) => l.name === "Pizza dough" && l.is_recipe));
    return `${usedBefore} recipes now use the Pizza dough recipe; allergens unchanged`;
  });

  await check("everything else still works on the new server", async () => {
    for (const action of ["manager_dashboard", "manager_recipe_list", "manager_invoice_list", "manager_invoice_usage", "manager_invoice_prices"]) {
      assert.equal((await api(vNew, 1, gm, { action })).status, 200, action);
    }
    return "200";
  });

  section("D. Rollback");
  await check("rollback removes ingredient costs; both servers still work", async () => {
    const r = db.psqlFile(COSTS_DOWN); assert.ok(r.ok, r.stderr);
    assert.deepEqual(Object.keys(await db.fingerprints()).sort(), Object.keys(fpBefore).sort());
    const a = await api(vNew, 1, gm, { action: "manager_invoice_list" });
    const m = await login(vProd, 1);
    const b = await api(vProd, 1, m, { action: "manager_dashboard" });
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    return "invoices 200 (new), dashboard 200 (production)";
  });
} finally {
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL INGREDIENT COST RELEASE CHECKS PASSED");
process.exit(failures ? 1 : 0);
