// Release check for Dish costs (menu price, amounts per plate, prices typed by
// hand), on a production-like database with the current server. Synthetic
// prices only. Run: node tests/integration/dish-costs.mjs
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { startProdLikeDb, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "./edge-loader.mjs";
import { ID, PIN, reseed } from "./seed.mjs";

const NEW = "20261106000000_dish_costs.sql";
const MIG = `supabase/migrations/${NEW}`;
const DOWN = "supabase/rollback/20261106000000_dish_costs.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v63.ts");

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
  // The recipes are seeded for the restaurant's staff: seed them again after the reseed.
  for (const f of ["20261022000000_recipes.sql", "20261022010000_recipes_kids_pasta.sql", "20261022020000_recipes_dairy_kinds.sql"]) db.mustFile(`supabase/migrations/${f}`);
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
  const gm = await login(vNew, 1), km = await login(vNew, 2);
  const id = (sql) => one(sql);
  const marg = await id("select id from public.recipes where name = 'Margherita' and location = 'Hawthorne' and active");
  const lasagna = await id("select id from public.recipes where name = 'Lasagna al Forno' and location = 'Hawthorne' and active");
  const bolo = await id("select id from public.recipes where name = 'Bolognese' and location = 'Hawthorne' and active");
  const mozz = await id("select id from public.recipe_ingredients where name = 'Mozzarella' and location = 'Hawthorne'");
  const mince = await id("select id from public.recipe_ingredients where name = 'Mince' and location = 'Hawthorne'");
  const sheets = await id("select id from public.recipe_ingredients where name = 'Lasagne sheets' and location = 'Hawthorne'");
  assert.ok(marg && lasagna && bolo && mozz && mince && sheets, "the recipes seed has these");

  await check("before the migration: clear answer; Recipes and Costs still work", async () => {
    const r = await api(vNew, 1, gm, { action: "manager_dish_costs" });
    assert.ok(r.status >= 400 && r.body.error);
    assert.equal((await api(vNew, 1, gm, { action: "manager_ingredient_costs" })).status, 200);
  });
  await check("migration applies, runs twice, closed to the public keys; production server keeps working", async () => {
    const before = await db.fingerprints();
    let r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    const after = await db.fingerprints();
    assert.deepEqual(Object.keys(before).filter((k) => after[k] !== before[k]), [], "nothing existing changed");
    for (const role of ["anon", "authenticated"]) {
      for (const tb of ["dish_costing", "dish_portions", "cost_manual_prices"]) assert.equal(await one(`select has_table_privilege('${role}', 'public.${tb}', 'select')`), "f");
      assert.equal(await one(`select has_function_privilege('${role}', 'public.manager_dish_cost_save(uuid,text,uuid,jsonb)', 'execute')`), "f");
    }
    const p = await login(vProd, 1);
    for (const action of ["manager_dashboard", "manager_recipe_list", "manager_ingredient_costs"]) assert.equal((await api(vProd, 1, p, { action })).status, 200, action);
  });
  await check("menu price and amounts per plate are saved; only the keys sent change", async () => {
    let r = await api(vNew, 2, km, { action: "manager_dish_cost_save", recipe_id: marg, dish: { sell_price: 23.5, portions: [{ kind: "ingredient", ref_id: mozz, qty: 120, unit: "g" }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api(vNew, 2, km, { action: "manager_dish_cost_save", recipe_id: marg, dish: { portions: [{ kind: "ingredient", ref_id: mozz, qty: 130, unit: "g" }] } });
    assert.equal(r.status, 200);
    const d = (await api(vNew, 1, gm, { action: "manager_dish_costs" })).body.data;
    const m = d.recipes.find((x) => x.id === marg);
    assert.equal(m.sizes.length, 1);
    assert.equal(m.sizes[0].size, "");
    assert.equal(Number(m.sizes[0].sell_price), 23.5, "price kept when not sent");
    assert.equal(m.sizes[0].portions.length, 1, "other lines not counted");
    const line = m.sizes[0].portions[0];
    assert.deepEqual([line.ref_id, Number(line.qty), line.unit, line.kind, line.product], [mozz, 130, "g", "ingredient", null]);
    assert.ok(m.lines.some((l) => l.ref_id === mozz && l.kind === "ingredient"));
    // Empty amount = left out.
    r = await api(vNew, 2, km, { action: "manager_dish_cost_save", recipe_id: marg, dish: { portions: [{ kind: "ingredient", ref_id: mozz, qty: "" }] } });
    assert.equal(r.status, 200);
    assert.equal(await one(`select count(*) from public.dish_portions where recipe_id = '${marg}'`), "0");
    assert.equal(await one(`select count(*) from public.recipe_audit where kind = 'dish_cost' and ref = '${marg}'`), "3", "every change is in the audit");
  });
  await check("sauce: one batch makes; a line not in the recipe and bad numbers are refused", async () => {
    let r = await api(vNew, 2, km, { action: "manager_dish_cost_save", recipe_id: bolo, dish: { yield_qty: 16, yield_unit: "kg", portions: [{ kind: "ingredient", ref_id: mince, qty: 10, unit: "kg" }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api(vNew, 2, km, { action: "manager_dish_cost_save", recipe_id: lasagna, dish: { portions: [{ kind: "ingredient", ref_id: mince, qty: 1, unit: "kg" }] } });
    assert.equal(r.status, 404, "Mince is not a line of Lasagna");
    r = await api(vNew, 2, km, { action: "manager_dish_cost_save", recipe_id: lasagna, dish: { sell_price: -3 } });
    assert.equal(r.status, 400);
    r = await api(vNew, 2, km, { action: "manager_dish_cost_save", recipe_id: lasagna, dish: { portions: [{ kind: "recipe", ref_id: bolo, qty: 200, unit: "cups" }] } });
    assert.equal(r.status, 400);
    r = await api(vNew, 2, km, { action: "manager_dish_cost_save", recipe_id: lasagna, dish: { sell_price: 35.9, portions: [{ kind: "recipe", ref_id: bolo, qty: 200, unit: "g" }, { kind: "ingredient", ref_id: sheets, qty: 450, unit: "g" }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
  await check("price by hand for an ingredient and a sauce; remove; bad price refused", async () => {
    let r = await api(vNew, 2, km, { action: "manager_cost_price_save", kind: "ingredient", ref_id: mince, price: { price: 10, unit: "kg", note: "Test estimate" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api(vNew, 2, km, { action: "manager_cost_price_save", kind: "ingredient", ref_id: sheets, price: { price: 18, unit: "kg" } });
    assert.equal(r.status, 200);
    r = await api(vNew, 2, km, { action: "manager_cost_price_save", kind: "recipe", ref_id: bolo, price: { price: 9, unit: "kg" } });
    assert.equal(r.status, 200);
    assert.equal((await api(vNew, 2, km, { action: "manager_cost_price_save", kind: "ingredient", ref_id: mince, price: { price: 0, unit: "kg" } })).status, 400);
    assert.equal((await api(vNew, 2, km, { action: "manager_cost_price_save", kind: "ingredient", ref_id: mince, price: { price: 3, unit: "box" } })).status, 400);
    const d = (await api(vNew, 1, gm, { action: "manager_dish_costs" })).body.data;
    assert.deepEqual(d.ingredients.find((i) => i.id === mince).manual, { price: 10, unit: "kg", note: "Test estimate" });
    assert.equal(Number(d.recipes.find((x) => x.id === bolo).manual.price), 9);
    const bs = d.recipes.find((x) => x.id === bolo).sizes[0];
    assert.deepEqual([Number(bs.yield_qty), bs.yield_unit], [16, "kg"]);
    r = await api(vNew, 2, km, { action: "manager_cost_price_save", kind: "recipe", ref_id: bolo, price: null });
    assert.equal(r.status, 200);
    assert.equal(await one(`select count(*) from public.cost_manual_prices where ref_id = '${bolo}'`), "0");
  });
  await check("a second size (Main) with its own price and amounts; removed", async () => {
    let r = await api(vNew, 2, km, { action: "manager_dish_cost_save", recipe_id: marg, dish: { size: "Main", sell_price: 30, portions: [{ kind: "ingredient", ref_id: mozz, qty: 200, unit: "g" }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let m = (await api(vNew, 1, gm, { action: "manager_dish_costs" })).body.data.recipes.find((x) => x.id === marg);
    assert.deepEqual(m.sizes.map((s) => [s.size, Number(s.sell_price), s.portions.length]), [["", 23.5, 0], ["Main", 30, 1]]);
    assert.equal((await api(vNew, 2, km, { action: "manager_dish_cost_save", recipe_id: marg, dish: { remove: true } })).status, 400, "the first size stays");
    r = await api(vNew, 2, km, { action: "manager_dish_cost_save", recipe_id: marg, dish: { size: "Main", remove: true } });
    assert.equal(r.status, 200);
    m = (await api(vNew, 1, gm, { action: "manager_dish_costs" })).body.data.recipes.find((x) => x.id === marg);
    assert.deepEqual(m.sizes.map((s) => s.size), [""]);
  });
  await check("a line with its own invoice product (pieces); a product not in the invoices refused", async () => {
    const inv = { supplier: "Test Seafood Co", number: "TS-1", kind: "invoice", date: "2026-11-01", subtotal: 21, gst: 0, total: 21, checks_ok: true,
      lines: [{ code: "TS-PRAWN", description: "Test prawn cutlet 13/15 700g", qty: 1, unit: "pk", unit_price: 21, line_total: 21, gst: 0 }] };
    assert.equal((await api(vNew, 1, gm, { action: "manager_invoice_save", invoice: inv })).status, 200);
    const prods = (await api(vNew, 1, gm, { action: "manager_dish_costs" })).body.data.products;
    const pr = prods.find((p) => p.supplier === "Test Seafood Co");
    assert.ok(pr && Number(pr.price) === 21, JSON.stringify(prods));
    const product = { supplier: pr.supplier, product_key: pr.product_key, label: pr.description, pack_count: 1, pack_size: 21, pack_unit: "each" };
    let r = await api(vNew, 2, km, { action: "manager_dish_cost_save", recipe_id: marg, dish: { portions: [{ kind: "ingredient", ref_id: mozz, qty: 7, unit: "each", product }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = (await api(vNew, 1, gm, { action: "manager_dish_costs" })).body.data.recipes.find((x) => x.id === marg);
    const p = m.sizes[0].portions[0].product;
    assert.deepEqual([p.supplier, Number(p.pack_size), p.pack_unit, Number(p.price)], ["Test Seafood Co", 21, "each", 21]);
    r = await api(vNew, 2, km, { action: "manager_dish_cost_save", recipe_id: marg, dish: { portions: [{ kind: "ingredient", ref_id: mozz, qty: 7, unit: "each", product: { ...product, product_key: "nope" } }] } });
    assert.equal(r.status, 404);
    r = await api(vNew, 2, km, { action: "manager_dish_cost_save", recipe_id: marg, dish: { portions: [{ kind: "ingredient", ref_id: mozz, qty: 7, unit: "each", product: { ...product, pack_unit: "box" } }] } });
    assert.equal(r.status, 400);
  });
  await check("a product from the imported supplier history (e.g. a year of Moco) can be chosen too", async () => {
    await db.admin.query(`insert into public.supplier_history_imports (id, location, supplier, period_from, period_to, source)
      values ('00000000-0000-4000-8000-00000000a001', 'Hawthorne', 'Test Wholesale', '2025-11-01', '2026-10-31', 'test.csv')`);
    await db.admin.query(`insert into public.supplier_history_products (import_id, code, brand, description, orders, cartons, units, carton_label, unit_label, spend, last_date, last_carton_price)
      values ('00000000-0000-4000-8000-00000000a001', 'T1620', 'Test Brand', 'Test Prawn Cutlet 16/20 Raw', 3, 3, 0, 'Carton', 'Bag', 600, '2026-09-07', 200)`);
    const prods = (await api(vNew, 1, gm, { action: "manager_dish_costs" })).body.data.products;
    const h = prods.find((p) => p.product_key === "history:T1620");
    assert.deepEqual([h.supplier, h.source, Number(h.price), h.unit], ["Test Wholesale", "history", 200, "Carton"]);
    assert.match(h.description, /Test Brand · Test Prawn Cutlet 16\/20/);
    const product = { supplier: h.supplier, product_key: h.product_key, label: h.description, pack_count: 10, pack_size: 1, pack_unit: "kg" };
    const r = await api(vNew, 2, km, { action: "manager_dish_cost_save", recipe_id: marg, dish: { portions: [{ kind: "ingredient", ref_id: mozz, qty: 150, unit: "g", product }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = (await api(vNew, 1, gm, { action: "manager_dish_costs" })).body.data.recipes.find((x) => x.id === marg);
    assert.equal(Number(m.sizes[0].portions[0].product.price), 200, "price from the history");
  });
  await check("staff and other units are refused", async () => {
    const st = await login(vNew, 4);
    assert.ok((await api(vNew, 4, st, { action: "manager_dish_costs" })).status >= 400);
    assert.ok((await api(vNew, 4, st, { action: "manager_dish_cost_save", recipe_id: marg, dish: { sell_price: 1 } })).status >= 400);
    assert.equal((await api(vNew, 1, gm, { action: "manager_unit_set", location: "Paddington" })).status, 200);
    assert.equal((await api(vNew, 1, gm, { action: "manager_dish_cost_save", recipe_id: marg, dish: { sell_price: 1 } })).status, 404);
    assert.equal((await api(vNew, 1, gm, { action: "manager_cost_price_save", kind: "ingredient", ref_id: mince, price: { price: 1, unit: "kg" } })).status, 404);
    assert.equal((await api(vNew, 1, gm, { action: "manager_unit_set", location: "Hawthorne" })).status, 200);
  });
  await check("rollback removes it; both servers still work", async () => {
    const r = db.psqlFile(DOWN); assert.ok(r.ok, r.stderr);
    assert.equal(await one("select to_regclass('public.dish_portions')"), null);
    assert.equal((await api(vNew, 1, gm, { action: "manager_recipe_list" })).status, 200);
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_dashboard" })).status, 200);
  });
} finally {
  db.stop();
}
log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL DISH COST CHECKS PASSED");
process.exit(failures ? 1 : 0);
