// End-to-end compatibility: the CURRENT app (index.html from this branch, unchanged)
// in an emulated iPhone, talking to the Edge Function code running in-process on a
// synthetic database. Every scenario runs against production v36 and against the
// observe-only version; what the user sees and what is stored must be identical.
// No network: the Supabase URL is intercepted; everything else is blocked.
//
// Run: node tests/e2e/login-clock.e2e.mjs   (needs Playwright + Chromium)
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadApi, seed, sessionFor, installEdgeRuntime } from "../edge/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const require = createRequire(import.meta.url);
const { chromium, devices } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const CHROME = process.env.CHROME_PATH || chromium.executablePath();

// Realistic time-clock functions (mirror tests/db/schema_snapshot.sql).
function realisticClock(db) {
  const T = db.tables;
  const open = (id) => T.shifts.filter((s) => s.staff_id === id && ["working", "break"].includes(s.status)).sort((a, b) => b.clock_in.localeCompare(a.clock_in))[0];
  const status = ({ p_staff_id }) => {
    const s = T.staff.find((x) => x.id === p_staff_id && x.active);
    if (!s) throw new Error("STAFF_NOT_FOUND");
    const sh = open(p_staff_id);
    return { staff_id: s.id, staff_name: s.name, staff_role: s.role, department: s.department, location: s.location,
      status: sh ? sh.status : "off_shift", shift_id: sh?.id ?? null, clock_in: sh?.clock_in ?? null,
      breaks: sh ? T.breaks.filter((b) => b.shift_id === sh.id) : [] };
  };
  const now = () => new Date().toISOString();
  db.rpc.staff_status_by_id = status;
  db.rpc.clock_in_by_id = (a) => {
    if (open(a.p_staff_id)) throw new Error("SHIFT_ALREADY_OPEN");
    T.shifts.push({ id: randomUUID(), staff_id: a.p_staff_id, clock_in: now(), clock_out: null, status: "working", approved: false, notes: null });
    return status(a);
  };
  db.rpc.start_break_by_id = (a) => {
    const sh = open(a.p_staff_id);
    if (!sh || sh.status !== "working") throw new Error("NO_WORKING_SHIFT");
    T.breaks.push({ id: randomUUID(), shift_id: sh.id, break_start: now(), break_end: null });
    sh.status = "break";
    return status(a);
  };
  db.rpc.end_break_by_id = (a) => {
    const sh = open(a.p_staff_id);
    if (!sh || sh.status !== "break") throw new Error("NO_ACTIVE_BREAK");
    T.breaks.find((b) => b.shift_id === sh.id && !b.break_end).break_end = now();
    sh.status = "working";
    return status(a);
  };
  db.rpc.clock_out_by_id = (a) => {
    const sh = open(a.p_staff_id);
    if (!sh) throw new Error("NO_OPEN_SHIFT");
    if (sh.status === "break") throw new Error("END_BREAK_REQUIRED");
    Object.assign(sh, { clock_out: now(), status: "completed" });
    return status(a);
  };
}

