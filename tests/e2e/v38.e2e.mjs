// Browser tests for v38: the real app (index.html) in an emulated iPhone 13,
// talking to the real Edge Function code, which talks to a throwaway PostgreSQL
// with the production structure, functions and privileges. Synthetic data only.
//
// Each stability fix is first shown on the CURRENT production frontend
// (index.html from main) and then on the new one.
//
// Run: node tests/e2e/v38.e2e.mjs        (E2E_BROWSER=webkit for Safari's engine)
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { startProdLikeDb, MIGRATION_A, MIGRATION_B, root } from "../integration/pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "../integration/edge-loader.mjs";
import { ID, PIN, reseed } from "../integration/seed.mjs";

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_PATH || "playwright");
const ENGINE = process.env.E2E_BROWSER === "webkit" ? "webkit" : "chromium";
const browserType = pw[ENGINE];
const launchOptions = ENGINE === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {};

const NEW_HTML = readFileSync(resolve(root, "index.html"));
// Production frontend today (index.html on main at 8dc5824), kept as a fixture.
const OLD_HTML = readFileSync(resolve(root, "tests/e2e/fixtures/index-production.html"));

let failures = 0;
const log = (...a) => console.log(...a);
// In GitHub Actions every result is also written as an annotation (readable without the raw log).
const gha = (level, title, msg) => {
  if (process.env.GITHUB_ACTIONS) console.log(`::${level} title=${title.replace(/[:,\n]/g, " ").slice(0, 120)}::${String(msg).replace(/\r?\n/g, " | ").slice(0, 900)}`);
};
async function check(name, fn) {
  try {
    const note = await fn();
    log(`  ✔ ${name}${note ? `\n      ${note}` : ""}`);
    gha("notice", name, note || "passed");
  } catch (e) {
    failures++;
    gha("error", name, e?.stack || e);
    log(`  ✖ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 6).join("\n      ")}`);
  }
}

// ---------------------------------------------------------------- environment
const quietConsole = { log: console.log };
let silence = 0;
const db = await startProdLikeDb({ poolSize: 10 });
db.psqlFile(MIGRATION_A); db.psqlFile(MIGRATION_B);
useDatabase(db.svc);
const h37 = await loadHandler(resolve(root, "tests/edge/baseline-v37.ts"));
const h38 = await loadHandler(resolve(root, "supabase/functions/marinara-api-v2/Index.ts"));

const server = await new Promise((ok) => {
  const s = createServer((req, res) => {
    const html = req.url.startsWith("/old/") ? OLD_HTML : NEW_HTML;
    if (req.url.endsWith("/index.html") || req.url.endsWith("/")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); }
    else { res.writeHead(404); res.end(); }
  });
  s.listen(0, "127.0.0.1", () => ok(s));
});
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const browser = await browserType.launch(launchOptions);

