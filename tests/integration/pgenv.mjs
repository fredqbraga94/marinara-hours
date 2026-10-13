// Throwaway PostgreSQL with the production structure, production function text
// and production privileges. Synthetic data only; nothing connects to Supabase.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "./pg-wire.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, "../..");

// md5(pg_get_functiondef) of every production function the app uses (read-only, 2026-10-13).
export const PROD_FINGERPRINTS = {
  clock_in_by_id: "7d2ae6b6ded68200b9d749797904cc60",
  clock_out_by_id: "40db6048bbeb7a09f50a4b899bc816db",
  end_break_by_id: "56ca414291f496bcc49727da4b88dc46",
  login_with_pin: "4fe42dbb03d86ea6a6619fa3d5c58d0d",
  manager_clock_out_staff: "21b0f2fc5903e0522260939c59d09a65",
  manager_create_staff: "ba679871846b58202f1c44d402b74f19",
  manager_update_staff: "b25c2b887014e4937db65a0c899a0a60",
  staff_status_by_id: "59d22572b44d3b9121eb1d7851b22dd9",
  start_break_by_id: "020e5f82ddd950973bb57ae4c8e6f1a0",
};

export const MIGRATION_A = "supabase/migrations/20261013010000_integrity_audit_privileges.sql";
export const MIGRATION_B = "supabase/migrations/20261013020000_device_auth_pin_limits.sql";
export const ROLLBACK_A = "supabase/rollback/20261013010000_integrity_audit_privileges.down.sql";
export const ROLLBACK_B = "supabase/rollback/20261013020000_device_auth_pin_limits.down.sql";

export async function startProdLikeDb({ poolSize = 8 } = {}) {
  const PGBIN = process.env.PGBIN || spawnSync("bash", ["-c", "ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1"]).stdout.toString().trim();
  const WORK = mkdtempSync(join(tmpdir(), "marinara-db-"));
  const PORT = 54000 + Math.floor(Math.random() * 900);
  const asPg = process.getuid() === 0 ? ["runuser", "-u", "pgtest", "--"] : [];
  const sh = (cmd, args) => {
    const r = spawnSync(asPg[0] || cmd, asPg.length ? [...asPg.slice(1), cmd, ...args] : args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.stdout}`);
  };
  if (asPg.length) {
    spawnSync("bash", ["-c", "id pgtest >/dev/null 2>&1 || useradd -M -s /bin/false pgtest"]);
    spawnSync("chown", ["-R", "pgtest", WORK]);
  }
  chmodSync(WORK, 0o755);
  sh(`${PGBIN}/initdb`, ["-D", `${WORK}/data`, "-U", "postgres", "-A", "trust"]);
  sh(`${PGBIN}/pg_ctl`, ["-D", `${WORK}/data`, "-o", `-k ${WORK} -p ${PORT} -c listen_addresses='' -c max_connections=60`, "-l", `${WORK}/log`, "-w", "start"]);

  const psqlFile = (file, { single = true } = {}) => {
    const r = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", ...(single ? ["-1"] : []), "-h", WORK, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-f", resolve(root, file)], { encoding: "utf8" });
    return { ok: r.status === 0, stderr: r.stderr };
  };
  const mustFile = (file) => { const r = psqlFile(file); if (!r.ok) throw new Error(`${file}: ${r.stderr}`); };

  mustFile("tests/db/schema_snapshot.sql");
  mustFile("supabase/migrations/20261012000000_add_manager_clock_out_staff.sql");
  mustFile("tests/integration/prod_manager_functions.sql");
  mustFile("tests/db/prod_acl.sql");

  const socketPath = join(WORK, `.s.PGSQL.${PORT}`);
  const admin = await new Pool({ socketPath, size: 2, init: ["set timezone to 'UTC'"] }).open();
  const svc = await new Pool({ socketPath, size: poolSize, init: ["set role service_role", "set timezone to 'UTC'"] }).open();
  const newPool = (size, role = "service_role") => new Pool({ socketPath, size, init: [`set role ${role}`, "set timezone to 'UTC'"] }).open();

  const fingerprints = async () => Object.fromEntries((await admin.query(
    "select p.proname, md5(pg_get_functiondef(p.oid)) from pg_proc p where p.pronamespace = 'public'::regnamespace")).rows);
  const tableAcl = async () => Object.fromEntries((await admin.query(
    "select c.relname, coalesce(c.relacl::text, '') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1")).rows);
  const sqlFile = (name, text) => { const p = join(WORK, name); writeFileSync(p, text); chmodSync(p, 0o644); return p; };

  return {
    WORK, PORT, socketPath, admin, svc, newPool, psqlFile, mustFile, fingerprints, tableAcl, sqlFile,
    stop() {
      admin.close(); svc.close();
      try { sh(`${PGBIN}/pg_ctl`, ["-D", `${WORK}/data`, "-m", "immediate", "stop"]); } catch (_) { /* ignore */ }
      rmSync(WORK, { recursive: true, force: true });
    },
  };
}