function serveApp() {
  const html = readFileSync(resolve(root, "index.html"));
  const server = createServer((req, res) => {
    if (req.url.startsWith("/index.html") || req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }
    else { res.writeHead(404); res.end(); }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

async function scenarioRun(browser, api, origin, { name, setup, steps }) {
  const db = seed();
  realisticClock(db);
  db.tables.shifts = db.tables.shifts.filter((s) => s.staff_id !== "f1");
  if (setup) setup(db);
  const runtime = installEdgeRuntime();
  const ctx = await browser.newContext({ ...devices["iPhone 13"], serviceWorkers: "block", timezoneId: "Australia/Brisbane" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const net = { failNext: null };
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(origin)) return route.continue();
    if (!url.includes("/functions/v1/marinara-api-v2")) return route.abort();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: cors, body: "ok" });
    if (net.failNext === "abort") { net.failNext = null; return route.abort("internetdisconnected"); }
    if (net.failNext === "503") { net.failNext = null; return route.fulfill({ status: 503, headers: cors, contentType: "application/json", body: '{"message":"Service Unavailable"}' }); }
    const r = await api.call(JSON.parse(route.request().postData() || "{}"), { ip: "203.0.113.9" });
    return route.fulfill({ status: r.status, headers: cors, contentType: "application/json", body: JSON.stringify(r.body) });
  });
  if (setup?.session) {
    const token = sessionFor(db, setup.session);
    await page.addInitScript((t) => sessionStorage.setItem("marinara_session_token", t), token);
  }
  await page.goto(`${origin}/index.html`);
  await page.waitForTimeout(400);
  const seen = [];
  if (!steps.length) seen.push({ step: "page load", onLogin: await page.locator("#loginScreen").first().isVisible().catch(() => false), onHome: await page.locator("#homeScreen").first().isVisible().catch(() => false) });
  const text = async (sel) => ((await page.locator(sel).first().textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim();
  const visible = async (sel) => page.locator(sel).first().isVisible().catch(() => false);
  const btn = async (b) => page.locator(b).first().evaluate((el) => !el.classList.contains("hidden")).catch(() => false);
  for (const step of steps) {
    if (step.net) net.failNext = step.net;
    if (step.pin !== undefined) {
      await page.fill("#pinInput", step.pin);
      const t0 = Date.now();
      await page.click("#loginBtn");
      await page.waitForTimeout(600);
      seen.push({ step: `login ${step.label}`, loginMessage: await text("#loginMessage"), onHome: await visible("#homeScreen"), status: await text("#statusValue"), fastEnough: Date.now() - t0 < 3000 });
    }
    if (step.click) {
      await page.click(step.click);
      await page.waitForTimeout(500);
      seen.push({ step: step.click + (step.net ? ` (${step.net})` : ""), status: await text("#statusValue"), actionMessage: await text("#actionMessage"),
        buttons: { clockIn: await btn("#clockInBtn"), startBreak: await btn("#startBreakBtn"), endBreak: await btn("#endBreakBtn"), clockOut: await btn("#clockOutBtn") } });
    }
  }
  await runtime.settle();
  const f1 = db.tables.shifts.filter((s) => s.staff_id === "f1");
  const stored = { shifts: f1.map((s) => s.status), breaks: db.tables.breaks.filter((b) => f1.some((s) => s.id === b.shift_id)).map((b) => !!b.break_end), sessions: db.tables.staff_sessions.length };
  await ctx.close();
  return { name, seen, stored, errors };
}

const scenarios = [
  { name: "wrong PIN then correct PIN, full shift with break", steps: [
    { pin: "9999", label: "wrong" }, { pin: "6666", label: "correct" },
    { click: "#clockInBtn" }, { click: "#startBreakBtn" }, { click: "#endBreakBtn" }, { click: "#clockOutBtn" }] },
  { name: "internet drops during Clock In, then retry", steps: [
    { pin: "6666", label: "correct" }, { click: "#clockInBtn", net: "abort" }, { click: "#clockInBtn" }] },
  { name: "Supabase unavailable (503) at login, then recovers", steps: [
    { pin: "6666", label: "during 503", net: "503" }, { pin: "6666", label: "after recovery" }] },
  { name: "Supabase unavailable (503) at Clock Out, then retry", steps: [
    { pin: "6666", label: "correct" }, { click: "#clockInBtn" }, { click: "#clockOutBtn", net: "503" }, { click: "#clockOutBtn" }] },
  { name: "already-open session keeps working (no new login)", setup: Object.assign(() => {}, { session: "f1" }), steps: [] },
];

const browser = await chromium.launch({ executablePath: CHROME });
const server = await serveApp();
const origin = `http://127.0.0.1:${server.address().port}`;
const baseline = await loadApi(resolve(root, "tests/edge/baseline-v36.ts"));
const candidate = await loadApi(resolve(root, "supabase/functions/marinara-api-v2/Index.ts"));
let failures = 0;
const quiet = console.log; const quietWarn = console.warn;
try {
  for (const sc of scenarios) {
    console.log = () => {}; console.warn = () => {};
    const a = await scenarioRun(browser, baseline, origin, sc);
    const b = await scenarioRun(browser, candidate, origin, sc);
    console.log = quiet; console.warn = quietWarn;
    try {
      assert.deepEqual(b.seen, a.seen, "what the user sees");
      assert.deepEqual(b.stored, a.stored, "what is stored");
      assert.deepEqual(b.errors, [], "no JavaScript errors");
      console.log(`✔ ${sc.name}`);
      for (const s of b.seen) console.log("   ", JSON.stringify(s));
      console.log("    stored:", JSON.stringify(b.stored));
    } catch (e) {
      failures++;
      console.log(`✖ ${sc.name}\n   v36:  ${JSON.stringify(a)}\n   new:  ${JSON.stringify(b)}\n   ${e.message}`);
    }
  }

  // Observation service down in the candidate: login must still be immediate.
  console.log = () => {}; console.warn = () => {};
  const hang = await scenarioRun(browser, candidate, origin, { name: "shared-PIN check hangs", setup: (db) => { db.rpc.pin_match_count = () => new Promise(() => {}); },
    steps: [{ pin: "6666", label: "correct" }, { click: "#clockInBtn" }] });
  console.log = quiet; console.warn = quietWarn;
  try {
    assert.equal(hang.seen[0].onHome, true);
    assert.equal(hang.seen[0].fastEnough, true);
    assert.deepEqual(hang.stored.shifts, ["working"]);
    console.log("✔ shared-PIN check hanging: login and Clock In unaffected");
  } catch (e) { failures++; console.log("✖ shared-PIN check hanging:", e.message, JSON.stringify(hang)); }
} finally {
  console.log = quiet; console.warn = quietWarn;
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} E2E scenario(s) FAILED` : "\nALL E2E SCENARIOS PASSED");
process.exit(failures ? 1 : 0);
