// Release check for the time-off count (app icon number), on a production-like
// database. Production at release time = everything up to phone notifications,
// served by the current main server (tests/edge/baseline-v44.ts).
// Run: node tests/integration/push-badge.mjs
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { startProdLikeDb, MIGRATION_A, MIGRATION_B, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret, settle } from "./edge-loader.mjs";
import { ID, PIN, reseed } from "./seed.mjs";

const BEFORE = [
  MIGRATION_A, MIGRATION_B,
  "supabase/migrations/20261020000000_student_visa.sql",
  "supabase/migrations/20261020010000_roster.sql",
  "supabase/migrations/20261020020000_leave.sql",
  "supabase/migrations/20261020030000_public_holidays.sql",
  "supabase/migrations/20261021000000_stock_par.sql",
  "supabase/migrations/20261021010000_roster_roles.sql",
  "supabase/migrations/20261021020000_roster_order.sql",
  "supabase/migrations/20261021030000_floor_services.sql",
  "supabase/migrations/20261021040000_push.sql",
];
const BADGE = "supabase/migrations/20261021050000_push_badge.sql";
const BADGE_DOWN = "supabase/rollback/20261021050000_push_badge.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v44.ts");

let failures = 0;
const log = (...a) => console.log(...a);
async function check(name, fn) {
  try {
    const note = await fn();
    log(`  ✔ ${name}${note ? `\n      ${note}` : ""}`);
  } catch (e) {
    failures++;
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=${name.replace(/[:,\n]/g, " ")}::${String(e?.stack || e).replace(/\r?\n/g, " | ").slice(0, 900)}`);
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
const sub = (n, host = "web.push.apple.com") => ({
  endpoint: `https://${host}/QB${n}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
  p256dh: "B" + "x".repeat(86), auth: "a".repeat(22),
});

const db = await startProdLikeDb();
try {
  for (const f of BEFORE) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  useDatabase(db.svc);
  await reseed(db);
  const vProd = await quiet(() => loadHandler(PROD_SERVER));
  const vNew = await quiet(() => loadHandler(NEW_SERVER));
  const sent = [];
  globalThis.__MH_PUSH_SEND = async (s, message) => { sent.push({ endpoint: s.endpoint, message }); return { ok: true, gone: false, status: 201 }; };

  const dev = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [n, newDeviceSecret()]));
  const login = async (h, n) => {
    const r = await quiet(() => call(h, { action: "login", pin: PIN[ID(n)], device: dev[n] }));
    assert.equal(r.status, 200, `login ${n}: ${JSON.stringify(r.body)}`);
    return r.body.session.token;
  };
  const api = (h, n, token, body) => quiet(() => call(h, { ...body, token, device: dev[n] }));

  section("A. Before the migration");
  const fpBefore = await db.fingerprints();
  await check("new server: notifications still go out without the count", async () => {
    const gm = await login(vNew, 1);
    assert.equal((await api(vNew, 1, gm, { action: "manager_push_subscribe", ...sub(1) })).status, 200);
    sent.length = 0;
    const st = await login(vNew, 6);
    assert.equal((await api(vNew, 6, st, { action: "session_leave_request", kind: "DAY_OFF", start_date: "2026-12-01" })).status, 200);
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].message.badge, undefined);
    return "sent 1, no number";
  });

  section("B. Migration");
  await check("applies; nothing existing changed; closed to the public keys", async () => {
    const r = db.psqlFile(BADGE); assert.ok(r.ok, r.stderr);
    const fp = await db.fingerprints();
    assert.deepEqual(Object.keys(fpBefore).filter((k) => fp[k] !== fpBefore[k]), []);
    assert.equal(await one(db, "select has_function_privilege('anon', 'public.mh_push_badges(text)', 'execute')"), "f");
    return `added: ${Object.keys(fp).filter((k) => !(k in fpBefore)).join(", ")}`;
  });
  await check("current production server keeps working", async () => {
    const m = await login(vProd, 1);
    for (const action of ["manager_dashboard", "manager_leave_list", "manager_push_list"]) {
      assert.equal((await api(vProd, 1, m, { action })).status, 200, action);
    }
    return "200";
  });

  section("C. New server");
  const gm = await login(vNew, 1);
  const km = await login(vNew, 2);
  const fm = await login(vNew, 3);
  await api(vNew, 2, km, { action: "manager_push_subscribe", ...sub(2, "fcm.googleapis.com") });
  await api(vNew, 3, fm, { action: "manager_push_subscribe", ...sub(3) });

  await check("each phone gets its own number: Administrator all, managers their department", async () => {
    // Waiting now: 1 Floor (from A). Add 1 Kitchen, then 1 more Floor.
    const k = await login(vNew, 4);
    await api(vNew, 4, k, { action: "session_leave_request", kind: "DAY_OFF", start_date: "2026-12-03" });
    await settle();
    sent.length = 0;
    const f = await login(vNew, 7);
    await api(vNew, 7, f, { action: "session_leave_request", kind: "HOLIDAY", start_date: "2026-12-08", end_date: "2026-12-09" });
    await settle();
    const by = Object.fromEntries(sent.map((x) => [x.endpoint, x.message.badge]));
    assert.deepEqual(by, { [sub(1).endpoint]: 3, [sub(3).endpoint]: 2 });
    return "Administrator 3, Floor manager 2 (Kitchen manager not notified for Floor)";
  });

  await check("app count matches what each manager has to answer", async () => {
    const a = await api(vNew, 1, gm, { action: "manager_leave_count" });
    const b = await api(vNew, 2, km, { action: "manager_leave_count" });
    const c = await api(vNew, 3, fm, { action: "manager_leave_count" });
    assert.deepEqual([a.body.data.pending, b.body.data.pending, c.body.data.pending], [3, 1, 2]);
    const list = await api(vNew, 1, gm, { action: "manager_leave_list" });
    const first = list.body.data.pending[0];
    assert.equal((await api(vNew, 1, gm, { action: "manager_leave_decide", leave_id: first.id, decision: "DECLINE" })).status, 200);
    assert.equal((await api(vNew, 1, gm, { action: "manager_leave_count" })).body.data.pending, 2);
    return "3 / 1 / 2; after declining one: 2";
  });

  await check("staff sessions cannot read the count", async () => {
    const st = await login(vNew, 6);
    const r = await api(vNew, 6, st, { action: "manager_leave_count" });
    assert.notEqual(r.status, 200);
    return `staff → ${r.status}`;
  });

  section("D. Rollback");
  await check("rollback removes the function; notifications still go out", async () => {
    const r = db.psqlFile(BADGE_DOWN); assert.ok(r.ok, r.stderr);
    assert.deepEqual(Object.keys(await db.fingerprints()).sort(), Object.keys(fpBefore).sort());
    sent.length = 0;
    const st = await login(vNew, 6);
    await api(vNew, 6, st, { action: "session_leave_request", kind: "DAY_OFF", start_date: "2026-12-15" });
    await settle();
    assert.equal(sent.length, 2);
    assert.ok(sent.every((x) => x.message.badge === undefined));
    return "sent 2, without numbers";
  });
} finally {
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL BADGE RELEASE CHECKS PASSED");
process.exit(failures ? 1 : 0);
