// Automated tests for marinara-api-v2 (security, permissions, clock flows).
// Run: node --test tests/edge/
// Uses synthetic data in memory only; never touches the real database.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadApi, seed, sessionFor, sha256 } from "./harness.mjs";

let api;
let db;
before(async () => { api = await loadApi(); });
beforeEach(() => { db = seed(); });

const rpcNames = () => db.rpcCalls.map((c) => c.name);
const attempts = (key) => db.tables.pin_attempts.find((r) => r.attempt_key === key);
const deviceKeyRow = () => db.tables.pin_attempts.find((r) => r.attempt_key.startsWith("ip:"));
const isoAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();

describe("1. Authentication: PIN login and brute-force protection", () => {
  test("wrong PIN is rejected with 401 and is counted", async () => {
    const r = await api.call({ action: "login", pin: "9999" });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "Invalid PIN");
    assert.equal(db.tables.staff_sessions.length, 0, "no session for a wrong PIN");
    assert.equal(attempts("hawthorne-pin-entry").failed_attempts, 1);
    assert.equal(deviceKeyRow().failed_attempts, 1);
  });

  test("the device is locked after 8 wrong PINs, even with the right PIN", async () => {
    for (let i = 0; i < 8; i++) {
      const r = await api.call({ action: "login", pin: String(9000 + i) });
      assert.equal(r.status, 401, `attempt ${i + 1}`);
    }
    const locked = await api.call({ action: "login", pin: "9100" });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.code, "PIN_TEMPORARILY_LOCKED");
    const rightPinStillLocked = await api.call({ action: "login", pin: "5555" });
    assert.equal(rightPinStillLocked.status, 429, "lock is not bypassed by guessing right");
    assert.ok(!rpcNames().slice(-1).includes("login_with_pin_v2"), "PIN not checked while locked");
  });

  test("one locked device does not lock other devices", async () => {
    for (let i = 0; i < 9; i++) await api.call({ action: "login", pin: String(9000 + i) }, { ip: "198.51.100.1" });
    const other = await api.call({ action: "login", pin: "5555" }, { ip: "198.51.100.2" });
    assert.equal(other.status, 200);
  });

  test("global ceiling stops distributed guessing across many devices", async () => {
    for (let i = 0; i < 40; i++) {
      const r = await api.call({ action: "login", pin: String(9000 + i) }, { ip: `10.0.${i}.1` });
      assert.equal(r.status, 401);
    }
    const r = await api.call({ action: "login", pin: "9999" }, { ip: "10.9.9.9" });
    assert.equal(r.status, 429);
  });

  test("parallel wrong PINs from one device cannot exceed the limit", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => api.call({ action: "login", pin: String(8000 + i) }))
    );
    const checked = results.filter((r) => r.status === 401).length;
    assert.ok(checked <= 8, `only 8 PIN checks allowed, got ${checked}`);
    assert.equal(rpcNames().filter((n) => n === "login_with_pin_v2").length, checked);
  });

  test("correct PIN creates a session, clears the device counter and gives back the global slot", async () => {
    await api.call({ action: "login", pin: "9999" });
    const r = await api.call({ action: "login", pin: "5555" });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.data[0].staff_id, "k1");
    assert.match(r.body.session.token, /^[0-9a-f]{64}$/);
    const stored = db.tables.staff_sessions[0];
    assert.equal(stored.token_hash, sha256(r.body.session.token), "only the hash is stored");
    assert.notEqual(stored.token_hash, r.body.session.token);
    assert.equal(deviceKeyRow().failed_attempts, 0);
    assert.equal(attempts("hawthorne-pin-entry").failed_attempts, 1, "only the wrong PIN remains counted");
  });

  test("a PIN shared by two active accounts is refused (no guessing who it is)", async () => {
    db.tables.staff.find((s) => s.id === "f1").pin = "5555";
    const r = await api.call({ action: "login", pin: "5555" });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "PIN_NOT_UNIQUE");
    assert.equal(db.tables.staff_sessions.length, 0);
  });

  test("inactive staff cannot log in", async () => {
    const r = await api.call({ action: "login", pin: "7777" });
    assert.equal(r.status, 401);
  });

  test("malformed PIN is rejected before any check and is not counted", async () => {
    for (const pin of ["", "12", "abcd", "1234567", "12 34"]) {
      const r = await api.call({ action: "login", pin });
      assert.equal(r.status, 400, JSON.stringify(pin));
    }
    assert.equal(rpcNames().length, 0);
  });

  test("a server error during the PIN check gives the attempt back", async () => {
    db.rpc.login_with_pin_v2 = () => { throw new Error("boom"); };
    const r = await api.call({ action: "login", pin: "5555" });
    assert.equal(r.status, 500);
    assert.equal(deviceKeyRow().failed_attempts, 0);
    assert.equal(attempts("hawthorne-pin-entry").failed_attempts, 0);
  });
});

