// Phase 3a (observe-only login logging): proves the new Edge Function behaves
// EXACTLY like production v36 for every request, and that observation can
// never block, slow down or break login, Clock In/Out, breaks or manager work.
//
// Method: differential testing. Each scenario runs against the real v36
// source (tests/edge/baseline-v36.ts) and against the new source, each on a
// fresh synthetic database; responses AND resulting database state must match.
// Run: node --test tests/edge/observe.test.mjs
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadApi, seed, sessionFor, installEdgeRuntime, captureConsole } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE = resolve(here, "baseline-v36.ts");
const CANDIDATE = resolve(here, "../../supabase/functions/marinara-api-v2/Index.ts");

let baseline;
let candidate;
before(async () => {
  baseline = await loadApi(BASELINE);
  candidate = await loadApi(CANDIDATE);
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalize(value, key = "") {
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = normalize(value[k], k);
    return out;
  }
  if (typeof value === "string") {
    if (ISO.test(value)) return "<time>";
    if (HEX64.test(value)) return "<hex>";
    if (UUID.test(value) && !value.startsWith("a0000000")) return "<uuid>";
  }
  if (typeof value === "number" && /hours|minutes/.test(key)) return Math.round(value * 10) / 10;
  return value;
}

function dbState(db) {
  const t = db.tables;
  return normalize({
    staff: t.staff,
    shifts: t.shifts,
    breaks: t.breaks,
    shift_audit: t.shift_audit,
    pin_attempts: t.pin_attempts,
    sessions: t.staff_sessions.map((s) => ({ staff_id: s.staff_id, revoked: !!s.revoked_at, expires_at: s.expires_at })),
  });
}

// Runs one scenario on a given API version with a fresh database.
async function runScenario(api, scenario) {
  const db = seed();
  const runtime = installEdgeRuntime();
  const logs = captureConsole();
  const tokens = {};
  try {
    if (scenario.setup) scenario.setup(db);
    for (const [name, staffId, opts] of scenario.sessions || []) tokens[name] = sessionFor(db, staffId, opts);
    const responses = [];
    for (const step of scenario.steps) {
      const body = { ...step.body };
      if (step.token) body.token = tokens[step.token];
      const started = Date.now();
      const r = await api.call(body, { ip: step.ip || "203.0.113.7" });
      responses.push({ status: r.status, body: normalize(r.body), ms: Date.now() - started });
    }
    await runtime.settle();
    return { responses, state: dbState(db), logs: logs.lines, db };
  } finally {
    logs.restore();
  }
}

const isoAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const K1_OPEN = "a0000000-0000-4000-8000-000000000001";
const K1_DONE = "a0000000-0000-4000-8000-000000000005";

const scenarios = {
  "login: correct PIN": { steps: [{ body: { action: "login", pin: "5555" } }] },
  "login: wrong PIN": { steps: [{ body: { action: "login", pin: "9999" } }] },
  "login: many wrong PINs then correct": {
    steps: [...Array.from({ length: 7 }, (_, i) => ({ body: { action: "login", pin: String(9000 + i) } })),
      { body: { action: "login", pin: "5555" } }],
  },
  "login: inactive staff": { steps: [{ body: { action: "login", pin: "7777" } }] },
  "login: malformed PINs": { steps: ["", "12", "abcd", "1234567", "12 34"].map((pin) => ({ body: { action: "login", pin } })) },
  "login: manager PIN": { steps: [{ body: { action: "login", pin: "111111" } }] },
  "login: PIN shared by two accounts (today's behaviour kept)": {
    setup: (db) => { db.tables.staff.find((s) => s.id === "f1").pin = "5555"; },
    steps: [{ body: { action: "login", pin: "5555" } }],
  },
  "login: existing lock row honoured exactly as today": {
    setup: (db) => { db.tables.pin_attempts[0].locked_until = new Date(Date.now() + 5 * 60e3).toISOString(); db.tables.pin_attempts[0].failed_attempts = 5; },
    steps: [{ body: { action: "login", pin: "5555" } }, { body: { action: "login", pin: "9999" } }],
  },
  "login: database error on PIN check": {
    setup: (db) => { db.rpc.login_with_pin = () => { throw new Error("connection reset"); }; },
    steps: [{ body: { action: "login", pin: "5555" } }],
  },
  "staff: full shift with break": {
    sessions: [["k", "f1"]],
    setup: (db) => { db.tables.shifts = db.tables.shifts.filter((s) => s.staff_id !== "f1"); },
    steps: ["session_status", "session_clock_in", "session_start_break", "session_end_break", "session_clock_out", "session_my_hours"]
      .map((action) => ({ body: { action }, token: "k" })),
  },
  "staff: expired and revoked sessions": {
    sessions: [["exp", "k1", { expiresInH: -1 }], ["rev", "k1", { revoked: true }]],
    steps: [{ body: { action: "session_status" }, token: "exp" }, { body: { action: "session_clock_in" }, token: "rev" }],
  },
  "staff: logout": {
    sessions: [["k", "k1"]],
    steps: [{ body: { action: "session_logout" }, token: "k" }, { body: { action: "session_status" }, token: "k" }],
  },
  "manager: dashboard, hours, approvals": {
    sessions: [["gm", "gm"], ["km", "km"]],
    steps: [{ body: { action: "manager_dashboard" }, token: "gm" }, { body: { action: "manager_working" }, token: "km" },
      { body: { action: "manager_hours" }, token: "gm" }, { body: { action: "manager_approvals" }, token: "km" }],
  },
  "manager: approve, reopen, clock out staff": {
    sessions: [["gm", "gm"]],
    steps: [{ body: { action: "manager_approve_shift", shift_id: K1_DONE }, token: "gm" },
      { body: { action: "manager_reopen_shift", shift_id: K1_DONE }, token: "gm" },
      { body: { action: "manager_clock_out_staff", shift_id: K1_OPEN, clock_out: isoAgo(0.5) }, token: "gm" }],
  },
  "manager: department scope enforced": {
    sessions: [["km", "km"], ["staff", "k1"]],
    steps: [{ body: { action: "manager_clock_out_staff", shift_id: "a0000000-0000-4000-8000-000000000002", clock_out: isoAgo(0.5) }, token: "km" },
      { body: { action: "manager_dashboard" }, token: "staff" }],
  },
  "no credentials / unknown action": {
    steps: [{ body: { action: "manager_dashboard" } }, { body: { action: "nope", token: "x" } }, { body: { action: "session_status", token: "fake" } }],
  },
};

describe("A. Identical behaviour to production v36 (responses and database)", () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    test(name, async () => {
      const a = await runScenario(baseline, scenario);
      const b = await runScenario(candidate, scenario);
      assert.deepEqual(
        b.responses.map(({ status, body }) => ({ status, body })),
        a.responses.map(({ status, body }) => ({ status, body })),
        "same HTTP status and body for every request"
      );
      assert.deepEqual(b.state, a.state, "same database state afterwards");
    });
  }
});

