// Release check for the new features (student visa, roster, time off, public
// holidays) on a production-like database, before anything touches Hawthorne.
//
// Real Edge Function code (the production version from main = v38, and the new
// version from this branch), real SQL (production structure, function text and
// privileges + the two production migrations), synthetic data only. Nothing
// connects to Supabase. Run: node tests/integration/features.mjs
//
// What it proves:
//  A. The 4 new migrations apply cleanly on the production structure, change no
//     existing function and no existing row.
//  B. The production server (v38) keeps working on the new database (so the
//     server can be rolled back alone).
//  C. The new server keeps every existing flow (login, clock, break, dashboard,
//     team, hours) and the new features work with the right access rules.
//  D. The rollback files undo the migrations and v38 still works afterwards.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { startProdLikeDb, MIGRATION_A, MIGRATION_B, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "./edge-loader.mjs";
import { ID, PIN, reseed } from "./seed.mjs";

const NEW_MIGRATIONS = [
  "supabase/migrations/20261020000000_student_visa.sql",
  "supabase/migrations/20261020010000_roster.sql",
  "supabase/migrations/20261020020000_leave.sql",
  "supabase/migrations/20261020030000_public_holidays.sql",
];
const NEW_ROLLBACKS = [
  "supabase/rollback/20261020030000_public_holidays.down.sql",
  "supabase/rollback/20261020020000_leave.down.sql",
  "supabase/rollback/20261020010000_roster.down.sql",
  "supabase/rollback/20261020000000_student_visa.down.sql",
];
const PROD_NOW = {
  clock_in_by_id: "492152cef9c0c594ae36584dae6ab885", clock_out_by_id: "e219cdad18ea16eaa4ba47ccfa7e9989",
  end_break_by_id: "8b9332d27bb8e15cc36a7729500191f5", start_break_by_id: "effe8837a3e327acd65a45fb5df06830",
  login_with_pin: "4fe42dbb03d86ea6a6619fa3d5c58d0d", staff_status_by_id: "59d22572b44d3b9121eb1d7851b22dd9",
  manager_clock_out_staff: "21b0f2fc5903e0522260939c59d09a65", manager_update_staff: "b25c2b887014e4937db65a0c899a0a60",
  manager_create_staff: "ba679871846b58202f1c44d402b74f19", manager_update_staff_audited: "5aeab616ce1a8ce46be21bcbeedfc599",
  manager_create_staff_audited: "05324f5db89f99b573b3e6966b526cdd", manager_toggle_staff_audited: "05fcbd0ccf2ef1586011b024e9bb7f68",
  mh_manager: "03b61fc87ea8d33e9726e36ddabb9069", mh_scope: "47434ab9c4e90a1fe27b5e45884b3b6e",
  mh_staff_json: "75174b644bb42a2a8f4de339a065339f", auth_session: "4f4c4ff7ab890f91b7c593151afd6787",
  auth_pin_login: "dfc2dd857fdd0d7fac52bf067fd6b2cc",
};
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");

// The production server today (v38), frozen byte-identical in tests/edge/baseline-v38.ts.
const productionServer = () => resolve(root, "tests/edge/baseline-v38.ts");

let failures = 0;
const log = (...a) => console.log(...a);
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
    log(`  ✖ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 8).join("\n      ")}`);
  }
}
const section = (t) => log(`\n== ${t} ==`);
const one = async (db, sql) => (await db.admin.query(sql)).rows[0]?.[0];

// Quiet the servers' own logging while calling them.
const realConsole = { ...console };
async function quiet(fn) {
  for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = () => {};
  try { return await fn(); } finally { Object.assign(console, realConsole); }
}

const DATA_SQL = `select md5(coalesce((select string_agg(id::text || name || pin_hash || department || location || role || active::text, ',' order by id) from public.staff), '')
  || coalesce((select string_agg(id::text || staff_id::text || clock_in::text || coalesce(clock_out::text,'') || status || approved::text || coalesce(notes,''), ',' order by id) from public.shifts), '')
  || coalesce((select string_agg(id::text || shift_id::text || break_start::text || coalesce(break_end::text,''), ',' order by id) from public.breaks), '')
  || coalesce((select count(*)::text from public.shift_audit), '')
  || coalesce((select count(*)::text from public.staff_sessions), ''))`;

