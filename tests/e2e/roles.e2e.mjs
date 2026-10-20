// Browser test for roster roles, roster-only people and the roster PDF (and stock par level helpers): the real app (index.html) in an emulated
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
  STOCK, "supabase/migrations/20261021010000_roster_roles.sql"]) { const r = db.psqlFile(f); if (!r.ok) throw new Error(`${f}: ${r.stderr}`); }
useDatabase(db.svc);
await reseed(db);
{ const r = db.psqlFile(STOCK); if (!r.ok) throw new Error(r.stderr); } // reseed's cascade emptied it
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

try {
  log(`\nBrowser: ${ENGINE} with iPhone 13 profile`);
  const gm = await phone();
  await gm.login(PIN[ID(1)]);
  const openTeam = async () => {
    await gm.page.click("#teamCard");
    await gm.page.waitForSelector("#teamScreen:not(.hidden) .team-person-row");
  };

  await check("Team: add a roster-only Chef (no PIN field)", async () => {
    await openTeam();
    await gm.page.click("#showAddStaffBtn");
    await gm.page.fill("#newStaffName", "Test Salary Chef");
    await gm.page.selectOption("#newStaffDepartment", "Kitchen");
    await gm.page.selectOption("#newStaffPosition", "Chef");
    await gm.page.check("#newStaffRosterOnly");
    const pinHidden = await gm.page.locator("#newStaffPinWrap").evaluate((e) => e.classList.contains("hidden"));
    await gm.shot("team_add_roster_only");
    await gm.page.click("#addStaffBtn");
    await gm.page.locator(".team-person-row", { hasText: "Test Salary Chef" }).waitFor();
    const row = gm.page.locator(".team-person-row", { hasText: "Test Salary Chef" });
    const meta = (await row.textContent()).replace(/\s+/g, " ");
    const dbRow = await db.admin.query("select department, position, roster_only from public.staff where name = 'Test Salary Chef'").then((r) => r.rows[0]);
    assert.equal(pinHidden, true); assert.deepEqual(dbRow, ["Kitchen", "Chef", "t"]);
    assert.match(meta, /Chef/); assert.match(meta, /Roster only/);
    return meta.trim().slice(0, 90);
  });

  await check("Team → Edit: set Dishwasher and Chef roles", async () => {
    for (const [name, role] of [["Test Kitchen B", "Dishwasher"], ["Test Kitchen A", "Chef"], ["Test Racer", "Dishwasher"]]) {
      await gm.page.locator(".team-person-row", { hasText: name }).locator(".team-edit-btn").click();
      const panel = gm.page.locator(`.team-edit-panel:not(.hidden)`);
      await panel.locator(".team-edit-position").selectOption(role);
      await panel.locator(".team-save-edit-btn").click();
      await gm.page.locator(".team-person-row", { hasText: name }).filter({ hasText: role }).waitFor();
    }
    const rows = await db.admin.query("select name, position from public.staff where position is not null order by name").then((r) => r.rows.map((x) => x.join(":")));
    return rows.join(", ");
  });

  await check("Roster (Kitchen): chefs on top, dishwashers last, roster-only tag", async () => {
    await gm.page.click('[data-manager-nav="home"]');
    await gm.page.waitForSelector("#managerScreen:not(.hidden)");
    await gm.page.click("#rosterCard");
    await gm.page.waitForSelector("#rosterGridBox .roster-grid");
    const kitchen = gm.page.locator('[data-roster-dept="Kitchen"]');
    if (await kitchen.count()) await kitchen.click();
    await gm.page.waitForSelector(".roster-role-row");
    const order = await gm.page.$$eval("#rosterGridBox tbody tr", (trs) => trs.map((tr) =>
      tr.classList.contains("roster-role-row") ? `[${tr.textContent.trim()}]` : tr.querySelector(".roster-name")?.firstChild?.textContent?.trim() || tr.querySelector(".roster-name")?.textContent.trim()));
    const tag = await gm.page.locator(".roster-name", { hasText: "Test Salary Chef" }).locator(".roster-only-tag").count();
    await gm.shot("roster_roles");
    const i = (s) => order.findIndex((x) => x && x.includes(s));
    assert.ok(i("[Chef]") < i("Test Kitchen A") && i("Test Kitchen A") < i("[Dishwasher]") && i("[Dishwasher]") < i("Test Kitchen B"), order.join(" | "));
    assert.equal(tag, 1);
    return order.join(" | ");
  });

  await check("Roster: Export PDF of the week (Kitchen)", async () => {
    // put a few cells in so the PDF has content
    const week = await gm.page.evaluate(() => rosterState.week);
    for (const [name, code, day] of [["Test Kitchen A", "LD", 0], ["Test Kitchen B", "L", 0], ["Test Salary Chef", "D", 1]]) {
      const id = await db.admin.query(`select id from public.staff where name = '${name}'`).then((r) => r.rows[0][0]);
      const d = await gm.page.evaluate(([w, n]) => rosterAddDays(w, n), [week, day]);
      await gm.page.evaluate(async ([sid, wd, c]) => managerApi("manager_roster_set", { staff_id: sid, work_date: wd, code: c }), [id, d, code]);
    }
    await gm.page.evaluate(async (w) => loadRoster(w), week);
    await gm.page.click("#rosterPdfBtn");
    await gm.page.waitForSelector("#rosterPdfDialog[open]");
    const b64 = await gm.page.evaluate(async () => {
      const blob = window.MarinaraRosterPdf.generate(rosterPdfReport());
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = ""; for (const x of buf) s += String.fromCharCode(x); return btoa(s);
    });
    const pdf = Buffer.from(b64, "base64");
    if (SHOTS) (await import("node:fs")).writeFileSync(`${SHOTS}/roster.pdf`, pdf);
    await gm.page.click("#closeRosterPdf");
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-"); assert.ok(pdf.length > 3000);
    assert.deepEqual(gm.errors, []);
    return `PDF ${pdf.length} bytes`;
  });

  await check("Staff Hours and timesheets do not list the roster-only person", async () => {
    await gm.page.click('[data-manager-nav="home"]');
    await gm.page.click("#staffHoursCard");
    await gm.page.waitForTimeout(800);
    const text = await gm.page.textContent("body");
    assert.ok(!/Test Salary Chef/.test(await gm.page.locator("#staffHoursScreen").textContent()), "not in Staff Hours");
    assert.deepEqual(gm.errors, []);
    return "not in Staff Hours";
  });
  await gm.close();
} finally {
  await browser.close();
  server.close();
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL ROLE BROWSER CHECKS PASSED");
process.exit(failures ? 1 : 0);
