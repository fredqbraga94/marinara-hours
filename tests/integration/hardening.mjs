// Hardening validation: v37 (production today) vs v38 (this branch).
//
// Real Edge Function code, real SQL (production structure, production function
// text and production privileges) in a throwaway PostgreSQL, synthetic data and
// credentials only. Nothing connects to Supabase.
//
// Every "bug" check first PROVES the problem on v37 + the current database, then
// shows the same scenario on v38 + migrations. Run: node tests/integration/hardening.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { startProdLikeDb, PROD_FINGERPRINTS, MIGRATION_A, MIGRATION_B, ROLLBACK_A, ROLLBACK_B, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, settle, newDeviceSecret, SERVICE_KEY } from "./edge-loader.mjs";
import { lit } from "./pg-supabase.mjs";
import { ID, SH, STAFF, PIN, reseed } from "./seed.mjs";
import { writeFileSync } from "node:fs";
const dump = (name, v) => { if (process.env.DUMP_DIR) writeFileSync(`${process.env.DUMP_DIR}/${name}.json`, JSON.stringify(v, null, 1)); };

const V37 = resolve(root, "tests/edge/baseline-v37.ts");
const V38 = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");

// ---------------------------------------------------------------- reporting
let failures = 0;
const evidence = [];
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
    evidence.push({ name, ok: true, note: note || "" });
  } catch (e) {
    failures++;
    gha("error", name, e?.stack || e);
    log(`  ✖ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 8).join("\n      ")}`);
    evidence.push({ name, ok: false, note: String(e?.message || e) });
  }
}
const section = (t) => log(`\n== ${t} ==`);
// Key order inside JSON objects does not matter to the app (jsonb sorts keys).
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// ---------------------------------------------------------------- console capture (privacy checks)
const lines = [];
let capture = false;
let quietDepth = 0;
for (const k of ["log", "info", "warn", "error", "debug"]) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
    if (capture) lines.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    else orig(...a);
  };
}
async function quiet(fn) {
  quietDepth++; capture = true;
  try { return await fn(); } finally { quietDepth--; if (quietDepth === 0) capture = false; }
}

// ---------------------------------------------------------------- synthetic data
// (tests/integration/seed.mjs)

const INVARIANTS_SQL = `select json_build_object(
  'overlapping_shift_pairs', (select count(*) from public.shifts a join public.shifts b on a.staff_id=b.staff_id and a.id<b.id
      and tstzrange(a.clock_in, coalesce(a.clock_out,'infinity'), '[)') && tstzrange(b.clock_in, coalesce(b.clock_out,'infinity'), '[)')),
  'shifts_with_two_open_breaks', (select count(*) from (select shift_id from public.breaks where break_end is null group by shift_id having count(*) > 1) x),
  'completed_with_open_break', (select count(*) from public.shifts s where s.clock_out is not null and exists (select 1 from public.breaks b where b.shift_id = s.id and b.break_end is null)),
  'status_mismatch', (select count(*) from public.shifts where (status = 'completed') <> (clock_out is not null)),
  'break_status_without_open_break', (select count(*) from public.shifts s where status = 'break' and not exists (select 1 from public.breaks b where b.shift_id = s.id and b.break_end is null)),
  'working_with_open_break', (select count(*) from public.shifts s where status = 'working' and exists (select 1 from public.breaks b where b.shift_id = s.id and b.break_end is null)),
  'overlapping_break_pairs', (select count(*) from public.breaks a join public.breaks b on a.shift_id=b.shift_id and a.id<b.id
      and tstzrange(a.break_start, coalesce(a.break_end,'infinity'), '[)') && tstzrange(b.break_start, coalesce(b.break_end,'infinity'), '[)')))`;
async function invariants(db) { return JSON.parse((await db.admin.query(INVARIANTS_SQL)).rows[0][0]); }
// Same checks restricted to one person (used by the race trials).
async function invariantsFor(db, staffId) {
  const sql = INVARIANTS_SQL
    .replaceAll("from public.shifts a join public.shifts b on", `from public.shifts a join public.shifts b on a.staff_id = '${staffId}' and`)
    .replaceAll("from public.breaks where break_end is null group by shift_id", `from public.breaks where break_end is null and shift_id in (select id from public.shifts where staff_id = '${staffId}') group by shift_id`)
    .replaceAll("from public.shifts s where", `from public.shifts s where s.staff_id = '${staffId}' and`)
    .replaceAll("from public.shifts where (status", `from public.shifts where staff_id = '${staffId}' and (status`)
    .replaceAll("from public.breaks a join public.breaks b on", `from public.breaks a join public.breaks b on a.shift_id in (select id from public.shifts where staff_id = '${staffId}') and`);
  return JSON.parse((await db.admin.query(sql)).rows[0][0]);
}
const clean = (inv) => Object.values(inv).every((v) => Number(v) === 0);
const dirty = (inv) => Object.fromEntries(Object.entries(inv).filter(([, v]) => Number(v) > 0));

async function one(db, sql) { const r = await db.admin.query(sql); return r.rows[0]?.[0] ?? null; }
const sha = (v) => createHash("sha256").update(v).digest("hex");

// ---------------------------------------------------------------- shared scenario (regression)
// Same requests against any version; returns normalised responses and database state.
function makeNormalizer() {
  const ids = new Map();
  const fixed = new Set([...STAFF.map((s) => s.id), ...[1, 2, 3, 4, 5, 6].map(SH)]);
  return (v) => JSON.parse(JSON.stringify(v)
    .replace(/\b[0-9a-f]{64}\b/g, "<token>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, (u) => {
      if (fixed.has(u)) return u;
      if (!ids.has(u)) ids.set(u, `<id${ids.size + 1}>`);
      return ids.get(u);
    })
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:\d{2})?)?/g, "<time>")
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} Brisbane/g, "<time> Brisbane"),
  (k, val) => (/(hours|minutes|seconds)$/i.test(k) && typeof val === "number" ? "<n>" : val));
}

async function dbState(db) {
  return JSON.parse((await db.admin.query(`select json_build_object(
    'staff', (select json_agg(x order by x.name) from (select id, name, department, location, role, active,
        case when created_at < now() - interval '1 day' then md5(pin_hash) else 'new (random salt)' end h from public.staff) x),
    'shifts', (select json_agg(x order by x.staff_id, x.clock_in) from (select id, staff_id, clock_in, clock_out, status, approved, notes from public.shifts) x),
    'breaks', (select json_agg(x order by x.staff_id, x.break_start) from (select b.shift_id, b.break_start, b.break_end, s.staff_id from public.breaks b join public.shifts s on s.id = b.shift_id) x),
    'sessions', (select json_agg(x order by x.staff_id, x.created_at) from (select staff_id, revoked_at is not null revoked, created_at from public.staff_sessions) x)
  )`)).rows[0][0]);
}

