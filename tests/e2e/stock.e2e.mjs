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
  STOCK]) { const r = db.psqlFile(f); if (!r.ok) throw new Error(`${f}: ${r.stderr}`); }
useDatabase(db.svc);
await reseed(db);
{ const r = db.psqlFile(STOCK); if (!r.ok) throw new Error(r.stderr); } // reseed's cascade emptied it
const handler = await loadHandler(resolve(root, "supabase/functions/marinara-api-v2/Index.ts"));

const server = await new Promise((ok) => {
  const s = createServer((req, res) => {
    if (req.url.endsWith("/index.html") || req.url.endsWith("/")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(HTML); }
    else if (/^\/(stock-pdf|timesheet-pdf)\.js$|^\/vendor\/[\w.-]+\.js$/.test(req.url)) {
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
    assert.equal(rows, 232); assert.equal(deptHidden, true); assert.match(place, /Floor \/ Bar/);
    assert.equal(fc, "Par 16 bot · box of 12");
    return `${place}; 232 rows; "${fc}"; no Floor/Kitchen switch`;
  });

  await check("count: live 'order' hint per item, bar counted apart, progress line", async () => {
    await fm.row("Fantini Chardonnay").locator('[data-stock-qty="qty"]').fill("5");
    // 1 full box of 12 + 8 loose bottles = 20 = par
    await fm.row("Ten Rocks").locator('[data-stock-qty="qty_box"]').fill("1");
    await fm.row("Ten Rocks").locator('[data-stock-qty="qty"]').fill("8");
    await fm.row("Torre Mora Etna Bianco").locator('[data-stock-qty="qty"]').fill("2");
    await fm.row("Torre Mora Etna Bianco").locator('[data-stock-qty="qty_extra"]').fill("1");
    await fm.row("S. Pellegrino").locator('[data-stock-qty="qty"]').fill("3");
    const need = async (n) => (await fm.row(n).locator(".stock-need").textContent()).trim();
    const got = [await need("Fantini Chardonnay"), await need("Ten Rocks"), await need("Torre Mora Etna Bianco"), await need("S. Pellegrino"), await need("Moscato")];
    const progress = await fm.page.textContent("#stockProgress");
    await fm.row("Fantini Chardonnay").scrollIntoViewIfNeeded();
    await fm.shot("stock_count_filled");
    if (SHOTS) {
      await fm.row("Ten Rocks").screenshot({ path: `${SHOTS}/row_box.png` });
      await fm.row("Torre Mora Etna Bianco").screenshot({ path: `${SHOTS}/row_reserve.png` });
      await fm.row("S. Pellegrino").screenshot({ path: `${SHOTS}/row_soft.png` });
    }
    assert.deepEqual(got, ["Order 1 box (12)", "At par · nothing to order", "Order 4 bot", "Order 4", ""]);
    assert.equal(progress, "4 of 232 counted · 3 to order");
    return got.join(" | ") + " | " + progress;
  });

  await check("group chips: show one group at a time, with counted / total", async () => {
    await fm.page.click('#stockGroupChips [data-stock-group="Spirits"], #stockGroupChips [data-stock-group="Gin"]');
    const groups = await fm.page.$$eval("#stockCountList .stock-group-title", (e) => e.map((x) => x.textContent));
    const rows = await fm.page.locator(".stock-row").count();
    const white = (await fm.page.locator('#stockGroupChips [data-stock-group="White"]').textContent()).trim();
    if (SHOTS) await fm.page.screenshot({ path: `${SHOTS}/stock_chips.png` });
    await fm.page.click('#stockGroupChips [data-stock-group=""]');
    const all = await fm.page.locator(".stock-row").count();
    assert.deepEqual(groups, ["Gin"]); assert.equal(rows, 4); assert.equal(white, "White2/13"); assert.equal(all, 232);
    return `Gin only: ${rows} rows; chip "${white}"; All: ${all}`;
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
    const tr = await db.admin.query("select l->>'qty' from public.stock_counts, jsonb_array_elements(lines) l where l->>'name' = 'Ten Rocks'").then((r) => r.rows[0][0]);
    assert.equal(Number(tr), 20, "1 box + 8 bottles saved as 20");
    await fm.page.click('[data-stock-tab="count"]');
    const v = await fm.row("Fantini Chardonnay").locator('[data-stock-qty="qty"]').inputValue();
    assert.equal(v, "");
    return blocks.join(" // ");
  });

  await check("Export PDF: order list by supplier, made on the phone", async () => {
    await fm.page.click('[data-stock-tab="order"]');
    await fm.page.click("#stockPdfBtn");
    await fm.page.waitForSelector("#stockPdfDialog[open]");
    const b64 = await fm.page.evaluate(async () => {
      const blob = window.MarinaraStockPdf.generate(stockPdfReport());
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = ""; for (const x of buf) s += String.fromCharCode(x); return btoa(s);
    });
    const pdf = Buffer.from(b64, "base64");
    if (SHOTS) (await import("node:fs")).writeFileSync(`${SHOTS}/stock_order.pdf`, pdf);
    await fm.page.click("#closeStockPdf");
    await fm.page.click('[data-stock-tab="count"]');
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(pdf.length > 3000, String(pdf.length));
    assert.deepEqual(fm.errors, []);
    return `PDF ${pdf.length} bytes; share dialog shown and closed`;
  });

  await check("open list: saved items show as 'Saved'; a second save adds to the order; Start new count clears it", async () => {
    const savedHint = (await fm.row("Fantini Chardonnay").locator(".stock-need").textContent()).trim();
    const ph = await fm.row("Fantini Chardonnay").locator('[data-stock-qty="qty"]').getAttribute("placeholder");
    await fm.row("Moscato").locator('[data-stock-qty="qty"]').fill("4");
    await fm.page.click("#stockSaveBtn");
    await fm.page.waitForFunction(() => /Moscato/.test(document.getElementById("stockOrderList").textContent));
    const text = await fm.page.textContent("#stockOrderList");
    await fm.shot("stock_order_open");
    assert.ok(/Fantini Chardonnay/.test(text) && /Moscato/.test(text) && /S\. Pellegrino/.test(text), text);
    assert.equal(Number(await db.admin.query("select count(*) from public.stock_counts").then((r) => r.rows[0][0])), 1);
    await fm.page.click("[data-stock-close]");
    await fm.page.waitForFunction(() => /New count started/.test(document.getElementById("stockMessage").textContent));
    const hintAfter = (await fm.row("Fantini Chardonnay").locator(".stock-need").textContent()).trim();
    await fm.page.click('[data-stock-tab="order"]');
    const after = await fm.page.textContent("#stockOrderList");
    await fm.page.click('[data-stock-tab="count"]');
    assert.equal(savedHint, "Saved · order 1 box (12)"); assert.equal(ph, "5"); assert.equal(hintAfter, "");
    assert.match(after, /Closed list/);
    return `before: "${savedHint}" (placeholder ${ph}); after 2nd save Moscato added to the same list; Start new count → "${after.trim().slice(0, 40)}…"`;
  });

  await check("edit list: add an item, change a par, set a supplier minimum", async () => {
    await fm.page.click('[data-stock-tab="edit"]');
    await fm.page.click("#stockAddBtn");
    await fm.page.fill("#stockFName", "Test Spritz Mix");
    await fm.page.fill("#stockFGroup", "Spirits");
    await fm.page.fill("#stockFPar", "2");
    await fm.shot("stock_edit_new");
    await fm.page.click("#stockFSave");
    // Wait for the list to reload (the message comes after it), not just the form closing.
    await fm.page.waitForFunction(() => /Saved: Test Spritz Mix/.test(document.getElementById("stockMessage").textContent));
    await fm.page.locator(".stock-edit-row", { hasText: "Fantini Chardonnay" }).locator("[data-stock-edit]").click();
    assert.equal(await fm.page.inputValue("#stockFCase"), "12");
    assert.equal(await fm.page.locator('#stockFOrderBy [data-order-by="box"]').evaluate((e) => e.classList.contains("selected")), true);
    await fm.page.fill("#stockFPar", "24");
    await fm.page.click("#stockFSave");
    await fm.page.waitForFunction(() => /Saved: Fantini Chardonnay/.test(document.getElementById("stockMessage").textContent));
    await fm.page.fill('[data-stock-min="RiverCity"]', "5");
    await fm.page.click('[data-stock-min-save="RiverCity"]');
    await fm.page.waitForFunction(() => /RiverCity: minimum 5/.test(document.getElementById("stockMessage").textContent));
    await fm.shot("stock_edit_list");
    const par = await db.admin.query("select par from public.stock_items where name = 'Fantini Chardonnay'").then((r) => r.rows[0][0]);
    const ap = await db.admin.query("select group_name, department from public.stock_items where name = 'Test Spritz Mix'").then((r) => r.rows[0]);
    const min = await db.admin.query("select min_order from public.stock_suppliers where name = 'RiverCity'").then((r) => r.rows[0][0]);
    assert.equal(String(par), "24.0"); assert.deepEqual(ap, ["Spirits", "Floor"]); assert.equal(String(min), "5");
    return "Test Spritz Mix added to Spirits; Fantini Chardonnay par 24; RiverCity minimum 5";
  });

  await check("rename a supplier from the Suppliers card", async () => {
    await fm.page.click('[data-stock-rename="Woolies (app)"]');
    await fm.page.fill("[data-stock-rename-input]", "Woolworths");
    await fm.shot("stock_rename");
    await fm.page.click('[data-stock-rename-save="Woolies (app)"]');
    await fm.page.waitForFunction(() => /is now Woolworths/.test(document.getElementById("stockMessage").textContent));
    const msg = (await fm.page.textContent("#stockMessage")).trim();
    const n = Number(await db.admin.query("select count(*) from public.stock_items where supplier = 'Woolworths'").then((r) => r.rows[0][0]));
    assert.equal(n, 32); assert.deepEqual(fm.errors, []);
    return msg;
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
    assert.equal(rowsFloor, 233); assert.equal(rowsKitchen, 0); assert.deepEqual(errs, []);
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