describe("B. What is observed (and nothing sensitive)", () => {
  const observeLines = (logs) => logs.filter((l) => l.includes("[login-observe]"));

  test("wrong PIN is recorded with a pseudonymous device tag", async () => {
    const r = await runScenario(candidate, scenarios["login: wrong PIN"]);
    const lines = observeLines(r.logs);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^warn: \[login-observe\] outcome=wrong_pin device=[0-9a-f]{16}$/);
  });

  test("successful login is recorded; no shared PIN reported for a unique PIN", async () => {
    const r = await runScenario(candidate, scenarios["login: correct PIN"]);
    const lines = observeLines(r.logs);
    assert.deepEqual(lines.map((l) => l.replace(/device=[0-9a-f]{16}/, "device=X")), ["log: [login-observe] outcome=ok device=X"]);
  });

  test("a PIN shared by two accounts is reported (by staff id, never by PIN), login still works as today", async () => {
    const r = await runScenario(candidate, scenarios["login: PIN shared by two accounts (today's behaviour kept)"]);
    assert.equal(r.responses[0].status, 200);
    const shared = observeLines(r.logs).find((l) => l.includes("shared_pin"));
    assert.match(shared, /outcome=shared_pin matches=2 staff=(k1|f1)$/);
  });

  test("the same device gets the same tag; different devices get different tags", async () => {
    const r = await runScenario(candidate, {
      steps: [{ body: { action: "login", pin: "9001" }, ip: "198.51.100.1" }, { body: { action: "login", pin: "9002" }, ip: "198.51.100.1" },
        { body: { action: "login", pin: "9003" }, ip: "198.51.100.2" }],
    });
    const tags = observeLines(r.logs).map((l) => l.match(/device=([0-9a-f]{16})/)[1]);
    assert.equal(tags[0], tags[1]);
    assert.notEqual(tags[0], tags[2]);
  });

  test("no PIN, token, IP address or name ever appears in the logs", async () => {
    const all = [];
    for (const name of ["login: correct PIN", "login: wrong PIN", "login: many wrong PINs then correct", "login: PIN shared by two accounts (today's behaviour kept)", "login: manager PIN"]) {
      const r = await runScenario(candidate, scenarios[name]);
      all.push(...r.logs);
    }
    const text = all.join("\n");
    for (const secret of ["5555", "9999", "111111", "9000", "9006", "203.0.113.7", "Kit One", "fake-service-key"]) {
      assert.ok(!text.includes(secret), `logs must not contain ${secret}`);
    }
    assert.ok(!/[0-9a-f]{64}/.test(text), "no session tokens");
  });

  test("observation writes nothing to the database", async () => {
    const r = await runScenario(candidate, scenarios["login: many wrong PINs then correct"]);
    const writes = r.db.rpcCalls.map((c) => c.name).filter((n) => !["login_with_pin", "pin_match_count"].includes(n));
    assert.deepEqual(writes, [], "only the existing PIN check and the read-only count are called");
  });
});

