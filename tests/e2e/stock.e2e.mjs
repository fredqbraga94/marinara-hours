// Browser test for stock par level: the real app (index.html) in an emulated
// iPhone 13, talking to the real Edge Function code and a throwaway PostgreSQL
// with the production structure + the stock migration. Synthetic staff only.
// Run: node tests/e2e/stock.e2e.mjs   (E2E_BROWSER=webkit for Safari's engine;
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

let failures = 0;
const log = (...a) => console.log(...a);
async function check(name, fn) {
  try {
    const note = await fn();
    log(`  ✔ ${name}${note ? `\n      ${note}` : ""}`);
  } catch (e) {
    failures++;
    log(`  ✖ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 6).join("\n      ")}`);
  }
}

const db = await startProdLikeDb({ poolSize: 10 });
for (const f of [MIGRATION_A, MIGRATION_B,
  "supabase/migrations/20261020000000_student_visa.sql",
  "supabase/migrations/20261020010000_roster.sql",
  "supabase/migrations/20261020020000_leave.sql",
  "supabase/migrations/20261020030000_public_holidays.sql",
  STOCK]) { const r = db.psqlFile(f); if (!r.ok) throw new Error(`${f}: ${r.stderr}`); }
useDatabase(db.svc);
await reseed(db);
{ const r = db.psqlFile(STOCK); if (!r.ok) throw new Error(r.stderr); } // reseed's cascade emptied it
const handler = await loadHandler(resolve(root, "supabase/functions/marinara-api-v2/Index.ts"));

