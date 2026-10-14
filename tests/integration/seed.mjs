// Synthetic staff, shifts and PINs shared by the integration and browser tests.
// Names start with "Test"; PINs are invented. bcrypt cost 6, as in production.
import { lit } from "./pg-supabase.mjs";

export const ID = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const SH = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const STAFF = [
  { id: ID(1), name: "Test General Manager", role: "manager", dept: "Floor", loc: "Hawthorne", active: true, pin: "900001" },
  { id: ID(2), name: "Test Kitchen Manager", role: "kitchen_manager", dept: "Kitchen", loc: "Hawthorne", active: true, pin: "900002" },
  { id: ID(3), name: "Test Floor Manager", role: "floor_manager", dept: "Floor", loc: "Hawthorne", active: true, pin: "900003" },
  { id: ID(4), name: "Test Kitchen A", role: "staff", dept: "Kitchen", loc: "Hawthorne", active: true, pin: "9104" },
  { id: ID(5), name: "Test Kitchen B", role: "staff", dept: "Kitchen", loc: "Hawthorne", active: true, pin: "9105" },
  { id: ID(6), name: "Test Floor A", role: "staff", dept: "Floor", loc: "Hawthorne", active: true, pin: "9106" },
  { id: ID(7), name: "Test Floor B", role: "staff", dept: "Floor", loc: "Hawthorne", active: true, pin: "9107" },
  { id: ID(8), name: "Test Inactive", role: "staff", dept: "Kitchen", loc: "Hawthorne", active: false, pin: "9108" },
  { id: ID(10), name: "Test Shared One", role: "staff", dept: "Floor", loc: "Hawthorne", active: true, pin: "9110" },
  { id: ID(11), name: "Test Shared Two", role: "staff", dept: "Kitchen", loc: "Hawthorne", active: true, pin: "9110" },
  { id: ID(12), name: "Test Racer", role: "staff", dept: "Kitchen", loc: "Hawthorne", active: true, pin: "9112" },
];
export const PIN = Object.fromEntries(STAFF.map((s) => [s.id, s.pin]));
let HASHES = null;

export async function reseed(db) {
  const A = db.admin;
  // auth tables exist only after migration B
  const hasAuth = (await A.query("select to_regclass('public.auth_devices') is not null")).rows[0][0] === "t";
  await A.query(`truncate public.shift_audit, public.breaks, public.shifts, public.staff_sessions, public.pin_attempts, public.staff cascade`);
  if ((await A.query("select to_regclass('public.staff_audit') is not null")).rows[0][0] === "t") await A.query("truncate public.staff_audit");
  if (hasAuth) {
    await A.query("truncate public.auth_events, public.auth_pairing_codes, public.auth_attempt_buckets, public.auth_devices cascade");
    // (truncating staff above cascades to auth_settings through updated_by)
    await A.query("insert into public.auth_settings (id) values (true) on conflict (id) do nothing");
    await A.query("update public.auth_settings set device_mode = 'grace', updated_by = null");
  }
  if (!HASHES) {
    HASHES = {};
    for (const s of STAFF) HASHES[s.id] = (await A.query(`select extensions.crypt(${lit(s.pin)}, extensions.gen_salt('bf', 6))`)).rows[0][0];
  }
  await A.query(`insert into public.staff (id, name, pin_hash, department, location, role, active, created_at) values ` +
    STAFF.map((s, i) => `(${lit(s.id)}, ${lit(s.name)}, ${lit(HASHES[s.id])}, ${lit(s.dept)}, ${lit(s.loc)}, ${lit(s.role)}, ${s.active}, now() - interval '${40 - i} days')`).join(", "));
  await A.query(`insert into public.shifts (id, staff_id, clock_in, clock_out, status, approved, notes) values
    (${lit(SH(1))}, ${lit(ID(5))}, now() - interval '3 hours', null, 'working', false, null),
    (${lit(SH(2))}, ${lit(ID(7))}, now() - interval '2 hours', null, 'break', false, null),
    (${lit(SH(3))}, ${lit(ID(4))}, now() - interval '26 hours', now() - interval '20 hours', 'completed', false, null),
    (${lit(SH(4))}, ${lit(ID(6))}, now() - interval '50 hours', now() - interval '44 hours', 'completed', true, null),
    (${lit(SH(5))}, ${lit(ID(6))}, now() - interval '27 hours', now() - interval '21 hours', 'completed', false, 'synthetic note')`);
  await A.query(`insert into public.breaks (shift_id, break_start, break_end) values
    (${lit(SH(2))}, now() - interval '20 minutes', null),
    (${lit(SH(3))}, now() - interval '23 hours', now() - interval '22 hours 30 minutes')`);
  await A.query(`insert into public.pin_attempts (attempt_key, failed_attempts, locked_until, last_attempt_at) values ('hawthorne-pin-entry', 0, null, now())`);
}