describe("2. Sessions", () => {
  test("manager actions need a valid, unexpired, unrevoked session", async () => {
    assert.equal((await api.call({ action: "manager_dashboard", pin: "1111" })).status, 401);
    assert.equal((await api.call({ action: "manager_dashboard", token: "not-a-real-token" })).status, 401);
    const expired = sessionFor(db, "gm", { expiresInH: -1 });
    assert.equal((await api.call({ action: "manager_dashboard", token: expired })).status, 401);
    const revoked = sessionFor(db, "gm", { revoked: true });
    assert.equal((await api.call({ action: "manager_dashboard", token: revoked })).status, 401);
    const ok = sessionFor(db, "gm");
    assert.equal((await api.call({ action: "manager_dashboard", token: ok })).status, 200);
  });

  test("logout revokes the session on the server", async () => {
    const t = sessionFor(db, "gm");
    assert.equal((await api.call({ action: "session_logout", token: t })).status, 200);
    assert.equal((await api.call({ action: "manager_dashboard", token: t })).status, 401);
    assert.equal((await api.call({ action: "session_status", token: t })).status, 401);
  });

  test("a deactivated account loses access immediately", async () => {
    const t = sessionFor(db, "k1");
    db.tables.staff.find((s) => s.id === "k1").active = false;
    assert.equal((await api.call({ action: "session_status", token: t })).status, 401);
  });

  test("time-clock actions act on the session owner, never on a staff_id sent by the client", async () => {
    const t = sessionFor(db, "k1");
    const r = await api.call({ action: "session_clock_in", token: t, staff_id: "gm", p_staff_id: "gm" });
    assert.equal(r.status, 200);
    assert.deepEqual(db.rpcCalls.at(-1), { name: "clock_in_by_id", args: { p_staff_id: "k1" } });
  });

  test("ordinary staff cannot use any manager action", async () => {
    const t = sessionFor(db, "k1");
    for (const action of ["manager_dashboard", "manager_working", "manager_hours", "manager_approvals",
      "manager_approve_shift", "manager_edit_shift", "manager_delete_shift", "manager_clock_out_staff",
      "manager_create_staff", "manager_update_staff", "manager_toggle_staff", "manager_reopen_shift"]) {
      const r = await api.call({ action, token: t, shift_id: "a0000000-0000-4000-8000-000000000005", staff_id: "k1" });
      assert.equal(r.status, 403, action);
    }
  });

  test("unknown actions are rejected", async () => {
    const r = await api.call({ action: "drop_tables", token: sessionFor(db, "gm") });
    assert.equal(r.status, 400);
    assert.ok(r.body.allowed_actions.includes("login"));
    assert.ok(r.body.allowed_actions.includes("manager_clock_out_staff"));
  });
});

