// Release check for recipes (Kitchen) and allergens (Floor), on a
// production-like database. Production at release time = everything up to the
// time-off count, served by the current main server (tests/edge/baseline-v45.ts).
// Run: node tests/integration/recipes.mjs
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
];
const RECIPES = "supabase/migrations/20261022000000_recipes.sql";
const RECIPES_DOWN = "supabase/rollback/20261022000000_recipes.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v45.ts");

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
  const vProd = await quiet(() => loadHandler(PROD_SERVER));
  const vNew = await quiet(() => loadHandler(NEW_SERVER));
  const dev = Object.fromEntries([1, 2, 3, 4, 6].map((n) => [n, newDeviceSecret()]));
  const login = async (h, n) => {
    const r = await quiet(() => call(h, { action: "login", pin: PIN[ID(n)], device: dev[n] }));
    assert.equal(r.status, 200, `login ${n}: ${JSON.stringify(r.body)}`);
    return r.body.session.token;
  };
  const api = (h, n, token, body) => quiet(() => call(h, { ...body, token, device: dev[n] }));

  section("A. Before the migration");
  const fpBefore = await db.fingerprints();
  await check("new server answers clearly while recipes are not installed", async () => {
    const gm = await login(vNew, 1);
    const r = await api(vNew, 1, gm, { action: "manager_recipe_list" });
    assert.ok(r.status >= 400 && r.status < 600, String(r.status));
    assert.equal((await api(vNew, 1, gm, { action: "manager_dashboard" })).status, 200);
    return `recipes ${r.status}; dashboard 200`;
  });

  section("B. Migration");
  await check("applies; nothing existing changed; closed to the public keys; 3 recipes added", async () => {
    const r = db.psqlFile(RECIPES); assert.ok(r.ok, r.stderr);
    const fp = await db.fingerprints();
    assert.deepEqual(Object.keys(fpBefore).filter((k) => fp[k] !== fpBefore[k]), []);
    for (const t of ["recipes", "recipe_ingredients", "recipe_lines", "recipe_audit"]) {
      assert.equal(await one(db, `select has_table_privilege('anon', 'public.${t}', 'select')`), "f", t);
    }
    assert.equal(await one(db, "select has_function_privilege('anon', 'public.manager_recipe_list(uuid,text)', 'execute')"), "f");
    assert.equal(await one(db, "select count(*) from public.recipes where location = 'Hawthorne'"), "3");
    assert.equal(await one(db, "select count(*) from public.recipe_ingredients where checked"), "0");
    // Onion powder is used in two recipes but stored once.
    assert.equal(await one(db, "select count(*) from public.recipe_ingredients where name = 'Onion powder'"), "1");
    const again = db.psqlFile(RECIPES); assert.ok(again.ok, again.stderr);
    assert.equal(await one(db, "select count(*) from public.recipes"), "3");
    return "3 recipes, 14 ingredients, none checked; running it twice adds nothing";
  });
  await check("current production server keeps working", async () => {
    const m = await login(vProd, 1);
    for (const action of ["manager_dashboard", "manager_team", "manager_stock_list", "manager_leave_list"]) {
      assert.equal((await api(vProd, 1, m, { action })).status, 200, action);
    }
    return "200";
  });

  section("C. New server");
  const gm = await login(vNew, 1);
  const km = await login(vNew, 2);
  const fm = await login(vNew, 3);

  await check("Administrator and Kitchen Manager see full recipes", async () => {
    for (const [n, t] of [[1, gm], [2, km]]) {
      const r = await api(vNew, n, t, { action: "manager_recipe_list" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const d = r.body.data;
      assert.equal(d.full, true);
      const bol = d.recipes.find((x) => x.name === "Bolognese");
      assert.equal(bol.lines[0].quantity, "10 kg");
      assert.match(bol.method, /Brown the mince/);
      assert.equal(d.ingredients.length, 14);
    }
    return "quantities, method and the ingredient list";
  });

  await check("Floor Manager sees what each recipe contains, without quantities or method", async () => {
    const r = await api(vNew, 3, fm, { action: "manager_recipe_list" });
    assert.equal(r.status, 200);
    const d = r.body.data;
    assert.equal(d.full, false);
    assert.equal(d.can_edit, false);
    assert.deepEqual(d.ingredients, []);
    const sauce = d.recipes.find((x) => x.name === "Creamy Chicken Sauce");
    assert.deepEqual(sauce.allergens, ["milk"]);
    assert.equal(sauce.all_checked, false);
    assert.ok(sauce.lines.every((l) => !("quantity" in l)));
    assert.ok(!("method" in sauce) && !("makes" in sauce));
    assert.deepEqual(sauce.lines.map((l) => l.name), ["Milk", "Cream", "Thickening agent", "Corn flour", "Chicken booster", "Onion powder"]);
    return "names and allergens only; 'not checked' shown";
  });

  await check("Floor Manager and staff cannot change anything", async () => {
    const list = (await api(vNew, 1, gm, { action: "manager_recipe_list" })).body.data;
    const corn = list.ingredients.find((i) => i.name === "Corn flour");
    let r = await api(vNew, 3, fm, { action: "manager_recipe_save", recipe: { name: "X", lines: [{ name: "Salt" }] } });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    r = await api(vNew, 3, fm, { action: "manager_recipe_ingredient_save", id: corn.id, allergens: [], checked: true });
    assert.equal(r.status, 403);
    const st = await login(vNew, 6);
    r = await api(vNew, 6, st, { action: "manager_recipe_list" });
    assert.equal(r.status, 403);
    return "floor manager 403; staff 403";
  });

  await check("checking an ingredient on the label updates every recipe that uses it", async () => {
    const list = (await api(vNew, 2, km, { action: "manager_recipe_list" })).body.data;
    const corn = list.ingredients.find((i) => i.name === "Corn flour");
    let r = await api(vNew, 2, km, { action: "manager_recipe_ingredient_save", id: corn.id, allergens: ["gluten", "wheat"], checked: true, note: "Wheaten cornflour" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api(vNew, 2, km, { action: "manager_recipe_ingredient_save", id: corn.id, allergens: ["peanuts"], checked: true });
    assert.equal(r.status, 400);
    const floor = (await api(vNew, 3, fm, { action: "manager_recipe_list" })).body.data;
    const sauce = floor.recipes.find((x) => x.name === "Creamy Chicken Sauce");
    assert.deepEqual(sauce.allergens, ["gluten", "milk", "wheat"]);
    assert.equal(sauce.lines.find((l) => l.name === "Corn flour").checked, true);
    return `Creamy Chicken Sauce now: ${sauce.allergens.join(", ")}; unknown allergen code 400`;
  });

  await check("new recipe reuses ingredients by name; editing and removing work", async () => {
    let r = await api(vNew, 2, km, { action: "manager_recipe_save", recipe: {
      name: "Italian Dressing", category: "Dressing", makes: "2 L",
      method: "1. Mix.", lines: [{ name: "corn flour", quantity: "10 g" }, { name: "Vinegar", quantity: "500 ml" }, { name: " ", quantity: "x" }],
    } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rec = r.body.data.recipe;
    assert.equal(rec.lines.length, 2);
    assert.equal(rec.lines[0].name, "Corn flour");
    assert.deepEqual(rec.allergens, ["gluten", "wheat"]);
    assert.equal(rec.all_checked, false); // Vinegar is new, not checked
    r = await api(vNew, 1, gm, { action: "manager_recipe_save", recipe: { ...rec, name: "Italian Dressing", lines: [{ name: "Vinegar", quantity: "600 ml" }] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.recipe.allergens, []);
    r = await api(vNew, 2, km, { action: "manager_recipe_save", recipe: { name: "", lines: [] } });
    assert.equal(r.status, 400);
    r = await api(vNew, 2, km, { action: "manager_recipe_remove", id: rec.id });
    assert.equal(r.status, 200);
    r = await api(vNew, 2, km, { action: "manager_recipe_remove", id: rec.id });
    assert.equal(r.status, 404);
    const floor = (await api(vNew, 3, fm, { action: "manager_recipe_list" })).body.data;
    assert.equal(floor.recipes.length, 3);
    assert.ok(Number(await one(db, "select count(*) from public.recipe_audit")) >= 4);
    return "lowercase 'corn flour' matched the existing one; edit 200; remove 200 then 404; changes audited";
  });

  section("D. Rollback");
  await check("rollback removes recipes; both servers still work", async () => {
    const r = db.psqlFile(RECIPES_DOWN); assert.ok(r.ok, r.stderr);
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

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL RECIPE RELEASE CHECKS PASSED");
process.exit(failures ? 1 : 0);
