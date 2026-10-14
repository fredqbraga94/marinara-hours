// Integrated validation of PR #5 against production v36.
//
// Real Edge Function code (v36 baseline and PR #5) + real SQL functions and constraints
// (production structure, copied read-only) in a throwaway local PostgreSQL.
// Data and credentials are 100% synthetic. Nothing connects to Supabase.
//
// Run: node tests/integration/run.mjs        (needs PostgreSQL 14+ binaries + TypeScript)
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { Pool } from "./pg-wire.mjs";
import { makeCreateClient, lit } from "./pg-supabase.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const require = createRequire(import.meta.url);
const ts = (() => {
  for (const c of [process.env.TYPESCRIPT_PATH, "typescript", "/opt/node-tools/node_modules/typescript"].filter(Boolean)) {
    try { return require(c); } catch (_) { /* next */ }
  }
  throw new Error("TypeScript not found");
})();

const V36 = resolve(root, "tests/edge/baseline-v36.ts");
// v37 (= PR #5, in production). v38 is validated by tests/integration/hardening.mjs.
const PR5 = process.env.PR5_SOURCE || resolve(root, "tests/edge/baseline-v37.ts");
const MIGRATION = resolve(root, "supabase/migrations/20261012080000_pin_match_count.sql");
const SERVICE_KEY = "synthetic-service-role-key-" + randomBytes(8).toString("hex");

// Production function fingerprints (md5 of pg_get_functiondef), read-only query on 2026-10-12.
const PROD_FINGERPRINTS = {
  clock_in_by_id: "7d2ae6b6ded68200b9d749797904cc60",
  clock_out_by_id: "40db6048bbeb7a09f50a4b899bc816db",
  end_break_by_id: "56ca414291f496bcc49727da4b88dc46",
  login_with_pin: "4fe42dbb03d86ea6a6619fa3d5c58d0d",
  manager_clock_out_staff: "21b0f2fc5903e0522260939c59d09a65",
  manager_create_staff: "ba679871846b58202f1c44d402b74f19",
  manager_update_staff: "b25c2b887014e4937db65a0c899a0a60",
  staff_status_by_id: "59d22572b44d3b9121eb1d7851b22dd9",
  start_break_by_id: "020e5f82ddd950973bb57ae4c8e6f1a0",
};