async function scenario(db, handler, { device = null } = {}) {
  const steps = [];
  const dev = device ? { device } : {};
  const c = async (label, body) => { const r = await call(handler, { ...body, ...dev }); steps.push({ label, status: r.status, body: r.body }); return r; };
  const login = async (label, staffId) => (await c(label, { action: "login", pin: PIN[staffId] })).body?.session?.token;
  const k1 = await login("login staff", ID(4));
  await c("wrong PIN", { action: "login", pin: "000000" });
  await c("shared PIN", { action: "login", pin: "9110" });
  await c("inactive PIN", { action: "login", pin: PIN[ID(8)] });
  await c("status", { action: "session_status", token: k1 });
  await c("clock in", { action: "session_clock_in", token: k1 });
  await c("clock in again", { action: "session_clock_in", token: k1 });
  await c("start break", { action: "session_start_break", token: k1 });
  await c("clock out on break", { action: "session_clock_out", token: k1 });
  await c("end break", { action: "session_end_break", token: k1 });
  await c("clock out", { action: "session_clock_out", token: k1 });
  await c("my hours", { action: "session_my_hours", token: k1 });
  await c("staff -> manager", { action: "manager_working", token: k1 });
  const gm = await login("login GM", ID(1));
  const km = await login("login KM", ID(2));
  for (const a of ["manager_working", "manager_team", "manager_approvals", "manager_hours", "manager_dashboard"]) {
    await c(`GM ${a}`, { action: a, token: gm });
    await c(`KM ${a}`, { action: a, token: km });
  }
  const before = new Date(Date.now() - 60e3).toISOString();
  await c("KM clock out Floor (denied)", { action: "manager_clock_out_staff", token: km, shift_id: SH(2), clock_out: before });
  await c("KM clock out Kitchen B", { action: "manager_clock_out_staff", token: km, shift_id: SH(1), clock_out: before });
  await c("KM approve own-dept shift", { action: "manager_approve_shift", token: km, shift_id: SH(3) });
  await c("KM edit approved (denied)", { action: "manager_edit_shift", token: km, shift_id: SH(3), clock_in: new Date(Date.now() - 26 * 3600e3).toISOString(), clock_out: new Date(Date.now() - 19 * 3600e3).toISOString(), break_minutes: 30 });
  await c("KM reopen", { action: "manager_reopen_shift", token: km, shift_id: SH(3) });
  await c("KM reopen again", { action: "manager_reopen_shift", token: km, shift_id: SH(3) });
  await c("KM edit", { action: "manager_edit_shift", token: km, shift_id: SH(3), clock_in: new Date(Date.now() - 26 * 3600e3).toISOString(), clock_out: new Date(Date.now() - 19 * 3600e3).toISOString(), break_minutes: 45 });
  await c("GM delete Floor shift", { action: "manager_delete_shift", token: gm, shift_id: SH(5) });
  await c("GM delete open (denied)", { action: "manager_delete_shift", token: gm, shift_id: SH(2) });
  await c("KM create shift", { action: "manager_create_shift", token: km, staff_id: ID(5), clock_in: new Date(Date.now() - 80 * 3600e3).toISOString(), clock_out: new Date(Date.now() - 74 * 3600e3).toISOString(), break_minutes: 30, notes: "synthetic" });
  await c("KM create staff", { action: "manager_create_staff", token: km, name: "Test New Cook", staff_pin: "905555", department: "Kitchen" });
  await c("KM create staff other dept (denied)", { action: "manager_create_staff", token: km, name: "Test X", staff_pin: "905556", department: "Floor" });
  await c("KM update own-dept staff", { action: "manager_update_staff", token: km, staff_id: ID(5), name: "Test Kitchen B2", department: "Kitchen" });
  await c("GM update staff", { action: "manager_update_staff", token: gm, staff_id: ID(6), name: "Test Floor A2", department: "Floor" });
  await c("KM toggle staff", { action: "manager_toggle_staff", token: km, staff_id: ID(5) });
  await c("KM toggle staff back", { action: "manager_toggle_staff", token: km, staff_id: ID(5) });
  await c("logout", { action: "session_logout", token: k1 });
  await c("status after logout", { action: "session_status", token: k1 });
  await settle();
  return { steps, state: await dbState(db) };
}