describe("3. Department scope (Kitchen / Floor / General Manager)", () => {
  test("Kitchen Manager only sees Kitchen in Who's Working", async () => {
    const r = await api.call({ action: "manager_working", token: sessionFor(db, "km") });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.working.length > 0);
    assert.ok(r.body.data.working.every((w) => w.department === "Kitchen"));
  });

  test("Floor Manager only sees Floor in Who's Working, hours and approvals", async () => {
    const t = sessionFor(db, "fm");
    const w = await api.call({ action: "manager_working", token: t });
    assert.ok(w.body.data.working.every((x) => x.department === "Floor"));
    const h = await api.call({ action: "manager_hours", token: t });
    assert.ok(h.body.data.shifts.every((x) => x.department === "Floor"));
    const a = await api.call({ action: "manager_approvals", token: t });
    assert.ok(a.body.data.approvals.every((x) => x.department === "Floor"));
  });

  test("other venues are never visible", async () => {
    const r = await api.call({ action: "manager_working", token: sessionFor(db, "gm") });
    assert.ok(r.body.data.working.every((w) => w.staff_id !== "o1"));
  });

  test("Kitchen Manager cannot clock out, edit or approve Floor shifts", async () => {
    const t = sessionFor(db, "km");
    const out = await api.call({ action: "manager_clock_out_staff", token: t, shift_id: "a0000000-0000-4000-8000-000000000002", clock_out: isoAgo(1) });
    assert.equal(out.status, 403);
    assert.ok(!rpcNames().includes("manager_clock_out_staff"));
    db.tables.shifts.push({ id: "a0000000-0000-4000-8000-000000000007", staff_id: "f1", clock_in: isoAgo(10), clock_out: isoAgo(5), status: "completed", approved: false });
    assert.equal((await api.call({ action: "manager_approve_shift", token: t, shift_id: "a0000000-0000-4000-8000-000000000007" })).status, 403);
    assert.equal((await api.call({ action: "manager_edit_shift", token: t, shift_id: "a0000000-0000-4000-8000-000000000007", clock_in: isoAgo(10), clock_out: isoAgo(6), break_minutes: 0 })).status, 403);
    assert.equal((await api.call({ action: "manager_delete_shift", token: t, shift_id: "a0000000-0000-4000-8000-000000000007" })).status, 403);
    assert.equal(db.tables.shifts.find((s) => s.id === "a0000000-0000-4000-8000-000000000007").approved, false, "state unchanged");
  });

  test("Floor Manager cannot clock out Kitchen shifts", async () => {
    const r = await api.call({ action: "manager_clock_out_staff", token: sessionFor(db, "fm"), shift_id: "a0000000-0000-4000-8000-000000000001", clock_out: isoAgo(1) });
    assert.equal(r.status, 403);
    assert.equal(db.tables.shifts.find((s) => s.id === "a0000000-0000-4000-8000-000000000001").clock_out, null);
  });

  test("a scoped manager cannot clock out another manager of the same department", async () => {
    const r = await api.call({ action: "manager_clock_out_staff", token: sessionFor(db, "km"), shift_id: "a0000000-0000-4000-8000-000000000003", clock_out: isoAgo(1) });
    assert.equal(r.status, 403);
  });

  test("scoped managers cannot promote anyone or edit manager accounts", async () => {
    const t = sessionFor(db, "km");
    const promote = await api.call({ action: "manager_update_staff", token: t, staff_id: "k1", name: "Kit One", department: "Kitchen", role: "manager" });
    assert.equal(db.tables.staff.find((s) => s.id === "k1").role, "staff", `role unchanged (status ${promote.status})`);
    const editMgr = await api.call({ action: "manager_update_staff", token: t, staff_id: "km2", name: "X", department: "Kitchen" });
    assert.equal(editMgr.status, 403);
    const moveDept = await api.call({ action: "manager_update_staff", token: t, staff_id: "k1", name: "Kit One", department: "Floor" });
    assert.equal(moveDept.status, 403);
  });

  test("General Manager can clock out both departments; the shift stays pending and is audited", async () => {
    const t = sessionFor(db, "gm");
    for (const id of ["a0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000002"]) {
      const r = await api.call({ action: "manager_clock_out_staff", token: t, shift_id: id, clock_out: isoAgo(0.5) });
      assert.equal(r.status, 200, id);
      const s = db.tables.shifts.find((x) => x.id === id);
      assert.equal(s.status, "completed");
      assert.equal(s.approved, false);
    }
    assert.deepEqual(db.rpcCalls.filter((c) => c.name === "manager_clock_out_staff").map((c) => c.args.p_manager_id), ["gm", "gm"]);
    assert.equal(db.tables.shift_audit.length, 2);
  });

  test("managers cannot deactivate their own account", async () => {
    const r = await api.call({ action: "manager_toggle_staff", token: sessionFor(db, "gm"), staff_id: "gm" });
    assert.equal(r.status, 400);
    assert.equal(db.tables.staff.find((s) => s.id === "gm").active, true);
  });
});