const server = await new Promise((ok) => {
  const s = createServer((req, res) => {
    if (req.url.endsWith("/index.html") || req.url.endsWith("/")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(HTML); }
    else { res.writeHead(404); res.end(); }
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

try {
  log(`\nBrowser: ${ENGINE} with iPhone 13 profile`);
  const fm = await phone();

  await check("floor manager: Stock opens on the Floor/Bar list with the par of each item", async () => {
    await fm.login(PIN[ID(3)]);
    await fm.openStock();
    const place = await fm.page.textContent("#stockPlace");
    const rows = await fm.page.locator(".stock-row").count();
    const deptHidden = await fm.page.locator("#stockDept").evaluate((e) => e.classList.contains("hidden"));
    const fc = await fm.row("Fantini Chardonnay").locator("small").textContent();
    await fm.shot("stock_count_empty");
    assert.equal(rows, 61); assert.equal(deptHidden, true); assert.match(place, /Floor \/ Bar/);
    assert.equal(fc, "Par 16 bot · box of 12");
    return `${place}; 61 rows; "${fc}"; no Floor/Kitchen switch`;
  });

  await check("count: live 'order' hint per item, bar counted apart, progress line", async () => {
    await fm.row("Fantini Chardonnay").locator('[data-stock-qty="qty"]').fill("5");
    await fm.row("Ten Rocks").locator('[data-stock-qty="qty"]').fill("20");
    await fm.row("Torre Mora Etna Bianco").locator('[data-stock-qty="qty"]').fill("2");
    await fm.row("Torre Mora Etna Bianco").locator('[data-stock-qty="qty_extra"]').fill("1");
    await fm.row("S. Pellegrino").locator('[data-stock-qty="qty"]').fill("3");
    const need = async (n) => (await fm.row(n).locator(".stock-need").textContent()).trim();
    const got = [await need("Fantini Chardonnay"), await need("Ten Rocks"), await need("Torre Mora Etna Bianco"), await need("S. Pellegrino"), await need("Moscato")];
    const progress = await fm.page.textContent("#stockProgress");
    await fm.row("Fantini Chardonnay").scrollIntoViewIfNeeded();
    await fm.shot("stock_count_filled");
    assert.deepEqual(got, ["Order 1 box (12)", "At par · nothing to order", "Order 4 bot", "Order 4", ""]);
    assert.equal(progress, "4 of 61 counted · 3 to order");
    return got.join(" | ") + " | " + progress;
  });

  await check("count in progress survives closing the app (kept on the phone)", async () => {
    await fm.page.reload();
    await fm.page.waitForSelector("#managerScreen:not(.hidden)");
    await fm.openStock();
    const v = await fm.row("Fantini Chardonnay").locator('[data-stock-qty="qty"]').inputValue();
    assert.equal(v, "5");
    return "Fantini Chardonnay still 5 after reload";
  });

  await check("save: order list by supplier, minimum order warning, count cleared", async () => {
    await fm.page.click("#stockSaveBtn");
    await fm.page.waitForSelector("#stockOrderView:not(.hidden) .stock-supplier");
    const blocks = await fm.page.$$eval(".stock-supplier", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
    await fm.shot("stock_order");
    assert.ok(blocks.some((b) => b.startsWith("Tom San Pellegrino (SMS)") && b.includes("S. Pellegrino 4") && b.includes("Below the minimum order of 9 (now 4)")), blocks.join(" // "));
    assert.ok(blocks.some((b) => b.startsWith("No supplier set") && b.includes("Fantini Chardonnay 1 box (12)") && b.includes("Torre Mora Etna Bianco 4 bot")), blocks.join(" // "));
    assert.equal(Number(await db.admin.query("select count(*) from public.stock_counts").then((r) => r.rows[0][0])), 1);
    await fm.page.click('[data-stock-tab="count"]');
    const v = await fm.row("Fantini Chardonnay").locator('[data-stock-qty="qty"]').inputValue();
    assert.equal(v, "");
    return blocks.join(" // ");
  });

  await check("edit list: add an item, change a par, set a supplier minimum", async () => {
    await fm.page.click('[data-stock-tab="edit"]');
    await fm.page.click("#stockAddBtn");
    await fm.page.fill("#stockFName", "Aperol");
    await fm.page.fill("#stockFGroup", "Spirits");
    await fm.page.fill("#stockFPar", "2");
    await fm.shot("stock_edit_new");
    await fm.page.click("#stockFSave");
    await fm.page.waitForSelector("#stockFormCard.hidden", { state: "attached" });
    await fm.page.locator(".stock-edit-row", { hasText: "Fantini Chardonnay" }).locator("[data-stock-edit]").click();
    assert.equal(await fm.page.inputValue("#stockFCase"), "12");
    assert.equal(await fm.page.locator('#stockFOrderBy [data-order-by="box"]').evaluate((e) => e.classList.contains("selected")), true);
    await fm.page.fill("#stockFPar", "24");
    await fm.page.click("#stockFSave");
    await fm.page.waitForSelector("#stockFormCard.hidden", { state: "attached" });
    await fm.page.fill('[data-stock-min="RiverCity"]', "5");
    await fm.page.click('[data-stock-min-save="RiverCity"]');
    await fm.page.waitForFunction(() => /RiverCity: minimum 5/.test(document.getElementById("stockMessage").textContent));
    await fm.shot("stock_edit_list");
    const par = await db.admin.query("select par from public.stock_items where name = 'Fantini Chardonnay'").then((r) => r.rows[0][0]);
    const ap = await db.admin.query("select group_name, department from public.stock_items where name = 'Aperol'").then((r) => r.rows[0]);
    const min = await db.admin.query("select min_order from public.stock_suppliers where name = 'RiverCity'").then((r) => r.rows[0][0]);
    assert.equal(String(par), "24.0"); assert.deepEqual(ap, ["Spirits", "Floor"]); assert.equal(String(min), "5");
    return "Aperol added to Spirits; Fantini Chardonnay par 24; RiverCity minimum 5";
  });

  await check("move an item up inside its group", async () => {
    const before = await fm.page.$$eval(".stock-edit-row strong", (e) => e.map((x) => x.textContent));
    const i = before.indexOf("Moscato");
    await fm.page.locator(".stock-edit-row", { hasText: "Moscato" }).locator('[data-stock-move="-1"]').click();
    await fm.page.waitForFunction((n) => [...document.querySelectorAll(".stock-edit-row strong")].map((x) => x.textContent).indexOf("Moscato") === n, i - 1);
    return `Moscato moved from position ${i + 1} to ${i}`;
  });

  await check("kitchen manager: own Kitchen list (empty), no Floor items, no switch", async () => {
    const km = await phone();
    await km.login(PIN[ID(2)]);
    await km.openStock();
    const place = await km.page.textContent("#stockPlace");
    const empty = await km.page.textContent("#stockCountList");
    const deptHidden = await km.page.locator("#stockDept").evaluate((e) => e.classList.contains("hidden"));
    const errs = km.errors;
    await km.close();
    assert.match(place, /Kitchen/); assert.match(empty, /No items yet/); assert.equal(deptHidden, true); assert.deepEqual(errs, []);
    return `${place}: "${empty.trim()}"`;
  });

  await check("administrator: can switch between Floor/Bar and Kitchen", async () => {
    const gm = await phone();
    await gm.login(PIN[ID(1)]);
    await gm.openStock();
    const rowsFloor = await gm.page.locator(".stock-row").count();
    await gm.page.click('[data-stock-dept="Kitchen"]');
    await gm.page.waitForFunction(() => /Kitchen/.test(document.getElementById("stockPlace").textContent));
    const rowsKitchen = await gm.page.locator(".stock-row").count();
    await gm.page.click('[data-stock-dept="Floor"]');
    await gm.page.waitForFunction(() => /Floor/.test(document.getElementById("stockPlace").textContent));
    await gm.shot("stock_admin");
    const errs = gm.errors;
    await gm.close();
    assert.equal(rowsFloor, 62); assert.equal(rowsKitchen, 0); assert.deepEqual(errs, []);
    return `Floor ${rowsFloor} items, Kitchen ${rowsKitchen}`;
  });

  await check("leaving Stock with the bottom bar shows the other screen; no JavaScript errors", async () => {
    await fm.page.click('[data-manager-nav="home"]');
    await fm.page.waitForTimeout(400);
    const stockHidden = await fm.page.locator("#stockScreen").evaluate((e) => e.classList.contains("hidden"));
    const homeShown = await fm.page.locator("#managerScreen").evaluate((e) => !e.classList.contains("hidden"));
    assert.equal(stockHidden, true); assert.equal(homeShown, true); assert.deepEqual(fm.errors, []);
    return "home shown, stock hidden";
  });
  await fm.close();
} finally {
  await browser.close();
  server.close();
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL STOCK BROWSER CHECKS PASSED");
process.exit(failures ? 1 : 0);
