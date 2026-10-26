// Release check for roster roles (Chef / Dishwasher / Floor / Bar) and
// roster-only people, on a production-like database. Production at release
// time = snapshot + hardening migrations + the 2026-10-20 migrations + stock,
// served by edge v41 (tests/edge/baseline-v41.ts). Synthetic data only.
// Run: node tests/integration/roles.mjs
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { startProdLikeDb, MIGRATION_A, MIGRATION_B, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "./edge-loader.mjs";
import { ID, PIN, reseed } from "./seed.mjs";

const BEFORE = [
  MIGRATION_A, MIGRATION_B,
  "supabase/migrations/20261020000000_student_visa.sql",
  "supabase/migrations/20261020010000_roster.sql",
  "supabase/migrations/20261020020000_leave.sql",
  "supabase/migrations/20261020030000_public_holidays.sql",
  "supabase/migrations/20261021000000_stock_par.sql",
];
const ROLES = "supabase/migrations/20261021010000_roster_roles.sql";
const ROLES_DOWN = "supabase/rollback/20261021010000_roster_roles.down.sql";
const ORDER = "supabase/migrations/20261021020000_roster_order.sql";
const ORDER_DOWN = "supabase/rollback/20261021020000_roster_order.down.sql";
const FLOOR = "supabase/migrations/20261021030000_floor_services.sql";
const FLOOR_DOWN = "supabase/rollback/20261021030000_floor_services.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v41.ts");

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
const realConsole = { ...console };
async function quiet(fn) {
  for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = () => {};
  try { return await fn(); } finally { Object.assign(console, realConsole); }
}
const DATA_SQL = `select md5(coalesce((select string_agg(id::text || name || pin_hash || department || location || role || active::text || student_visa::text, ',' order by id) from public.staff), '')
  || coalesce((select string_agg(id::text || staff_id::text || clock_in::text || coalesce(clock_out::text,'') || status || approved::text, ',' order by id) from public.shifts), '')
  || coalesce((select count(*)::text from public.roster_entries), '')
  || coalesce((select count(*)::text from public.leave_requests), '')
  || coalesce((select count(*)::text from public.stock_items), ''))`;

