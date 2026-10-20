// Release check for stock par level on a production-like database, before
// anything touches Hawthorne. Production today = snapshot + the two hardening
// migrations + the four 2026-10-20 migrations, served by edge v41 (frozen in
// tests/edge/baseline-v41.ts). Synthetic data only; nothing connects to
// Supabase. Run: node tests/integration/stock.mjs
//
//  A. The stock migration applies cleanly, changes no existing function, row
//     or table privilege, and loads the Hawthorne Floor list from the sheet.
//  B. The production server (v41) keeps working on the new database.
//  C. The new server: existing flows unchanged; count -> order maths; edit the
//     list; suppliers' minimum order; department scope.
//  D. The rollback file undoes it and v41 still works.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { startProdLikeDb, MIGRATION_A, MIGRATION_B, root } from "./pgenv.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "./edge-loader.mjs";
import { ID, PIN, reseed } from "./seed.mjs";

const PROD_MIGRATIONS = [
  MIGRATION_A, MIGRATION_B,
  "supabase/migrations/20261020000000_student_visa.sql",
  "supabase/migrations/20261020010000_roster.sql",
  "supabase/migrations/20261020020000_leave.sql",
  "supabase/migrations/20261020030000_public_holidays.sql",
];
const STOCK = "supabase/migrations/20261021000000_stock_par.sql";
const STOCK_DOWN = "supabase/rollback/20261021000000_stock_par.down.sql";
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
  || coalesce((select string_agg(id::text || staff_id::text || clock_in::text || coalesce(clock_out::text,'') || status || approved::text || coalesce(notes,''), ',' order by id) from public.shifts), '')
  || coalesce((select string_agg(id::text || shift_id::text || break_start::text || coalesce(break_end::text,''), ',' order by id) from public.breaks), '')
  || coalesce((select count(*)::text from public.shift_audit), '')
  || coalesce((select count(*)::text from public.roster_entries), '')
  || coalesce((select count(*)::text from public.leave_requests), '')
  || coalesce((select count(*)::text from public.public_holidays), '')
  || coalesce((select count(*)::text from public.staff_sessions), ''))`;

const db = await startProdLikeDb();
try {
  for (const f of PROD_MIGRATIONS) { const r = db.psqlFile(f); assert.ok(r.ok, `${f}: ${r.stderr}`); }
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

  // ------------------------------------------------------------ A
  section("A. Stock migration on the production structure");
  const fpBefore = await db.fingerprints();
  const dataBefore = await one(db, DATA_SQL);
  const aclBefore = await db.tableAcl();

  await check("the stock migration applies cleanly in one transaction", async () => {
    const r = db.psqlFile(STOCK); assert.ok(r.ok, r.stderr);
    return STOCK.split("/").pop();
  });
  await check("no existing function changed", async () => {
    const fp = await db.fingerprints();
    const changed = Object.keys(fpBefore).filter((k) => fp[k] !== fpBefore[k]);
    assert.deepEqual(changed, []);
    const added = Object.keys(fp).filter((k) => !(k in fpBefore)).sort();
    assert.ok(added.every((k) => k.includes("stock")), added.join(", "));
    return `added only: ${added.join(", ")}`;
  });
  await check("no existing row changed", async () => {
    assert.equal(await one(db, DATA_SQL), dataBefore);
    return "staff, shifts, breaks, audit, roster, leave, holidays, sessions identical";
  });
  await check("existing table privileges unchanged; stock tables closed to the public keys", async () => {
    const acl = await db.tableAcl();
    for (const [t, v] of Object.entries(aclBefore)) assert.equal(acl[t], v, t);
    for (const t of ["stock_items", "stock_suppliers", "stock_counts", "stock_audit"]) {
      for (const role of ["anon", "authenticated"]) {
        for (const p of ["select", "insert", "update", "delete"]) {
          assert.equal(await one(db, `select has_table_privilege('${role}', 'public.${t}', '${p}')`), "f", `${t} ${role} ${p}`);
        }
      }
    }
    for (const fn of ["manager_stock_list(uuid,text,text)", "manager_stock_item_save(uuid,text,jsonb)",
      "manager_stock_item_remove(uuid,text,uuid)", "manager_stock_supplier_save(uuid,text,text,text,integer,text)",
      "manager_stock_count_save(uuid,text,text,jsonb)"]) {
      assert.equal(await one(db, `select has_function_privilege('anon', 'public.${fn}', 'execute')`), "f", fn);
      assert.equal(await one(db, `select has_function_privilege('authenticated', 'public.${fn}', 'execute')`), "f", fn);
    }
    return "anon / authenticated cannot read or change stock, or run its functions";
  });
  await check("Hawthorne Floor list loaded from the par sheet (232 items, 3 suppliers)", async () => {
    assert.equal(Number(await one(db, "select count(*) from public.stock_items where location='Hawthorne' and department='Floor'")), 232);
    assert.equal(Number(await one(db, "select count(*) from public.stock_suppliers")), 3);
    assert.equal(await one(db, "select min_order from public.stock_suppliers where name like 'Tom San%'"), "9");
    // Applying it again adds nothing (never overwrites changes made in the app).
    const r = db.psqlFile(STOCK); assert.ok(r.ok, r.stderr);
    assert.equal(Number(await one(db, "select count(*) from public.stock_items")), 232);
    return "232 items; Tom San Pellegrino min 9; re-run adds nothing";
  });

  // ------------------------------------------------------------ B
  section("B. Production server (v41) on the new database");
  await check("v41: staff clock flow and manager screens", async () => {
    const t = await login(v41, 4);
    for (const action of ["session_clock_in", "session_start_break", "session_end_break", "session_clock_out"]) {
      const r = await api(v41, 4, t, { action });
      assert.equal(r.status, 200, `${action}: ${JSON.stringify(r.body)}`);
    }
    const m = await login(v41, 1);
    for (const action of ["manager_dashboard", "manager_team", "manager_hours", "manager_working", "manager_roster_week", "manager_leave_list", "manager_devices"]) {
      const r = await api(v41, 1, m, { action });
      assert.equal(r.status, 200, `${action}: ${JSON.stringify(r.body)}`);
    }
    return "all 200";
  });

  // ------------------------------------------------------------ C
  section("C. New server");
  await reseed(db);
  // reseed truncates staff with cascade, which also empties the stock tables
  // (they reference staff). Re-run the migration to load the sheet again.
  { const r = db.psqlFile(STOCK); assert.ok(r.ok, r.stderr); }
  const gm = await login(vNew, 1);
  const km = await login(vNew, 2);
  const fm = await login(vNew, 3);

  await check("new: existing flows unchanged (same answers as v41)", async () => {
    const st = await login(vNew, 6);
    for (const action of ["session_clock_in", "session_clock_out", "session_my_hours", "session_status", "session_leave_list"]) {
      const r = await api(vNew, 6, st, { action });
      assert.equal(r.status, 200, `${action}: ${JSON.stringify(r.body)}`);
    }
    const t41 = await login(v41, 1);
    for (const action of ["manager_team", "manager_hours", "manager_working", "manager_roster_week", "manager_leave_list"]) {
      const a = await api(v41, 1, t41, { action });
      const b = await api(vNew, 1, gm, { action });
      const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => (["generated_at", "manager", "today", "position", "roster_only"].includes(k) ? undefined : v)));
      assert.equal(b.status, 200, action);
      assert.deepEqual(strip(b.body.data), strip(a.body.data), action);
    }
    return "staff flow 200; team, hours, working, roster, time off identical to v41";
  });

  let list;
  await check("list: floor manager and administrator see the Floor list; kitchen manager only Kitchen", async () => {
    const f = await api(vNew, 3, fm, { action: "manager_stock_list" });
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.equal(f.body.data.department, "Floor"); assert.equal(f.body.data.items.length, 232);
    assert.equal(f.body.data.can_choose_department, false);
    const g = await api(vNew, 1, gm, { action: "manager_stock_list" });
    assert.equal(g.body.data.items.length, 232); assert.equal(g.body.data.can_choose_department, true);
    const k = await api(vNew, 2, km, { action: "manager_stock_list" });
    assert.equal(k.body.data.department, "Kitchen"); assert.equal(k.body.data.items.length, 0);
    const kf = await api(vNew, 2, km, { action: "manager_stock_list", department: "Floor" });
    assert.equal(kf.status, 403);
    const st = await login(vNew, 7);
    const s = await api(vNew, 7, st, { action: "manager_stock_list" });
    assert.ok(s.status === 401 || s.status === 403, String(s.status));
    list = f.body.data;
    return `floor 232 items; admin 232 (can switch); kitchen 0 and Floor refused 403; staff ${s.status}`;
  });

  const byName = (n) => list.items.find((i) => i.name === n);
  await check("count -> order: boxes round up, bar/open counted apart, blanks order nothing", async () => {
    const lines = [
      { item_id: byName("Fantini Chardonnay").id, qty: 5 },            // par 16, box 12: 11 missing -> 1 box
      { item_id: byName("Ten Rocks").id, qty: 20 },                    // at par -> 0
      { item_id: byName("Don Camillo Sangio Cab").id, qty: 10 },       // par 28, box 6: 18 -> 3 boxes
      { item_id: byName("Torre Mora Etna Bianco").id, qty: 2, qty_extra: 1 }, // 4+3bar: 2+2 -> 4 bottles
      { item_id: byName("Pure Blonde").id, qty: 0, qty_extra: 1 },      // 1+1open: 1
      { item_id: byName("S. Pellegrino").id, qty: 3 },                 // par 7: 4
      { item_id: byName("Panna").id, qty: 9 },                         // over par -> 0
    ];
    const r = await api(vNew, 3, fm, { action: "manager_stock_count_save", lines });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const got = Object.fromEntries(r.body.data.count.lines.filter((l) => l.counted).map((l) => [l.name, `${l.order_qty} ${l.order_unit}`]));
    assert.deepEqual(got, {
      "Fantini Chardonnay": "1 box", "Ten Rocks": "0 box", "Don Camillo Sangio Cab": "3 box",
      "Torre Mora Etna Bianco": "4 unit", "Pure Blonde": "1 unit", "S. Pellegrino": "4 unit", "Panna": "0 unit",
    });
    assert.equal(r.body.data.count.lines.length, 232);
    assert.equal(r.body.data.count.lines.filter((l) => !l.counted).every((l) => l.order_qty === 0), true);
    const again = await api(vNew, 1, gm, { action: "manager_stock_list" });
    assert.equal(again.body.data.last_count.counted_by, "Test Floor Manager");
    return Object.entries(got).map(([k, v]) => `${k}: ${v}`).join("; ");
  });

  await check("count: bad numbers refused; nothing counted refused", async () => {
    const id = byName("Panna").id;
    for (const lines of [[{ item_id: id, qty: -1 }], [{ item_id: id, qty: "abc" }], [{ item_id: id }], []]) {
      const r = await api(vNew, 3, fm, { action: "manager_stock_count_save", lines });
      assert.equal(r.status, 400, JSON.stringify(lines));
    }
    assert.equal(Number(await one(db, "select count(*) from public.stock_counts")), 1);
    return "4 bad requests 400; still 1 count saved";
  });

  await check("open list: a second save adds to it; a new count starts a fresh list", async () => {
    let r = await api(vNew, 1, gm, { action: "manager_stock_count_save", lines: [{ item_id: byName("Moscato").id, qty: 4 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const got = Object.fromEntries(r.body.data.count.lines.filter((l) => l.counted).map((l) => [l.name, l.order_qty]));
    assert.equal(got["Moscato"], 1); assert.equal(got["Fantini Chardonnay"], 1); assert.equal(got["Don Camillo Sangio Cab"], 3);
    assert.equal(Number(await one(db, "select count(*) from public.stock_counts")), 1, "same list updated");
    // Recount one item: the new number replaces the old one.
    r = await api(vNew, 3, fm, { action: "manager_stock_count_save", lines: [{ item_id: byName("Fantini Chardonnay").id, qty: 16 }] });
    assert.equal(r.body.data.count.lines.find((l) => l.name === "Fantini Chardonnay").order_qty, 0);
    const kc = await api(vNew, 2, km, { action: "manager_stock_count_close", department: "Floor" });
    assert.equal(kc.status, 403);
    const c = await api(vNew, 3, fm, { action: "manager_stock_count_close" });
    assert.equal(c.status, 200); assert.equal(c.body.data.closed, 1);
    const l = await api(vNew, 3, fm, { action: "manager_stock_list" });
    assert.equal(l.body.data.last_count.open, false);
    r = await api(vNew, 3, fm, { action: "manager_stock_count_save", lines: [{ item_id: byName("Panna").id, qty: 1 }] });
    assert.equal(r.body.data.count.lines.filter((x) => x.counted).length, 1);
    assert.equal(Number(await one(db, "select count(*) from public.stock_counts")), 2);
    return "2nd save merged (Moscato added, earlier lines kept); recount replaced; kitchen manager cannot close Floor; after closing, a new list starts";
  });

  await check("edit the list: add, change par, remove; every change audited", async () => {
    let r = await api(vNew, 3, fm, { action: "manager_stock_item_save", item: { name: "Aperol", group_name: "Spirits", par: 2, unit: "bot" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const aperol = r.body.data.item;
    assert.equal(aperol.department, "Floor");
    const fc = byName("Fantini Chardonnay");
    r = await api(vNew, 3, fm, { action: "manager_stock_item_save", item: { ...fc, par: 24 } });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(Number(r.body.data.item.par), 24);
    r = await api(vNew, 3, fm, { action: "manager_stock_item_save", item: { ...fc, order_by: "box", case_size: null } });
    assert.equal(r.status, 400);
    r = await api(vNew, 3, fm, { action: "manager_stock_item_save", item: { ...fc, name: "" } });
    assert.equal(r.status, 400);
    r = await api(vNew, 2, km, { action: "manager_stock_item_save", item: { ...fc, par: 1 } });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    r = await api(vNew, 2, km, { action: "manager_stock_item_remove", item_id: fc.id });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    r = await api(vNew, 3, fm, { action: "manager_stock_item_remove", item_id: aperol.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const l = await api(vNew, 3, fm, { action: "manager_stock_list" });
    assert.equal(l.body.data.items.length, 232);
    assert.equal(Number(l.body.data.items.find((i) => i.id === fc.id).par), 24);
    const audit = Number(await one(db, "select count(*) from public.stock_audit"));
    assert.equal(audit, 3);
    // The saved count keeps the par it was made with.
    const old = (await one(db, `select l->>'par' from public.stock_counts, jsonb_array_elements(lines) l where closed_at is not null and l->>'item_id' = '${fc.id}'`));
    assert.equal(Number(old), 16);
    return "add 200, par 16->24, box without size 400, empty name 400, kitchen manager 403 x2, remove 200; 3 audit rows; old count keeps par 16";
  });

  await check("suppliers: set and clear a minimum order; kitchen manager cannot touch Floor", async () => {
    let r = await api(vNew, 3, fm, { action: "manager_stock_supplier_save", name: "RiverCity", min_order: 5 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api(vNew, 3, fm, { action: "manager_stock_supplier_save", name: "RiverCity", min_order: "" });
    assert.equal(r.status, 200); assert.equal(r.body.data.supplier.min_order, null);
    r = await api(vNew, 3, fm, { action: "manager_stock_supplier_save", name: "RiverCity", min_order: 0 });
    assert.equal(r.status, 400);
    r = await api(vNew, 2, km, { action: "manager_stock_supplier_save", department: "Floor", name: "Global", min_order: 3 });
    assert.equal(r.status, 403);
    const k = await api(vNew, 2, km, { action: "manager_stock_supplier_save", name: "Butcher", min_order: 2 });
    assert.equal(k.status, 200);
    assert.equal(await one(db, "select department from public.stock_suppliers where name = 'Butcher'"), "Kitchen");
    return "min 5 then cleared; 0 refused; kitchen manager 403 on Floor, own Kitchen supplier ok";
  });

  await check("suppliers: rename on every item at once; renaming into an existing one merges them", async () => {
    let r = await api(vNew, 3, fm, { action: "manager_stock_supplier_rename", from: "Abrisca (email)", to: "Abrisca Coffee" });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.data.supplier.items, 16);
    assert.equal(Number(await one(db, "select count(*) from public.stock_items where supplier = 'Abrisca (email)'")), 0);
    // Tom San Pellegrino has min 9; rename it into a new name keeps the minimum.
    r = await api(vNew, 3, fm, { action: "manager_stock_supplier_rename", from: "Tom San Pellegrino (SMS)", to: "SMS" });
    assert.equal(r.status, 200);
    assert.equal(await one(db, "select min_order from public.stock_suppliers where name = 'SMS'"), "9");
    // Merge Global into RiverCity (RiverCity has no minimum now) .
    r = await api(vNew, 3, fm, { action: "manager_stock_supplier_rename", from: "Global", to: "RiverCity" });
    assert.equal(r.status, 200);
    assert.equal(await one(db, "select min_order from public.stock_suppliers where name = 'Global'"), null);
    assert.equal(Number(await one(db, "select count(*) from public.stock_items where supplier = 'Global'")), 0);
    r = await api(vNew, 2, km, { action: "manager_stock_supplier_rename", department: "Floor", from: "RiverCity", to: "X" });
    assert.equal(r.status, 403);
    r = await api(vNew, 3, fm, { action: "manager_stock_supplier_rename", from: "RiverCity", to: "" });
    assert.equal(r.status, 400);
    const audit = Number(await one(db, "select count(*) from public.stock_audit where kind = 'supplier_rename'"));
    assert.equal(audit, 3);
    return "Abrisca renamed on 16 items; SMS keeps min 9; Global merged into RiverCity; kitchen manager 403; empty name 400; 3 audit rows";
  });

  await check("administrator can switch to Kitchen", async () => {
    const r = await api(vNew, 1, gm, { action: "manager_stock_item_save", item: { department: "Kitchen", name: "Flour 00", group_name: "Dry", par: 4, unit: "bag" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const k = await api(vNew, 2, km, { action: "manager_stock_list" });
    assert.deepEqual(k.body.data.items.map((i) => i.name), ["Flour 00"], JSON.stringify([r.body, k.body]));
    return "admin added a Kitchen item; kitchen manager sees it";
  });

  await check("v41 still works with stock data in place (server rollback is safe)", async () => {
    const m = await login(v41, 1);
    for (const action of ["manager_dashboard", "manager_team"]) {
      const r = await api(v41, 1, m, { action });
      assert.equal(r.status, 200, action);
    }
    return "dashboard, team 200";
  });

  // ------------------------------------------------------------ D
  section("D. Rollback");
  await check("the rollback file removes everything stock; functions equal production again", async () => {
    const r = db.psqlFile(STOCK_DOWN); assert.ok(r.ok, r.stderr);
    const fp = await db.fingerprints();
    assert.deepEqual(Object.keys(fp).sort(), Object.keys(fpBefore).sort());
    for (const k of Object.keys(fpBefore)) assert.equal(fp[k], fpBefore[k], k);
    assert.equal(Number(await one(db, "select count(*) from information_schema.tables where table_schema='public' and table_name like 'stock_%'")), 0);
    return "no stock table or function left";
  });
  await check("v41 works after the rollback", async () => {
    useDatabase(db.svc);
    const m = await login(v41, 1);
    const d = await api(v41, 1, m, { action: "manager_dashboard" });
    assert.equal(d.status, 200);
    return "dashboard 200";
  });
} finally {
  db.stop();
}

log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL STOCK RELEASE CHECKS PASSED");
process.exit(failures ? 1 : 0);