// One "phone": a browser context with its own storage, routed to a backend.
async function phone({ frontend = "new", backend = h38 } = {}) {
  const ctx = await browser.newContext({ ...pw.devices["iPhone 13"], serviceWorkers: "block", timezoneId: "Australia/Brisbane" });
  const page = await ctx.newPage();
  const errors = [];
  const requests = [];
  const net = { mode: null, backend };
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN)) return route.continue();
    if (!url.includes("/functions/v1/marinara-api-v2")) return route.abort();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: cors, body: "ok" });
    const body = JSON.parse(route.request().postData() || "{}");
    requests.push(body.action);
    if (net.mode === "offline") return route.abort("internetdisconnected");
    if (net.mode === "503") return route.fulfill({ status: 503, headers: cors, contentType: "text/plain", body: "Service Unavailable" });
    silence++;
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    try {
      const r = await call(net.backend, body);
      return route.fulfill({ status: r.status, headers: cors, contentType: "application/json", body: JSON.stringify(r.body) });
    } finally {
      if (--silence === 0) { console.log = quietConsole.log; console.warn = quietConsole.log; console.error = quietConsole.log; }
    }
  });
  await page.goto(`${ORIGIN}/${frontend === "old" ? "old" : "new"}/index.html`);
  await page.waitForTimeout(300);
  const visible = (sel) => page.locator(sel).first().isVisible().catch(() => false);
  const text = async (sel) => ((await page.locator(sel).first().textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim();
  const login = async (pin) => { await page.fill("#pinInput", pin); await page.click("#loginBtn"); await page.waitForTimeout(700); };
  return { ctx, page, errors, requests, net, visible, text, login, close: () => ctx.close() };
}

const count = (arr, a) => arr.filter((x) => x === a).length;
async function one(sql) { return (await db.admin.query(sql)).rows[0]?.[0] ?? null; }

try {
  log(`\nBrowser: ${ENGINE} (${ENGINE === "webkit" ? "Safari engine" : "Chromium"}) with iPhone 13 profile`);

  log("\n== Session restore after reload ==");
  await check("current app: reloading the page shows the PIN screen again although the session is valid", async () => {
    await reseed(db);
    const p = await phone({ frontend: "old" });
    await p.login(PIN[ID(4)]);
    assert.ok(await p.visible("#homeScreen"));
    await p.page.reload(); await p.page.waitForTimeout(900);
    const onLogin = await p.visible("#loginScreen"), onHome = await p.visible("#homeScreen");
    await p.close();
    assert.equal(onLogin, true); assert.equal(onHome, false);
    return "after reload: PIN screen (staff must sign in again; a new session is created each time)";
  });
  await check("new app: staff and manager stay signed in after a reload", async () => {
    await reseed(db);
    const s = await phone();
    await s.login(PIN[ID(4)]);
    await s.page.reload(); await s.page.waitForTimeout(900);
    const staffHome = await s.visible("#homeScreen"), staffLogin = await s.visible("#loginScreen");
    const m = await phone();
    await m.login(PIN[ID(1)]);
    await m.page.reload(); await m.page.waitForTimeout(1200);
    const mgrHome = await m.visible("#managerScreen");
    const errs = [...s.errors, ...m.errors];
    await s.close(); await m.close();
    assert.equal(staffHome, true); assert.equal(staffLogin, false); assert.equal(mgrHome, true); assert.deepEqual(errs, []);
    return "staff home and manager dashboard restored; no JavaScript errors";
  });

  log("\n== Double taps ==");
  await check("current app: a double tap on Clock In sends two requests", async () => {
    await reseed(db);
    const p = await phone({ frontend: "old", backend: h37 });
    await p.login(PIN[ID(4)]);
    await p.page.locator("#clockInBtn").dblclick();
    await p.page.waitForTimeout(800);
    const n = count(p.requests, "session_clock_in");
    const msg = await p.text("#actionMessage");
    await p.close();
    assert.equal(n, 2);
    return `2 requests; message shown: "${msg}"`;
  });
  await check("new app: double taps on Clock In and Start Break send ONE request each", async () => {
    await reseed(db);
    const p = await phone();
    await p.login(PIN[ID(4)]);
    await p.page.locator("#clockInBtn").dblclick();
    await p.page.waitForTimeout(800);
    await p.page.locator("#startBreakBtn").dblclick();
    await p.page.waitForTimeout(800);
    const a = count(p.requests, "session_clock_in"), b = count(p.requests, "session_start_break");
    const status = await p.text("#statusValue");
    const breaks = Number(await one(`select count(*) from public.breaks b join public.shifts s on s.id = b.shift_id where s.staff_id = '${ID(4)}' and b.break_end is null`));
    await p.close();
    assert.equal(a, 1); assert.equal(b, 1); assert.equal(breaks, 1);
    return `Clock In: ${a} request; Start Break: ${b} request; status "${status}"; 1 open break`;
  });

  log("\n== Error messages ==");
  const MSG_CASES = [
    { name: "wrong PIN", setup: () => {}, pin: "000000" },
    { name: "no internet", setup: (p) => { p.net.mode = "offline"; }, pin: PIN[ID(4)] },
    { name: "server unavailable (503)", setup: (p) => { p.net.mode = "503"; }, pin: PIN[ID(4)] },
  ];
  const seen = {};
  for (const [label, frontend, backend] of [["current app + v37", "old", h37], ["new app + v38", "new", h38]]) {
    await reseed(db);
    seen[label] = {};
    for (const c of MSG_CASES) {
      const p = await phone({ frontend, backend });
      c.setup(p);
      await p.login(c.pin);
      seen[label][c.name] = await p.text("#loginMessage");
      await p.close();
    }
  }
  await check("current app shows wrong or technical messages at sign-in", async () => {
    const s = seen["current app + v37"];
    assert.equal(s["wrong PIN"], "Unable to create secure session");
    assert.match(s["no internet"], /Failed to fetch|Load failed|NetworkError/);
    // 503 with a JSON body showed "PIN not recognised."; with a plain-text body (as here) a JSON parse error
    assert.match(s["server unavailable (503)"], /PIN not recognised|not valid JSON|JSON/);
    return JSON.stringify(s);
  });
  await check("new app shows the right message for each case", async () => {
    const s = seen["new app + v38"];
    assert.match(s["wrong PIN"], /^PIN not recognised\./);
    assert.match(s["no internet"], /offline|Can't reach the server/);
    assert.match(s["server unavailable (503)"], /server is busy/);
    return JSON.stringify(s);
  });
  await check("clock action during an outage: plain message, and it works again on retry", async () => {
    await reseed(db);
    const old = await phone({ frontend: "old", backend: h37 });
    await old.login(PIN[ID(4)]);
    old.net.mode = "503";
    await old.page.click("#clockInBtn"); await old.page.waitForTimeout(500);
    const oldMsg = await old.text("#actionMessage");
    await old.close();
    await reseed(db);
    const p = await phone();
    await p.login(PIN[ID(4)]);
    p.net.mode = "503";
    await p.page.click("#clockInBtn"); await p.page.waitForTimeout(500);
    const msg = await p.text("#actionMessage");
    p.net.mode = null;
    await p.page.click("#clockInBtn"); await p.page.waitForTimeout(700);
    const status = await p.text("#statusValue");
    await p.close();
    assert.match(msg, /server is busy/); assert.equal(status, "You are clocked in");
    return `current app: "${oldMsg}" → new app: "${msg}", retry: "${status}"`;
  });

  log("\n== Session ended elsewhere ==");
  await check("new app returns to the PIN screen with a message when the session is ended (device removed)", async () => {
    await reseed(db);
    const s = await phone();
    await s.login(PIN[ID(4)]);
    await db.admin.query(`update public.staff_sessions set revoked_at = now() where staff_id = '${ID(4)}'`);
    await s.page.waitForTimeout(6500); // background refresh runs every 5 s
    const onLogin = await s.visible("#loginScreen");
    const msg = await s.text("#loginMessage");
    await s.close();
    assert.equal(onLogin, true); assert.match(msg, /session has ended/);
    return `"${msg}"`;
  });

  log("\n== Authorised devices ==");
  await check("enforce mode: new phone sees the device-code prompt; manager makes a code; phone pairs and signs in", async () => {
    await reseed(db);
    const gm = await phone();
    await gm.login(PIN[ID(1)]);                                   // grace: GM's phone becomes authorised
    await db.admin.query("update public.auth_settings set device_mode = 'enforce'");
    const staff = await phone();
    const prompt = await staff.visible("#pairToggleBtn");
    const promptMsg = await staff.text("#loginMessage");
    await staff.login(PIN[ID(4)]);
    const refused = await staff.text("#loginMessage");
    await gm.page.click('[data-manager-nav="more"]'); await gm.page.waitForTimeout(300);
    await gm.page.click("#moreDevicesBtn"); await gm.page.waitForTimeout(700);
    await gm.page.click("#newDeviceCodeBtn"); await gm.page.waitForTimeout(700);
    const code = await gm.text("#deviceCodeBox strong");
    if (!(await staff.visible("#pairPanel"))) await staff.page.click("#pairToggleBtn");
    await staff.page.fill("#pairCodeInput", code);
    await staff.page.click("#pairBtn"); await staff.page.waitForTimeout(700);
    const paired = await staff.text("#loginMessage");
    await staff.login(PIN[ID(4)]);
    const home = await staff.visible("#homeScreen");
    const errs = [...gm.errors, ...staff.errors];
    await gm.close(); await staff.close();
    assert.equal(prompt, true); assert.match(promptMsg, /needs to be authorised/);
    assert.match(refused, /not authorised/); assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.match(paired, /authorised/); assert.equal(home, true); assert.deepEqual(errs, []);
    return `prompt shown; PIN refused before pairing ("${refused}"); code XXXX-XXXX; after pairing: signed in`;
  });
  await check("manager removes a device (two taps): its session ends and it must be paired again", async () => {
    const devices = Number(await one("select count(*) from public.auth_devices where status = 'approved'"));
    const gm = await phone();
    await db.admin.query("update public.auth_settings set device_mode = 'grace'");
    await gm.login(PIN[ID(1)]);
    const staff = await phone();
    await staff.login(PIN[ID(5)]);
    await gm.page.click('[data-manager-nav="more"]'); await gm.page.waitForTimeout(300);
    await gm.page.click("#moreDevicesBtn"); await gm.page.waitForTimeout(800);
    const rows = await gm.page.locator(".device-row").count();
    // remove the staff phone: the device last used by "Test Kitchen B"
    const row = gm.page.locator(".device-row", { hasText: "Test Kitchen B" }).first();
    await row.locator("[data-device-revoke]").click();
    await row.locator("[data-device-revoke]").click(); await gm.page.waitForTimeout(800);
    const msg = await gm.text("#devicesMessage");
    await staff.page.waitForTimeout(6500);
    const staffOnLogin = await staff.visible("#loginScreen");
    await gm.close(); await staff.close();
    assert.ok(rows >= 2, String(rows)); assert.match(msg, /Device removed\. 1 open session/); assert.equal(staffOnLogin, true);
    return `${rows} devices listed (${devices} before this test); "${msg}"; staff phone back to PIN screen`;
  });
  await check("team list flags people whose PIN is shared", async () => {
    await reseed(db);
    const s = await phone();
    await s.login("9110");
    const refused = await s.text("#loginMessage");
    const gm = await phone();
    await gm.login(PIN[ID(1)]);
    await gm.page.click('[data-manager-nav="team"]'); await gm.page.waitForTimeout(900);
    const flags = await gm.page.locator(".team-pin-conflict").count();
    await s.close(); await gm.close();
    assert.match(refused, /more than one person/); assert.equal(flags, 2);
    return `sign-in refused: "${refused}"; ${flags} people flagged in Team`;
  });

  log("\n== Compatibility (any publication order) ==");
  await check("current app (cached on a phone) + v38 backend: sign in, Clock In, Break, Clock Out", async () => {
    await reseed(db);
    const p = await phone({ frontend: "old", backend: h38 });
    await p.login(PIN[ID(4)]);
    const steps = [];
    for (const b of ["#clockInBtn", "#startBreakBtn", "#endBreakBtn", "#clockOutBtn"]) {
      await p.page.click(b); await p.page.waitForTimeout(600);
      steps.push(await p.text("#statusValue"));
    }
    const errs = p.errors; await p.close();
    assert.deepEqual(steps, ["You are clocked in", "You are on break", "You are clocked in", "Off shift"]); assert.deepEqual(errs, []);
    return steps.join(" → ");
  });
  await check("new app + v37 backend (if the app is published first): sign in, Clock In, Break, Clock Out, wrong PIN", async () => {
    await reseed(db);
    const p = await phone({ backend: h37 });
    await p.login("000000");
    const wrong = await p.text("#loginMessage");
    await p.login(PIN[ID(4)]);
    const steps = [];
    for (const b of ["#clockInBtn", "#startBreakBtn", "#endBreakBtn", "#clockOutBtn"]) {
      await p.page.click(b); await p.page.waitForTimeout(600);
      steps.push(await p.text("#statusValue"));
    }
    await p.page.reload(); await p.page.waitForTimeout(900);
    const restored = await p.visible("#homeScreen");
    const errs = p.errors; await p.close();
    assert.equal(wrong, "PIN not recognised."); assert.deepEqual(steps, ["You are clocked in", "You are on break", "You are clocked in", "Off shift"]);
    assert.equal(restored, true); assert.deepEqual(errs, []);
    return `wrong PIN: "${wrong}"; ${steps.join(" → ")}; reload restored`;
  });

  log("\n== iPhone layout ==");
  await check("no horizontal scrolling and no input that triggers iOS auto-zoom (font < 16 px) on the new screens", async () => {
    await reseed(db);
    const p = await phone();
    const report = {};
    const inspect = async (name) => {
      report[name] = await p.page.evaluate(() => {
        const overflow = document.scrollingElement.scrollWidth - window.innerWidth;
        const small = [...document.querySelectorAll("input, select, textarea")]
          .filter((el) => el.offsetParent !== null && parseFloat(getComputedStyle(el).fontSize) < 16)
          .map((el) => el.id || el.className);
        return { overflow, small };
      });
    };
    await p.page.click("#pairToggleBtn").catch(() => {});
    await p.page.evaluate(() => { document.getElementById("pairToggleBtn").classList.remove("hidden"); document.getElementById("pairPanel").classList.remove("hidden"); });
    await inspect("login + device code");
    await p.login(PIN[ID(1)]);
    await inspect("manager home");
    await p.page.click('[data-manager-nav="more"]'); await p.page.waitForTimeout(300);
    await p.page.click("#moreDevicesBtn"); await p.page.waitForTimeout(700);
    await p.page.click("#newDeviceCodeBtn"); await p.page.waitForTimeout(600);
    await inspect("devices");
    await p.close();
    for (const [k, v] of Object.entries(report)) { assert.ok(v.overflow <= 0, `${k} overflow ${v.overflow}px`); assert.deepEqual(v.small, [], `${k} small inputs`); }
    return JSON.stringify(report);
  });
} finally {
  await browser.close();
  server.close();
  db.stop();
}
log(failures ? `\n${failures} BROWSER CHECK(S) FAILED` : "\nALL BROWSER CHECKS PASSED");
process.exit(failures ? 1 : 0);
