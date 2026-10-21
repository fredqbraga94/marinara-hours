// Browser test for recipes and allergens: the real app (index.html) in an emulated
// iPhone 13, talking to the real Edge Function code and a throwaway PostgreSQL
// with the production structure + the recipes migration. Synthetic staff only.
// Run: node tests/e2e/recipes.e2e.mjs   (E2E_BROWSER=webkit for Safari's engine;
// SHOTS=<dir> also saves screenshots)
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { startProdLikeDb, MIGRATION_A, MIGRATION_B, root } from "../integration/pgenv.mjs";
import { loadHandler, useDatabase, call } from "../integration/edge-loader.mjs";
import { ID, PIN, reseed } from "../integration/seed.mjs";

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_PATH || "playwright");
const ENGINE = process.env.E2E_BROWSER === "webkit" ? "webkit" : "chromium";
const SHOTS = process.env.SHOTS || "";
const HTML = readFileSync(resolve(root, "index.html"));
const STOCK = "supabase/migrations/20261021000000_stock_par.sql";
const RECIPES = "supabase/migrations/20261022000000_recipes.sql";

let failures = 0;
const log = (...a) => console.log(...a);
// In GitHub Actions, failures are also written as annotations (readable without the raw log).
const gha = (level, title, msg) => {
  if (process.env.GITHUB_ACTIONS) console.log(`::${level} title=${title.replace(/[:,\n]/g, " ").slice(0, 120)}::${String(msg).replace(/\r?\n/g, " | ").slice(0, 900)}`);
};
async function check(name, fn) {
  try {
    const note = await fn();
    log(`  ✔ ${name}${note ? `\n      ${note}` : ""}`);
  } catch (e) {
    failures++;
    gha("error", `${ENGINE}: ${name}`, e?.stack || e);
    log(`  ✖ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 6).join("\n      ")}`);
  }
}

const db = await startProdLikeDb({ poolSize: 10 });
for (const f of [MIGRATION_A, MIGRATION_B,
  "supabase/migrations/20261020000000_student_visa.sql",
  "supabase/migrations/20261020010000_roster.sql",
  "supabase/migrations/20261020020000_leave.sql",
  "supabase/migrations/20261020030000_public_holidays.sql",
  STOCK, "supabase/migrations/20261021010000_roster_roles.sql", "supabase/migrations/20261021020000_roster_order.sql", "supabase/migrations/20261021030000_floor_services.sql", "supabase/migrations/20261021040000_push.sql", "supabase/migrations/20261021050000_push_badge.sql", RECIPES]) { const r = db.psqlFile(f); if (!r.ok) throw new Error(`${f}: ${r.stderr}`); }
useDatabase(db.svc);
await reseed(db);
for (const f of [STOCK, RECIPES, "supabase/migrations/20261022010000_recipes_kids_pasta.sql", "supabase/migrations/20261022020000_recipes_dairy_kinds.sql"]) { const r = db.psqlFile(f); if (!r.ok) throw new Error(r.stderr); } // reseed's cascade emptied them
const handler = await loadHandler(resolve(root, "supabase/functions/marinara-api-v2/Index.ts"));

const server = await new Promise((ok) => {
  const s = createServer((req, res) => {
    if (req.url.endsWith("/index.html") || req.url.endsWith("/")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(HTML); }
    else if (/^\/(stock-pdf|timesheet-pdf|roster-pdf)\.js$|^\/vendor\/[\w.-]+\.js$/.test(req.url)) {
      res.writeHead(200, { "content-type": "text/javascript" }); res.end(readFileSync(resolve(root, "." + req.url)));
    } else { res.writeHead(404); res.end(); }
  });
  s.listen(0, "127.0.0.1", () => ok(s));
});
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const browser = await pw[ENGINE].launch();
const realLog = console.log;

async function phone() {
  const ctx = await browser.newContext({ ...pw.devices["iPhone 13"], serviceWorkers: "block", timezoneId: "Australia/Brisbane" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN)) return route.continue();
    if (!url.includes("/functions/v1/marinara-api-v2")) return route.abort();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: cors, body: "ok" });
    console.log = console.warn = console.error = () => {};
    try {
      const r = await call(handler, JSON.parse(route.request().postData() || "{}"));
      return route.fulfill({ status: r.status, headers: cors, contentType: "application/json", body: JSON.stringify(r.body) });
    } finally { console.log = console.warn = console.error = realLog; }
  });
  await page.goto(`${ORIGIN}/index.html`);
  await page.waitForTimeout(300);
  const login = async (pin) => { await page.fill("#pinInput", pin); await page.click("#loginBtn"); await page.waitForSelector("#managerScreen:not(.hidden)"); };
  const openStock = async () => {
    await page.click("#stockCard");
    await page.waitForSelector("#stockScreen:not(.hidden)");
    await page.waitForFunction(() => !/Loading/.test(document.getElementById("stockCountList").textContent));
  };
  const shot = (name) => SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : null;
  const row = (name) => page.locator(".stock-row", { hasText: name });
  return { ctx, page, errors, login, openStock, shot, row, close: () => ctx.close() };
}


