// Release check for Notes (Kitchen and Floor lists, kept apart), on a
// production-like database, with the production server (baseline-v65) still
// working before and after. Synthetic data only: this repository is public.
// Run: node tests/integration/notes.mjs
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { startProdLikeDb, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "./edge-loader.mjs";
import { ID, PIN, reseed } from "./seed.mjs";

const NEW = "20261109010000_notes.sql";
const MIG = `supabase/migrations/${NEW}`;
const DOWN = "supabase/rollback/20261109010000_notes.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v65.ts");

let failures = 0;
const log = (...a) => console.log(...a);
async function check(name, fn) {
  try { const note = await fn(); log(`  ✔ ${name}${note ? `\n      ${note}` : ""}`); }
  catch (e) {
    failures++;
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=${name.replace(/[:,\n]/g, " ")}::${String(e?.stack || e).replace(/\r?\n/g, " | ").slice(0, 900)}`);
    log(`  ✖ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 8).join("\n      ")}`);
  }
}
const realConsole = { ...console };
async function quiet(fn) {
  for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = () => {};
  try { return await fn(); } finally { Object.assign(console, realConsole); }
}

const db = await startProdLikeDb();
const one = async (sql) => (await db.admin.query(sql)).rows[0]?.[0];
try {
  for (const f of readdirSync(resolve(root, "supabase/migrations")).filter((f) => f >= "20261013010000" && f < NEW).sort()) db.mustFile(`supabase/migrations/${f}`);
  await reseed(db);
  useDatabase(db.svc);
  const vProd = await quiet(() => loadHandler(PROD_SERVER));
  const vNew = await quiet(() => loadHandler(NEW_SERVER));
  const dev = Object.fromEntries([1, 2, 3, 4].map((n) => [n, newDeviceSecret()]));
  const login = async (h, n) => {
    const r = await quiet(() => call(h, { action: "login", pin: PIN[ID(n)], device: dev[n] }));
    assert.equal(r.status, 200, `login ${n}: ${JSON.stringify(r.body)}`);
    return r.body.session.token;
  };
  const api = (h, n, token, body) => quiet(() => call(h, { ...body, token, device: dev[n] }));
  const gm = await login(vNew, 1), km = await login(vNew, 2), fm = await login(vNew, 3);

  await check("before the migration: clear answer; Home works", async () => {
    const r = await api(vNew, 2, km, { action: "manager_note_list" });
    assert.ok(r.status >= 400 && r.body.error);
    assert.equal((await api(vNew, 2, km, { action: "manager_dashboard" })).status, 200);
  });
  await check("migration applies, runs twice, closed to the public keys; production server keeps working", async () => {
    let r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await one(`select has_table_privilege('${role}', 'public.manager_notes', 'select')`), "f");
      assert.equal(await one(`select has_function_privilege('${role}', 'public.manager_note_save(uuid,jsonb)', 'execute')`), "f");
      assert.equal(await one(`select has_function_privilege('${role}', 'public.manager_note_list(uuid,text)', 'execute')`), "f");
    }
    const p = await login(vProd, 1);
    assert.equal((await api(vProd, 1, p, { action: "manager_dashboard" })).status, 200);
  });
  const list = async (n, tok, department) => (await api(vNew, n, tok, { action: "manager_note_list", ...(department ? { department } : {}) })).body;
  const save = (n, tok, note) => api(vNew, n, tok, { action: "manager_note_save", note });
  let kNote, fNote;
  await check("each manager writes in their own list; the Administrator sees both", async () => {
    let r = await save(2, km, { department: "Kitchen", body: "Test: clean the fryer\nThursday" });
    assert.equal(r.status, 200, JSON.stringify(r.body)); kNote = r.body.data.note;
    assert.equal(kNote.department, "Kitchen"); assert.equal(kNote.body, "Test: clean the fryer\nThursday"); assert.equal(kNote.created_by, "Test Kitchen Manager");
    r = await save(3, fm, { body: "Test: table 4 booking" });
    assert.equal(r.status, 200, JSON.stringify(r.body)); fNote = r.body.data.note;
    assert.equal(fNote.department, "Floor", "a Floor Manager writes in Floor");
    await save(1, gm, { department: "Kitchen", body: "Test: older kitchen note", pinned: true });
    const k = await list(2, km);
    assert.equal(k.data.department, "Kitchen"); assert.equal(k.data.can_choose_department, false);
    assert.deepEqual(k.data.notes.map((n) => n.body), ["Test: older kitchen note", "Test: clean the fryer\nThursday"], "pinned first");
    const f = await list(3, fm);
    assert.deepEqual(f.data.notes.map((n) => n.body), ["Test: table 4 booking"]);
    assert.equal((await list(1, gm, "Floor")).data.notes.length, 1);
    assert.equal((await list(1, gm, "Kitchen")).data.notes.length, 2);
    assert.equal((await list(1, gm, "Kitchen")).data.can_choose_department, true);
  });
  await check("a manager cannot read, write, edit or remove the other list", async () => {
    let r = await api(vNew, 2, km, { action: "manager_note_list", department: "Floor" });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    r = await save(2, km, { department: "Floor", body: "Test: sneaky" });
    assert.equal(r.status, 403);
    r = await save(2, km, { id: fNote.id, department: "Kitchen", body: "Test: changed" });
    assert.equal(r.status, 404);
    r = await api(vNew, 2, km, { action: "manager_note_remove", id: fNote.id });
    assert.equal(r.status, 404);
    assert.equal((await list(3, fm)).data.notes[0].body, "Test: table 4 booking", "untouched");
    const st = await login(vNew, 4);
    assert.ok((await api(vNew, 4, st, { action: "manager_note_list" })).status >= 400, "staff refused");
  });
  await check("edit, pin, empty refused, remove (only once)", async () => {
    let r = await save(1, gm, { id: kNote.id, department: "Kitchen", body: "Test: clean the fryer Friday", pinned: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.note.updated_by, "Test General Manager");
    assert.equal(r.body.data.note.pinned, true);
    assert.equal((await save(2, km, { department: "Kitchen", body: "   " })).status, 400);
    assert.equal((await save(2, km, { id: "nope", body: "x" })).status, 404);
    assert.equal((await api(vNew, 2, km, { action: "manager_note_remove", id: kNote.id })).status, 200);
    assert.equal((await api(vNew, 2, km, { action: "manager_note_remove", id: kNote.id })).status, 404);
    assert.deepEqual((await list(2, km)).data.notes.map((n) => n.body), ["Test: older kitchen note"]);
  });
  await check("another unit has its own notes", async () => {
    assert.equal((await api(vNew, 1, gm, { action: "manager_unit_set", location: "Paddington" })).status, 200);
    assert.equal((await list(1, gm, "Floor")).data.notes.length, 0);
    assert.equal((await api(vNew, 1, gm, { action: "manager_note_remove", id: fNote.id })).status, 404);
    assert.equal((await api(vNew, 1, gm, { action: "manager_unit_set", location: "Hawthorne" })).status, 200);
  });
  await check("rollback removes it; both servers still work", async () => {
    const r = db.psqlFile(DOWN); assert.ok(r.ok, r.stderr);
    assert.equal(await one(`select to_regclass('public.manager_notes') is null`), "t");
    assert.equal((await api(vNew, 1, gm, { action: "manager_dashboard" })).status, 200);
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_dashboard" })).status, 200);
  });
} finally {
  db.stop();
}
log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL NOTES CHECKS PASSED");
process.exit(failures ? 1 : 0);
