// Release check for Ingredient prices: a typed price (supplier with no PDF)
// and renaming an ingredient, on a production-like database, with the
// production server (baseline-v66) still working before and after. Synthetic data only: this repository is public.
// Run: node tests/integration/ingredient-edit.mjs
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { startProdLikeDb, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "./edge-loader.mjs";
import { ID, PIN, reseed } from "./seed.mjs";

const NEW = "20261110000000_ingredient_edit.sql";
const MIG = `supabase/migrations/${NEW}`;
const DOWN = "supabase/rollback/20261110000000_ingredient_edit.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v66.ts");

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
  const gm = await login(vNew, 1), km = await login(vNew, 2), fm = await login(vNew, 3);
  const mince = await one("select id from public.recipe_ingredients where name = 'Mince' and location = 'Hawthorne'");
  const mozz = await one("select id from public.recipe_ingredients where name = 'Mozzarella' and location = 'Hawthorne'");
  const dough = await one("select id from public.recipe_ingredients where name = 'Pizza dough' and location = 'Hawthorne'");
  assert.ok(mince && mozz && dough, "the recipes seed has these");
  const ingOf = async (n, tok, id) => (await api(vNew, n, tok, { action: "manager_ingredient_costs" })).body.data.ingredients.find((i) => i.id === id);

  await check("before the migration: renaming gets a clear answer; Costs still work", async () => {
    const r = await api(vNew, 2, km, { action: "manager_ingredient_rename", ingredient_id: mince, name: "Test beef mince" });
    assert.ok(r.status >= 400 && r.body.error);
    assert.equal((await api(vNew, 2, km, { action: "manager_ingredient_costs" })).status, 200);
  });
  await check("migration applies, runs twice, closed to the public keys; production server keeps working", async () => {
    let r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await one(`select has_function_privilege('${role}', 'public.manager_ingredient_rename(uuid,text,uuid,text)', 'execute')`), "f");
      assert.equal(await one(`select has_function_privilege('${role}', 'public.manager_ingredient_costs(uuid,text)', 'execute')`), "f");
    }
    const p = await login(vProd, 1);
    for (const action of ["manager_dashboard", "manager_ingredient_costs", "manager_dish_costs"]) assert.equal((await api(vProd, 1, p, { action })).status, 200, action);
  });
  await check("a typed price shows in Ingredient prices and in the dish costs", async () => {
    let r = await api(vNew, 2, km, { action: "manager_cost_price_save", kind: "ingredient", ref_id: mince, price: { price: 11.5, unit: "kg", note: "Test supplier" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ing = await ingOf(2, km, mince);
    assert.deepEqual({ price: Number(ing.manual.price), unit: ing.manual.unit, note: ing.manual.note }, { price: 11.5, unit: "kg", note: "Test supplier" });
    assert.equal(ing.link, null);
    const d = (await api(vNew, 2, km, { action: "manager_dish_costs" })).body.data.ingredients.find((i) => i.id === mince);
    assert.equal(Number(d.manual.price), 11.5);
    r = await api(vNew, 2, km, { action: "manager_cost_price_save", kind: "ingredient", ref_id: mince, price: null });
    assert.equal(r.status, 200);
    assert.equal((await ingOf(2, km, mince)).manual, null, "removed");
  });
  await check("rename: shows everywhere at once (recipes, dish costs); kept in the audit", async () => {
    const r = await api(vNew, 2, km, { action: "manager_ingredient_rename", ingredient_id: mince, name: "  Test   beef mince " });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.ingredient.name, "Test beef mince");
    assert.equal((await ingOf(2, km, mince)).name, "Test beef mince");
    const recipes = (await api(vNew, 2, km, { action: "manager_dish_costs" })).body.data.recipes;
    const lines = recipes.flatMap((x) => x.lines).filter((l) => l.ref_id === mince);
    assert.ok(lines.length > 0 && lines.every((l) => l.name === "Test beef mince"), "every recipe line shows the new name");
    assert.equal(await one(`select new_value->>'name' from public.recipe_audit where kind = 'ingredient_rename' and ref = '${mince}' order by id desc limit 1`), "Test beef mince");
  });
  await check("rename refused: a name already used, a kitchen-made name, empty, other people", async () => {
    let r = await api(vNew, 2, km, { action: "manager_ingredient_rename", ingredient_id: mince, name: "mozzarella" });
    assert.equal(r.status, 409); assert.equal(r.body.code, "INGREDIENT_EXISTS");
    r = await api(vNew, 2, km, { action: "manager_ingredient_rename", ingredient_id: mince, name: "Bolognese" });
    assert.equal(r.status, 409); assert.equal(r.body.code, "NAME_IS_A_DISH");
    assert.equal((await api(vNew, 2, km, { action: "manager_ingredient_make_recipe", ingredient_id: dough })).status, 200);
    r = await api(vNew, 2, km, { action: "manager_ingredient_rename", ingredient_id: dough, name: "Test dough" });
    assert.equal(r.status, 409, "made in the kitchen: rename its recipe instead");
    assert.equal((await api(vNew, 2, km, { action: "manager_ingredient_rename", ingredient_id: mince, name: "   " })).status, 400);
    assert.equal((await api(vNew, 2, km, { action: "manager_ingredient_rename", ingredient_id: "nope", name: "x" })).status, 404);
    assert.ok((await api(vNew, 3, fm, { action: "manager_ingredient_rename", ingredient_id: mince, name: "Test floor" })).status >= 400, "Floor Manager refused");
    assert.equal((await ingOf(2, km, mince)).name, "Test beef mince", "unchanged");
  });
  await check("rollback removes it; both servers still work", async () => {
    const r = db.psqlFile(DOWN); assert.ok(r.ok, r.stderr);
    assert.equal(await one(`select to_regprocedure('public.manager_ingredient_rename(uuid,text,uuid,text)') is null`), "t");
    assert.equal((await api(vNew, 2, km, { action: "manager_ingredient_costs" })).status, 200, "Costs still work");
    assert.equal((await api(vNew, 1, gm, { action: "manager_dashboard" })).status, 200);
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_dashboard" })).status, 200);
  });
} finally {
  db.stop();
}
log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL INGREDIENT EDIT CHECKS PASSED");
process.exit(failures ? 1 : 0);