// ---------------------------------------------------------------- PostgreSQL
const PGBIN = process.env.PGBIN || spawnSync("bash", ["-c", "ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1"]).stdout.toString().trim();
const WORK = mkdtempSync(join(tmpdir(), "marinara-int-"));
const PORT = 55000 + Math.floor(Math.random() * 900);
const asPg = process.getuid() === 0 ? ["runuser", "-u", "pgtest", "--"] : [];
function sh(cmd, args) {
  const r = spawnSync(asPg[0] || cmd, asPg.length ? [...asPg.slice(1), cmd, ...args] : args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
function psqlFile(file) {
  const r = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", WORK, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-f", file], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql ${file}: ${r.stderr}`);
}
function startPg() {
  if (asPg.length) {
    spawnSync("bash", ["-c", "id pgtest >/dev/null 2>&1 || useradd -M -s /bin/false pgtest"]);
    spawnSync("chown", ["-R", "pgtest", WORK]);
  }
  chmodSync(WORK, 0o755);
  sh(`${PGBIN}/initdb`, ["-D", `${WORK}/data`, "-U", "postgres", "-A", "trust"]);
  sh(`${PGBIN}/pg_ctl`, ["-D", `${WORK}/data`, "-o", `-k ${WORK} -p ${PORT} -c listen_addresses=''`, "-l", `${WORK}/log`, "-w", "start"]);
}
function stopPg() {
  try { sh(`${PGBIN}/pg_ctl`, ["-D", `${WORK}/data`, "-m", "immediate", "stop"]); } catch (_) { /* ignore */ }
  rmSync(WORK, { recursive: true, force: true });
}

// ---------------------------------------------------------------- Edge Function loader
function loadApi(sourcePath) {
  const shim = join(WORK, "supabase-shim.mjs");
  writeFileSync(shim, "export const createClient = (...a) => globalThis.__PG_CREATE_CLIENT(...a);\n");
  const js = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/from\s+["']https:\/\/esm\.sh\/@supabase\/supabase-js@2["']/, `from ${JSON.stringify(pathToFileURL(shim).href)}`);
  let handler = null;
  globalThis.Deno = {
    env: { get: (k) => ({ SUPABASE_URL: "http://isolated.local", SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY })[k] },
    serve: (h) => { handler = h; },
  };
  const file = join(WORK, `api-${randomUUID()}.mjs`);
  writeFileSync(file, js);
  return import(pathToFileURL(file).href).then(() => {
    if (!handler) throw new Error("Deno.serve not called");
    return handler;
  });
}

// Background tasks (EdgeRuntime.waitUntil) are tracked so state is read after they finish.
const pending = [];
const realEdgeRuntime = { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})) };
globalThis.EdgeRuntime = realEdgeRuntime;
async function settle() { while (pending.length) await Promise.allSettled(pending.splice(0)); }

// Console capture: every line any version prints.
const logLines = [];
let logTag = "";
for (const k of ["log", "info", "warn", "error", "debug"]) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
    if (logTag) logLines.push({ tag: logTag, level: k, text: a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ") });
    else orig(...a);
  };
}
const out = (...a) => { const t = logTag; logTag = ""; console.log(...a); logTag = t; };

// ---------------------------------------------------------------- synthetic data
const ID = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SH = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const STAFF = [
  { id: ID(1), name: "Test General Manager", role: "manager", department: "Floor", location: "Hawthorne", active: true, pin: "900001" },
  { id: ID(2), name: "Test Kitchen Manager", role: "kitchen_manager", department: "Kitchen", location: "Hawthorne", active: true, pin: "900002" },
  { id: ID(3), name: "Test Floor Manager", role: "floor_manager", department: "Floor", location: "Hawthorne", active: true, pin: "900003" },
  { id: ID(4), name: "Test Kitchen A", role: "staff", department: "Kitchen", location: "Hawthorne", active: true, pin: "9104" },
  { id: ID(5), name: "Test Kitchen B", role: "staff", department: "Kitchen", location: "Hawthorne", active: true, pin: "9105" },
  { id: ID(6), name: "Test Floor A", role: "staff", department: "Floor", location: "Hawthorne", active: true, pin: "9106" },
  { id: ID(7), name: "Test Floor B", role: "staff", department: "Floor", location: "Hawthorne", active: true, pin: "9107" },
  { id: ID(8), name: "Test Inactive", role: "staff", department: "Kitchen", location: "Hawthorne", active: false, pin: "9108" },
  { id: ID(9), name: "Test Other Venue", role: "staff", department: "Kitchen", location: "Elsewhere", active: true, pin: "9109" },
  { id: ID(10), name: "Test Shared One", role: "staff", department: "Floor", location: "Hawthorne", active: true, pin: "9110" },
  { id: ID(11), name: "Test Shared Two", role: "staff", department: "Kitchen", location: "Hawthorne", active: true, pin: "9110" },
];
const PIN = Object.fromEntries(STAFF.map((s) => [s.id, s.pin]));
const FIXED_IDS = new Set([...STAFF.map((s) => s.id), ...Array.from({ length: 9 }, (_, i) => SH(i + 1))]);
let HASHES = null; // bcrypt cost 6 (as production), computed once so every run uses identical rows

async function reseed(admin) {
  await admin.query("truncate public.shift_audit, public.breaks, public.shifts, public.staff_sessions, public.pin_attempts, public.staff cascade");
  if (!HASHES) {
    HASHES = {};
    for (const s of STAFF) HASHES[s.id] = (await admin.query(`select extensions.crypt(${lit(s.pin)}, extensions.gen_salt('bf', 6))`)).rows[0][0];
  }
  await admin.query(`insert into public.staff (id, name, pin_hash, department, location, role, active, created_at) values ` +
    STAFF.map((s, i) => `(${lit(s.id)}, ${lit(s.name)}, ${lit(HASHES[s.id])}, ${lit(s.department)}, ${lit(s.location)}, ${lit(s.role)}, ${s.active}, now() - interval '${30 - i} days')`).join(", "));
  await admin.query(`insert into public.shifts (id, staff_id, clock_in, clock_out, status, approved, notes) values
    (${lit(SH(1))}, ${lit(ID(5))}, now() - interval '3 hours', null, 'working', false, null),
    (${lit(SH(2))}, ${lit(ID(7))}, now() - interval '2 hours', null, 'break', false, null),
    (${lit(SH(3))}, ${lit(ID(4))}, now() - interval '26 hours', now() - interval '20 hours', 'completed', false, null),
    (${lit(SH(4))}, ${lit(ID(6))}, now() - interval '50 hours', now() - interval '44 hours', 'completed', true, null),
    (${lit(SH(5))}, ${lit(ID(6))}, now() - interval '27 hours', now() - interval '21 hours', 'completed', false, 'synthetic note'),
    (${lit(SH(6))}, ${lit(ID(9))}, now() - interval '1 hours', null, 'working', false, null)`);
  await admin.query(`insert into public.breaks (shift_id, break_start, break_end) values
    (${lit(SH(2))}, now() - interval '20 minutes', null),
    (${lit(SH(3))}, now() - interval '23 hours', now() - interval '22 hours 30 minutes')`);
  await admin.query(`insert into public.pin_attempts (attempt_key, failed_attempts, locked_until, last_attempt_at) values ('hawthorne-pin-entry', 0, null, now())`);
}

async function dbState(admin) {
  const r = await admin.query(`select json_build_object(
    'staff', (select json_agg(x order by x.id) from (select id, name, department, location, role, active, md5(pin_hash) as pin_hash_md5 from public.staff) x),
    'shifts', (select json_agg(x order by x.staff_id, x.clock_in) from (select id, staff_id, clock_in, clock_out, status, approved, notes from public.shifts) x),
    'breaks', (select json_agg(x order by x.staff_id, x.break_start) from (select b.id, b.shift_id, b.break_start, b.break_end, s.staff_id from public.breaks b join public.shifts s on s.id = b.shift_id) x),
    'sessions', (select json_agg(x order by x.staff_id, x.created_at) from (select id, staff_id, length(token_hash) as hash_len, round(extract(epoch from expires_at - created_at) / 60) as ttl_minutes, revoked_at is not null as revoked, expires_at <= now() as expired, created_at from public.staff_sessions) x),
    'audit', (select json_agg(x order by x.changed_at) from (select shift_id, changed_by, old_data, new_data, changed_at from public.shift_audit) x),
    'pin_attempts', (select json_agg(x order by x.attempt_key) from (select attempt_key, failed_attempts, locked_until from public.pin_attempts) x)
  )`);
  return JSON.parse(r.rows[0][0]);
}

// Normalise values that legitimately differ between two runs (new ids, tokens, clock times).
function makeNormalizer() {
  const ids = new Map();
  return (v) => JSON.parse(
    JSON.stringify(v)
      .replace(/\b[0-9a-f]{64}\b/g, "<token>")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, (u) => {
        if (FIXED_IDS.has(u)) return u;
        if (!ids.has(u)) ids.set(u, `<new-id-${ids.size + 1}>`);
        return ids.get(u);
      })
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:\d{2})?)?/g, "<time>")
      .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} Brisbane/g, "<time> Brisbane"),
    (k, val) => (/(hours|minutes|seconds)$/i.test(k) && typeof val === "number" ? "<number>" : val)
  );
}

// ---------------------------------------------------------------- scenarios
const IPS = { cf: "198.51.100.23", real: "198.51.100.24", xff: "198.51.100.25" };

async function scenario(handler, admin) {
  const steps = [];
  const tokens = {};
  const call = async (label, body, headers = {}) => {
    const req = new Request("http://isolated.local/functions/v1/marinara-api-v2", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": IPS.xff, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const t0 = performance.now();
    const res = await handler(req);
    const ms = performance.now() - t0;
    let json = null;
    try { json = await res.json(); } catch (_) { /* empty */ }
    steps.push({ label, status: res.status, body: json, ms });
    return { status: res.status, body: json };
  };
  const login = async (label, staffId, headers) => {
    const r = await call(label, { action: "login", pin: PIN[staffId] }, headers);
    if (r.body?.session?.token) tokens[label] = r.body.session.token;
    return r.body?.session?.token;
  };
  const sessionWhere = (token) => `token_hash = ${lit(createHash("sha256").update(token).digest("hex"))}`;

  // 1. Correct login and session creation (three header layouts).
  const k1 = await login("1. login correct (Kitchen staff, cf header)", ID(4), { "cf-connecting-ip": IPS.cf });
  await login("1. login correct (Floor staff, x-real-ip)", ID(6), { "x-real-ip": IPS.real });
  await login("1. login correct (GM, x-forwarded-for only)", ID(1));
  // 2. Wrong PIN and current responses.
  await call("2. wrong PIN (6 digits)", { action: "login", pin: "000000" });
  await call("2. wrong PIN (4 digits)", { action: "login", pin: "0000" });
  await call("2. wrong PIN (letters)", { action: "login", pin: "abcd" });
  await call("2. empty PIN", { action: "login", pin: "" });
  await call("2. inactive staff PIN", { action: "login", pin: PIN[ID(8)] });
  await login("2. shared PIN (two staff)", ID(10));
  await login("2. other venue staff", ID(9));
  await call("2. invalid JSON", "not json");
  // 3. Sessions: valid, expired, revoked, fake.
  await call("3. session_status valid", { action: "session_status", token: k1 });
  await call("3. session_test valid", { action: "session_test", token: k1 });
  const exp = await login("3. login for expiry test", ID(7));
  await admin.query(`update public.staff_sessions set expires_at = now() - interval '1 minute' where ${sessionWhere(exp)}`);
  await call("3. session_status expired", { action: "session_status", token: exp });
  await call("3. clock in with expired session", { action: "session_clock_in", token: exp });
  const rev = await login("3. login for logout test", ID(6));
  await call("3. logout", { action: "session_logout", token: rev });
  await call("3. session_status after logout", { action: "session_status", token: rev });
  await call("3. logout again (idempotent)", { action: "session_logout", token: rev });
  const rev2 = await login("3. login for server-side revoke", ID(6));
  await admin.query(`update public.staff_sessions set revoked_at = now() where ${sessionWhere(rev2)}`);
  await call("3. session_status revoked", { action: "session_status", token: rev2 });
  await call("3. fake 64-hex token", { action: "session_status", token: "ab".repeat(32) });
  await call("3. empty token", { action: "session_status", token: "" });
  // 4. Clock In, Break, Clock Out (with the existing error rules).
  await call("4. clock in", { action: "session_clock_in", token: k1 });
  await call("4. clock in again", { action: "session_clock_in", token: k1 });
  await call("4. start break", { action: "session_start_break", token: k1 });
  await call("4. start break again", { action: "session_start_break", token: k1 });
  await call("4. clock out during break", { action: "session_clock_out", token: k1 });
  await call("4. end break", { action: "session_end_break", token: k1 });
  await call("4. end break again", { action: "session_end_break", token: k1 });
  await call("4. clock out", { action: "session_clock_out", token: k1 });
  await call("4. clock out again", { action: "session_clock_out", token: k1 });
  await call("4. my hours", { action: "session_my_hours", token: k1 });
  // 5. Permissions.
  await call("5. staff -> manager_working", { action: "manager_working", token: k1 });
  await call("5. staff -> manager_clock_out_staff", { action: "manager_clock_out_staff", token: k1, shift_id: SH(1), clock_out: new Date(Date.now() - 60e3).toISOString() });
  await call("5. no token -> manager_team", { action: "manager_team" });
  const km = await login("5. login Kitchen Manager", ID(2));
  const fm = await login("5. login Floor Manager", ID(3));
  const gm = tokens["1. login correct (GM, x-forwarded-for only)"];
  for (const [who, tok] of [["KM", km], ["FM", fm], ["GM", gm]]) {
    for (const a of ["manager_working", "manager_team", "manager_approvals", "manager_hours", "manager_dashboard"]) {
      await call(`5. ${who} ${a}`, { action: a, token: tok });
    }
  }
  const outAt = () => new Date(Date.now() - 60e3).toISOString();
  await call("5. KM clocks out Floor staff (denied)", { action: "manager_clock_out_staff", token: km, shift_id: SH(2), clock_out: outAt() });
  await call("5. KM clocks out other venue (denied)", { action: "manager_clock_out_staff", token: km, shift_id: SH(6), clock_out: outAt() });
  await call("5. KM clocks out Kitchen staff", { action: "manager_clock_out_staff", token: km, shift_id: SH(1), clock_out: outAt() });
  await call("5. FM clocks out Floor staff on break", { action: "manager_clock_out_staff", token: fm, shift_id: SH(2), clock_out: outAt() });
  await call("5. FM approves Kitchen shift (denied)", { action: "manager_approve_shift", token: fm, shift_id: SH(3) });
  await call("5. FM approves Floor shift", { action: "manager_approve_shift", token: fm, shift_id: SH(5) });
  await call("5. GM approves Kitchen shift", { action: "manager_approve_shift", token: gm, shift_id: SH(3) });
  await call("5. manager with expired session", { action: "manager_working", token: exp });
  // Concurrency: 12 simultaneous logins (correct and wrong).
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    (async () => {
      const req = new Request("http://isolated.local/functions/v1/marinara-api-v2", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": IPS.cf }, body: JSON.stringify({ action: "login", pin: i % 3 === 0 ? "000000" : PIN[ID(5)] }) });
      const r = await handler(req);
      const b = await r.json();
      return { status: r.status, ok: !!b?.session?.token, error: b?.error ?? null };
    })()));
  steps.push({ label: "concurrency: 12 parallel logins", status: 0, body: burst, ms: 0 });
  await settle();
  return { steps, tokens };
}

async function runVersion(name, src, admin, envLabel, opts = {}) {
  const handler = await loadApi(src);
  await reseed(admin);
  logTag = `${envLabel}/${name}`;
  const r = await scenario(handler, admin);
  await settle();
  const state = await dbState(admin);
  logTag = "";
  return { ...r, state, handler };
}

// ---------------------------------------------------------------- failure injection
async function failureRuns(handlerV36, handlerPr5, admin, setupFailure, label) {
  const results = {};
  for (const [name, h] of [["v36", handlerV36], ["PR5", handlerPr5]]) {
    await reseed(admin);
    const undo = await setupFailure();
    logTag = `failure:${label}/${name}`;
    const t0 = performance.now();
    const req = new Request("http://isolated.local/functions/v1/marinara-api-v2", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": IPS.cf }, body: JSON.stringify({ action: "login", pin: PIN[ID(4)] }) });
    const res = await h(req);
    const ms = performance.now() - t0;
    const body = await res.json();
    const token = body?.session?.token;
    const clock = await h(new Request("http://isolated.local/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "session_clock_in", token }) }));
    const clockBody = await clock.json();
    const out = await h(new Request("http://isolated.local/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "session_clock_out", token }) }));
    await out.json();
    await settle();
    await new Promise((r) => setTimeout(r, 300));
    await undo();
    logTag = "";
    results[name] = { login: { status: res.status, body }, ms, clockIn: { status: clock.status, body: clockBody }, clockOut: out.status, state: await dbState(admin) };
  }
  return results;
}

// ---------------------------------------------------------------- main
let failures = 0;
const check = (name, fn) => {
  try { fn(); out(`  ✔ ${name}`); } catch (e) { failures++; out(`  ✖ ${name}\n      ${String(e.message).split("\n").slice(0, 12).join("\n      ")}`); }
};
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };

startPg();
let admin, svc;
try {
  psqlFile(resolve(root, "tests/db/schema_snapshot.sql"));
  psqlFile(resolve(root, "supabase/migrations/20261012000000_add_manager_clock_out_staff.sql"));
  psqlFile(resolve(here, "prod_manager_functions.sql")); // after the migration: exact production text wins
  admin = await new Pool({ socketPath: join(WORK, `.s.PGSQL.${PORT}`), size: 1, init: ["set timezone to 'UTC'"] }).open();
  // The Edge Function talks to the database as service_role (like PostgREST does).
  svc = await new Pool({ socketPath: join(WORK, `.s.PGSQL.${PORT}`), size: 6, init: ["set role service_role", "set timezone to 'UTC'"] }).open();

  out("\n== Fidelity of the isolated database ==");
  const fp = Object.fromEntries((await admin.query(`select p.proname, md5(pg_get_functiondef(p.oid)) from pg_proc p where p.pronamespace = 'public'::regnamespace`)).rows);
  for (const [fn, md5] of Object.entries(PROD_FINGERPRINTS)) check(`function ${fn} identical to production`, () => assert.equal(fp[fn], md5));
  check("pin_match_count absent (as in production today)", () => assert.equal(fp.pin_match_count, undefined));

  const results = {};
  for (const env of ["A: production DB as today (no migration)", "B: with optional migration pin_match_count"]) {
    if (env.startsWith("B")) psqlFile(MIGRATION);
    globalThis.__PG_CREATE_CLIENT = makeCreateClient(svc);
    out(`\n== Environment ${env} ==`);
    const a = await runVersion("v36", V36, admin, env[0]);
    const b = await runVersion("PR5", PR5, admin, env[0]);
    results[env[0]] = { a, b };
    const normA = makeNormalizer(), normB = makeNormalizer();
    const viewA = normA({ steps: a.steps.map(({ label, status, body }) => ({ label, status, body })), state: a.state });
    const viewB = normB({ steps: b.steps.map(({ label, status, body }) => ({ label, status, body })), state: b.state });
    for (let i = 0; i < viewA.steps.length; i++) {
      const sa = viewA.steps[i], sb = viewB.steps[i];
      check(`${sa.label} -> ${sa.status}${sa.status ? " " + JSON.stringify(sa.body).slice(0, 70) : ""}`, () => assert.deepEqual(sb, sa));
    }
    check("database state after the scenario: identical (staff, PINs, shifts, breaks, sessions, audit, PIN lock)", () => assert.deepEqual(viewB.state, viewA.state));
    check("no real-looking data: every staff row is synthetic", () => assert.ok(a.state.staff.every((s) => s.name.startsWith("Test "))));
    // Expectations about the current behaviour itself (same for both versions).
    const by = (l) => a.steps.find((s) => s.label === l);
    check("login creates a 12-hour session; token stored only as a hash", () => {
      assert.equal(by("1. login correct (Kitchen staff, cf header)").status, 200);
      const s = a.state.sessions.find((x) => x.staff_id === ID(4));
      assert.equal(s.hash_len, 64); assert.equal(Number(s.ttl_minutes), 720);
    });
    check("expired / revoked / fake sessions are refused (401)", () => {
      for (const l of ["3. session_status expired", "3. session_status after logout", "3. session_status revoked", "3. fake 64-hex token", "3. clock in with expired session", "5. manager with expired session"]) assert.equal(by(l).status, 401, l);
    });
    check("staff cannot use manager actions (403); scoped managers denied outside their department", () => {
      assert.equal(by("5. staff -> manager_working").status, 403);
      assert.equal(by("5. staff -> manager_clock_out_staff").status, 403);
      assert.notEqual(by("5. KM clocks out Floor staff (denied)").status, 200);
      assert.notEqual(by("5. FM approves Kitchen shift (denied)").status, 200);
      assert.equal(by("5. KM clocks out Kitchen staff").status, 200);
    });
    check("full shift stored once: 1 completed shift + 1 closed break for the test staff", () => {
      const mine = a.state.shifts.filter((x) => x.staff_id === ID(4) && x.id !== SH(3));
      assert.equal(mine.length, 1); assert.equal(mine[0].status, "completed");
      assert.equal(a.state.breaks.filter((x) => x.shift_id === mine[0].id && x.break_end).length, 1);
    });
  }

  // Observation lines: present only in PR #5, never in v36.
  out("\n== Observation output (PR #5) ==");
  const obsA = logLines.filter((l) => l.tag === "A/PR5" && l.text.startsWith("[login-observe]")).map((l) => l.text);
  const obsB = logLines.filter((l) => l.tag === "B/PR5" && l.text.startsWith("[login-observe]")).map((l) => l.text);
  const tmpl = (arr) => [...new Set(arr.map((t) => t.replace(/device=[0-9a-f]{16}/, "device=<tag>").replace(/staff=[0-9a-f-]{36}/, "staff=<id>")))].sort();
  out("  env A (no migration):", JSON.stringify(tmpl(obsA)));
  out("  env B (migration):   ", JSON.stringify(tmpl(obsB)));
  check("v36 prints no observation lines", () => assert.equal(logLines.filter((l) => /\/v36$/.test(l.tag) && l.text.includes("login-observe")).length, 0));
  check("env B detects the shared PIN (matches=2) and wrong PINs", () => {
    assert.ok(obsB.some((t) => /outcome=shared_pin matches=2/.test(t)));
    assert.ok(obsB.some((t) => /outcome=wrong_pin/.test(t)));
  });
  check("env A (migration missing): fixed text only, login unaffected", () => assert.ok(obsA.includes("[login-observe] shared-PIN check unavailable")));
  check("source header detected: cf, real, xff", () => { for (const s of ["src=cf", "src=real", "src=xff"]) assert.ok(obsB.some((t) => t.includes(s)), s); });
  const otherA = (tag) => tmpl(logLines.filter((l) => l.tag === tag && !l.text.startsWith("[login-observe]")).map((l) => `${l.level}: ${l.text}`));
  check("all other log lines identical between v36 and PR #5", () => {
    assert.deepEqual(otherA("A/PR5"), otherA("A/v36"));
    assert.deepEqual(otherA("B/PR5"), otherA("B/v36"));
  });

  // Failure of the observation after a successful login.
  out("\n== Observation failures after a successful login ==");
  const hV36 = results.B.a.handler, hPr5 = results.B.b.handler;
  const failuresToTest = [
    ["migration missing (function not found)", async () => { await admin.query("drop function public.pin_match_count(text)"); return async () => psqlFile(MIGRATION); }],
    ["shared-PIN check raises an error", async () => {
      await admin.query("create or replace function public.pin_match_count(p_pin text) returns integer language plpgsql as $$ begin raise exception 'synthetic failure with secret-looking text %', p_pin; end $$");
      return async () => psqlFile(MIGRATION);
    }],
    ["shared-PIN check hangs 8 s (3 s timeout)", async () => {
      await admin.query("create or replace function public.pin_match_count(p_pin text) returns integer language sql as $$ select pg_sleep(8)::text::integer $$");
      return async () => psqlFile(MIGRATION);
    }],
    ["EdgeRuntime.waitUntil unavailable", async () => { globalThis.EdgeRuntime = undefined; return async () => { globalThis.EdgeRuntime = realEdgeRuntime; }; }],
    ["crypto.subtle.importKey fails", async () => {
      const orig = crypto.subtle.importKey;
      crypto.subtle.importKey = () => Promise.reject(new Error("synthetic crypto failure"));
      return async () => { crypto.subtle.importKey = orig; };
    }],
    ["console.warn throws", async () => {
      const orig = console.warn;
      console.warn = () => { throw new Error("synthetic logger failure"); };
      return async () => { console.warn = orig; };
    }],
  ];
  for (const [label, setup] of failuresToTest) {
    const r = await failureRuns(hV36, hPr5, admin, setup, label);
    const n1 = makeNormalizer(), n2 = makeNormalizer();
    check(`${label}: login ${r.PR5.login.status}, Clock In ${r.PR5.clockIn.status}, Clock Out ${r.PR5.clockOut}; same as v36; response ${Math.round(r.PR5.ms)} ms (v36 ${Math.round(r.v36.ms)} ms)`, () => {
      assert.equal(r.PR5.login.status, 200);
      assert.equal(r.PR5.clockIn.status, 200);
      assert.equal(r.PR5.clockOut, 200);
      assert.deepEqual(n2({ l: r.PR5.login, c: r.PR5.clockIn, o: r.PR5.clockOut, s: r.PR5.state }), n1({ l: r.v36.login, c: r.v36.clockIn, o: r.v36.clockOut, s: r.v36.state }));
      assert.ok(r.PR5.ms < r.v36.ms + 1000, "login must not wait for the observation");
    });
  }
  const failLines = logLines.filter((l) => l.tag.startsWith("failure:") && l.tag.endsWith("/PR5") && l.text.includes("login-observe")).map((l) => `${l.tag.split("/")[0].slice(8)} => ${l.text}`);
  out("  observation lines during failures:\n   ", [...new Set(failLines)].join("\n    "));

  // Timing.
  out("\n== Response time (env B, sequential, interleaved v36 / PR #5) ==");
  await reseed(admin);
  globalThis.__PG_CREATE_CLIENT = makeCreateClient(svc);
  const times = { v36: { ok: [], wrong: [], status: [] }, PR5: { ok: [], wrong: [], status: [] } };
  const tok = {};
  logTag = "timing";
  for (let i = 0; i < 40; i++) {
    for (const [name, h] of i % 2 ? [["v36", hV36], ["PR5", hPr5]] : [["PR5", hPr5], ["v36", hV36]]) {
      for (const [kind, body] of [["ok", { action: "login", pin: PIN[ID(5)] }], ["wrong", { action: "login", pin: "000000" }], ["status", { action: "session_status", token: tok[name] || "x" }]]) {
        const t0 = performance.now();
        const r = await h(new Request("http://isolated.local/x", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": IPS.cf }, body: JSON.stringify(body) }));
        const b = await r.json();
        times[name][kind].push(performance.now() - t0);
        if (b?.session?.token) tok[name] = b.session.token;
      }
    }
    await settle();
  }
  logTag = "";
  for (const kind of ["ok", "wrong", "status"]) {
    out(`  ${kind.padEnd(6)} v36 median ${median(times.v36[kind]).toFixed(1)} ms p95 ${p95(times.v36[kind]).toFixed(1)} ms | PR #5 median ${median(times.PR5[kind]).toFixed(1)} ms p95 ${p95(times.PR5[kind]).toFixed(1)} ms`);
  }
  check("PR #5 response time within 20% (+5 ms) of v36 for every request type", () => {
    for (const kind of ["ok", "wrong", "status"]) assert.ok(median(times.PR5[kind]) <= median(times.v36[kind]) * 1.2 + 5, kind);
  });

  // Privacy of the logs.
  out("\n== Log privacy ==");
  const all = logLines.map((l) => l.text).join("\n");
  const allNoIds = all.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>");
  const issued = [...new Set([...Object.values(results.A.a.tokens), ...Object.values(results.A.b.tokens), ...Object.values(results.B.a.tokens), ...Object.values(results.B.b.tokens), ...Object.values(tok)])];
  check(`${logLines.length} log lines captured, none contains a PIN`, () => { for (const p of new Set(STAFF.map((s) => s.pin).concat(["000000", "0000"]))) assert.ok(!new RegExp(`(^|[^0-9a-f])${p}([^0-9a-f]|$)`).test(allNoIds), p); });
  check(`none contains any of the ${issued.length} session tokens, or their hashes`, () => {
    for (const t of issued) { assert.ok(!all.includes(t)); assert.ok(!all.includes(createHash("sha256").update(t).digest("hex"))); }
    assert.ok(!/\b[0-9a-f]{64}\b/.test(all));
  });
  check("none contains an IP address", () => { for (const ip of Object.values(IPS)) assert.ok(!all.includes(ip), ip); assert.ok(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(all)); });
  check("none contains the service key or the injected error text", () => { assert.ok(!all.includes(SERVICE_KEY)); assert.ok(!all.includes("secret-looking")); });
  check("PR #5 adds only fixed-format observation lines", () => {
    const added = logLines.filter((l) => l.tag.endsWith("PR5") && l.text.includes("login-observe")).map((l) => l.text);
    for (const t of added) assert.match(t, /^\[login-observe\] (outcome=(ok|wrong_pin) device=[0-9a-f]{16} src=(cf|real|xff|none)|outcome=shared_pin matches=\d+ staff=[0-9a-f-]{36}|shared-PIN check unavailable|skipped: (timeout|error))$/);
  });

  // Migration rollback.
  out("\n== Optional migration: rollback ==");
  await admin.query("drop function if exists public.pin_match_count(text)");
  const fp2 = Object.fromEntries((await admin.query(`select p.proname, md5(pg_get_functiondef(p.oid)) from pg_proc p where p.pronamespace = 'public'::regnamespace`)).rows);
  check("after rollback the database functions equal production again", () => { assert.equal(fp2.pin_match_count, undefined); for (const [fn, md5] of Object.entries(PROD_FINGERPRINTS)) assert.equal(fp2[fn], md5); });
} finally {
  logTag = "";
  admin?.close(); svc?.close();
  stopPg();
}
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL INTEGRATED CHECKS PASSED");
process.exit(failures ? 1 : 0);