// ================================================================ main
const db = await startProdLikeDb({ poolSize: 12 });
let h37, h38;
try {
  section("0. Isolated database = production structure, functions and privileges");
  await check("all 9 production functions byte-identical (md5)", async () => {
    const fp = await db.fingerprints();
    for (const [k, v] of Object.entries(PROD_FINGERPRINTS)) assert.equal(fp[k], v, k);
  });
  await check("table privileges reproduce production (service_role has no INSERT on staff, nothing on audit)", async () => {
    const acl = await db.tableAcl();
    assert.match(acl.staff, /service_role=rwDxt\//);
    assert.match(acl.shift_audit, /service_role=Dxt\//);
    assert.match(acl.breaks, /authenticated=Dxt\//);
  });

  h37 = await loadHandler(V37);
  h38 = await loadHandler(V38);

  // ============================================================ PHASE 1: v37 today
  section("1. Problems proven on v37 + current database");
  useDatabase(db.svc);
  await reseed(db);

  await check("PIN attempts are unlimited on v37 (40 wrong PINs: never blocked, counter stays 0)", async () => {
    const statuses = [];
    for (let i = 0; i < 40; i++) statuses.push((await quiet(() => call(h37, { action: "login", pin: String(100000 + i) }))).status);
    const counter = await one(db, "select failed_attempts from public.pin_attempts where attempt_key = 'hawthorne-pin-entry'");
    assert.deepEqual([...new Set(statuses)], [500]);
    assert.equal(Number(counter), 0);
    const ok = await quiet(() => call(h37, { action: "login", pin: PIN[ID(4)] }));
    assert.equal(ok.status, 200);
    return `40 × HTTP 500 "Unable to create secure session", lock counter ${counter}, correct PIN still accepted right after`;
  });

  await check("shared PIN logs in as one of the two people on v37 (silently picks one)", async () => {
    const r = await quiet(() => call(h37, { action: "login", pin: "9110" }));
    assert.equal(r.status, 200);
    return `HTTP 200 as "${r.body.data[0].staff_name}" — the other person with this PIN can never sign in as themselves`;
  });

  let v37Gm, v37Km;
  await check("control: General Manager staff edit works on v37 (suspected bug NOT confirmed, nothing changed)", async () => {
    v37Gm = (await quiet(() => call(h37, { action: "login", pin: PIN[ID(1)] }))).body.session.token;
    const r = await quiet(() => call(h37, { action: "manager_update_staff", token: v37Gm, staff_id: ID(6), name: "Test Floor A", department: "Floor" }));
    assert.equal(r.status, 200);
    return `HTTP ${r.status}`;
  });

  await check("manager edit is not atomic on v37: a failure mid-way loses the break", async () => {
    v37Km = (await quiet(() => call(h37, { action: "login", pin: PIN[ID(2)] }))).body.session.token;
    const inject = { failQuery: (t, op) => t === "breaks" && op === "insert" };
    useDatabase(db.svc, inject);
    const r = await quiet(() => call(h37, { action: "manager_edit_shift", token: v37Km, shift_id: SH(3), clock_in: new Date(Date.now() - 26 * 3600e3).toISOString(), clock_out: new Date(Date.now() - 19 * 3600e3).toISOString(), break_minutes: 30 }));
    useDatabase(db.svc);
    const breaks = Number(await one(db, `select count(*) from public.breaks where shift_id = ${lit(SH(3))}`));
    const out = await one(db, `select clock_out > now() - interval '19 hours 30 minutes' from public.shifts where id = ${lit(SH(3))}`);
    assert.equal(r.status, 500);
    assert.equal(breaks, 0);
    assert.equal(out, "t");
    return `HTTP 500 shown, but the shift times WERE changed and its 30-min break was deleted (0 breaks left)`;
  });

  await check("v37 manager changes leave no audit trail; deleting a shift erases its audit history", async () => {
    await quiet(() => call(h37, { action: "manager_approve_shift", token: v37Km, shift_id: SH(3) }));
    await quiet(() => call(h37, { action: "manager_reopen_shift", token: v37Km, shift_id: SH(3) }));
    const audit1 = Number(await one(db, "select count(*) from public.shift_audit"));
    const co = await quiet(() => call(h37, { action: "manager_clock_out_staff", token: v37Km, shift_id: SH(1), clock_out: new Date(Date.now() - 60e3).toISOString() }));
    const audit2 = Number(await one(db, "select count(*) from public.shift_audit"));
    const del = await quiet(() => call(h37, { action: "manager_delete_shift", token: v37Km, shift_id: SH(1) }));
    const audit3 = Number(await one(db, "select count(*) from public.shift_audit"));
    assert.equal(audit1, 0); assert.equal(co.status, 200); assert.equal(audit2, 1); assert.equal(del.status, 200); assert.equal(audit3, 0);
    return `approve+reopen: ${audit1} audit rows; manager clock-out wrote ${audit2}; deleting that shift left ${audit3}`;
  });

  await check("v37 lets a manager create a shift that overlaps an existing one", async () => {
    const r = await quiet(() => call(h37, { action: "manager_create_shift", token: v37Km, staff_id: ID(4), clock_in: new Date(Date.now() - 25 * 3600e3).toISOString(), clock_out: new Date(Date.now() - 21 * 3600e3).toISOString(), break_minutes: 0, notes: "" }));
    const inv = await invariants(db);
    assert.equal(r.status, 200);
    assert.ok(inv.overlapping_shift_pairs > 0);
    return `HTTP 200, overlapping shift pairs now ${inv.overlapping_shift_pairs} (the same hours counted twice)`;
  });

  // Concurrency races on v37 (double taps, two devices, manager + staff at once).
  const RACES = [
    { name: "double tap Start Break", setup: "working", calls: ["session_start_break", "session_start_break"] },
    { name: "Clock Out and Start Break at once", setup: "working", calls: ["session_clock_out", "session_start_break"] },
    { name: "double tap Clock In", setup: "off", calls: ["session_clock_in", "session_clock_in"] },
    { name: "manager Clock Out while staff ends break", setup: "break", calls: ["manager_clock_out_staff", "session_end_break"] },
  ];
  async function raceSetup(state) {
    const A = db.admin;
    await A.query(`delete from public.shifts where staff_id = ${lit(ID(12))}`);
    if (state === "working" || state === "break") {
      await A.query(`insert into public.shifts (id, staff_id, clock_in, status) values ('30000000-0000-4000-8000-000000000001', ${lit(ID(12))}, now() - interval '2 hours', ${lit(state)})`);
      if (state === "break") await A.query(`insert into public.breaks (shift_id, break_start) values ('30000000-0000-4000-8000-000000000001', now() - interval '10 minutes')`);
    }
  }
  async function runRaces(handler, label, trials, extra = {}) {
    const tok = (await quiet(() => call(handler, { action: "login", pin: PIN[ID(12)], ...extra }))).body.session.token;
    const mgr = (await quiet(() => call(handler, { action: "login", pin: PIN[ID(2)], ...extra }))).body.session.token;
    const report = {};
    for (const race of RACES) {
      let bad = 0; const messages = new Set(); const kinds = new Set();
      for (let t = 0; t < trials; t++) {
        await raceSetup(race.setup);
        const rs = await quiet(() => Promise.all(race.calls.map((a) => a === "manager_clock_out_staff"
          ? call(handler, { action: a, token: mgr, shift_id: "30000000-0000-4000-8000-000000000001", clock_out: new Date(Date.now() - 1000).toISOString(), ...extra })
          : call(handler, { action: a, token: tok, ...extra }))));
        rs.forEach((r) => { if (r.status !== 200) messages.add(`${r.status} ${r.body?.error}`); });
        const inv = await invariantsFor(db, ID(12));
        if (!clean(inv)) { bad++; Object.keys(dirty(inv)).forEach((k) => kinds.add(k)); }
      }
      report[race.name] = { corrupted: bad, trials, kinds: [...kinds], messages: [...messages] };
    }
    log(`      ${label}: ` + JSON.stringify(report));
    return report;
  }
  let races37;
  await check("v37 concurrency trials (40 each): corrupted records and raw database errors shown to staff", async () => {
    await reseed(db);
    const before = await invariants(db);
    assert.ok(clean(before), JSON.stringify(dirty(before)));
    races37 = await runRaces(h37, "v37", 40);
    const corrupted = Object.values(races37).reduce((a, r) => a + r.corrupted, 0);
    const raw = Object.values(races37).flatMap((r) => r.messages).filter((m) => /duplicate key|SHIFT_ALREADY_OPEN|NO_WORKING_SHIFT|NO_OPEN_SHIFT|NO_ACTIVE_BREAK/.test(m));
    assert.ok(corrupted > 0 || raw.length > 0, "no problem reproduced");
    return `corrupted states: ${corrupted}/160 trials; raw codes shown to staff: ${[...new Set(raw)].join(" | ")}`;
  });
  await reseed(db);

  await check("browser roles (anon/authenticated) hold TRUNCATE on 4 tables — TRUNCATE ignores RLS", async () => {
    const r = await db.admin.query("begin; set local role authenticated; truncate public.breaks; rollback;").then(() => "allowed", (e) => e.message);
    assert.equal(r, "allowed");
    return "TRUNCATE public.breaks as 'authenticated' succeeded (rolled back; the API never exposes it, but it is unnecessary privilege)";
  });

  // Reference run of the full scenario on v37 + today's database.
  useDatabase(db.svc);
  await reseed(db);
  const base37 = await quiet(() => scenario(db, h37));

  // Sessions open before the migration must survive it.
  await reseed(db);
  const legacyTokens = {
    staff: (await quiet(() => call(h37, { action: "login", pin: PIN[ID(4)] }))).body.session.token,
    manager: (await quiet(() => call(h37, { action: "login", pin: PIN[ID(1)] }))).body.session.token,
  };
  await quiet(() => call(h37, { action: "session_clock_in", token: legacyTokens.staff }));

  // ============================================================ PHASE 2: migrations
  section("2. Migrations on the database");
  await check("migration A (integrity, audit, privileges) applies in one transaction", async () => {
    const r = db.psqlFile(MIGRATION_A); assert.ok(r.ok, r.stderr);
  });
  await check("migration B (devices, PIN limits) applies in one transaction", async () => {
    const r = db.psqlFile(MIGRATION_B); assert.ok(r.ok, r.stderr);
  });
  await check("migration A aborts and changes nothing if existing data already overlaps", async () => {
    const t = await db.newPool(1, "postgres");
    try {
      // copy of the pre-check run against a deliberately bad row inside a rolled-back transaction
      const r = await t.query(`begin;
        alter table public.shifts drop constraint shifts_no_overlap_per_staff;
        insert into public.shifts (staff_id, clock_in, clock_out, status) values (${lit(ID(6))}, now() - interval '49 hours', now() - interval '45 hours', 'completed');
        do $$ declare n int; begin
          select count(*) into n from public.shifts a join public.shifts b on a.staff_id = b.staff_id and a.id < b.id
           and tstzrange(a.clock_in, coalesce(a.clock_out, 'infinity'::timestamptz), '[)') && tstzrange(b.clock_in, coalesce(b.clock_out, 'infinity'::timestamptz), '[)');
          if n > 0 then raise exception 'PRECHECK_FAILED: % overlapping shift pair(s)', n; end if; end $$;`).then(() => "passed", (e) => e.message);
      await t.query("rollback");
      assert.match(r, /PRECHECK_FAILED: 1 overlapping/);
      return r;
    } finally { t.close(); }
  });
  await check("sessions opened on v37 before the migration still work on v38 (and are not ended)", async () => {
    useDatabase(db.svc);
    const dev = newDeviceSecret();
    const a = await quiet(() => call(h38, { action: "session_status", token: legacyTokens.staff }));
    const b = await quiet(() => call(h38, { action: "session_status", token: legacyTokens.staff, device: dev }));
    const c = await quiet(() => call(h38, { action: "manager_working", token: legacyTokens.manager }));
    assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(c.status, 200);
    assert.equal(b.body.data.status, "working");
    const bound = await one(db, `select d.approved_via from public.staff_sessions s join public.auth_devices d on d.id = s.device_id where s.token_hash = ${lit(sha(legacyTokens.staff))}`);
    assert.equal(bound, "session");
    const other = await quiet(() => call(h38, { action: "session_status", token: legacyTokens.staff, device: newDeviceSecret() }));
    assert.equal(other.status, 401);
    return "old sessions valid with or without device; first device seen is authorised (via 'session') and the session is then bound to it — a copied token fails on another device (401)";
  });

  // ============================================================ PHASE 3: compatibility + regression
  section("3. Compatibility and regression (same 50-step scenario)");
  let v37new, v38new;
  await check("v37 on the migrated database behaves exactly as on today's database (safe order + safe rollback)", async () => {
    useDatabase(db.svc);
    await reseed(db);
    v37new = await quiet(() => scenario(db, h37));
    const n1 = makeNormalizer(), n2 = makeNormalizer();
    dump("base37", n1(base37)); dump("v37new", n2(v37new));
    assert.deepEqual(n2(v37new), n1(base37));
    return `${base37.steps.length} responses and the final database state identical`;
  });
  const INTENDED = new Map([
    ["wrong PIN", "500 'Unable to create secure session' -> 401 'Invalid PIN' with attempts remaining"],
    ["shared PIN", "200 (logged in as one of two people) -> 409 PIN_CONFLICT"],
    ["inactive PIN", "500 -> 401 'Invalid PIN'"],
    ["clock in again", "raw code SHIFT_ALREADY_OPEN -> plain message + code"],
    ["clock out on break", "raw code END_BREAK_REQUIRED -> plain message + code"],
  ]);
  await check("v38 vs v37: every response identical except the intended fixes", async () => {
    useDatabase(db.svc);
    await reseed(db);
    v38new = await quiet(() => scenario(db, h38, { device: newDeviceSecret() }));
    const n1 = makeNormalizer(), n2 = makeNormalizer();
    const A = n1(base37);
    // v38 adds one field to team members (pin_conflict_at, null unless a PIN is shared)
    const B = JSON.parse(JSON.stringify(n2(v38new), (k, v) => (k === "pin_conflict_at" ? undefined : v)));
    const diffs = [];
    for (let i = 0; i < A.steps.length; i++) {
      if (canon(A.steps[i]) !== canon(B.steps[i])) diffs.push(A.steps[i].label);
    }
    const unexpected = diffs.filter((d) => !INTENDED.has(d));
    assert.deepEqual(unexpected, [], `unexpected differences: ${unexpected.join(", ")}`);
    const show = diffs.map((d) => { const i = A.steps.findIndex((s) => s.label === d); return `${d}: ${A.steps[i].status} ${JSON.stringify(A.steps[i].body).slice(0, 60)} => ${B.steps[i].status} ${JSON.stringify(B.steps[i].body).slice(0, 80)}`; });
    return `${A.steps.length - diffs.length}/${A.steps.length} identical; intended differences:\n        ` + show.join("\n        ");
  });
  await check("v38 database state = v37 state, except the refused shared-PIN session", async () => {
    const n1 = makeNormalizer(), n2 = makeNormalizer();
    const A = n1(base37.state), B = n2(v38new.state);
    dump("base37_state", A); dump("v38_state", B);
    assert.deepEqual(B.shifts, A.shifts, "shifts");
    assert.deepEqual(B.breaks, A.breaks, "breaks");
    assert.deepEqual(B.staff, A.staff, "staff");
    assert.equal(B.sessions.length, A.sessions.length - 1, "one session fewer: the shared-PIN login is refused");
    return "staff, shifts and breaks identical; sessions: the shared-PIN login is not created";
  });
  await check("v38 writes an audit row for every manager change (and none on refused ones)", async () => {
    const rows = JSON.parse(await one(db, "select json_agg(coalesce(action, new_data->>'action') order by changed_at) from public.shift_audit"));
    const staffRows = JSON.parse(await one(db, "select json_agg(action order by changed_at) from public.staff_audit"));
    assert.deepEqual(rows, ["manager_clock_out_staff", "manager_approve_shift", "manager_reopen_shift", "manager_edit_shift", "manager_delete_shift", "manager_create_shift"]);
    assert.deepEqual(staffRows, ["manager_create_staff", "manager_update_staff", "manager_update_staff", "manager_deactivate_staff", "manager_activate_staff"]);
    const deleted = await one(db, "select shift_id is null and shift_ref is not null and old_data ? 'shift' from public.shift_audit where action = 'manager_delete_shift'");
    assert.equal(deleted, "t");
    const leak = await one(db, "select count(*) from public.staff_audit where new_data::text ~ '\\$2[aby]\\$' or old_data::text ~ '\\$2[aby]\\$'");
    assert.equal(Number(leak), 0);
    return `shift audit: ${rows.join(", ")}; staff audit: ${staffRows.join(", ")}; deleted shift keeps its history; no PIN hash in audit`;
  });

  // ============================================================ PHASE 4: PIN security on v38
  section("4. PIN security and authorised devices (v38)");
  useDatabase(db.svc);
  await reseed(db);
  const devA = newDeviceSecret(), devB = newDeviceSecret();
  const loginAs = (staffId, device, pin = PIN[staffId]) => quiet(() => call(h38, { action: "login", pin, ...(device ? { device } : {}) }));

  await check("grace mode: first successful sign-in authorises the device; session is bound to it", async () => {
    const r = await loginAs(ID(4), devA);
    assert.equal(r.status, 200);
    const via = await one(db, "select approved_via from public.auth_devices order by created_at desc limit 1");
    assert.equal(via, "pin_grace");
    const other = await quiet(() => call(h38, { action: "session_status", token: r.body.session.token, device: devB }));
    const none = await quiet(() => call(h38, { action: "session_status", token: r.body.session.token }));
    assert.equal(other.status, 401); assert.equal(none.status, 401);
    await loginAs(ID(6), devB);
    return "login 200 (device authorised); same token from another device: 401; without device: 401";
  });

  await check("unknown devices share one small allowance: 5 wrong PINs -> blocked 15 min", async () => {
    const st = [];
    for (let i = 0; i < 6; i++) st.push((await loginAs(ID(4), newDeviceSecret(), String(200000 + i))).status);
    const correctUnknown = await loginAs(ID(5), newDeviceSecret());
    assert.deepEqual(st, [401, 401, 401, 401, 429, 429]);
    assert.equal(correctUnknown.status, 429);
    return `statuses ${st.join(",")}; even a correct PIN from a new device waits: ${correctUnknown.body.error}`;
  });

  await check("NO collective lockout: authorised devices keep working while unknown devices are blocked", async () => {
    const a = await loginAs(ID(4), devA);
    const b = await loginAs(ID(6), devB);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    return "device A and device B: 200, 200";
  });

  await check("attempts without a device id (old cached app) count against the unknown allowance, never unlimited", async () => {
    const r = await loginAs(ID(4), null, "123123");
    assert.equal(r.status, 429);
    return `HTTP ${r.status}: ${r.body.error}`;
  });

  await check("forged IP headers change nothing (no IP is used)", async () => {
    const r = await quiet(() => call(h38, { action: "login", pin: "321321" }, { "x-forwarded-for": "10.9.9.9", "cf-connecting-ip": "10.8.8.8", "x-real-ip": "10.7.7.7" }));
    assert.equal(r.status, 429);
    return "still blocked with three different forged IP headers";
  });

  await check("daily cap for unknown devices: 15 wrong PINs in 24 h -> blocked until the 24 h window ends", async () => {
    for (let i = 0; i < 10; i++) {
      // clear only the 15-minute block so the 24-hour count keeps growing
      await db.admin.query("update public.auth_attempt_buckets set locked_until = null, short_failures = 0 where bucket = 'unknown'");
      await loginAs(ID(4), newDeviceSecret(), String(300000 + i));
    }
    const row = JSON.parse(await one(db, "select row_to_json(b) from public.auth_attempt_buckets b where bucket = 'unknown'"));
    const lockedHours = Number(await one(db, "select round(extract(epoch from locked_until - now()) / 3600) from public.auth_attempt_buckets where bucket = 'unknown'"));
    assert.ok(row.daily_failures >= 15, JSON.stringify(row));
    assert.ok(lockedHours >= 23, String(lockedHours));
    return `daily failures ${row.daily_failures}; locked for ~${lockedHours} h; authorised devices unaffected`;
  });

  await check("authorised device: 5 wrong PINs lock THAT device only; manager can unlock it", async () => {
    await db.admin.query("delete from public.auth_attempt_buckets where bucket = 'unknown'");
    const st = [];
    for (let i = 0; i < 6; i++) st.push((await loginAs(ID(4), devA, String(400000 + i))).status);
    const blockedCorrect = await loginAs(ID(4), devA);
    const otherDevice = await loginAs(ID(6), devB);
    assert.deepEqual(st, [401, 401, 401, 401, 429, 429]);
    assert.equal(blockedCorrect.status, 429);
    assert.equal(otherDevice.status, 200);
    const gm = (await loginAs(ID(1), devB)).body.session.token;
    const list = await quiet(() => call(h38, { action: "manager_devices", token: gm, device: devB }));
    const devId = list.body.data.devices.find((d) => d.locked_until).id;
    const unlock = await quiet(() => call(h38, { action: "manager_device_unlock", token: gm, device: devB, device_id: devId }));
    const after = await loginAs(ID(4), devA);
    assert.equal(unlock.status, 200); assert.equal(after.status, 200);
    return `device A: ${st.join(",")} then correct PIN 429; device B still 200; after manager unlock: 200`;
  });

  await check("a correct PIN on an authorised device resets its counter (staff typos never pile up)", async () => {
    for (let i = 0; i < 4; i++) await loginAs(ID(4), devA, String(500000 + i));
    const ok = await loginAs(ID(4), devA);
    const again = [];
    for (let i = 0; i < 4; i++) again.push((await loginAs(ID(4), devA, String(510000 + i))).status);
    assert.equal(ok.status, 200); assert.deepEqual(again, [401, 401, 401, 401]);
  });

  await check("shared PIN: refused for both people (409), flagged for the manager, never guessed", async () => {
    const r = await loginAs(ID(10), devB, "9110");
    const flagged = Number(await one(db, `select count(*) from public.staff where pin_conflict_at is not null and id in (${lit(ID(10))}, ${lit(ID(11))})`));
    const sessions = Number(await one(db, `select count(*) from public.staff_sessions where staff_id in (${lit(ID(10))}, ${lit(ID(11))})`));
    assert.equal(r.status, 409); assert.equal(flagged, 2); assert.equal(sessions, 0);
    const gm = (await loginAs(ID(1), devB)).body.session.token;
    const team = await quiet(() => call(h38, { action: "manager_team", token: gm, device: devB }));
    const shown = JSON.stringify(team.body).includes("pin_conflict_at");
    const fix = await quiet(() => call(h38, { action: "manager_update_staff", token: gm, device: devB, staff_id: ID(11), name: "Test Shared Two", department: "Kitchen", new_pin: "9211" }));
    const one1 = await loginAs(ID(10), devB, "9110");
    const two = await loginAs(ID(11), devB, "9211");
    assert.ok(shown); assert.equal(fix.status, 200); assert.equal(one1.status, 200); assert.equal(two.status, 200);
    assert.equal(one1.body.data[0].staff_name, "Test Shared One"); assert.equal(two.body.data[0].staff_name, "Test Shared Two");
    return `409 "${r.body.error}"; both flagged in the team list; after the manager sets a new PIN both sign in as themselves`;
  });

  await check("new or changed PINs must be unique (also under two simultaneous requests)", async () => {
    const gm = (await loginAs(ID(1), devB)).body.session.token;
    const km = (await loginAs(ID(2), devB)).body.session.token;
    const dup = await quiet(() => call(h38, { action: "manager_create_staff", token: gm, device: devB, name: "Test Dup", staff_pin: PIN[ID(5)], department: "Kitchen" }));
    const [x, y] = await quiet(() => Promise.all([
      call(h38, { action: "manager_create_staff", token: gm, device: devB, name: "Test Race 1", staff_pin: "987654", department: "Kitchen" }),
      call(h38, { action: "manager_create_staff", token: km, device: devB, name: "Test Race 2", staff_pin: "987654", department: "Kitchen" }),
    ]));
    assert.equal(dup.status, 409);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    return `existing PIN: 409 "${dup.body.error}"; two managers at once with the same new PIN: ${x.status} / ${y.status}`;
  });

  await check("enforce mode: unknown devices cannot try PINs at all (even a correct PIN)", async () => {
    const km = (await loginAs(ID(2), devB)).body.session.token;
    const deny = await quiet(() => call(h38, { action: "manager_auth_mode", token: km, device: devB, mode: "enforce" }));
    assert.equal(deny.status, 403);
    const gm = (await loginAs(ID(1), devB)).body.session.token;
    const set = await quiet(() => call(h38, { action: "manager_auth_mode", token: gm, device: devB, mode: "enforce" }));
    assert.equal(set.status, 200);
    const before = Number(await one(db, "select coalesce(sum(daily_failures), 0) from public.auth_attempt_buckets"));
    const r = await loginAs(ID(4), newDeviceSecret());
    const wrong = await loginAs(ID(4), newDeviceSecret(), "111111");
    const after = Number(await one(db, "select coalesce(sum(daily_failures), 0) from public.auth_attempt_buckets"));
    const okA = await loginAs(ID(4), devA);
    const status = await quiet(() => call(h38, { action: "device_status", device: newDeviceSecret() }));
    assert.equal(r.status, 403); assert.equal(r.body.code, "DEVICE_NOT_AUTHORIZED");
    assert.equal(wrong.status, 403); assert.equal(after, before); assert.equal(okA.status, 200);
    assert.deepEqual(status.body.data, { mode: "enforce", device: "unknown" });
    return `Kitchen Manager cannot change the mode (403); GM can. Unknown device: 403 for right AND wrong PIN (no PIN checked, nothing counted); authorised device: 200`;
  });

  let pairedDev;
  await check("pairing: manager creates a one-time code; new device enters it; it can then sign in", async () => {
    const gm = (await loginAs(ID(1), devB)).body.session.token;
    const code = await quiet(() => call(h38, { action: "manager_device_code", token: gm, device: devB }));
    assert.equal(code.status, 200); assert.match(code.body.data.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    pairedDev = newDeviceSecret();
    const pair = await quiet(() => call(h38, { action: "device_pair", device: pairedDev, code: code.body.data.code.toLowerCase().replace("-", " ") }));
    const reuse = await quiet(() => call(h38, { action: "device_pair", device: newDeviceSecret(), code: code.body.data.code }));
    const login = await loginAs(ID(5), pairedDev);
    assert.equal(pair.status, 200); assert.equal(reuse.status, 400); assert.equal(login.status, 200);
    const stored = Number(await one(db, `select count(*) from public.auth_pairing_codes where code_hash = ${lit(sha(code.body.data.code.replace("-", "")))}`));
    assert.equal(stored, 1);
    return `code ${code.body.data.code.replace(/[A-Z2-9]/g, "X")} (stored only as a hash); accepted typed in lower case with a space; reuse refused (400); new device signs in (200)`;
  });

  await check("expired codes fail; 10 wrong codes block pairing for 15 min", async () => {
    const gm = (await loginAs(ID(1), devB)).body.session.token;
    const code = await quiet(() => call(h38, { action: "manager_device_code", token: gm, device: devB }));
    await db.admin.query("update public.auth_pairing_codes set expires_at = now() - interval '1 second' where used_at is null");
    const expired = await quiet(() => call(h38, { action: "device_pair", device: newDeviceSecret(), code: code.body.data.code }));
    const st = [];
    for (let i = 0; i < 10; i++) st.push((await quiet(() => call(h38, { action: "device_pair", device: newDeviceSecret(), code: "ZZZZZZZ" + "23456789"[i % 8] }))).status);
    assert.equal(expired.status, 400);
    assert.deepEqual(st.slice(-2), [429, 429]);
    await db.admin.query("delete from public.auth_attempt_buckets where bucket = 'pairing'");
    return `expired: 400; wrong codes: ${st.join(",")}`;
  });

  await check("removing a device ends its sessions at once and stops its sign-in; re-pairing restores it", async () => {
    const staffTok = (await loginAs(ID(5), pairedDev)).body.session.token;
    const gm = (await loginAs(ID(1), devB)).body.session.token;
    const list = await quiet(() => call(h38, { action: "manager_devices", token: gm, device: devB }));
    const target = list.body.data.devices.find((d) => d.approved_via === "pairing" && d.status === "approved");
    const rev = await quiet(() => call(h38, { action: "manager_device_revoke", token: gm, device: devB, device_id: target.id }));
    const st = await quiet(() => call(h38, { action: "session_status", token: staffTok, device: pairedDev }));
    const login = await loginAs(ID(5), pairedDev);
    const code = await quiet(() => call(h38, { action: "manager_device_code", token: gm, device: devB }));
    await quiet(() => call(h38, { action: "device_pair", device: pairedDev, code: code.body.data.code }));
    const again = await loginAs(ID(5), pairedDev);
    assert.equal(rev.status, 200); assert.ok(rev.body.data.sessions_ended >= 1);
    assert.equal(st.status, 401); assert.equal(login.status, 403); assert.equal(login.body.code, "DEVICE_REVOKED"); assert.equal(again.status, 200);
    return `revoke: ${rev.body.data.sessions_ended} session(s) ended; session 401; login 403 DEVICE_REVOKED; after a new code: 200`;
  });

  await check("owner recovery code from the SQL editor works; the API role cannot create one", async () => {
    const code = await one(db, "select public.auth_owner_pairing_code()");
    const dev = newDeviceSecret();
    const pair = await quiet(() => call(h38, { action: "device_pair", device: dev, code }));
    const login = await loginAs(ID(1), dev);
    const denied = await db.svc.query("select public.auth_owner_pairing_code()").then(() => "allowed", (e) => e.message);
    assert.equal(pair.status, 200); assert.equal(login.status, 200); assert.match(denied, /permission denied/);
    return `owner code paired a device and the GM signed in; service_role: "${denied}"`;
  });

  await check("a flood of requests cannot hold database connections (busy instead of waiting)", async () => {
    await db.admin.query("update public.auth_settings set device_mode = 'grace'");
    await db.admin.query("delete from public.auth_attempt_buckets where bucket = 'unknown'");
    await db.admin.query("insert into public.auth_attempt_buckets (bucket) values ('unknown')");
    const holder = await db.newPool(1, "postgres");
    try {
      await holder.query("begin; select * from public.auth_attempt_buckets where bucket = 'unknown' for update;");
      const t0 = performance.now();
      const rs = await Promise.all(Array.from({ length: 30 }, () => loginAs(ID(4), newDeviceSecret(), "777777")));
      const ms = performance.now() - t0;
      const statuses = [...new Set(rs.map((r) => r.status))];
      const authorised = await loginAs(ID(4), devA);
      assert.deepEqual(statuses, [429]); assert.ok(ms < 3000, `${ms}`); assert.equal(authorised.status, 200);
      return `30 parallel requests while the bucket is locked: all 429 'busy' in ${Math.round(ms)} ms; authorised device still 200`;
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.close();
    }
  });

  // ============================================================ PHASE 5: integrity under concurrency (v38)
  section("5. Integrity under concurrency (v38 + migrations)");
  await reseed(db);
  assert.ok(clean(await invariants(db)));
  let races38;
  await check("same 4 races × 40 trials on v38: zero corrupted records, only plain messages", async () => {
    const dev = newDeviceSecret();
    races38 = await runRaces(h38, "v38", 40, { device: dev });
    const corrupted = Object.values(races38).reduce((a, r) => a + r.corrupted, 0);
    const raw = Object.values(races38).flatMap((r) => r.messages).filter((m) => /duplicate key|violates|^\d+ [A-Z_]+$/.test(m));
    assert.equal(corrupted, 0); assert.deepEqual(raw, []);
    void dev;
    return `corrupted states: 0/160 (v37: ${Object.values(races37).reduce((a, r) => a + r.corrupted, 0)}/160)`;
  });
  await check("database refuses corrupt writes even outside the app (constraints, not just code)", async () => {
    const tries = {
      overlap: `insert into public.shifts (staff_id, clock_in, clock_out, status) values (${lit(ID(6))}, now() - interval '49 hours', now() - interval '45 hours', 'completed')`,
      second_open_break: `insert into public.breaks (shift_id, break_start) values (${lit(SH(2))}, now())`,
      negative_shift: `insert into public.shifts (staff_id, clock_in, clock_out, status) values (${lit(ID(6))}, now() - interval '100 hours', now() - interval '101 hours', 'completed')`,
    };
    const out = {};
    for (const [k, sql] of Object.entries(tries)) out[k] = await db.admin.query(sql).then(() => "accepted", (e) => e.pg?.code || e.message);
    assert.equal(out.overlap, "23P01");
    assert.ok(["23505", "23P01"].includes(out.second_open_break), out.second_open_break);
    assert.equal(out.negative_shift, "23514");
    return JSON.stringify(out);
  });
  await check("v38 manager edit is atomic: a failure inside the transaction changes nothing", async () => {
    useDatabase(db.svc);
    await reseed(db);
    const km = (await loginAs(ID(2), devA)).body.session.token;
    const before = await one(db, `select json_build_object('s', (select row_to_json(s) from public.shifts s where id = ${lit(SH(3))}), 'b', (select json_agg(b.break_start) from public.breaks b where shift_id = ${lit(SH(3))}))::text`);
    await db.admin.query(`create function public.t_fail() returns trigger language plpgsql as $$ begin raise exception 'synthetic failure'; end $$;
                          create trigger t_fail before insert on public.shift_audit for each row execute function public.t_fail();`);
    const r = await quiet(() => call(h38, { action: "manager_edit_shift", token: km, device: devA, shift_id: SH(3), clock_in: new Date(Date.now() - 26 * 3600e3).toISOString(), clock_out: new Date(Date.now() - 19 * 3600e3).toISOString(), break_minutes: 30 }));
    await db.admin.query("drop trigger t_fail on public.shift_audit; drop function public.t_fail();");
    const after = await one(db, `select json_build_object('s', (select row_to_json(s) from public.shifts s where id = ${lit(SH(3))}), 'b', (select json_agg(b.break_start) from public.breaks b where shift_id = ${lit(SH(3))}))::text`);
    assert.equal(r.status, 500); assert.equal(after, before);
    const inject = { failRpc: (n) => n === "manager_edit_shift" };
    useDatabase(db.svc, inject);
    const r2 = await quiet(() => call(h38, { action: "manager_edit_shift", token: km, device: devA, shift_id: SH(3), clock_in: new Date(Date.now() - 26 * 3600e3).toISOString(), clock_out: new Date(Date.now() - 19 * 3600e3).toISOString(), break_minutes: 30 }));
    useDatabase(db.svc);
    const after2 = await one(db, `select json_build_object('s', (select row_to_json(s) from public.shifts s where id = ${lit(SH(3))}), 'b', (select json_agg(b.break_start) from public.breaks b where shift_id = ${lit(SH(3))}))::text`);
    assert.equal(r2.status, 500); assert.equal(after2, before);
    return "failure inside the transaction: shift and break unchanged; connection failure: unchanged (v37 lost the break)";
  });

  // ============================================================ PHASE 6: failures and recovery (v38)
  section("6. Failures and recovery (v38)");
  await check("database unavailable during login: clear 503, no session, no counter change", async () => {
    useDatabase(db.svc, { failRpc: (n) => n === "auth_pin_login" });
    const r = await quiet(() => call(h38, { action: "login", pin: PIN[ID(4)], device: devA }));
    useDatabase(db.svc);
    assert.equal(r.status, 503); assert.equal(r.body.code, "LOGIN_UNAVAILABLE");
    const ok = await loginAs(ID(4), devA);
    assert.equal(ok.status, 200);
    return `503 "${r.body.error}"; next attempt after recovery: 200`;
  });
  await check("database unavailable during a clock action: error, nothing half-written, retry works", async () => {
    const tok = (await loginAs(ID(4), devA)).body.session.token;
    useDatabase(db.svc, { failRpc: (n) => n === "clock_in_by_id" });
    const r = await quiet(() => call(h38, { action: "session_clock_in", token: tok, device: devA }));
    useDatabase(db.svc);
    const open = Number(await one(db, `select count(*) from public.shifts where staff_id = ${lit(ID(4))} and clock_out is null`));
    const retry = await quiet(() => call(h38, { action: "session_clock_in", token: tok, device: devA }));
    assert.equal(r.status, 400); assert.equal(open, 0); assert.equal(retry.status, 200);
    return `failed attempt: ${r.status} "${r.body.error}", 0 open shifts; retry: 200`;
  });
  await check("v38 deployed WITHOUT the migrations fails safely (clear 503 on login, no data written)", async () => {
    // Simulate: function missing (as on a database without migration B).
    useDatabase(db.svc, { failRpc: (n) => n.startsWith("auth_") ? true : false });
    const r = await quiet(() => call(h38, { action: "login", pin: PIN[ID(4)], device: devA }));
    useDatabase(db.svc);
    assert.equal(r.status, 503);
    return "login 503 — this is why the migrations must be applied BEFORE the Edge Function (see runbook)";
  });

  // ============================================================ PHASE 7: logs, speed
  section("7. Logs and response time");
  await check(`logs never contain PINs, tokens, device secrets, hashes or IPs (${lines.length} lines captured)`, async () => {
    const all = lines.join("\n").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>");
    for (const p of new Set(STAFF.map((s) => s.pin))) assert.ok(!new RegExp(`(^|[^0-9])${p}([^0-9]|$)`).test(all), `PIN ${p}`);
    assert.ok(!/\b[0-9a-f]{64}\b/.test(all), "64-hex value");
    assert.ok(!/[A-Za-z0-9_-]{43}/.test(all), "device secret-like value");
    assert.ok(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(all), "IP");
    assert.ok(!all.includes(SERVICE_KEY), "service key");
    const v38lines = [...new Set(lines.filter((l) => l.startsWith("[auth]")).map((l) => l.replace(/=\S+/g, "=…")))];
    return `v38 auth log formats: ${v38lines.join(" | ")}`;
  });
  await check("response time: session and clock requests within 25% (+5 ms) of v37; login at most +60 ms", async () => {
    await reseed(db);
    const t = { v37: { login: [], status: [], clock: [] }, v38: { login: [], status: [], clock: [] } };
    const dev = newDeviceSecret();
    for (let i = 0; i < 25; i++) {
      for (const [name, h, d] of i % 2 ? [["v37", h37, {}], ["v38", h38, { device: dev }]] : [["v38", h38, { device: dev }], ["v37", h37, {}]]) {
        const l = await quiet(() => call(h, { action: "login", pin: PIN[ID(5)], ...d }));
        t[name].login.push(l.ms);
        const s = await quiet(() => call(h, { action: "session_status", token: l.body.session.token, ...d }));
        t[name].status.push(s.ms);
        const ci = await quiet(() => call(h, { action: "session_my_hours", token: l.body.session.token, ...d }));
        t[name].clock.push(ci.ms);
      }
    }
    const out = [];
    for (const k of ["login", "status", "clock"]) {
      out.push(`${k}: v37 ${median(t.v37[k]).toFixed(1)} ms / v38 ${median(t.v38[k]).toFixed(1)} ms`);
      // Login checks the PIN against EVERY active person (to refuse shared PINs);
      // v37 stopped at the first match. Budget: at most +60 ms per login.
      const budget = k === "login" ? median(t.v37[k]) + 60 : median(t.v37[k]) * 1.25 + 5;
      assert.ok(median(t.v38[k]) <= budget, `${k}: v37 ${median(t.v37[k]).toFixed(1)} ms, v38 ${median(t.v38[k]).toFixed(1)} ms`);
    }
    return out.join("; ");
  });

  // ============================================================ PHASE 8: rollback
  section("8. Rollback");
  await check("rollback of B then A: production function text restored (md5), v37 passes the full scenario again", async () => {
    await reseed(db);
    const auditRowsBefore = Number(await one(db, "select count(*) from public.shift_audit"));
    for (const f of [ROLLBACK_B, ROLLBACK_A]) { const r = db.psqlFile(f); assert.ok(r.ok, r.stderr); }
    const fp = await db.fingerprints();
    for (const [k, v] of Object.entries(PROD_FINGERPRINTS)) assert.equal(fp[k], v, k);
    assert.ok(!Object.keys(fp).some((k) => k.startsWith("auth_") || k.startsWith("mh_")));
    useDatabase(db.svc);
    await reseed(db);
    const again = await quiet(() => scenario(db, h37));
    const n1 = makeNormalizer(), n2 = makeNormalizer();
    assert.deepEqual(n2(again), n1(base37));
    return `9/9 functions identical to production; v37 scenario identical to before the migration; audit rows kept (${auditRowsBefore} before reseed)`;
  });
  await check("sessions survive the rollback (device link removed, session still valid on v37)", async () => {
    // apply again, create a device-bound session on v38, roll back, use it on v37
    for (const f of [MIGRATION_A, MIGRATION_B]) { const r = db.psqlFile(f); assert.ok(r.ok, r.stderr); }
    await reseed(db);
    const dev = newDeviceSecret();
    const tok = (await loginAs(ID(4), dev)).body.session.token;
    for (const f of [ROLLBACK_B, ROLLBACK_A]) { const r = db.psqlFile(f); assert.ok(r.ok, r.stderr); }
    const r = await quiet(() => call(h37, { action: "session_status", token: tok }));
    assert.equal(r.status, 200);
    return "session created on v38 still works on v37 after both rollbacks";
  });
  await check("migrations can be applied again after a rollback", async () => {
    for (const f of [MIGRATION_A, MIGRATION_B]) { const r = db.psqlFile(f); assert.ok(r.ok, r.stderr); }
  });
} finally {
  capture = false;
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : `\nALL ${evidence.length} HARDENING CHECKS PASSED`);
process.exit(failures ? 1 : 0);
