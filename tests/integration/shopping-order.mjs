// Release check for the shopping list order (up/down arrows), on a
// production-like database with the current server. Synthetic data only.
// Run: node tests/integration/shopping-order.mjs
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { startProdLikeDb, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "./edge-loader.mjs";
import { ID, PIN, reseed } from "./seed.mjs";

const NEW = "20261103000000_shopping_order.sql";
const MIG = `supabase/migrations/${NEW}`;
const DOWN = "supabase/rollback/20261103000000_shopping_order.down.sql";
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
try {
  for (const f of readdirSync(resolve(root, "supabase/migrations")).filter((f) => f >= "20261013010000" && f < NEW).sort()) db.mustFile(`supabase/migrations/${f}`);
  await reseed(db);
  useDatabase(db.svc);
  const vNew = await quiet(() => loadHandler(resolve(root, "supabase/functions/marinara-api-v2/Index.ts")));
  const vProd = await quiet(() => loadHandler(resolve(root, "tests/edge/baseline-v62.ts")));
  const dev = { 2: newDeviceSecret(), 4: newDeviceSecret() };
  const login = async (h, n) => (await quiet(() => call(h, { action: "login", pin: PIN[ID(n)], device: dev[n] }))).body.session.token;
  const api = (h, n, token, body) => quiet(() => call(h, { ...body, token, device: dev[n] }));
  const km = await login(vNew, 2);
  const add = (name, urgent = false) => api(vNew, 2, km, { action: "manager_shopping_save", item: { name, urgent } });
  const names = async () => (await api(vNew, 2, km, { action: "manager_shopping_list" })).body.data.open.map((i) => i.name);
  for (const n of ["Test A", "Test B", "Test C"]) await add(n);
  await add("Test Urgent", true);

  await check("before the migration: same list, moving answers clearly", async () => {
    assert.deepEqual(await names(), ["Test Urgent", "Test A", "Test B", "Test C"]);
    const r = await api(vNew, 2, km, { action: "manager_shopping_move", id: ID(1), dir: "up" });
    assert.ok(r.status >= 400);
  });
  await check("migration applies twice; the list keeps its order; closed to the public keys", async () => {
    let r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr); r = db.psqlFile(MIG); assert.ok(r.ok, r.stderr);
    assert.deepEqual(await names(), ["Test Urgent", "Test A", "Test B", "Test C"]);
    assert.equal((await db.admin.query(`select has_function_privilege('anon', 'public.manager_shopping_move(uuid,uuid,integer)', 'execute')`)).rows[0][0], "f");
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_shopping_list" })).status, 200);
  });
  const idOf = async (n) => (await api(vNew, 2, km, { action: "manager_shopping_list" })).body.data.open.find((i) => i.name === n).id;
  await check("up and down inside the group; urgent stays on top; ends do nothing", async () => {
    assert.equal((await api(vNew, 2, km, { action: "manager_shopping_move", id: await idOf("Test C"), dir: "up" })).status, 200);
    assert.deepEqual(await names(), ["Test Urgent", "Test A", "Test C", "Test B"]);
    await api(vNew, 2, km, { action: "manager_shopping_move", id: await idOf("Test C"), dir: "up" });
    assert.deepEqual(await names(), ["Test Urgent", "Test C", "Test A", "Test B"]);
    const r = await api(vNew, 2, km, { action: "manager_shopping_move", id: await idOf("Test C"), dir: "up" });
    assert.equal(r.body.data.moved, false); assert.deepEqual(await names(), ["Test Urgent", "Test C", "Test A", "Test B"]);
    await api(vNew, 2, km, { action: "manager_shopping_move", id: await idOf("Test A"), dir: "down" });
    assert.deepEqual(await names(), ["Test Urgent", "Test C", "Test B", "Test A"]);
    await add("Test D");
    assert.deepEqual(await names(), ["Test Urgent", "Test C", "Test B", "Test A", "Test D"], "a new item goes to the end");
    assert.equal((await api(vNew, 2, km, { action: "manager_shopping_move", id: await idOf("Test A"), dir: "sideways" })).status, 400);
    assert.equal((await api(vNew, 2, km, { action: "manager_shopping_move", id: "nope", dir: "up" })).status, 404);
    const st = await login(vNew, 4);
    assert.ok((await api(vNew, 4, st, { action: "manager_shopping_move", id: await idOf("Test A"), dir: "up" })).status >= 400);
  });
  await check("rollback: back to oldest first; the server still works", async () => {
    const r = db.psqlFile(DOWN); assert.ok(r.ok, r.stderr);
    assert.deepEqual(await names(), ["Test Urgent", "Test A", "Test B", "Test C", "Test D"]);
  });
} finally { db.stop(); }
log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL SHOPPING ORDER CHECKS PASSED");
process.exit(failures ? 1 : 0);
