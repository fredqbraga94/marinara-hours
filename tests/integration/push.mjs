// Release check for phone notifications (Web Push), on a production-like
// database. Production at release time = everything up to roster order and
// Floor times, served by the current main server (tests/edge/baseline-v43.ts).
// Push services are not contacted: a stub records what would be sent.
// Run: node tests/integration/push.mjs
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
];
const PUSH = "supabase/migrations/20261021040000_push.sql";
const PUSH_DOWN = "supabase/rollback/20261021040000_push.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v43.ts");

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

// Fake phone subscriptions (valid shapes; nothing is really sent).
const sub = (n, host = "web.push.apple.com") => ({
  endpoint: `https://${host}/QA${n}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
  p256dh: "B" + "x".repeat(86), auth: "a".repeat(22),
});

const db = await startProdLikeDb();
try {
  for (const f of BEFORE) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  useDatabase(db.svc);
  await reseed(db);
  const vProd = await quiet(() => loadHandler(PROD_SERVER));
  const vNew = await quiet(() => loadHandler(NEW_SERVER));
  // VAPID keys for the new server; the stub records sends instead of calling Apple/Google.
  const baseEnv = globalThis.Deno.env.get;
  globalThis.Deno.env.get = (k) => ({ VAPID_PUBLIC_KEY: "BPUBLICKEYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", VAPID_PRIVATE_KEY: "privatekeyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" })[k] ?? baseEnv(k);
  const sent = [];
  let reply = () => ({ ok: true, gone: false, status: 201 });
  globalThis.__MH_PUSH_SEND = async (s, message) => { sent.push({ endpoint: s.endpoint, message }); return reply(s); };

  const dev = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [n, newDeviceSecret()]));
  const login = async (h, n) => {
    const r = await quiet(() => call(h, { action: "login", pin: PIN[ID(n)], device: dev[n] }));
    assert.equal(r.status, 200, `login ${n}: ${JSON.stringify(r.body)}`);
    return r.body.session.token;
  };
  const api = (h, n, token, body) => quiet(() => call(h, { ...body, token, device: dev[n] }));

  section("A. Migration");
  const fpBefore = await db.fingerprints();
  await check("the new server works BEFORE the migration (leave request does not fail)", async () => {
    const st = await login(vNew, 7);
    const r = await api(vNew, 7, st, { action: "session_leave_request", kind: "DAY_OFF", start_date: "2026-12-01" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await settle();
    assert.equal(sent.length, 0);
    return "request 200; nothing sent (no table yet)";
  });
  await check("migration applies; no existing function changed; closed to the public keys", async () => {
    const r = db.psqlFile(PUSH); assert.ok(r.ok, r.stderr);
    const fp = await db.fingerprints();
    assert.deepEqual(Object.keys(fpBefore).filter((k) => fp[k] !== fpBefore[k]), []);
    assert.equal(await one(db, "select has_table_privilege('anon', 'public.push_subscriptions', 'select')"), "f");
    assert.equal(await one(db, "select has_function_privilege('anon', 'public.manager_push_subscribe(uuid,text,text,text,text)', 'execute')"), "f");
    return `added: ${Object.keys(fp).filter((k) => !(k in fpBefore)).sort().join(", ")}`;
  });

  section("B. Production server on the new database");
  await check("current production server keeps working", async () => {
    const m = await login(vProd, 1);
    for (const action of ["manager_dashboard", "manager_team", "manager_roster_week", "manager_leave_list"]) {
      assert.equal((await api(vProd, 1, m, { action })).status, 200, action);
    }
    const st = await login(vProd, 6);
    const r = await api(vProd, 6, st, { action: "session_leave_request", kind: "DAY_OFF", start_date: "2026-12-02" });
    assert.equal(r.status, 200);
    return "manager screens and a leave request 200";
  });

  section("C. New server");
  const gm = await login(vNew, 1);
  const km = await login(vNew, 2);
  const fm = await login(vNew, 3);

  await check("turn on: only real push services are accepted", async () => {
    let r = await api(vNew, 1, gm, { action: "manager_push_subscribe", ...sub(1, "evil.example.com") });
    assert.equal(r.status, 400);
    r = await api(vNew, 1, gm, { action: "manager_push_subscribe", ...sub(1), p256dh: "short" });
    assert.equal(r.status, 400);
    r = await api(vNew, 1, gm, { action: "manager_push_subscribe", ...sub(1), label: "iPhone · Fred" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api(vNew, 2, km, { action: "manager_push_subscribe", ...sub(2, "fcm.googleapis.com"), label: "Android · Dani" });
    assert.equal(r.status, 200);
    r = await api(vNew, 3, fm, { action: "manager_push_subscribe", ...sub(3), label: "iPhone · Chris" });
    assert.equal(r.status, 200);
    const cfg = await api(vNew, 1, gm, { action: "manager_push_config" });
    assert.ok(cfg.body.data.public_key);
    return "other host 400; bad key 400; Apple and Google 200; public key served";
  });

  await check("a Floor request goes to the Administrator and the Floor manager, not Kitchen", async () => {
    sent.length = 0;
    const st = await login(vNew, 6);
    const r = await api(vNew, 6, st, { action: "session_leave_request", kind: "HOLIDAY", start_date: "2026-11-09", end_date: "2026-11-11" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await settle();
    const to = sent.map((x) => x.endpoint).sort();
    assert.deepEqual(to, [sub(1).endpoint, sub(3).endpoint].sort());
    assert.equal(sent[0].message.title, "Holiday request");
    assert.match(sent[0].message.body, /^Test Floor A asked for a holiday · 9–11 Nov\./);
    assert.equal(sent[0].message.url, "./?open=timeoff");
    return `sent to 2 phones: "${sent[0].message.body}"`;
  });

  await check("a Kitchen request goes to the Administrator and the Kitchen manager", async () => {
    sent.length = 0;
    const st = await login(vNew, 4);
    await api(vNew, 4, st, { action: "session_leave_request", kind: "DAY_OFF", start_date: "2026-11-20" });
    await settle();
    assert.deepEqual(sent.map((x) => x.endpoint).sort(), [sub(1).endpoint, sub(2, "fcm.googleapis.com").endpoint].sort());
    assert.match(sent[0].message.body, /asked for a day off · 20 Nov/);
    return "admin + kitchen manager";
  });

  await check("a phone that is gone (410) is turned off automatically", async () => {
    sent.length = 0;
    reply = (s) => (s.endpoint === sub(3).endpoint ? { ok: false, gone: true, status: 410 } : { ok: true, gone: false, status: 201 });
    const st = await login(vNew, 6);
    await api(vNew, 6, st, { action: "session_leave_request", kind: "DAY_OFF", start_date: "2026-11-25" });
    await settle();
    reply = () => ({ ok: true, gone: false, status: 201 });
    assert.equal(await one(db, `select active from public.push_subscriptions where endpoint = '${sub(3).endpoint}'`), "f");
    return "Chris's phone (410) now off";
  });

  await check("list: Administrator sees all phones and can turn one off; others only their own", async () => {
    let r = await api(vNew, 1, gm, { action: "manager_push_list" });
    assert.equal(r.body.data.subscriptions.length, 2, JSON.stringify(r.body));
    const dani = r.body.data.subscriptions.find((p) => p.device_label === "Android · Dani");
    r = await api(vNew, 2, km, { action: "manager_push_list" });
    assert.equal(r.body.data.subscriptions.length, 1);
    r = await api(vNew, 2, km, { action: "manager_push_remove", id: dani.id });
    assert.equal(r.status, 403);
    r = await api(vNew, 1, gm, { action: "manager_push_remove", id: dani.id });
    assert.equal(r.status, 200);
    r = await api(vNew, 1, gm, { action: "manager_push_test" });
    assert.equal(r.body.data.phones, 1); assert.equal(r.body.data.sent, 1);
    r = await api(vNew, 1, gm, { action: "manager_push_unsubscribe", endpoint: sub(1).endpoint });
    assert.equal(r.status, 200);
    r = await api(vNew, 1, gm, { action: "manager_push_list" });
    assert.equal(r.body.data.subscriptions.length, 0);
    return "admin 2, kitchen manager 1 (own); remove 403 for kitchen manager, 200 for admin; test sent; own turn-off works";
  });

  await check("a failing push service never breaks the request", async () => {
    await api(vNew, 1, gm, { action: "manager_push_subscribe", ...sub(9) });
    globalThis.__MH_PUSH_SEND = async () => { throw new Error("network down"); };
    const st = await login(vNew, 6);
    const r = await api(vNew, 6, st, { action: "session_leave_request", kind: "DAY_OFF", start_date: "2026-11-27" });
    await settle();
    assert.equal(r.status, 200);
    assert.match(await one(db, `select last_error from public.push_subscriptions where endpoint = '${sub(9).endpoint}'`), /network down/);
    return "request 200; error recorded on the phone";
  });

  section("D. Rollback");
  await check("rollback removes the table and functions; both servers still work", async () => {
    const r = db.psqlFile(PUSH_DOWN); assert.ok(r.ok, r.stderr);
    const fp = await db.fingerprints();
    assert.deepEqual(Object.keys(fp).sort(), Object.keys(fpBefore).sort());
    const st = await login(vNew, 7);
    const a = await api(vNew, 7, st, { action: "session_leave_request", kind: "DAY_OFF", start_date: "2026-12-10" });
    await settle();
    const m = await login(vProd, 1);
    const b = await api(vProd, 1, m, { action: "manager_dashboard" });
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    return "leave request 200 (new), dashboard 200 (production)";
  });
} finally {
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL PUSH RELEASE CHECKS PASSED");
process.exit(failures ? 1 : 0);
