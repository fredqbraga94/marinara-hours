// End-to-end: real server code (teste/Index.ts) + test DB structure (local throwaway PostgreSQL).
import assert from "node:assert/strict";
import { Pool } from "/home/claude/fredqbraga94/marinara-hours/tests/integration/pg-wire.mjs";
import { loadHandler, useDatabase, call, newDeviceSecret } from "/home/claude/fredqbraga94/marinara-hours/tests/integration/edge-loader.mjs";

const pool = await new Pool({ socketPath: "/home/claude/work/pg/.s.PGSQL.55433", database: "t2", size: 4 }).open();
useDatabase(pool);
const handler = await loadHandler("/home/claude/work/teste/Index.ts");
const device = newDeviceSecret();

const people = [
  ["Admin Fred", "9001", "Floor", "Hawthorne", "admin"],
  ["GM Hawthorne", "9002", "Floor", "Hawthorne", "manager"],
  ["Floor Mgr Padd", "9003", "Floor", "Paddington", "floor_manager"],
  ["Kitchen Mgr Padd", "9004", "Kitchen", "Paddington", "kitchen_manager"],
  ["Floor Staff Padd", "9005", "Floor", "Paddington", "staff"],
  ["Kitchen Staff Padd", "9006", "Kitchen", "Paddington", "staff"],
  ["Staff Hawthorne", "9007", "Floor", "Hawthorne", "staff"],
  ["Staff Clayfield", "9008", "Kitchen", "Clayfield", "staff"],
];
for (const [n, pin, d, l, r] of people) {
  await pool.query(`insert into public.staff(name,pin_hash,department,location,role) values ('${n}', extensions.crypt('${pin}', extensions.gen_salt('bf')), '${d}', '${l}', '${r}')`);
}

async function login(pin) {
  const r = await call(handler, { action: "login", pin, device });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.session.token;
}
const names = (team) => team.map((p) => p.name).sort();
let pass = 0;
const ok = (label) => { pass++; console.log("PASS", label); };

// Admin
const admin = await login("9001");
let r = await call(handler, { action: "manager_dashboard", token: admin, device });
assert.equal(r.status, 200); assert.equal(r.body.data.location, "Hawthorne");
assert.deepEqual(r.body.data.manager.units, ["Hawthorne", "Paddington", "Clayfield"]);
assert.equal(r.body.data.manager.is_admin, true); ok("admin dashboard: Hawthorne por padrao + 3 unidades");

r = await call(handler, { action: "manager_team", token: admin, device, unit: "Paddington" });
assert.deepEqual(names(r.body.data.team), ["Floor Mgr Padd", "Floor Staff Padd", "Kitchen Mgr Padd", "Kitchen Staff Padd"]); ok("admin ve equipe de Paddington");

r = await call(handler, { action: "manager_team", token: admin, device, unit: "Clayfield" });
assert.deepEqual(names(r.body.data.team), ["Staff Clayfield"]); ok("admin ve equipe de Clayfield");

r = await call(handler, { action: "manager_team", token: admin, device, unit: "Sydney" });
assert.equal(r.body.data.manager.location, "Hawthorne"); ok("unidade invalida volta para a unidade do admin");

r = await call(handler, { action: "manager_create_staff", token: admin, device, unit: "Clayfield", name: "Novo Clay", staff_pin: "3331", department: "Floor" });
assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.data.staff.location, "Clayfield"); ok("admin cria funcionario em Clayfield");

// Floor manager Paddington
const fm = await login("9003");
r = await call(handler, { action: "manager_team", token: fm, device });
assert.deepEqual(names(r.body.data.team), ["Floor Mgr Padd", "Floor Staff Padd"]); ok("floor mgr Padd ve so floor de Paddington");

r = await call(handler, { action: "manager_team", token: fm, device, unit: "Hawthorne" });
assert.deepEqual(names(r.body.data.team), ["Floor Mgr Padd", "Floor Staff Padd"]); ok("floor mgr Padd NAO consegue trocar para Hawthorne");

r = await call(handler, { action: "manager_create_staff", token: fm, device, name: "Novo Floor", staff_pin: "1111", department: "Floor" });
assert.equal(r.status, 200); assert.equal(r.body.data.staff.location, "Paddington"); ok("floor mgr cria floor em Paddington");

r = await call(handler, { action: "manager_create_staff", token: fm, device, unit: "Hawthorne", name: "Tentativa", staff_pin: "1112", department: "Floor" });
assert.equal(r.status, 200); assert.equal(r.body.data.staff.location, "Paddington"); ok("floor mgr pedindo Hawthorne ainda cria em Paddington");

r = await call(handler, { action: "manager_create_staff", token: fm, device, name: "K", staff_pin: "1113", department: "Kitchen" });
assert.equal(r.status, 403); ok("floor mgr NAO cria kitchen");

// Kitchen manager Paddington
const km = await login("9004");
r = await call(handler, { action: "manager_team", token: km, device });
assert.deepEqual(names(r.body.data.team), ["Kitchen Mgr Padd", "Kitchen Staff Padd"]); ok("kitchen mgr Padd ve so kitchen de Paddington");

// GM Hawthorne - igual a hoje
const gm = await login("9002");
r = await call(handler, { action: "manager_team", token: gm, device, unit: "Paddington" });
assert.deepEqual(names(r.body.data.team), ["Admin Fred", "GM Hawthorne", "Staff Hawthorne"]); ok("GM Hawthorne continua so em Hawthorne");
assert.equal(r.body.data.manager.is_admin, false);

const staffH = (await pool.query(`select id from public.staff where name='Staff Hawthorne'`)).rows?.[0];
const adminRow = (await pool.query(`select id from public.staff where name='Admin Fred'`)).rows?.[0];
const idOf = (row) => row?.id ?? row?.[0] ?? Object.values(row || {})[0];
r = await call(handler, { action: "manager_update_staff", token: gm, device, staff_id: idOf(staffH), name: "Staff Hawthorne", department: "Floor", role: "admin" });
assert.equal(r.status, 403); assert.equal(r.body.code, "ADMIN_REQUIRED"); ok("GM Hawthorne NAO cria admin");
r = await call(handler, { action: "manager_toggle_staff", token: gm, device, staff_id: idOf(adminRow) });
assert.equal(r.status, 403); ok("GM Hawthorne NAO desativa admin");

// Working / hours: staff of Paddington clocks in, admin sees it in Paddington only
const fs = await login("9005");
r = await call(handler, { action: "session_clock_in", token: fs, device });
const working = async (tok, unit) => (await call(handler, { action: "manager_working", token: tok, device, ...(unit ? { unit } : {}) })).body.data.working.map((w) => w.name);
assert.deepEqual(await working(admin, "Paddington"), ["Floor Staff Padd"]);
assert.deepEqual(await working(admin, "Hawthorne"), []);
assert.deepEqual(await working(fm), ["Floor Staff Padd"]);
assert.deepEqual(await working(km), []);
assert.deepEqual(await working(gm), []); ok("quem esta trabalhando: cada um ve so o seu");

r = await call(handler, { action: "manager_devices", token: admin, device });
assert.equal(r.body.data.can_change_mode, true); ok("admin pode mudar modo de aparelhos");

console.log(`\n${pass} PASS, 0 FAIL`);
pool.close();
