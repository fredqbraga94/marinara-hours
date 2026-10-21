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

async function phone(device = pw.devices["iPhone 13"]) {
  const ctx = await browser.newContext({ ...device, serviceWorkers: "block", timezoneId: "Australia/Brisbane" });
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

  await check("Home: restaurant header, today's numbers, grouped shortcuts; Recipes tile opens recipes", async () => {
    await km.page.waitForFunction(() => !/Loading/.test(document.getElementById("workingList").textContent));
    const header = (await km.page.textContent(".header")).replace(/\s+/g, " ").trim();
    const groups = await km.page.locator("#managerScreen .home-group:visible").allTextContents();
    const stats = await km.page.locator("#managerScreen .home-stat-l:visible").allTextContents();
    await km.shot("home_kitchen_manager");
    assert.match(header, /Hawthorne Restaurant manager/);
    assert.deepEqual(groups, ["Team & hours", "Kitchen & floor"]);
    assert.deepEqual(stats, ["Working now", "To approve", "Time off requests"]);
    // "Working now" scrolls to Who's Working on the same screen (no screen change).
    await km.page.click('[data-home-scroll="workingList"]');
    await km.page.waitForTimeout(700);
    assert.equal(await km.page.locator("#managerScreen").isVisible(), true);
    assert.equal(await km.page.locator("#teamScreen").isVisible(), false);
    const top = await km.page.locator("#workingList").evaluate((e) => e.closest(".card").getBoundingClientRect().top);
    assert.ok(top >= -2 && top < 200, String(top));
    // The time-off dot on the tile: white number on red, readable size.
    await km.page.evaluate(() => showLeaveBadge(3));
    const dot = await km.page.locator("#homeTimeOffBadge").evaluate((e) => { const c = getComputedStyle(e); return [e.textContent, c.color, c.backgroundColor, c.fontSize, c.display]; });
    await km.shot("home_badge");
    assert.deepEqual(dot, ["3", "rgb(255, 255, 255)", "rgb(217, 48, 37)", "12px", "flex"]);
    await km.page.evaluate(() => showLeaveBadge(0));
    assert.equal(await km.page.locator("#homeTimeOffBadge").isVisible(), false);
    await km.page.click("#recipesCard");
    await km.page.waitForSelector("#recipesScreen:not(.hidden)");
    await km.page.click("#backRecipesBtn");
    await km.page.click('[data-manager-nav="home"]');
    await km.page.waitForSelector("#managerScreen:not(.hidden)");
    return header;
  });

  await check("More screen: grouped menu with line icons", async () => {
    await km.page.click('[data-manager-nav="more"]');
    await km.page.waitForSelector("#managerMoreScreen:not(.hidden)");
    const groups = await km.page.locator("#managerMoreScreen .more-group").allTextContents();
    const icons = await km.page.locator("#managerMoreScreen .more-v2-icon svg").count();
    await km.shot("more_kitchen_manager");
    await km.page.click('[data-manager-nav="home"]');
    assert.deepEqual(groups, ["Team & hours", "Kitchen & floor", "This phone & access"]);
    assert.ok(icons >= 8, String(icons));
    return groups.join(" / ");
  });

  await check("Team and Approvals in the new look (no MANAGER label, avatars)", async () => {
    await km.page.click('[data-manager-nav="team"]');
    await km.page.waitForSelector("#teamScreen:not(.hidden) .team-person-row");
    const avatars = await km.page.locator("#teamScreen .team-person-row .who-av").count();
    const kickerShown = await km.page.locator("#teamScreen .team-v2-kicker").isVisible();
    await km.shot("team_screen");
    await km.page.click('[data-manager-nav="approvals"]');
    await km.page.waitForSelector("#approvalsScreen:not(.hidden)");
    await km.page.waitForTimeout(400);
    await km.shot("approvals_screen");
    const apprKicker = await km.page.locator("#approvalsScreen .approvals-v2-kicker").isVisible();
    await km.page.click('[data-manager-nav="home"]');
    assert.ok(avatars > 0); assert.equal(kickerShown, false); assert.equal(apprKicker, false);
    return `${avatars} people with initials`;
  });

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

  await check("Recipes tab: section chips filter; status shows checked / to check / to complete", async () => {
    await km.page.click('[data-rcp-tab="recipes"]');
    await km.page.locator('[data-rcp-cats="recipes"] [data-rcp-cat="Pizza"]').click();
    const groups = await km.page.locator("#rcpRecipeList .rcp-group").allTextContents();
    const pesto = await km.page.locator('[data-rcp-cats="recipes"] [data-rcp-cat="Sauce"]').click().then(() =>
      km.page.locator("#rcpRecipeList .rcp-item", { hasText: "Pesto sauce" }).textContent());
    await km.shot("recipes_list_style");
    await km.page.locator('[data-rcp-cats="recipes"] [data-rcp-cat=""]').click();
    assert.deepEqual(groups, ["Pizza"]);
    assert.match(pesto, /0 ingredients/); assert.match(pesto, /To complete/);
    return `Pizza only; Pesto sauce: ${pesto.replace(/\s+/g, " ").trim()}`;
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
  await check("Floor Manager home: the recipes tile says Allergens", async () => {
    await fm.page.click('[data-manager-nav="home"]');
    await fm.page.waitForSelector("#managerScreen:not(.hidden)");
    await fm.page.waitForFunction(() => !/Loading/.test(document.getElementById("workingList").textContent));
    const label = await fm.page.textContent("#recipesCardLabel");
    await fm.shot("home_floor_manager");
    assert.equal(label, "Allergens");
    return label;
  });

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
  const desk = await phone({ viewport: { width: 1440, height: 900 } });
  await desk.login(PIN[ID(1)]);
  await check("Laptop/desktop: overview with the four areas, grouped side menu; sign out from More", async () => {
    await desk.page.waitForFunction(() => !/Loading/.test(document.getElementById("workingList").textContent));
    await desk.page.waitForSelector("#deskAreas .desk-area-card");
    await desk.page.waitForFunction(() => /To order|No stock count/.test(document.getElementById("deskStats").textContent));
    const nav = await desk.page.locator(".manager-bottom-nav").boundingBox();
    const top = (sel) => desk.page.locator(sel).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    const stats = await top("#deskStats .desk-stat");
    const areas = await desk.page.locator("#deskAreas h3").allInnerTexts();
    const areaTops = await top("#deskAreas .desk-area-card");
    const pair = await top("#managerScreen > .desk-attention, #managerScreen > .desk-today");
    const att = await desk.page.innerText("#deskAttention");
    const today = await desk.page.innerText("#deskToday");
    const head = await desk.page.innerText("#managerScreen .week-head");
    const title = await desk.page.innerText(".desk-title");
    await desk.shot("desktop_home");
    assert.ok(nav.x === 0 && nav.width < 300 && nav.height > 800, JSON.stringify(nav)); // a left side menu
    assert.equal(title, "Restaurant overview");
    assert.equal(stats.length, 4); assert.equal(new Set(stats).size, 1, "four numbers on one row");
    assert.deepEqual(areas, ["Team & Hours", "Stock & Orders", "Kitchen & Recipes", "Invoices & Costs"]);
    assert.equal(areaTops[0], areaTops[1]); assert.equal(areaTops[2], areaTops[3]); assert.ok(areaTops[2] > areaTops[0], "2 x 2");
    assert.equal(pair.length, 2); assert.equal(pair[0], pair[1], "Needs attention and Today side by side");
    assert.equal(await desk.page.locator("#deskAttention").isVisible(), true);
    assert.equal(await desk.page.locator("#deskToday").isVisible(), true);
    assert.ok(pair[0] > areaTops[2], "below the areas");
    assert.match(att, /Needs attention/); assert.match(att, /2 shifts awaiting approval/);
    assert.match(today, /Today at Hawthorne/); assert.match(today, /2 working/);
    assert.match(head, /EMPLOYEE\s*DEPARTMENT\s*SHIFTS\s*TOTAL HOURS/i);
    // area buttons open their screens
    await desk.page.click('#deskAreas [data-desk-card="rosterCard"]');
    await desk.page.waitForSelector("#rosterGridBox .roster-grid");
    await desk.shot("desktop_roster");
    // side menu: four areas that open to their sections
    const areaNames = (await desk.page.locator("[data-desk-area]").allInnerTexts()).map((t) => t.replace(/[›\d]/g, "").trim());
    assert.deepEqual(areaNames, ["Team & Hours", "Stock & Orders", "Kitchen & Recipes", "Invoices & Costs"]);
    assert.equal(await desk.page.locator('[data-desk-area="team"]').getAttribute("aria-expanded"), "true", "opens where you are");
    assert.match(await desk.page.getAttribute('[data-desk-key="moreRosterBtn"]', "class"), /active/);
    await desk.page.click('[data-desk-area="invoices"]');
    await desk.page.click('[data-desk-key="moreInvoicesBtn:costs"]');
    await desk.page.waitForSelector("#invoicesScreen:not(.hidden) #invCostsView:not(.hidden)");
    assert.match(await desk.page.getAttribute('[data-desk-key="moreInvoicesBtn:costs"]', "class"), /active/);
    assert.equal(await desk.page.locator('[data-desk-area="team"]').getAttribute("aria-expanded"), "false");
    await desk.page.click('[data-desk-area="team"]');
    await desk.page.click('[data-desk-nav="approvals"]');
    await desk.page.waitForSelector("#approvalsScreen:not(.hidden)");
    assert.equal(await desk.page.locator("#invoicesScreen").isVisible(), false);
    assert.match(await desk.page.getAttribute('[data-desk-nav="approvals"]', "class"), /active/);
    await desk.page.click('[data-desk-area="kitchen"]');
    await desk.page.click('[data-desk-key="moreRecipesBtn"]');
    await desk.page.waitForSelector("#recipesScreen:not(.hidden)");
    await desk.page.waitForFunction(() => document.querySelector('#recipesTabs [data-rcp-tab="recipes"]')?.classList.contains("selected"));
    await desk.shot("desktop_recipes");
    await desk.page.click('[data-manager-nav="home"]');
    await desk.page.waitForSelector("#managerScreen:not(.hidden)");
    assert.equal(await desk.page.locator("[data-desk-key].active, [data-desk-nav].active").count(), 0);
    assert.match(await desk.page.innerText(".desk-foot"), /Test General Manager\s*Administrator/);
    assert.equal(await desk.page.locator("#managerLogoutBtn").isVisible(), false, "sign out lives in More");
    await desk.page.click(".desk-foot");
    await desk.page.waitForSelector("#managerMoreScreen:not(.hidden)");
    await desk.page.click("#moreSignOutBtn");
    await desk.page.waitForSelector("#loginScreen:not(.hidden)");
    assert.equal(await desk.page.evaluate(() => document.body.classList.contains("mgr-mode")), false);
    assert.deepEqual(desk.errors, []);
    return `4 numbers, 4 areas (2 x 2), attention + today; side menu ${nav.width}px with 4 areas`;
  });
  await desk.close();
  await check("Laptop/desktop: Floor Manager sees Allergens and no Invoices & Costs", async () => {
    const fd = await phone({ viewport: { width: 1440, height: 900 } });
    await fd.login(PIN[ID(3)]);
    await fd.page.waitForSelector("#deskAreas .desk-area-card");
    const areas = (await fd.page.locator("[data-desk-area]").allInnerTexts()).map((t) => t.replace(/[›\d]/g, "").trim());
    const cards = await fd.page.locator("#deskAreas h3").allInnerTexts();
    assert.deepEqual(areas, ["Team & Hours", "Stock & Orders", "Allergens"]);
    assert.ok(cards.includes("Allergens") && !cards.includes("Invoices & Costs"), cards.join(","));
    assert.match(await fd.page.innerText("#deskStats"), /Time off requests/);
    assert.match(await fd.page.innerText(".desk-foot"), /Floor Manager/);
    await fd.page.click('[data-desk-area="kitchen"]');
    await fd.page.click('[data-desk-key="moreRecipesBtn"]');
    await fd.page.waitForSelector("#recipesScreen:not(.hidden)");
    assert.deepEqual(fd.errors, []);
    await fd.close();
    return areas.join(", ");
  });
  // A phone never shows the extra links.
  await check("Phone: bottom bar keeps 4 buttons", async () => {
    const ph = await phone();
    await ph.login(PIN[ID(1)]);
    assert.equal(await ph.page.locator("#deskNavLinks").isVisible(), false);
    assert.equal(await ph.page.locator("#deskAreas").isVisible(), false);
    assert.equal(await ph.page.locator(".desk-foot").isVisible(), false);
    const visible = await ph.page.locator("#managerBottomNav [data-manager-nav]").evaluateAll((els) => els.filter((e) => e.offsetParent).length);
    assert.equal(visible, 4);
    await ph.close();
    return "4";
  });
} finally {
  await browser.close();
  server.close();
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL RECIPE BROWSER CHECKS PASSED");
process.exit(failures ? 1 : 0);
