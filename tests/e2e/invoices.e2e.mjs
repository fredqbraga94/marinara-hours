// Browser test for supplier invoices: the real app (index.html) in an emulated
// iPhone 13 reads made-up PDF invoices with the vendored pdf.js, then saves them
// through the real Edge Function code into a throwaway PostgreSQL with the
// production structure + the invoices migration. Synthetic data only.
// Run: node tests/e2e/invoices.e2e.mjs   (E2E_BROWSER=webkit for Safari's engine;
// SHOTS=<dir> also saves screenshots)
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { startProdLikeDb, MIGRATION_A, MIGRATION_B, root } from "../integration/pgenv.mjs";
import { loadHandler, useDatabase, call } from "../integration/edge-loader.mjs";
import { ID, PIN, reseed } from "../integration/seed.mjs";
import { mocoStylePdf, unknownPdf } from "./synthetic-invoice.mjs";

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_PATH || "playwright");
const ENGINE = process.env.E2E_BROWSER === "webkit" ? "webkit" : "chromium";
const SHOTS = process.env.SHOTS || "";
const HTML = readFileSync(resolve(root, "index.html"));
const STOCK = "supabase/migrations/20261021000000_stock_par.sql";
const RECIPES = "supabase/migrations/20261022000000_recipes.sql";
const INVOICES = "supabase/migrations/20261022030000_invoices.sql";
const COSTS = "supabase/migrations/20261022040000_ingredient_costs.sql";

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
for (const f of [STOCK, RECIPES, "supabase/migrations/20261022010000_recipes_kids_pasta.sql", "supabase/migrations/20261022020000_recipes_dairy_kinds.sql", INVOICES, COSTS]) { const r = db.psqlFile(f); if (!r.ok) throw new Error(r.stderr); } // reseed's cascade emptied them
const handler = await loadHandler(resolve(root, "supabase/functions/marinara-api-v2/Index.ts"));

