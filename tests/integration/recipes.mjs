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
  await check("applies; nothing existing changed; closed to the public keys; menu and sauces added", async () => {
    const r = db.psqlFile(RECIPES); assert.ok(r.ok, r.stderr);
    const fp = await db.fingerprints();
    assert.deepEqual(Object.keys(fpBefore).filter((k) => fp[k] !== fpBefore[k]), []);
    for (const t of ["recipes", "recipe_ingredients", "recipe_lines", "recipe_audit"]) {
      assert.equal(await one(db, `select has_table_privilege('anon', 'public.${t}', 'select')`), "f", t);
    }
    assert.equal(await one(db, "select has_function_privilege('anon', 'public.manager_recipe_list(uuid,text)', 'execute')"), "f");
    const total = await one(db, "select count(*) from public.recipes where location = 'Hawthorne'");
    assert.ok(Number(total) >= 60, total);
    for (const n of ["Creamy Chicken Sauce", "Bolognese", "Chilli Oil", "Margherita", "Lasagna al Forno", "Pesto sauce"]) {
      assert.equal(await one(db, `select count(*) from public.recipes where name = '${n}'`), "1", n);
    }
    // Lasagna uses the Bolognese recipe (linked, not a copy).
    assert.equal(await one(db, "select s.name from public.recipe_lines l join public.recipes r on r.id = l.recipe_id join public.recipes s on s.id = l.sub_recipe_id where r.name = 'Lasagna al Forno'"), "Bolognese");
    // 'Pepperoni' on a pizza is an ingredient, never the 'Pepperoni Pizza' recipe.
    assert.equal(await one(db, "select count(*) from public.recipe_lines where sub_recipe_id in (select id from public.recipes where category not in ('Sauce','Dressing','Prep'))"), "0");
    assert.equal(await one(db, "select count(*) from public.recipe_ingredients where checked"), "0");
    // Onion powder is used in two recipes but stored once.
    assert.equal(await one(db, "select count(*) from public.recipe_ingredients where name = 'Onion powder'"), "1");
    const again = db.psqlFile(RECIPES); assert.ok(again.ok, again.stderr);
    assert.equal(await one(db, "select count(*) from public.recipes"), total);
    return `${total} recipes (menu + sauces), sauces linked, none checked; running it twice adds nothing`;
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
      assert.equal(d.ingredients.length, Number(await one(db, "select count(*) from public.recipe_ingredients")));
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
      method: "1. Mix.", dairy_free_note: "Already dairy free", gluten_free_note: "Leave out the corn flour",
      lines: [{ name: "corn flour", quantity: "10 g" }, { name: "Vinegar", quantity: "500 ml" }, { name: " ", quantity: "x" }],
    } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rec = r.body.data.recipe;
    assert.equal(rec.lines.length, 2);
    const seen = (await api(vNew, 3, fm, { action: "manager_recipe_list" })).body.data.recipes.find((x) => x.id === rec.id);
    assert.equal(seen.gluten_free_note, "Leave out the corn flour"); // the floor sees how to adapt it
    assert.equal(seen.dairy_free_note, "Already dairy free");
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
    assert.ok(!floor.recipes.some((x) => x.id === rec.id));
    assert.ok(Number(await one(db, "select count(*) from public.recipe_audit")) >= 4);
    return "lowercase 'corn flour' matched the existing one; edit 200; remove 200 then 404; changes audited";
  });

  await check("a sauce's allergens reach every dish that uses it; an empty sauce keeps the dish 'not checked'", async () => {
    const list = (await api(vNew, 2, km, { action: "manager_recipe_list" })).body.data;
    const napoli = list.recipes.find((x) => x.name === "Napoli sauce");
    assert.equal(napoli.lines.length, 0);
    let mussel = list.recipes.find((x) => x.name === "Mussel Napoletana");
    assert.ok(!mussel.allergens.includes("sesame"));
    let r = await api(vNew, 2, km, { action: "manager_recipe_save", recipe: { ...napoli, lines: [{ name: "Tomato", quantity: "5 kg" }, { name: "Sesame oil", quantity: "10 ml" }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = (await api(vNew, 2, km, { action: "manager_recipe_list" })).body.data;
    const sesame = after.ingredients.find((i) => i.name === "Sesame oil");
    await api(vNew, 2, km, { action: "manager_recipe_ingredient_save", id: sesame.id, allergens: ["sesame"], checked: true });
    const floor = (await api(vNew, 3, fm, { action: "manager_recipe_list" })).body.data;
    mussel = floor.recipes.find((x) => x.name === "Mussel Napoletana");
    const line = mussel.lines.find((l) => l.name === "Napoli sauce");
    assert.ok(mussel.allergens.includes("sesame"), mussel.allergens.join());
    assert.equal(line.is_recipe, true);
    assert.ok(line.allergens.includes("sesame"));
    // Kilpatrick sauce is still empty: even with the oysters checked, the dish is not checked.
    const oysters = after.ingredients.find((i) => i.name === "Oysters");
    await api(vNew, 2, km, { action: "manager_recipe_ingredient_save", id: oysters.id, allergens: ["mollusc"], checked: true });
    const kil = (await api(vNew, 3, fm, { action: "manager_recipe_list" })).body.data.recipes.find((x) => x.name === "Kilpatrick Oysters");
    assert.equal(kil.all_checked, false);
    // Typing a sauce name in a new recipe links that sauce.
    r = await api(vNew, 2, km, { action: "manager_recipe_save", recipe: { name: "Test Dish", category: "Dish", lines: [{ name: "napoli sauce" }, { name: "Basil" }] } });
    assert.equal(r.body.data.recipe.lines[0].is_recipe, true);
    assert.ok(r.body.data.recipe.allergens.includes("sesame"));
    await api(vNew, 2, km, { action: "manager_recipe_remove", id: r.body.data.recipe.id });
    return `Mussel Napoletana now: ${mussel.allergens.join(", ")}; Kilpatrick Oysters still not checked`;
  });

  await check("Kids Pasta: the three pastas become separate ingredients (and back on rollback)", async () => {
    const KIDS = "supabase/migrations/20261022010000_recipes_kids_pasta.sql";
    const KIDS_DOWN = "supabase/rollback/20261022010000_recipes_kids_pasta.down.sql";
    const names = async () => (await api(vNew, 3, fm, { action: "manager_recipe_list" })).body.data.recipes
      .find((x) => x.name.startsWith("Kids Pasta")).lines.map((l) => l.name);
    assert.deepEqual(await names(), ["Fettuccine, penne or gnocchi", "Parmesan", "Butter"]);
    let r = db.psqlFile(KIDS); assert.ok(r.ok, r.stderr);
    r = db.psqlFile(KIDS); assert.ok(r.ok, r.stderr); // twice: no change
    assert.deepEqual(await names(), ["Fettuccine", "Penne", "Gnocchi", "Parmesan", "Butter"]);
    r = db.psqlFile(KIDS_DOWN); assert.ok(r.ok, r.stderr);
    assert.deepEqual(await names(), ["Fettuccine, penne or gnocchi", "Parmesan", "Butter"]);
    r = db.psqlFile(KIDS); assert.ok(r.ok, r.stderr);
    assert.deepEqual(await names(), ["Fettuccine", "Penne", "Gnocchi", "Parmesan", "Butter"]);
    return (await names()).join(", ");
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