describe("4. Manager Clock Out validation", () => {
  const call = (extra) => api.call({ action: "manager_clock_out_staff", token: sessionFor(db, "gm"), ...extra });

  test("rejects future, missing time zone, bad IDs and unknown shifts without changing data", async () => {
    assert.equal((await call({ shift_id: "a0000000-0000-4000-8000-000000000001", clock_out: new Date(Date.now() + 3600e3).toISOString() })).status, 400);
    assert.equal((await call({ shift_id: "a0000000-0000-4000-8000-000000000001", clock_out: "2026-10-12T09:00" })).status, 400, "no offset");
    assert.equal((await call({ shift_id: "not-a-uuid", clock_out: isoAgo(1) })).status, 400);
    assert.equal((await call({ shift_id: "00000000-0000-4000-8000-000000000000", clock_out: isoAgo(1) })).status, 404);
    assert.equal(db.tables.shifts.find((s) => s.id === "a0000000-0000-4000-8000-000000000001").clock_out, null);
  });
});

describe("5. Hours, breaks and Brisbane weeks", () => {
  test("hours subtract breaks, including a shift that crosses midnight", async () => {
    // Fri 9 Oct 2026, 17:00 -> Sat 01:30 Brisbane, 30 min break = 8.0 h
    db.tables.shifts.push({ id: "a0000000-0000-4000-8000-000000000008", staff_id: "f1", clock_in: "2026-10-09T07:00:00.000Z", clock_out: "2026-10-09T15:30:00.000Z", status: "completed", approved: false });
    db.tables.breaks.push({ id: "b-night", shift_id: "a0000000-0000-4000-8000-000000000008", break_start: "2026-10-09T11:00:00.000Z", break_end: "2026-10-09T11:30:00.000Z" });
    const r = await api.call({ action: "manager_hours", token: sessionFor(db, "gm"), week_start: "2026-10-09" });
    assert.equal(r.status, 200);
    const s = r.body.data.shifts.find((x) => x.shift_id === "a0000000-0000-4000-8000-000000000008");
    assert.ok(s, "shift is in the Brisbane week of 5-11 Oct");
    assert.equal(s.break_minutes, 30);
    assert.equal(s.hours, 8);
    const person = r.body.data.summary.find((p) => p.staff_id === "f1");
    assert.equal(person.unapproved, 1);
  });

  test("Brisbane week starts Monday 00:00 (UTC+10, no daylight saving)", async () => {
    const r = await api.call({ action: "manager_hours", token: sessionFor(db, "gm"), week_start: "2026-10-14" });
    assert.equal(r.body.data.week_start_date, "2026-10-12");
    assert.equal(r.body.data.week_start, "2026-10-11T14:00:00.000Z");
    assert.equal(r.body.data.week_end, "2026-10-18T14:00:00.000Z");
    const bad = await api.call({ action: "manager_hours", token: sessionFor(db, "gm"), week_start: "2026-02-30" });
    assert.equal(bad.status, 400);
  });
});

describe("6. Approvals integrity", () => {
  test("approved shifts cannot be edited or deleted; active shifts cannot be approved", async () => {
    const t = sessionFor(db, "gm");
    const edit = await api.call({ action: "manager_edit_shift", token: t, shift_id: "a0000000-0000-4000-8000-000000000006", clock_in: isoAgo(30), clock_out: isoAgo(21), break_minutes: 0 });
    assert.ok([400, 409].includes(edit.status), `edit of approved shift refused (got ${edit.status})`);
    assert.equal((await api.call({ action: "manager_delete_shift", token: t, shift_id: "a0000000-0000-4000-8000-000000000006" })).status, 400);
    assert.equal((await api.call({ action: "manager_approve_shift", token: t, shift_id: "a0000000-0000-4000-8000-000000000001" })).status, 400);
    assert.ok(db.tables.shifts.find((s) => s.id === "a0000000-0000-4000-8000-000000000006"));
  });
});

