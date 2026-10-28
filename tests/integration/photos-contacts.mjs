// Release check for photos on Shopping/Maintenance items and Maintenance
// contacts, on a production-like database. Production at release time =
// everything up to permissions per manager, served by the current main server
// (tests/edge/baseline-v52.ts).
// Synthetic people and items only: this repository is public.
// Run: node tests/integration/photos-contacts.mjs
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
  "supabase/migrations/20261021010000_roster_roles.sql",
  "supabase/migrations/20261021020000_roster_order.sql",
  "supabase/migrations/20261021030000_floor_services.sql",
  "supabase/migrations/20261021040000_push.sql",
  "supabase/migrations/20261021050000_push_badge.sql",
  "supabase/migrations/20261022000000_recipes.sql",
  "supabase/migrations/20261022010000_recipes_kids_pasta.sql",
  "supabase/migrations/20261022020000_recipes_dairy_kinds.sql",
  "supabase/migrations/20261022030000_invoices.sql",
  "supabase/migrations/20261022040000_ingredient_costs.sql",
  "supabase/migrations/20261027000000_invoice_price_book.sql",
  "supabase/migrations/20261027010000_manager_permissions.sql",
  "supabase/migrations/20261028000000_shopping_list.sql",
  "supabase/migrations/20261028010000_maintenance.sql",
];
const PC = "supabase/migrations/20261028020000_photos_contacts.sql";
const PC_DOWN = "supabase/rollback/20261028020000_photos_contacts.down.sql";
const NEW_SERVER = resolve(root, "supabase/functions/marinara-api-v2/Index.ts");
const PROD_SERVER = resolve(root, "tests/edge/baseline-v52.ts");

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

const THUMB = "data:image/jpeg;base64," + "A".repeat(400);
const PHOTO = "data:image/jpeg;base64," + "B".repeat(4000);