const openRecipes = async (p) => {
  await p.page.click('[data-manager-nav="more"]');
  await p.page.waitForSelector("#managerMoreScreen:not(.hidden)");
  await p.page.click("#moreRecipesBtn");
  await p.page.waitForSelector("#recipesScreen:not(.hidden)");
  await p.page.waitForFunction(() => !/Loading/.test(document.getElementById("rcpAllergenList").textContent));
};

try {
  log(`\nBrowser: ${ENGINE} with iPhone 13 profile`);
  const km = await phone();
  await km.login(PIN[ID(2)]);

  await check("Kitchen Manager: Allergens list shows the whole menu by section, not checked yet", async () => {
    await openRecipes(km);
    const tabsShown = await km.page.locator("#recipesTabs").evaluate((e) => !e.classList.contains("hidden"));
    const items = await km.page.locator("#rcpAllergenList .rcp-item").count();
    const warn = await km.page.locator("#rcpAllergenList .rcp-warn").count();
    const creamy = (await km.page.locator("#rcpAllergenList .rcp-item", { hasText: "Creamy Chicken Sauce" }).textContent()).replace(/\s+/g, " ");
    await km.shot("recipes_allergens_kitchen");
    const groups = await km.page.locator("#rcpAllergenList .rcp-group").allTextContents();
    assert.equal(tabsShown, true); assert.ok(items >= 60, String(items)); assert.equal(warn, items);
    assert.deepEqual(groups.slice(0, 3), ["Pane", "Salad", "Entrée"]);
    assert.match(creamy, /Dairy \(milk, cream\)/);
    return creamy.trim().slice(0, 90);
  });

  await check("Recipes tab: Bolognese shows quantities and method", async () => {
    await km.page.click('[data-rcp-tab="recipes"]');
    await km.page.locator("#rcpRecipeList .rcp-head", { has: km.page.getByText("Bolognese", { exact: true }) }).click();
    const text = (await km.page.locator("#rcpRecipeList .rcp-detail").textContent()).replace(/\s+/g, " ");
    await km.shot("recipes_bolognese");
    assert.match(text, /Mince\s*10 kg/); assert.match(text, /Brown the mince/);
    return text.slice(0, 80);
  });

  await check("Ingredients tab: mark Corn flour Gluten + Wheat, checked on label", async () => {
    await km.page.click('[data-rcp-tab="ingredients"]');
    await km.page.fill("#rcpIngSearch", "corn");
    const shown = await km.page.locator("#rcpIngredientList .rcp-head strong").allTextContents();
    assert.deepEqual(shown.sort(), ["Corn flour", "Corn kernels"]);
    const all = await km.page.textContent("#rcpIngredientList");
    await km.page.fill("#rcpIngSearch", "");
    assert.ok(!/Fettuccine, penne or gnocchi/.test(await km.page.textContent("#rcpIngredientList")), "unused ingredient hidden");
    await km.page.locator("#rcpIngredientList .rcp-head", { hasText: "Corn flour" }).click();
    assert.match(await km.page.textContent("#rcpIngAllergens"), /MilkButterCreamCheeseYoghurt/);
    await km.page.click('[data-rcp-pick="gluten"]');
    await km.page.click('[data-rcp-pick="wheat"]');
    await km.page.check("#rcpIngChecked");
    await km.page.fill("#rcpIngNote", "Wheaten cornflour");
    await km.shot("recipes_ingredient_edit");
    await km.page.click("#rcpIngSaveBtn");
    await km.page.waitForSelector("#recipesMessage.ok");
    const row = (await km.page.locator("#rcpIngredientList .rcp-item", { hasText: "Corn flour" }).textContent()).replace(/\s+/g, " ");
    const db1 = await db.admin.query("select allergens::text, checked from public.recipe_ingredients where name = 'Corn flour'").then((r) => r.rows[0]);
    assert.deepEqual(db1, ["{gluten,wheat}", "t"]);
    assert.match(row, /Checked on label/);
    return row.trim().slice(0, 90);
  });

  await check("New recipe from the form appears in the lists", async () => {
    await km.page.click('[data-rcp-tab="recipes"]');
    await km.page.click("#rcpNewBtn");
    await km.page.fill("#rcpFName", "Italian Dressing");
    await km.page.fill("#rcpFCategory", "Dressing");
    const rows = km.page.locator("#rcpFLines .rcp-row");
    await rows.nth(0).locator('[data-rcp-line="name"]').fill("Olive oil");
    await rows.nth(0).locator('[data-rcp-line="quantity"]').fill("1 L");
    await rows.nth(1).locator('[data-rcp-line="name"]').fill("Corn flour");
    await rows.nth(1).locator('[data-rcp-line="quantity"]').fill("20 g");
    await km.page.fill("#rcpFMethod", "1. Whisk everything.");
    await km.page.fill("#rcpFGlutenFree", "Use gluten-free flour instead of corn flour");
    await km.shot("recipes_new_form");
    await km.page.click("#rcpSaveBtn");
    await km.page.waitForSelector("#recipesMessage.ok");
    await km.page.click('[data-rcp-tab="allergens"]');
    const row = (await km.page.locator("#rcpAllergenList .rcp-item", { hasText: "Italian Dressing" }).textContent()).replace(/\s+/g, " ");
    assert.match(row, /Gluten/); assert.match(row, /Wheat/); assert.match(row, /Not checked yet/);
    assert.match(row, /Can be made gluten free: Use gluten-free flour/);
    assert.deepEqual(km.errors, []);
    return row.trim().slice(0, 90);
  });
  await check("Green 'Dairy free' / 'Gluten free' only once every ingredient is checked", async () => {
    const before = (await km.page.locator("#rcpAllergenList .rcp-item", { hasText: "Chilli Oil" }).textContent()).replace(/\s+/g, " ");
    await db.admin.query("update public.recipe_ingredients set checked = true where name in ('Paprika','Chilli paste','Chilli flakes','Tuscan olive oil')");
    await km.page.click('[data-rcp-tab="recipes"]');
    await km.page.click('[data-rcp-tab="allergens"]');
    await km.page.click("#backRecipesBtn");
    await openRecipes(km);
    const after = (await km.page.locator("#rcpAllergenList .rcp-item", { hasText: "Chilli Oil" }).textContent()).replace(/\s+/g, " ");
    await km.shot("recipes_free_labels");
    assert.ok(!/Dairy free|Gluten free/.test(before), before);
    assert.match(after, /Dairy free/); assert.match(after, /Gluten free/); assert.ok(!/Not checked/.test(after));
    return `before: no green labels; after: ${after.trim().slice(0, 60)}`;
  });
  await km.close();

  const fm = await phone();
  await fm.login(PIN[ID(3)]);
  await check("Floor Manager: 'Allergens' only, no quantities, search works", async () => {
    await fm.page.click('[data-manager-nav="more"]');
    const label = await fm.page.textContent("#moreRecipesLabel");
    await openRecipes(fm);
    const tabsHidden = await fm.page.locator("#recipesTabs").evaluate((e) => e.classList.contains("hidden"));
    await fm.page.locator("#rcpAllergenList .rcp-head", { hasText: "Creamy Chicken Sauce" }).click();
    const detail = (await fm.page.locator("#rcpAllergenList .rcp-detail").textContent()).replace(/\s+/g, " ");
    await fm.shot("recipes_floor");
    await fm.page.fill("#rcpSearch", "corn");
    const found = await fm.page.locator("#rcpAllergenList .rcp-item").count();
    assert.equal(label, "Allergens"); assert.equal(tabsHidden, true);
    assert.ok(!/bottles|900 g/.test(detail), detail);
    assert.match(detail, /Corn flour Gluten, Wheat/);
    const names = await fm.page.locator("#rcpAllergenList .rcp-head strong").allTextContents();
    assert.ok(names.includes("Creamy Chicken Sauce") && names.includes("Italian Dressing") && names.includes("Vegetarian Pizza"), names.join());
    assert.deepEqual(fm.errors, []);
    return `${label}; ${detail.slice(0, 70)}…; search 'corn' → ${found}`;
  });
  await fm.close();
} finally {
  await browser.close();
  server.close();
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL RECIPE BROWSER CHECKS PASSED");
process.exit(failures ? 1 : 0);