const db = await startProdLikeDb();
try {
  for (const f of BEFORE) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  useDatabase(db.svc);
  await reseed(db);

  const v41 = await quiet(() => loadHandler(PROD_SERVER));
  const vNew = await quiet(() => loadHandler(NEW_SERVER));
  const dev = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [n, newDeviceSecret()]));
  const login = async (h, n) => {
    const r = await quiet(() => call(h, { action: "login", pin: PIN[ID(n)], device: dev[n] }));
    assert.equal(r.status, 200, `login ${n}: ${JSON.stringify(r.body)}`);
    return r.body.session.token;
  };
  const api = (h, n, token, body) => quiet(() => call(h, { ...body, token, device: dev[n] }));

  section("A. Roles migration on the production structure");
  const fpBefore = await db.fingerprints();
  const dataBefore = await one(db, DATA_SQL);
  const aclBefore = await db.tableAcl();

  await check("the new server works on the database BEFORE this migration (team, roster)", async () => {
    const gm = await login(vNew, 1);
    for (const action of ["manager_team", "manager_roster_week", "manager_dashboard"]) {
      const r = await api(vNew, 1, gm, { action });
      assert.equal(r.status, 200, `${action}: ${JSON.stringify(r.body)}`);
    }
    return "team, roster, dashboard 200 (no role columns yet)";
  });
  await check("the migrations apply cleanly; no existing function or row changed", async () => {
    const r = db.psqlFile(ROLES); assert.ok(r.ok, r.stderr);
    const r2 = db.psqlFile(ORDER); assert.ok(r2.ok, r2.stderr);
    const r3 = db.psqlFile(FLOOR); assert.ok(r3.ok, r3.stderr);
    const fp = await db.fingerprints();
    assert.deepEqual(Object.keys(fpBefore).filter((k) => fp[k] !== fpBefore[k]), []);
    assert.equal(await one(db, DATA_SQL), dataBefore);
    const added = Object.keys(fp).filter((k) => !(k in fpBefore)).sort();
    return `added only: ${added.join(", ")}`;
  });
  await check("privileges: existing unchanged; new table and functions closed to the public keys", async () => {
    const acl = await db.tableAcl();
    for (const [t, v] of Object.entries(aclBefore)) if (t !== "staff") assert.equal(acl[t], v, t);
    assert.equal(await one(db, "select has_table_privilege('anon', 'public.roster_position_services', 'select')"), "f");
    assert.equal(await one(db, "select has_table_privilege('service_role', 'public.roster_position_services', 'select')"), "t");
    for (const fn of ["manager_set_roster_info_audited(uuid,uuid,text,boolean)", "manager_create_roster_person_audited(uuid,text,text,text)"]) {
      assert.equal(await one(db, `select has_function_privilege('anon', 'public.${fn}', 'execute')`), "f", fn);
    }
    return "anon cannot read the times table or run the new functions; the server can read the times";
  });

  section("B. Production server (v41) on the new database");
  await check("v41: clock flow and manager screens", async () => {
    const t = await login(v41, 4);
    for (const action of ["session_clock_in", "session_clock_out"]) assert.equal((await api(v41, 4, t, { action })).status, 200, action);
    const m = await login(v41, 1);
    for (const action of ["manager_dashboard", "manager_team", "manager_hours", "manager_roster_week"]) {
      assert.equal((await api(v41, 1, m, { action })).status, 200, action);
    }
    return "all 200";
  });

  section("C. New server: roles and roster-only people");
  const gm = await login(vNew, 1);
  const km = await login(vNew, 2);
  const fm = await login(vNew, 3);

  await check("set roles; wrong role for the department refused; kitchen manager only in Kitchen", async () => {
    let r = await api(vNew, 2, km, { action: "manager_set_roster_info", staff_id: ID(4), position: "Chef" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api(vNew, 2, km, { action: "manager_set_roster_info", staff_id: ID(5), position: "Dishwasher" });
    assert.equal(r.status, 200);
    r = await api(vNew, 2, km, { action: "manager_set_roster_info", staff_id: ID(12), position: "Bar" });
    assert.equal(r.status, 400, "Bar is not a Kitchen role");
    r = await api(vNew, 2, km, { action: "manager_set_roster_info", staff_id: ID(6), position: "Floor" });
    assert.equal(r.status, 403);
    r = await api(vNew, 3, fm, { action: "manager_set_roster_info", staff_id: ID(6), position: "Bar" });
    assert.equal(r.status, 200);
    const t = await api(vNew, 1, gm, { action: "manager_team" });
    const pos = Object.fromEntries(t.body.data.team.map((p) => [p.name, p.position]));
    assert.equal(pos["Test Kitchen A"], "Chef"); assert.equal(pos["Test Kitchen B"], "Dishwasher"); assert.equal(pos["Test Floor A"], "Bar");
    const audit = Number(await one(db, "select count(*) from public.staff_audit where action = 'manager_set_roster_info'"));
    assert.equal(audit, 3);
    return "Chef / Dishwasher / Bar saved; Bar in Kitchen 400; kitchen manager on Floor 403; 3 audit rows";
  });

  await check("roster: chef and dishwasher lunch use their own times (4.5h vs 4h)", async () => {
    const week = "2026-11-02";
    for (const id of [ID(4), ID(5)]) {
      const r = await api(vNew, 2, km, { action: "manager_roster_set", staff_id: id, work_date: week, code: "L" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    const w = await api(vNew, 2, km, { action: "manager_roster_week", week_start: week });
    assert.equal(w.body.data.planned_hours[ID(4)], 4.5);
    assert.equal(w.body.data.planned_hours[ID(5)], 4);
    assert.ok(w.body.data.services.some((s) => s.position === "Dishwasher" && s.service === "L" && s.start_time === "11:00"));
    assert.equal(w.body.data.team.find((p) => p.id === ID(4)).position, "Chef");
    return "chef L 10:30-15:00 = 4.5h; dishwasher L 11:00-15:00 = 4h";
  });

  let rosterOnlyId;
  await check("add a roster-only person: on the roster, not in hours; cannot sign in", async () => {
    let r = await api(vNew, 2, km, { action: "manager_create_roster_person", name: "Test Salary Chef", position: "Chef" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    rosterOnlyId = r.body.data.staff.id;
    r = await api(vNew, 2, km, { action: "manager_create_roster_person", name: "Bad", department: "Floor", position: "Floor" });
    assert.equal(r.status, 400, "kitchen manager cannot add to Floor");
    r = await api(vNew, 2, km, { action: "manager_roster_set", staff_id: rosterOnlyId, work_date: "2026-11-03", code: "LD" });
    assert.equal(r.status, 200);
    const w = await api(vNew, 1, gm, { action: "manager_roster_week", week_start: "2026-11-02" });
    const p = w.body.data.team.find((x) => x.id === rosterOnlyId);
    assert.equal(p.roster_only, true); assert.equal(p.position, "Chef");
    const h = await api(vNew, 1, gm, { action: "manager_hours" });
    assert.ok(!JSON.stringify(h.body.data).includes(rosterOnlyId), "not in hours");
    const hash = await one(db, `select pin_hash from public.staff where id = '${rosterOnlyId}'`);
    for (const pin of ["0000", "1234", "000000"]) {
      assert.equal(await one(db, `select '${hash}' = extensions.crypt('${pin}', '${hash}')`), "f");
    }
    return "created (Kitchen, Chef, roster only); rostered L/D; not in hours; no 4-6 digit PIN opens it";
  });

  await check("make a PIN user roster-only: old PIN stops working; giving a PIN back restores the clock", async () => {
    let r = await api(vNew, 3, fm, { action: "manager_set_roster_info", staff_id: ID(7), position: "Floor", roster_only: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const tryLogin = await quiet(() => call(vNew, { action: "login", pin: PIN[ID(7)], device: newDeviceSecret() }));
    assert.notEqual(tryLogin.status, 200, "old PIN must not work");
    r = await api(vNew, 3, fm, { action: "manager_set_roster_info", staff_id: ID(1), roster_only: true });
    assert.notEqual(r.status, 200, "a manager account cannot be roster-only");
    r = await api(vNew, 3, fm, { action: "manager_update_staff", staff_id: ID(7), name: "Test Floor B", department: "Floor", new_pin: "915573" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api(vNew, 3, fm, { action: "manager_set_roster_info", staff_id: ID(7), position: "Floor", roster_only: false });
    assert.equal(r.status, 200);
    const back = await quiet(() => call(vNew, { action: "login", pin: "915573", device: newDeviceSecret() }));
    assert.equal(back.status, 200, JSON.stringify(back.body));
    return `roster-only: old PIN ${tryLogin.status}; manager refused; new PIN + untick: sign-in 200`;
  });

  await check("floor: L / D / L/D cells, 11-15 and 17-22 (Floor and Bar)", async () => {
    const week = "2026-11-02";
    let r = await api(vNew, 3, fm, { action: "manager_roster_set", staff_id: ID(6), work_date: week, code: "L" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api(vNew, 3, fm, { action: "manager_roster_set", staff_id: ID(6), work_date: "2026-11-03", code: "LD" });
    assert.equal(r.status, 200);
    r = await api(vNew, 3, fm, { action: "manager_roster_set", staff_id: ID(10), work_date: week, code: "D" });
    assert.equal(r.status, 200);
    const w = await api(vNew, 3, fm, { action: "manager_roster_week", week_start: week });
    assert.equal(w.body.data.planned_hours[ID(6)], 4 + 9, "Bar: L 4h + L/D 9h");
    assert.equal(w.body.data.planned_hours[ID(10)], 5, "no role: Floor D 5h");
    return "Bar L 4h + L/D 9h = 13h; Floor (no role) D = 5h";
  });

  await check("roster order: saved order comes back; kitchen manager cannot order Floor people", async () => {
    let r = await api(vNew, 2, km, { action: "manager_set_roster_order", staff_ids: [ID(12), ID(4), ID(5)] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const w = await api(vNew, 2, km, { action: "manager_roster_week", week_start: "2026-11-02" });
    const ord = Object.fromEntries(w.body.data.team.map((p) => [p.id, p.roster_order]));
    assert.deepEqual([ord[ID(12)], ord[ID(4)], ord[ID(5)]], [10, 20, 30]);
    r = await api(vNew, 2, km, { action: "manager_set_roster_order", staff_ids: [ID(6)] });
    assert.equal(r.status, 403);
    r = await api(vNew, 2, km, { action: "manager_set_roster_order", staff_ids: [ID(4), ID(4)] });
    assert.equal(r.status, 400);
    assert.equal(Number(await one(db, "select count(*) from public.staff_audit where action = 'manager_set_roster_order'")), 1);
    return "Racer 10, Kitchen A 20, Kitchen B 30; Floor person 403; duplicate 400; 1 audit row";
  });

  await check("existing screens keep working for every manager type", async () => {
    for (const [n, t] of [[1, gm], [2, km], [3, fm]]) {
      for (const action of ["manager_dashboard", "manager_team", "manager_hours", "manager_working", "manager_approvals", "manager_roster_week", "manager_leave_list", "manager_stock_list"]) {
        const r = await api(vNew, n, t, { action });
        assert.equal(r.status, 200, `${n} ${action}: ${JSON.stringify(r.body)}`);
      }
    }
    return "24 calls 200";
  });

  await check("v41 still works with roles in place (server rollback is safe)", async () => {
    const m = await login(v41, 1);
    for (const action of ["manager_dashboard", "manager_team", "manager_roster_week"]) {
      assert.equal((await api(v41, 1, m, { action })).status, 200, action);
    }
    return "dashboard, team, roster 200";
  });

  section("D. Rollback");
  await check("the rollback files remove the order and role columns, table and functions", async () => {
    const rf = db.psqlFile(FLOOR_DOWN); assert.ok(rf.ok, rf.stderr);
    const r0 = db.psqlFile(ORDER_DOWN); assert.ok(r0.ok, r0.stderr);
    const r = db.psqlFile(ROLES_DOWN); assert.ok(r.ok, r.stderr);
    const fp = await db.fingerprints();
    assert.deepEqual(Object.keys(fp).sort(), Object.keys(fpBefore).sort());
    for (const k of Object.keys(fpBefore)) assert.equal(fp[k], fpBefore[k], k);
    assert.equal(Number(await one(db, "select count(*) from information_schema.columns where table_name='staff' and column_name in ('position','roster_only','roster_order')")), 0);
    return "functions equal production again";
  });
  await check("v41 and the new server both work after the rollback", async () => {
    useDatabase(db.svc);
    const m = await login(v41, 1);
    assert.equal((await api(v41, 1, m, { action: "manager_dashboard" })).status, 200);
    const n = await login(vNew, 1);
    assert.equal((await api(vNew, 1, n, { action: "manager_roster_week" })).status, 200);
    return "200 / 200";
  });
} finally {
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL ROLE RELEASE CHECKS PASSED");
process.exit(failures ? 1 : 0);