describe("C. Failures of the observation never affect login or the time clock", () => {
  const failures = {
    "shared-PIN function not installed yet (migration not applied)": (db) => { delete db.rpc.pin_match_count; },
    "shared-PIN function throws": (db) => { db.rpc.pin_match_count = () => { throw new Error("boom"); }; },
    "shared-PIN function hangs (Supabase slow)": (db) => { db.rpc.pin_match_count = () => new Promise(() => {}); },
    "crypto unavailable for the device tag": () => { globalThis.__savedSubtle = globalThis.crypto.subtle.importKey; globalThis.crypto.subtle.importKey = () => Promise.reject(new Error("no crypto")); },
  };

  for (const [name, breakIt] of Object.entries(failures)) {
    test(name, async () => {
      const scenario = { setup: breakIt, sessions: [["k", "f1"]], steps: [
        { body: { action: "login", pin: "5555" } },
        { body: { action: "login", pin: "9999" } },
        { body: { action: "session_status" }, token: "k" },
      ] };
      const expected = await runScenario(baseline, { ...scenario, setup: undefined });
      const started = Date.now();
      const got = await runScenario(candidate, scenario);
      if (globalThis.__savedSubtle) { globalThis.crypto.subtle.importKey = globalThis.__savedSubtle; delete globalThis.__savedSubtle; }
      assert.deepEqual(got.responses.map(({ status, body }) => ({ status, body })), expected.responses.map(({ status, body }) => ({ status, body })));
      for (const r of got.responses) assert.ok(r.ms < 1500, `response not delayed (${r.ms} ms)`);
      assert.ok(Date.now() - started < 6000, "background work is bounded by its timeout");
    });
  }

  test("login responds before the background shared-PIN check finishes", async () => {
    let release;
    const scenario = {
      setup: (db) => { db.rpc.pin_match_count = () => new Promise((res) => { release = () => res(1); }); },
      steps: [{ body: { action: "login", pin: "5555" } }],
    };
    const db = seed();
    scenario.setup(db);
    const runtime = installEdgeRuntime();
    const r = await candidate.call({ action: "login", pin: "5555" });
    assert.equal(r.status, 200, "login answered while the check is still pending");
    assert.ok(runtime.pending.length >= 1, "check runs in the background");
    release?.();
    await runtime.settle();
  });
});

describe("D. Simultaneous requests", () => {
  test("50 parallel logins and time-clock calls: same outcomes as v36", async () => {
    const steps = [];
    for (let i = 0; i < 50; i++) {
      steps.push(i % 5 === 0 ? { body: { action: "login", pin: "5555" } } : { body: { action: "login", pin: String(8000 + i) }, ip: `10.0.0.${i}` });
    }
    const runParallel = async (api) => {
      const db = seed();
      const runtime = installEdgeRuntime();
      const logs = captureConsole();
      try {
        const results = await Promise.all(steps.map((s) => api.call(s.body, { ip: s.ip || "203.0.113.7" })));
        await runtime.settle();
        return { statuses: results.map((r) => r.status), sessions: db.tables.staff_sessions.length, logs: logs.lines };
      } finally { logs.restore(); }
    };
    const a = await runParallel(baseline);
    const b = await runParallel(candidate);
    assert.deepEqual(b.statuses, a.statuses);
    assert.equal(b.sessions, a.sessions);
    assert.equal(b.logs.filter((l) => l.includes("outcome=wrong_pin")).length, 40);
    assert.equal(b.logs.filter((l) => l.includes("outcome=ok")).length, 10);
  });
});