const db = await startProdLikeDb();
try {
  for (const f of BEFORE) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  useDatabase(db.svc);
  await reseed(db);
  for (const f of BEFORE.slice(-9)) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
  const vProd = await quiet(() => loadHandler(PROD_SERVER));
  const vNew = await quiet(() => loadHandler(NEW_SERVER));
  const dev = Object.fromEntries([1, 2, 3, 5].map((n) => [n, newDeviceSecret()]));
  const login = async (h, n) => {
    const r = await quiet(() => call(h, { action: "login", pin: PIN[ID(n)], device: dev[n] }));
    assert.equal(r.status, 200, `login ${n}: ${JSON.stringify(r.body)}`);
    return r.body.session.token;
  };
  const api = (h, n, token, body) => quiet(() => call(h, { ...body, token, device: dev[n] }));
  const gm = await login(vNew, 1);
  const km = await login(vNew, 2);
  const fm = await login(vNew, 3);
  const knife = (await api(vNew, 2, km, { action: "manager_shopping_save", item: { name: "Test knife" } })).body.data.item;
  const oven = (await api(vNew, 2, km, { action: "manager_maintenance_save", item: { equipment: "Test oven", urgent: true } })).body.data.item;

  section("A. Before the migration");
  const fpBefore = await db.fingerprints();
  await check("lists work without photos; photo and contact actions answer clearly", async () => {
    const l = (await api(vNew, 1, gm, { action: "manager_shopping_list" })).body.data;
    assert.equal(l.open[0].thumb, undefined);
    const r = await api(vNew, 1, gm, { action: "manager_contact_list" });
    assert.ok(r.status >= 400 && r.body.error, JSON.stringify(r.body));
    return `shopping list 200; contacts ${r.status}`;
  });

  section("B. Migration");
  await check("applies; nothing else changed; closed to the public keys; runs twice", async () => {
    const r = db.psqlFile(PC); assert.ok(r.ok, r.stderr);
    const fp = await db.fingerprints();
    const changed = Object.keys(fpBefore).filter((k) => fp[k] !== fpBefore[k]);
    assert.ok(changed.every((k) => /mh_shopping_json|mh_maintenance_json/.test(k)), JSON.stringify(changed));
    for (const role of ["anon", "authenticated"]) {
      for (const t of ["item_photos", "maintenance_contacts"]) assert.equal(await one(db, `select has_table_privilege('${role}', 'public.${t}', 'select')`), "f", role);
      assert.equal(await one(db, `select has_function_privilege('${role}', 'public.manager_photo_get(uuid,text,uuid)', 'execute')`), "f", role);
    }
    const again = db.psqlFile(PC); assert.ok(again.ok, again.stderr);
    return changed.length ? `only the two list helpers changed (${changed.length})` : "nothing existing changed";
  });
  await check("current production server keeps working", async () => {
    const p = await login(vProd, 1);
    assert.equal((await api(vProd, 1, p, { action: "manager_dashboard" })).status, 200);
    return "Home 200";
  });

  section("C. Photos");
  const setPhoto = (n, token, kind, item_id, thumb = THUMB, photo = PHOTO) => api(vNew, n, token, { action: "manager_photo_set", kind, item_id, thumb, photo });
  await check("add a photo; the list shows the preview; tap loads the larger copy; replace; remove", async () => {
    assert.equal((await setPhoto(3, fm, "shopping", knife.id)).status, 200);
    let l = (await api(vNew, 1, gm, { action: "manager_shopping_list" })).body.data;
    assert.equal(l.open[0].thumb, THUMB);
    const g = await api(vNew, 2, km, { action: "manager_photo_get", kind: "shopping", item_id: knife.id });
    assert.equal(g.status, 200); assert.equal(g.body.data.photo, PHOTO);
    assert.equal((await setPhoto(1, gm, "maintenance", oven.id)).status, 200);
    const t2 = "data:image/jpeg;base64," + "C".repeat(300);
    assert.equal((await setPhoto(1, gm, "maintenance", oven.id, t2)).status, 200, "replace");
    assert.equal(Number(await one(db, "select count(*) from public.item_photos")), 2, "one photo per item");
    const m = (await api(vNew, 1, gm, { action: "manager_maintenance_list" })).body.data;
    assert.equal(m.open[0].thumb, t2);
    assert.equal((await api(vNew, 1, gm, { action: "manager_photo_remove", kind: "shopping", item_id: knife.id })).status, 200);
    l = (await api(vNew, 1, gm, { action: "manager_shopping_list" })).body.data;
    assert.equal(l.open[0].thumb, null);
    return "set, list preview, larger copy, replaced, removed";
  });
  await check("bad photos, wrong items and staff are refused", async () => {
    assert.equal((await setPhoto(1, gm, "shopping", knife.id, "data:image/png;base64,AAAA")).status, 400, "not jpeg");
    assert.equal((await setPhoto(1, gm, "shopping", knife.id, THUMB, "data:image/jpeg;base64," + "A".repeat(700001))).status, 400, "too big");
    assert.equal((await setPhoto(1, gm, "shopping", knife.id, "data:image/jpeg;base64,<script>")).status, 400, "not base64");
    assert.equal((await setPhoto(1, gm, "stock", knife.id)).status, 404, "unknown kind");
    assert.equal((await setPhoto(1, gm, "maintenance", knife.id)).status, 404, "item of the other list");
    assert.equal((await setPhoto(1, gm, "shopping", "00000000-0000-4000-8000-00000000ffff")).status, 404);
    const other = await one(db, `insert into public.shopping_items (location, name) values ('Test Elsewhere', 'Test other') returning id::text`);
    assert.equal((await setPhoto(1, gm, "shopping", other)).status, 404, "other location");
    await db.admin.query(`insert into public.item_photos (location, kind, item_id, thumb, photo) values ('Test Elsewhere', 'shopping', '${other}', '${THUMB}', '${PHOTO}')`);
    assert.equal((await api(vNew, 1, gm, { action: "manager_photo_get", kind: "shopping", item_id: other })).status, 404, "other location's photo not shown");
    const st = await login(vNew, 5);
    assert.ok((await setPhoto(5, st, "shopping", knife.id)).status >= 400, "staff");
    assert.equal((await api(vNew, 1, gm, { action: "manager_shopping_mark", id: knife.id, status: "removed" })).status, 200);
    assert.equal((await setPhoto(1, gm, "shopping", knife.id)).status, 404, "removed item");
    return "png, too big, not base64, wrong list, other location, staff, removed item: all refused";
  });

  section("D. Contacts");
  const saveC = (n, token, contact) => api(vNew, n, token, { action: "manager_contact_save", contact });
  await check("every manager adds contacts; list by service; edit; remove", async () => {
    const a = await saveC(3, fm, { trade: "Plumber", name: "Test Plumbing Co", phone: "+61 400 000 001", note: "After hours ok" });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const b = await saveC(2, km, { trade: "Oven", name: "", phone: "(07) 3000 0002" });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    let l = (await api(vNew, 1, gm, { action: "manager_contact_list" })).body.data.contacts;
    assert.deepEqual(l.map((c) => c.trade), ["Oven", "Plumber"]);
    assert.equal(l[0].name, null);
    const e = await saveC(1, gm, { id: b.body.data.contact.id, trade: "Pizza oven", name: "Test Oven Tech", phone: "07 3000 0003" });
    assert.equal(e.status, 200); assert.equal(e.body.data.contact.phone, "07 3000 0003");
    assert.equal((await api(vNew, 1, gm, { action: "manager_contact_remove", id: a.body.data.contact.id })).status, 200);
    assert.equal((await api(vNew, 1, gm, { action: "manager_contact_remove", id: a.body.data.contact.id })).status, 404, "already removed");
    l = (await api(vNew, 3, fm, { action: "manager_contact_list" })).body.data.contacts;
    assert.deepEqual(l.map((c) => c.name), ["Test Oven Tech"]);
    return "added by floor and kitchen managers; edited; removed";
  });
  await check("bad contacts, other locations and staff are refused", async () => {
    assert.equal((await saveC(1, gm, { trade: "", phone: "0400" })).status, 400);
    assert.equal((await saveC(1, gm, { trade: "Electrician", phone: "call me" })).status, 400);
    assert.equal((await saveC(1, gm, { trade: "Electrician", phone: "12" })).status, 400);
    assert.equal((await saveC(1, gm, { id: "x", trade: "Electrician", phone: "0400 000 000" })).status, 404);
    const other = await one(db, `insert into public.maintenance_contacts (location, trade, phone) values ('Test Elsewhere', 'Test other', '0400') returning id::text`);
    assert.equal((await api(vNew, 1, gm, { action: "manager_contact_list" })).body.data.contacts.some((c) => c.trade === "Test other"), false);
    assert.equal((await saveC(1, gm, { id: other, trade: "x", phone: "0400 000 000" })).status, 404);
    const st = await login(vNew, 5);
    assert.ok((await api(vNew, 5, st, { action: "manager_contact_list" })).status >= 400);
    return "blank service, letters, too short, bad id, other location, staff: all refused";
  });

  section("E. Rollback");
  await check("rollback: photos and contacts go away; lists, both servers still work", async () => {
    const r = db.psqlFile(PC_DOWN); assert.ok(r.ok, r.stderr);
    assert.deepEqual(await db.fingerprints(), fpBefore);
    assert.equal((await api(vNew, 1, gm, { action: "manager_maintenance_list" })).status, 200);
    assert.equal((await api(vNew, 1, gm, { action: "manager_shopping_list" })).status, 200);
    const p = await login(vProd, 2);
    assert.equal((await api(vProd, 2, p, { action: "manager_dashboard" })).status, 200);
    return "same database as before; lists 200; production server 200";
  });
} finally {
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL PHOTOS AND CONTACTS RELEASE CHECKS PASSED");
process.exit(failures ? 1 : 0);