describe("7. Audit trail and integrity of manager changes", () => {
  const PENDING = "a0000000-0000-4000-8000-000000000005"; // k1 completed, pending, 30h -> 22h ago
  const auditFor = (id, action) => db.tables.shift_audit.filter((a) => a.shift_id === id && (a.new_data?.action === action));

  test("approve is recorded once with the manager, and is idempotent", async () => {
    const t = sessionFor(db, "km");
    const r1 = await api.call({ action: "manager_approve_shift", token: t, shift_id: PENDING });
    assert.equal(r1.status, 200);
    assert.equal(db.tables.shifts.find((s) => s.id === PENDING).approved, true);
    const r2 = await api.call({ action: "manager_approve_shift", token: t, shift_id: PENDING });
    assert.equal(r2.status, 200);
    const audits = auditFor(PENDING, "manager_approve_shift");
    assert.equal(audits.length, 1, "double approval does not create a second record");
    assert.equal(audits[0].changed_by, "km");
    assert.equal(audits[0].old_data.approved, false);
  });

  test("reopen is recorded", async () => {
    const t = sessionFor(db, "gm");
    const APPROVED = "a0000000-0000-4000-8000-000000000006";
    assert.equal((await api.call({ action: "manager_reopen_shift", token: t, shift_id: APPROVED })).status, 200);
    assert.equal(db.tables.shifts.find((s) => s.id === APPROVED).approved, false);
    assert.equal(auditFor(APPROVED, "manager_reopen_shift").length, 1);
  });

  test("delete keeps a full copy of the deleted shift in the audit trail", async () => {
    const t = sessionFor(db, "km");
    const r = await api.call({ action: "manager_delete_shift", token: t, shift_id: PENDING });
    assert.equal(r.status, 200);
    assert.ok(!db.tables.shifts.find((s) => s.id === PENDING));
    const a = auditFor(PENDING, "manager_delete_shift");
    assert.equal(a.length, 1);
    assert.equal(a[0].old_data.id, PENDING);
    assert.equal(a[0].old_data.breaks.length, 1, "breaks are kept in the record");
  });

  test("edit goes through the atomic database function with the manager's identity", async () => {
    const t = sessionFor(db, "km");
    const r = await api.call({ action: "manager_edit_shift", token: t, shift_id: PENDING, clock_in: isoAgo(31), clock_out: isoAgo(23), break_minutes: 30 });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.shift.hours, 7.5);
    const call = db.rpcCalls.find((c) => c.name === "manager_edit_shift");
    assert.equal(call.args.p_manager_id, "km");
    assert.equal(auditFor(PENDING, "manager_edit_shift").length, 1);
  });

  test("edit that overlaps another shift is refused with a clear message", async () => {
    const t = sessionFor(db, "km");
    // the open k1 shift started 5h ago
    const r = await api.call({ action: "manager_edit_shift", token: t, shift_id: PENDING, clock_in: isoAgo(10), clock_out: isoAgo(4), break_minutes: 0 });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "SHIFT_OVERLAP");
  });

  test("manual shift: overlap and future are refused; a valid one is audited", async () => {
    const t = sessionFor(db, "km");
    const overlap = await api.call({ action: "manager_create_shift", token: t, staff_id: "k1", clock_in: isoAgo(29), clock_out: isoAgo(25), break_minutes: 0 });
    assert.equal(overlap.status, 409);
    const future = await api.call({ action: "manager_create_shift", token: t, staff_id: "k1", clock_in: isoAgo(1), clock_out: new Date(Date.now() + 3 * 3600e3).toISOString(), break_minutes: 0 });
    assert.equal(future.status, 400);
    const before = db.tables.shifts.length;
    const ok = await api.call({ action: "manager_create_shift", token: t, staff_id: "k1", clock_in: isoAgo(60), clock_out: isoAgo(52), break_minutes: 30, notes: "forgot phone" });
    assert.equal(ok.status, 200);
    assert.equal(db.tables.shifts.length, before + 1);
    const created = ok.body.data.shift;
    assert.equal(created.approved, false);
    assert.equal(auditFor(created.id, "manager_create_shift").length, 1);
  });
});