const server = await new Promise((ok) => {
  const s = createServer((req, res) => {
    if (req.url.endsWith("/index.html") || req.url.endsWith("/")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(HTML); }
    else if (/^\/(stock-pdf|timesheet-pdf|roster-pdf|invoice-reader)\.js$|^\/vendor\/(pdfjs\/)?[\w.-]+\.m?js$/.test(req.url)) {
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



const today = new Intl.DateTimeFormat("en-GB", { timeZone: "Australia/Brisbane", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
const lines = (tomato) => [
  { code: "10001", brand: "TESTCO", desc: "TEST TOMATOES", unit: "RW", qty: 2.5, price: tomato, gst: false },
  { code: "10002", brand: "TESTCO", desc: "TEST NAPKINS", unit: "CTN", qty: 1, price: 30, gst: true },
];
const FILES = {
  good: { name: "test-5001.pdf", mimeType: "application/pdf", buffer: mocoStylePdf({ number: "T-5001", date: today, lines: lines(4.4) }) },
  wrong: { name: "test-5002.pdf", mimeType: "application/pdf", buffer: mocoStylePdf({ number: "T-5002", date: today, lines: lines(4.4), wrongTotal: true }) },
  unknown: { name: "letter.pdf", mimeType: "application/pdf", buffer: unknownPdf() },
  dearer: { name: "test-5003.pdf", mimeType: "application/pdf", buffer: mocoStylePdf({ number: "T-5003", date: today, lines: lines(5.5) }) },
};
const cards = (p) => p.page.locator("#invReview .inv-review").allInnerTexts();
const waitRead = (p, n) => p.page.waitForFunction((n) => {
  const c = [...document.querySelectorAll("#invReview .inv-review")];
  return c.length === n && !c.some((e) => /Reading…/.test(e.textContent));
}, n, { timeout: 30000 });
const waitList = (p) => p.page.waitForFunction(() => !/Loading/.test(document.getElementById("invList").textContent));

try {
  log(`\nBrowser: ${ENGINE} with iPhone 13 profile`);

  await check("Kitchen Manager sees Invoices; Floor Manager doesn't (home tile and More)", async () => {
    const fm = await phone();
    await fm.login(PIN[ID(3)]);
    assert.equal(await fm.page.locator("#invoicesCard").isVisible(), false);
    await fm.page.click('[data-manager-nav="more"]');
    await fm.page.waitForSelector("#managerMoreScreen:not(.hidden)");
    assert.equal(await fm.page.locator("#moreInvoicesBtn").isVisible(), false);
    await fm.close();
    const km = await phone();
    await km.login(PIN[ID(2)]);
    await km.page.waitForSelector("#invoicesCard:not(.hidden)");
    await km.page.click('[data-manager-nav="more"]');
    await km.page.waitForSelector("#managerMoreScreen:not(.hidden)");
    assert.equal(await km.page.locator("#moreInvoicesBtn").isVisible(), true);
    await km.page.click("#moreInvoicesBtn");
    await km.page.waitForSelector("#invoicesScreen:not(.hidden)");
    await waitList(km);
    assert.deepEqual(km.errors, []);
    await km.close();
    return "Floor Manager: hidden; Kitchen Manager: opens";
  });

  const gm = await phone();
  await gm.login(PIN[ID(1)]);

  await check("reads PDFs in the phone: adds up, doesn't add up, unknown supplier", async () => {
    await gm.page.waitForSelector("#invoicesCard:not(.hidden)");
    await gm.page.click("#invoicesCard");
    await gm.page.waitForSelector("#invoicesScreen:not(.hidden)");
    await waitList(gm);
    assert.match(await gm.page.textContent("#invSummary"), /No invoices in this period/);
    await gm.page.setInputFiles("#invFiles", [FILES.good, FILES.wrong, FILES.unknown]);
    await waitRead(gm, 3);
    const c = await cards(gm);
    await gm.shot("invoices_review");
    assert.match(c[0], /MOCO Food Services/); assert.match(c[0], /T-5001/); assert.match(c[0], /\$44\.00/); assert.match(c[0], /Adds up: 2 lines/);
    assert.match(c[1], /T-5002/); assert.match(c[1], /don't add up/);
    assert.match(c[2], /layout isn't known yet/);
    return "3 cards: ok / check / unknown";
  });

  await check("save one, discard the others; it shows in this week's list and totals", async () => {
    await gm.page.click('#invReview [data-inv-save="0"]');
    await gm.page.waitForSelector("#invMessage.ok");
    assert.match(await gm.page.textContent("#invMessage"), /Saved: MOCO Food Services #T-5001/);
    await gm.page.click('#invReview [data-inv-dismiss="2"]');
    await gm.page.click('#invReview [data-inv-dismiss="1"]');
    assert.equal((await cards(gm)).length, 1);
    await gm.page.waitForFunction(() => /T-5001/.test(document.getElementById("invList").textContent));
    const sum = await gm.page.textContent("#invSummary");
    assert.match(sum, /\$44\.00/); assert.match(sum, /MOCO Food Services/);
    return sum.replace(/\s+/g, " ").trim();
  });

  await check("the same invoice twice is refused", async () => {
    await gm.page.setInputFiles("#invFiles", [FILES.good]);
    await waitRead(gm, 2);
    await gm.page.click('#invReview [data-inv-save="1"]');
    await gm.page.waitForSelector("#invMessage.error");
    assert.match(await gm.page.textContent("#invMessage"), /already saved/);
    await gm.page.click('#invReview [data-inv-dismiss="1"]');
    return "409 shown";
  });

  await check("price changes: a dearer product on the next invoice", async () => {
    await gm.page.setInputFiles("#invFiles", [FILES.dearer]);
    await waitRead(gm, 2);
    await gm.page.click('#invReview [data-inv-save="1"]');
    await gm.page.waitForFunction(() => /T-5003/.test(document.getElementById("invList").textContent));
    await gm.page.click('[data-inv-tab="prices"]');
    await gm.page.waitForSelector("#invPrices .inv-price");
    const t = (await gm.page.textContent("#invPrices")).replace(/\s+/g, " ");
    await gm.shot("invoices_prices");
    assert.match(t, /TEST TOMATOES/); assert.match(t, /▲ 25%\+\$1\.10/); assert.match(t, /\$4\.40/); assert.match(t, /\$5\.50/);
    assert.doesNotMatch(t, /NAPKINS/);
    await gm.page.click('[data-inv-tab="list"]');
    await waitList(gm);
    return t.trim().slice(0, 120);
  });

  await check("weekly use: most bought products, per week, busiest week, filter and search", async () => {
    await gm.page.click('[data-inv-tab="usage"]');
    await gm.page.waitForSelector("#invUsage .inv-use");
    const sum = (await gm.page.innerText("#invUsageSummary")).replace(/\s+/g, " ");
    assert.match(sum, /1 Week of invoices/i); assert.match(sum, /2 Products/i); assert.match(sum, /\$84\.75/);
    const rows = await gm.page.locator("#invUsage .inv-use").allInnerTexts();
    assert.match(rows[0], /TEST NAPKINS/); assert.match(rows[0], /2\s*CTN/); assert.match(rows[0], /Busiest week 2 CTN/);
    assert.match(rows[1], /TEST TOMATOES/); assert.match(rows[1], /5\s*kg/); assert.match(rows[1], /last price \$5\.50\/kg/);
    assert.equal(await gm.page.locator("#invUsageSuppliers button").count(), 0, "one supplier: no filter chips");
    await gm.page.fill("#invUsageSearch", "tomat");
    assert.equal(await gm.page.locator("#invUsage .inv-use").count(), 1);
    await gm.shot("invoices_usage");
    await gm.page.fill("#invUsageSearch", "");
    await gm.page.click('[data-inv-weeks="4"]');
    await gm.page.waitForFunction(() => document.querySelectorAll("#invUsage .inv-use").length === 2);
    await gm.page.click('[data-inv-tab="list"]');
    await waitList(gm);
    return sum.slice(0, 90);
  });

  await check("costs: link an ingredient to an invoice product and see its price per kg", async () => {
    await gm.page.click('[data-inv-tab="costs"]');
    await gm.page.waitForSelector("#invCosts .inv-cost");
    const sum = (await gm.page.innerText("#invCostsSummary")).replace(/\s+/g, " ");
    assert.match(sum, /0 Linked/i); assert.match(sum, /2 Products in invoices/i);
    await gm.page.fill("#invCostsSearch", "tomato");
    const head = gm.page.locator(".inv-cost-head", { hasText: /^Tomato\s*Link/ });
    await head.first().click();
    await gm.page.waitForSelector(".inv-cost-edit .inv-prod");
    const sugg = await gm.page.locator(".inv-cost-edit .inv-prod").allInnerTexts();
    assert.match(sugg[0], /TEST TOMATOES/); assert.doesNotMatch(sugg.join(" "), /NAPKINS/);
    await gm.page.locator(".inv-cost-edit .inv-prod").first().click();
    await gm.page.waitForSelector("#invCostResult");
    assert.equal(await gm.page.textContent("#invCostResult"), "= $5.50 per kg");
    // A carton of 2 x 5 kg would be $0.55 per kg (live, before saving)
    await gm.page.fill('[data-inv-pack="count"]', "2");
    await gm.page.fill('[data-inv-pack="size"]', "5");
    assert.equal(await gm.page.textContent("#invCostResult"), "= $0.55 per kg");
    await gm.page.fill('[data-inv-pack="count"]', "1");
    await gm.page.fill('[data-inv-pack="size"]', "1");
    await gm.shot("invoices_costs_edit");
    await gm.page.click("[data-inv-cost-save]");
    await gm.page.waitForSelector("#invMessage.ok");
    assert.match(await gm.page.textContent("#invMessage"), /linked/);
    await gm.page.click('[data-inv-costs-filter="done"]');
    await gm.page.fill("#invCostsSearch", "");
    const linked = await gm.page.locator("#invCosts .inv-cost").allInnerTexts();
    await gm.shot("invoices_costs_linked");
    assert.equal(linked.length, 1);
    assert.match(linked[0], /Tomato/); assert.match(linked[0], /\$5\.50\/kg/); assert.match(linked[0], /TEST TOMATOES/);
    await gm.page.click('[data-inv-tab="list"]');
    await waitList(gm);
    return linked[0].replace(/\s+/g, " ");
  });

  await check("open an invoice to see its lines; remove needs two taps", async () => {
    const head = gm.page.locator(".inv-head", { hasText: "T-5001" });
    await head.click();
    await gm.page.waitForFunction(() => /TEST NAPKINS/.test(document.getElementById("invList").textContent));
    const lines = await gm.page.locator(".inv-lines").first().innerText();
    await gm.shot("invoices_open");
    assert.match(lines, /TEST TOMATOES/); assert.match(lines, /2\.5 kg × \$4\.40/);
    const rm = gm.page.locator("[data-inv-remove]").first();
    await rm.click();
    assert.equal(await rm.textContent(), "Tap again to remove");
    await rm.click();
    await gm.page.waitForFunction(() => !/T-5001/.test(document.getElementById("invList").textContent));
    assert.match(await gm.page.textContent("#invSummary"), /\$46\.75/);
    return "removed; total updated";
  });

  await check("back to More, then Home; no page errors", async () => {
    await gm.page.click("#backInvoicesBtn");
    await gm.page.waitForSelector("#managerMoreScreen:not(.hidden)");
    await gm.page.click("#moreInvoicesBtn");
    await gm.page.waitForSelector("#invoicesScreen:not(.hidden)");
    await gm.page.click('[data-manager-nav="home"]');
    await gm.page.waitForSelector("#managerScreen:not(.hidden)");
    assert.equal(await gm.page.locator("#invoicesScreen").isVisible(), false);
    assert.deepEqual(gm.errors, []);
    return "ok";
  });
  await gm.close();
} finally {
  await browser.close();
  server.close();
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL INVOICE BROWSER CHECKS PASSED");
process.exit(failures ? 1 : 0);
