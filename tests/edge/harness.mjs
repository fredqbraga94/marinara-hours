// Runs the real marinara-api-v2 source under Node with a fake database.
// Usage: const api = await loadApi(); const db = seed(); const res = await api.call({...})
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadTypeScript() {
  const candidates = [
    process.env.TYPESCRIPT_PATH,
    "typescript",
    "/opt/node-tools/node_modules/typescript",
    "/opt/npm-tools/node_modules/typescript",
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch (_) { /* try next */ }
  }
  throw new Error("TypeScript not found: npm i -D typescript, or set TYPESCRIPT_PATH");
}

export const sha256 = (v) => createHash("sha256").update(v).digest("hex");

export async function loadApi(sourcePath) {
  const ts = loadTypeScript();
  const src = readFileSync(
    sourcePath || process.env.API_SOURCE || resolve(here, "../../supabase/functions/marinara-api-v2/Index.ts"),
    "utf8"
  );
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(
    /from\s+["']https:\/\/esm\.sh\/@supabase\/supabase-js@2["']/,
    `from ${JSON.stringify(pathToFileURL(join(here, "fake-supabase.mjs")).href)}`
  );
  let handler = null;
  globalThis.Deno = {
    env: { get: (k) => ({ SUPABASE_URL: "http://fake", SUPABASE_SERVICE_ROLE_KEY: "fake-service-key" })[k] },
    serve: (h) => { handler = h; },
  };
  const dir = mkdtempSync(join(tmpdir(), "marinara-api-"));
  const file = join(dir, `api-${randomUUID()}.mjs`);
  writeFileSync(file, js);
  await import(pathToFileURL(file).href);
  if (!handler) throw new Error("Deno.serve was not called");
  return {
    async call(body, { ip = "203.0.113.10", method = "POST" } = {}) {
      const req = new Request("http://fake/functions/v1/marinara-api-v2", {
        method,
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: method === "POST" ? JSON.stringify(body) : undefined,
      });
      const res = await handler(req);
      let json = null;
      try { json = await res.json(); } catch (_) { /* empty */ }
      return { status: res.status, body: json };
    },
  };
}

const iso = (ms) => new Date(ms).toISOString();

export function seed() {
  const now = Date.now();
  const staff = [
    { id: "gm", name: "GM", role: "manager", department: "Floor", location: "Hawthorne", active: true, pin: "111111" },
    { id: "km", name: "KM", role: "kitchen_manager", department: "Kitchen", location: "Hawthorne", active: true, pin: "222222" },
    { id: "fm", name: "FM", role: "floor_manager", department: "Floor", location: "Hawthorne", active: true, pin: "333333" },
    { id: "km2", name: "KM2", role: "kitchen_manager", department: "Kitchen", location: "Hawthorne", active: true, pin: "444444" },
    { id: "k1", name: "Kit One", role: "staff", department: "Kitchen", location: "Hawthorne", active: true, pin: "5555" },
    { id: "f1", name: "Floor One", role: "staff", department: "Floor", location: "Hawthorne", active: true, pin: "6666" },
    { id: "kx", name: "Kit Inactive", role: "staff", department: "Kitchen", location: "Hawthorne", active: false, pin: "7777" },
    { id: "o1", name: "Other Venue", role: "staff", department: "Kitchen", location: "Elsewhere", active: true, pin: "8888" },
  ];
  const sh = (id, staff_id, inH, outH, extra = {}) => ({
    id, staff_id, clock_in: iso(now - inH * 3600e3),
    clock_out: outH == null ? null : iso(now - outH * 3600e3),
    status: outH == null ? "working" : "completed", approved: false, notes: null, ...extra,
  });
  const db = {
    now,
    tables: {
      staff,
      staff_sessions: [],
      shifts: [
        sh("a0000000-0000-4000-8000-000000000001", "k1", 5, null),
        sh("a0000000-0000-4000-8000-000000000002", "f1", 4, null),
        sh("a0000000-0000-4000-8000-000000000003", "km2", 3, null),
        sh("a0000000-0000-4000-8000-000000000004", "o1", 3, null),
        sh("a0000000-0000-4000-8000-000000000005", "k1", 30, 22),
        sh("a0000000-0000-4000-8000-000000000006", "f1", 30, 22, { approved: true }),
      ],
      breaks: [
        { id: "b1", shift_id: "a0000000-0000-4000-8000-000000000005", break_start: iso(now - 26 * 3600e3), break_end: iso(now - 25.5 * 3600e3) },
      ],
      pin_attempts: [{ id: "pa-global", attempt_key: "hawthorne-pin-entry", failed_attempts: 0, locked_until: null, last_attempt_at: iso(now) }],
      shift_audit: [],
    },
    rpcCalls: [],
    rpc: {},
  };
  installRpc(db);
  globalThis.__FAKE_DB = db;
  return db;
}

export function sessionFor(db, staffId, { expiresInH = 12, revoked = false } = {}) {
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  db.tables.staff_sessions.push({
    id: randomUUID(), staff_id: staffId, token_hash: sha256(token),
    created_at: iso(Date.now()), expires_at: iso(Date.now() + expiresInH * 3600e3),
    revoked_at: revoked ? iso(Date.now()) : null, last_used_at: iso(Date.now()),
  });
  return token;
}

const MANAGER_ROLES = ["manager", "kitchen_manager", "floor_manager"];

function installRpc(db) {
  const T = db.tables;
  const findStaff = (id) => T.staff.find((s) => s.id === id);
  const status = (id) => ({ staff_id: id, status: "ok" });

  // Mirrors supabase/migrations/20261012060000_pin_rate_limit_and_unique_login.sql
  db.rpc.pin_attempt_reserve = ({ p_key, p_max, p_window_minutes, p_lock_minutes }) => {
    if (!p_key || !(p_max >= 1)) throw new Error("INVALID_INPUT");
    const now = Date.now();
    let r = T.pin_attempts.find((x) => x.attempt_key === p_key);
    if (!r) { r = { id: randomUUID(), attempt_key: p_key, failed_attempts: 0, locked_until: null, last_attempt_at: iso(now) }; T.pin_attempts.push(r); }
    if (r.locked_until && Date.parse(r.locked_until) > now) {
      return { allowed: false, remaining: 0, retry_after_seconds: Math.max(1, Math.ceil((Date.parse(r.locked_until) - now) / 1000)) };
    }
    let count = r.failed_attempts || 0;
    if (r.locked_until || !r.last_attempt_at || Date.parse(r.last_attempt_at) < now - p_window_minutes * 60e3) count = 0;
    count += 1;
    if (count > p_max) {
      Object.assign(r, { failed_attempts: p_max, locked_until: iso(now + p_lock_minutes * 60e3), last_attempt_at: iso(now) });
      return { allowed: false, remaining: 0, retry_after_seconds: p_lock_minutes * 60 };
    }
    Object.assign(r, { failed_attempts: count, locked_until: null, last_attempt_at: iso(now) });
    return { allowed: true, remaining: p_max - count, retry_after_seconds: 0 };
  };
  db.rpc.pin_attempt_release = ({ p_key, p_clear }) => {
    const r = T.pin_attempts.find((x) => x.attempt_key === p_key);
    if (!r) return null;
    if (p_clear) Object.assign(r, { failed_attempts: 0, locked_until: null });
    else if (!r.locked_until || Date.parse(r.locked_until) <= Date.now()) r.failed_attempts = Math.max(0, r.failed_attempts - 1);
    return null;
  };
  const row = (s) => ({ staff_id: s.id, staff_name: s.name, staff_role: s.role, department: s.department, location: s.location });
  db.rpc.login_with_pin_v2 = ({ p_pin }) =>
    /^[0-9]{4,6}$/.test(p_pin) ? T.staff.filter((s) => s.active && s.pin === p_pin).slice(0, 2).map(row) : [];
  // Legacy behaviour (v36 and earlier): wrong PIN -> empty set, no error.
  db.rpc.login_with_pin = ({ p_pin }) => T.staff.filter((s) => s.active && s.pin === p_pin).slice(0, 1).map(row);

  for (const n of ["staff_status_by_id", "clock_in_by_id", "start_break_by_id", "end_break_by_id", "clock_out_by_id"]) {
    db.rpc[n] = ({ p_staff_id }) => status(p_staff_id);
  }

  // Mirrors the rules of supabase/migrations/20261012000000_add_manager_clock_out_staff.sql
  db.rpc.manager_clock_out_staff = ({ p_manager_id, p_shift_id, p_clock_out }) => {
    const mgr = findStaff(p_manager_id);
    if (!mgr || !mgr.active || !MANAGER_ROLES.includes(mgr.role)) throw new Error("MANAGER_REQUIRED");
    const scope = mgr.role === "kitchen_manager" ? "Kitchen" : mgr.role === "floor_manager" ? "Floor" : null;
    const sh = T.shifts.find((x) => x.id === p_shift_id);
    if (!sh) throw new Error("SHIFT_NOT_FOUND");
    const st = findStaff(sh.staff_id);
    if (!st || !st.active || st.location !== (mgr.location || "Hawthorne")) throw new Error("SHIFT_NOT_FOUND");
    if (scope && (st.department !== scope || (st.role !== "staff" && st.id !== mgr.id))) throw new Error("DEPARTMENT_DENIED");
    if (sh.approved) throw new Error("SHIFT_APPROVED");
    if (sh.clock_out) throw new Error("SHIFT_ALREADY_CLOSED");
    if (Date.parse(p_clock_out) <= Date.parse(sh.clock_in)) throw new Error("CLOCK_OUT_BEFORE_CLOCK_IN");
    if (Date.parse(p_clock_out) > Date.now() + 60e3) throw new Error("CLOCK_OUT_IN_FUTURE");
    Object.assign(sh, { clock_out: p_clock_out, status: "completed", approved: false });
    T.shift_audit.push({ id: randomUUID(), shift_id: sh.id, changed_by: mgr.id });
    return { shift_id: sh.id, approved: false, status: "completed" };
  };

  // Mirrors supabase/migrations/20261012070000_audit_and_integrity.sql (manager_edit_shift)
  db.rpc.manager_edit_shift = ({ p_manager_id, p_shift_id, p_clock_in, p_clock_out, p_break_minutes }) => {
    const mgr = findStaff(p_manager_id);
    if (!mgr || !mgr.active || !MANAGER_ROLES.includes(mgr.role)) throw new Error("MANAGER_REQUIRED");
    const scope = mgr.role === "kitchen_manager" ? "Kitchen" : mgr.role === "floor_manager" ? "Floor" : null;
    const sh = T.shifts.find((x) => x.id === p_shift_id);
    if (!sh) throw new Error("SHIFT_NOT_FOUND");
    const st = findStaff(sh.staff_id);
    if (!st || !st.active || st.location !== (mgr.location || "Hawthorne")) throw new Error("SHIFT_NOT_FOUND");
    if (scope && st.department !== scope) throw new Error("DEPARTMENT_DENIED");
    if (!sh.clock_out) throw new Error("SHIFT_STILL_OPEN");
    if (sh.approved) throw new Error("SHIFT_APPROVED");
    const a = Date.parse(p_clock_in), b = Date.parse(p_clock_out);
    if (b <= a) throw new Error("CLOCK_OUT_BEFORE_CLOCK_IN");
    if (b > Date.now() + 60e3) throw new Error("CLOCK_OUT_IN_FUTURE");
    if (b - a > 24 * 3600e3) throw new Error("SHIFT_TOO_LONG");
    if (p_break_minutes < 0 || p_break_minutes > 720 || p_break_minutes * 60e3 >= b - a) throw new Error("INVALID_BREAK");
    const overlap = T.shifts.some((o) => o.staff_id === sh.staff_id && o.id !== sh.id && Date.parse(o.clock_in) < b && (o.clock_out ? Date.parse(o.clock_out) : Infinity) > a);
    if (overlap) throw new Error("SHIFT_OVERLAP");
    Object.assign(sh, { clock_in: p_clock_in, clock_out: p_clock_out, status: "completed" });
    T.breaks = T.breaks.filter((x) => x.shift_id !== sh.id);
    if (p_break_minutes > 0) T.breaks.push({ id: randomUUID(), shift_id: sh.id, break_start: new Date(b - p_break_minutes * 60e3).toISOString(), break_end: p_clock_out });
    T.shift_audit.push({ id: randomUUID(), shift_id: sh.id, changed_by: mgr.id, new_data: { action: "manager_edit_shift" } });
    return { id: sh.id, hours: Math.round(((b - a) / 3600e3 - p_break_minutes / 60) * 100) / 100, break_minutes: p_break_minutes };
  };

  db.rpc.manager_update_staff = ({ p_staff_id, p_name, p_department }) => {
    const s = findStaff(p_staff_id);
    Object.assign(s, { name: p_name, department: p_department });
    return [{ ...s }];
  };
  db.rpc.manager_create_staff = ({ p_name, p_department, p_location }) => {
    const s = { id: randomUUID(), name: p_name, department: p_department, location: p_location, role: "staff", active: true };
    T.staff.push(s);
    return [{ ...s }];
  };
}