const db = await startProdLikeDb();
try {
  // Production today = snapshot + clock-out + the two hardening migrations.
  for (const f of [MIGRATION_A, MIGRATION_B]) { const r = db.psqlFile(f); assert.ok(r.ok, r.stderr); }
  useDatabase(db.svc);
  await reseed(db);

  const v38 = await quiet(() => loadHandler(productionServer()));
  const vNew = await quiet(() => loadHandler(NEW_SERVER));
  const dev = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [n, newDeviceSecret()]));
  const login = async (h, n) => {
    const r = await quiet(() => call(h, { action: "login", pin: PIN[ID(n)], device: dev[n] }));
    assert.equal(r.status, 200, `login ${n}: ${JSON.stringify(r.body)}`);
    return r.body.session.token;
  };
  const api = (h, n, token, body) => quiet(() => call(h, { ...body, token, device: dev[n] }));

  // ------------------------------------------------------------ A
  section("A. Migrations on the production structure");
  const fpBefore = await db.fingerprints();
  const dataBefore = await one(db, DATA_SQL);
  const aclBefore = await db.tableAcl();

  await check("the 4 new migrations apply cleanly, in order, each in one transaction", async () => {
    for (const f of NEW_MIGRATIONS) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
    return NEW_MIGRATIONS.map((f) => f.split("/").pop()).join(", ");
  });

  await check("no existing function changed; production fingerprints still match", async () => {
    const fp = await db.fingerprints();
    const changed = Object.keys(fpBefore).filter((k) => fp[k] !== fpBefore[k]);
    assert.deepEqual(changed, []);
    // md5(pg_get_functiondef) read from production (read-only, 2026-10-20), after
    // its two hardening migrations: the harness must equal production before and after.
    for (const [k, v] of Object.entries(PROD_NOW)) assert.equal(fp[k], v, k);
    const added = Object.keys(fp).filter((k) => !(k in fpBefore)).sort();
    return `added only: ${added.join(", ")}`;
  });

  await check("no existing row changed (staff, shifts, breaks, audit, sessions)", async () => {
    assert.equal(await one(db, DATA_SQL), dataBefore);
    const visa = await one(db, "select count(*) from public.staff where student_visa or visa_course_break");
    assert.equal(Number(visa), 0);
    return "data fingerprint identical; new visa columns all false";
  });

  await check("existing table privileges unchanged; new tables closed to the public keys", async () => {
    const acl = await db.tableAcl();
    for (const [t, v] of Object.entries(aclBefore)) assert.equal(acl[t], v, t);
    for (const t of ["roster_entries", "roster_services", "roster_audit", "leave_requests", "public_holidays"]) {
      const anon = await one(db, `select has_table_privilege('anon', 'public.${t}', 'select')`);
      const auth = await one(db, `select has_table_privilege('authenticated', 'public.${t}', 'select')`);
      assert.equal(anon, "f", `${t} anon`); assert.equal(auth, "f", `${t} authenticated`);
    }
    for (const fn of ["manager_set_student_visa_audited(uuid,uuid,boolean,boolean)", "manager_roster_set(uuid,uuid,date,text,time,time)",
      "manager_roster_week(uuid,text,date)", "staff_leave_request(uuid,text,date,date,text)", "manager_leave_decide(uuid,uuid,text)"]) {
      assert.equal(await one(db, `select has_function_privilege('anon', 'public.${fn}', 'execute')`), "f", fn);
    }
    return "anon / authenticated cannot read the new tables or run the new functions";
  });

  // ------------------------------------------------------------ B
  section("B. Production server (v38) on the new database");
  await check("v38: staff sign-in, clock in, break, clock out", async () => {
    const t = await login(v38, 4);
    for (const action of ["session_clock_in", "session_start_break", "session_end_break", "session_clock_out"]) {
      const r = await api(v38, 4, t, { action });
      assert.equal(r.status, 200, `${action}: ${JSON.stringify(r.body)}`);
    }
    return "all 200";
  });
  await check("v38: manager dashboard, team, hours, working", async () => {
    const t = await login(v38, 1);
    for (const action of ["manager_dashboard", "manager_team", "manager_hours", "manager_working"]) {
      const r = await api(v38, 1, t, { action });
      assert.equal(r.status, 200, `${action}: ${JSON.stringify(r.body)}`);
    }
    return "all 200";
  });

  // ------------------------------------------------------------ C
  section("C. New server: existing flows unchanged, new features");
  await reseed(db);
  await check("new: staff sign-in, clock in, break, clock out, my hours", async () => {
    const t = await login(vNew, 6);
    for (const action of ["session_clock_in", "session_start_break", "session_end_break", "session_clock_out", "session_my_hours", "session_status"]) {
      const r = await api(vNew, 6, t, { action });
      assert.equal(r.status, 200, `${action}: ${JSON.stringify(r.body)}`);
    }
    return "all 200";
  });

  const gm = await login(vNew, 1);
  const km = await login(vNew, 2);
  const fm = await login(vNew, 3);

  await check("new: dashboard, team, hours, working, approvals load for every manager type", async () => {
    for (const [n, t] of [[1, gm], [2, km], [3, fm]]) {
      for (const action of ["manager_dashboard", "manager_team", "manager_hours", "manager_working", "manager_approvals"]) {
        const r = await api(vNew, n, t, { action });
        assert.equal(r.status, 200, `${n} ${action}: ${JSON.stringify(r.body)}`);
      }
    }
    const d = await api(vNew, 1, gm, { action: "manager_dashboard" });
    assert.ok(Array.isArray(d.body.data.visa_hours) && Array.isArray(d.body.data.upcoming_holidays));
    return "15 calls 200; dashboard carries visa_hours + upcoming_holidays";
  });

  await check("new: same responses as v38 for the existing manager screens (apart from the new fields)", async () => {
    const t38 = await login(v38, 1);
    for (const action of ["manager_team", "manager_hours", "manager_working"]) {
      const a = await api(v38, 1, t38, { action });
      const b = await api(vNew, 1, gm, { action });
      const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => (["student_visa", "visa_course_break", "visa_hours", "generated_at"].includes(k) ? undefined : v)));
      assert.deepEqual(strip(b.body.data), strip(a.body.data), action);
    }
    return "manager_team, manager_hours, manager_working identical";
  });

  await check("visa: floor manager marks Floor staff; kitchen manager refused; 48h fortnight reported", async () => {
    const ok = await api(vNew, 3, fm, { action: "manager_set_student_visa", staff_id: ID(6), student_visa: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const no = await api(vNew, 2, km, { action: "manager_set_student_visa", staff_id: ID(6), student_visa: false });
    assert.equal(no.status, 403);
    const team = await api(vNew, 3, fm, { action: "manager_team" });
    const v = team.body.data.visa_hours.find((x) => x.staff_id === ID(6));
    assert.ok(v && v.limit_hours === 48 && v.hours_14d > 0, JSON.stringify(team.body.data.visa_hours));
    const audit = await one(db, `select count(*) from public.staff_audit where action = 'manager_set_student_visa'`);
    assert.equal(Number(audit), 1);
    return `Floor A ${v.hours_14d}h of 48h; kitchen manager 403; 1 audit row`;
  });

  await check("roster: kitchen L/D, floor times, department scope, Monday weeks only", async () => {
    const week = "2026-11-02";
    let r = await api(vNew, 2, km, { action: "manager_roster_set", staff_id: ID(4), work_date: week, code: "LD" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api(vNew, 3, fm, { action: "manager_roster_set", staff_id: ID(6), work_date: week, code: "SHIFT", start_time: "17:00", end_time: "21:00" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api(vNew, 2, km, { action: "manager_roster_set", staff_id: ID(6), work_date: week, code: "L" });
    assert.equal(r.status, 403);
    r = await api(vNew, 3, fm, { action: "manager_roster_week", week_start: "2026-11-03" });
    assert.equal(r.status, 400);
    const k = await api(vNew, 2, km, { action: "manager_roster_week", week_start: week });
    const f = await api(vNew, 3, fm, { action: "manager_roster_week", week_start: week });
    const g = await api(vNew, 1, gm, { action: "manager_roster_week", week_start: week });
    assert.equal(k.body.data.entries.length, 1); assert.equal(f.body.data.entries.length, 1); assert.equal(g.body.data.entries.length, 2);
    assert.equal(k.body.data.planned_hours[ID(4)], 10.5);
    assert.equal(f.body.data.planned_hours[ID(6)], 4);
    return "kitchen sees 1, floor 1, general manager 2; L/D = 10.5h, 17:00-21:00 = 4h; wrong department 403; Tuesday week 400";
  });

  await check("time off: staff asks, the right manager approves, roster refuses that day", async () => {
    const st = await login(vNew, 7);
    let r = await api(vNew, 7, st, { action: "session_leave_request", kind: "HOLIDAY", start_date: "2026-11-09", end_date: "2026-11-11", note: "trip" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const id = r.body.data.request.id;
    r = await api(vNew, 7, st, { action: "session_leave_request", kind: "DAY_OFF", start_date: "2026-11-10" });
    assert.equal(r.status, 409);
    const kl = await api(vNew, 2, km, { action: "manager_leave_list" });
    assert.equal(kl.body.data.pending.length, 0);
    r = await api(vNew, 2, km, { action: "manager_leave_decide", leave_id: id, decision: "APPROVE" });
    assert.equal(r.status, 403);
    r = await api(vNew, 3, fm, { action: "manager_leave_decide", leave_id: id, decision: "APPROVE" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api(vNew, 3, fm, { action: "manager_roster_set", staff_id: ID(7), work_date: "2026-11-10", code: "SHIFT", start_time: "17:00", end_time: "21:00" });
    assert.equal(r.status, 409); assert.equal(r.body.code, "ON_LEAVE");
    r = await api(vNew, 3, fm, { action: "manager_roster_week", week_start: "2026-11-09" });
    assert.equal(r.body.data.leave.length, 1);
    const mine = await api(vNew, 7, st, { action: "session_leave_list" });
    assert.equal(mine.body.data.requests[0].status, "APPROVED");
    return "request 200; overlap 409; kitchen manager sees 0 and gets 403; floor manager approves; roster ON_LEAVE 409";
  });

  await check("devices: Administrator only (list, code, name, remove); others get 403", async () => {
    const g = await api(vNew, 1, gm, { action: "manager_devices" });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    const tablet = g.body.data.devices.find((d) => !d.is_current);
    const named = await api(vNew, 1, gm, { action: "manager_device_rename", device_id: tablet.id, label: "Restaurant tablet" });
    assert.equal(named.status, 200, JSON.stringify(named.body));
    const statuses = [];
    for (const [n, t] of [[2, km], [3, fm]]) {
      for (const body of [{ action: "manager_devices" }, { action: "manager_device_code" },
        { action: "manager_device_rename", device_id: tablet.id, label: "x" },
        { action: "manager_device_revoke", device_id: tablet.id }, { action: "manager_device_unlock", device_id: tablet.id }]) {
        const r = await api(vNew, n, t, body);
        statuses.push(r.status);
        assert.equal(r.status, 403, `${n} ${body.action}: ${JSON.stringify(r.body)}`);
      }
    }
    const label = await one(db, `select label from public.auth_devices where id = '${tablet.id}'`);
    const revoked = await one(db, `select count(*) from public.auth_devices where status = 'revoked'`);
    assert.equal(label, "Restaurant tablet"); assert.equal(Number(revoked), 0);
    return `administrator 200 (named "${label}"); kitchen/floor managers: ${statuses.length} calls, all 403; nothing changed by them`;
  });

  await check("public holidays: Christmas week on the roster", async () => {
    const r = await api(vNew, 1, gm, { action: "manager_roster_week", week_start: "2026-12-21" });
    assert.deepEqual(r.body.data.holidays.map((h) => h.holiday_date), ["2026-12-24", "2026-12-25", "2026-12-26"]);
    return r.body.data.holidays.map((h) => `${h.holiday_date} ${h.name}`).join("; ");
  });

  await check("v38 still works with the new data in place (server rollback is safe)", async () => {
    const t = await login(v38, 5);
    const a = await api(v38, 5, t, { action: "session_status" });
    const t1 = await login(v38, 1);
    const b = await api(v38, 1, t1, { action: "manager_dashboard" });
    const c = await api(v38, 1, t1, { action: "manager_team" });
    assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(c.status, 200);
    return "status, dashboard, team 200";
  });

  // ------------------------------------------------------------ D
  section("D. Rollback files");
  await check("the 4 rollback files apply in reverse order; functions equal production again", async () => {
    for (const f of NEW_ROLLBACKS) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
    const fp = await db.fingerprints();
    assert.deepEqual(Object.keys(fp).sort(), Object.keys(fpBefore).sort());
    for (const k of Object.keys(fpBefore)) assert.equal(fp[k], fpBefore[k], k);
    const left = await one(db, "select count(*) from information_schema.tables where table_schema='public' and table_name in ('roster_entries','roster_services','roster_audit','leave_requests','public_holidays')");
    assert.equal(Number(left), 0);
    return "no new table, column or function left";
  });
  await check("v38 works after the rollback", async () => {
    useDatabase(db.svc);
    const t = await login(v38, 4);
    const r = await api(v38, 4, t, { action: "session_status" });
    const m = await login(v38, 1);
    const d = await api(v38, 1, m, { action: "manager_dashboard" });
    assert.equal(r.status, 200); assert.equal(d.status, 200);
    return "status, dashboard 200";
  });
} finally {
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL FEATURE RELEASE CHECKS PASSED");
process.exit(failures ? 1 : 0);
