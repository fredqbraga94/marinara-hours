// Stand-in for supabase-js used by the integrated test: every call becomes real SQL
// against the isolated local PostgreSQL, run as the service_role (as PostgREST does
// for the Edge Function). Covers exactly the query shapes marinara-api-v2 uses.
// Behaviour follows PostgREST: embedded "staff!inner(...)" (to-one, inner join),
// embedded "breaks(...)" (to-many array), single()/maybeSingle() errors, RPC
// set-returning vs scalar results, and "function not found" errors.

const RELATIONS = {
  "shifts.staff": { table: "staff", kind: "one", on: (p, c) => `${c}.id = ${p}.staff_id` },
  "shifts.breaks": { table: "breaks", kind: "many", on: (p, c) => `${c}.shift_id = ${p}.id` },
};

const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return s;
};

export function lit(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number");
    return String(v);
  }
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function splitTop(s) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function parseSelect(spec) {
  const items = [];
  for (const part of splitTop(String(spec || "*").replace(/\s+/g, " "))) {
    const m = part.match(/^([a-z_]+)(!inner)?\s*\((.*)\)$/s);
    if (m) items.push({ embed: m[1], inner: !!m[2], cols: parseSelect(m[3]) });
    else items.push({ col: part.trim() });
  }
  return items;
}

let aliasN = 0;
function buildObject(table, alias, items, joins) {
  if (items.length === 1 && items[0].col === "*") return `to_json(${alias})`;
  const parts = [];
  for (const it of items) {
    if (it.col) { parts.push(`'${ident(it.col)}', ${alias}.${ident(it.col)}`); continue; }
    const rel = RELATIONS[`${table}.${it.embed}`];
    if (!rel) throw new Error(`unknown relation ${table}.${it.embed}`);
    const a = `e${++aliasN}`;
    if (rel.kind === "one") {
      if (it.inner) {
        joins.push({ name: it.embed, sql: `join public.${rel.table} ${a} on ${rel.on(alias, a)}`, alias: a });
        parts.push(`'${it.embed}', ${buildObject(rel.table, a, it.cols, [])}`);
      } else {
        parts.push(`'${it.embed}', (select ${buildObject(rel.table, a, it.cols, [])} from public.${rel.table} ${a} where ${rel.on(alias, a)})`);
      }
    } else {
      parts.push(`'${it.embed}', coalesce((select json_agg(${buildObject(rel.table, a, it.cols, [])}) from public.${rel.table} ${a} where ${rel.on(alias, a)}), '[]'::json)`);
    }
  }
  return `json_build_object(${parts.join(", ")})`;
}

const toError = (e) => (e && e.pg ? { ...e.pg } : { message: String(e?.message || e), code: null, details: null, hint: null });

class Query {
  constructor(client, table) {
    this.client = client;
    this.table = ident(table);
    this.op = "select";
    this.filters = [];
    this.orders = [];
    this.selectSpec = null;
    this.wantSingle = null;
  }
  select(spec) { this.selectSpec = spec ?? "*"; return this; }
  insert(v) { this.op = "insert"; this.payload = v; return this; }
  update(v) { this.op = "update"; this.payload = v; return this; }
  upsert(v, o) { this.op = "upsert"; this.payload = v; this.onConflict = o?.onConflict; return this; }
  delete() { this.op = "delete"; return this; }
  _f(col, sqlOp, v) { this.filters.push({ col, sql: (c) => `${c} ${sqlOp} ${lit(v)}` }); return this; }
  eq(c, v) { return this._f(c, "=", v); }
  neq(c, v) { return this._f(c, "<>", v); }
  gt(c, v) { return this._f(c, ">", v); }
  gte(c, v) { return this._f(c, ">=", v); }
  lt(c, v) { return this._f(c, "<", v); }
  lte(c, v) { return this._f(c, "<=", v); }
  is(c, v) { this.filters.push({ col: c, sql: (x) => `${x} is ${v === null ? "null" : lit(v)}` }); return this; }
  in(c, vs) { this.filters.push({ col: c, sql: (x) => `${x} in (${vs.map(lit).join(", ")})` }); return this; }
  not(c, op, v) {
    if (op !== "is") throw new Error(`unsupported not(${op})`);
    this.filters.push({ col: c, sql: (x) => `${x} is not ${v === null ? "null" : lit(v)}` });
    return this;
  }
  order(c, o) { this.orders.push(`${ident(c)} ${o?.ascending === false ? "desc" : "asc"}`); return this; }
  single() { this.wantSingle = "single"; return this; }
  maybeSingle() { this.wantSingle = "maybe"; return this; }
  then(res, rej) { return this.exec().then(res, rej); }

  colRef(col, joins) {
    const [a, b] = col.split(".");
    if (!b) return `t.${ident(a)}`;
    const j = joins.find((x) => x.name === a);
    if (!j) throw new Error(`filter on ${col} needs an inner embed`);
    return `${j.alias}.${ident(b)}`;
  }

  sql() {
    const joins = [];
    const items = parseSelect(this.selectSpec ?? "*");
    const where = (js) => (this.filters.length ? " where " + this.filters.map((f) => f.sql(this.colRef(f.col, js))).join(" and ") : "");
    const shape = (js) => buildObject(this.table, "t", items, js);
    if (this.op === "select") {
      const obj = shape(joins);
      const order = this.orders.length ? " order by " + this.orders.map((o) => "t." + o).join(", ") : "";
      return `select coalesce(json_agg(q.r), '[]'::json) from (select ${obj} as r from public.${this.table} t ${joins.map((j) => j.sql).join(" ")}${where(joins)}${order}) q`;
    }
    const ret = this.selectSpec != null ? `select coalesce(json_agg(${buildObject(this.table, "t", items, [])}), '[]'::json) from w t` : `select null::json from (select 1) x`;
    if (this.op === "insert" || this.op === "upsert") {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
      const cols = Object.keys(rows[0]).map(ident);
      const values = rows.map((r) => `(${cols.map((c) => lit(r[c])).join(", ")})`).join(", ");
      let conflict = "";
      if (this.op === "upsert") {
        const key = ident(this.onConflict);
        conflict = ` on conflict (${key}) do update set ${cols.filter((c) => c !== key).map((c) => `${c} = excluded.${c}`).join(", ")}`;
      }
      return `with w as (insert into public.${this.table} (${cols.join(", ")}) values ${values}${conflict} returning *) ${ret}`;
    }
    if (this.op === "update") {
      const sets = Object.entries(this.payload).map(([k, v]) => `${ident(k)} = ${lit(v)}`).join(", ");
      return `with w as (update public.${this.table} t set ${sets}${where([])} returning t.*) ${ret}`;
    }
    if (this.op === "delete") {
      return `with w as (delete from public.${this.table} t${where([])} returning t.*) ${ret}`;
    }
    throw new Error(`unsupported op ${this.op}`);
  }

  async exec() {
    const inj = this.client.inject;
    if (inj && inj.failQuery && inj.failQuery(this.table, this.op)) {
      return { data: null, error: { message: "simulated connection failure", code: null, details: null, hint: null } };
    }
    let sql;
    try { sql = this.sql(); } catch (e) { return { data: null, error: toError(e) }; }
    let data;
    try {
      const r = await this.client.pool.query(sql);
      this.client.log.push({ table: this.table, op: this.op });
      data = r.rows[0][0] == null ? null : JSON.parse(r.rows[0][0]);
    } catch (e) {
      return { data: null, error: toError(e) };
    }
    if (this.wantSingle && Array.isArray(data)) {
      if (data.length === 1) return { data: data[0], error: null };
      if (data.length === 0 && this.wantSingle === "maybe") return { data: null, error: null };
      return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${data.length} rows`, hint: null } };
    }
    return { data, error: null };
  }
}

export function makeCreateClient(pool, log = [], inject = null) {
  const retsetCache = new Map();
  return function createClient() {
    const client = { pool, log, inject };
    client.from = (table) => new Query(client, table);
    client.rpc = async (name, args = {}) => {
      ident(name);
      if (inject && inject.failRpc && inject.failRpc(name)) {
        return { data: null, error: { message: "simulated connection failure", code: null, details: null, hint: null } };
      }
      const keys = Object.keys(args).map(ident);
      try {
        const cacheKey = `${name}(${keys.slice().sort().join(",")})`;
        let retset = retsetCache.get(cacheKey);
        if (retset === undefined) {
          const r = await pool.query(
            `select p.proretset from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = ${lit(name)}` +
            ` and (select count(*) from unnest(p.proargnames) a where a = any (array[${keys.map(lit).join(",") || "NULL"}]::text[])) = ${keys.length} limit 1`
          );
          if (!r.rows.length) {
            return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${name}(${keys.slice().sort().join(", ")}) in the schema cache`, details: null, hint: null } };
          }
          retset = r.rows[0][0] === "t";
          retsetCache.set(cacheKey, retset);
        }
        const call = `public.${name}(${keys.map((k) => `${k} => ${lit(args[k])}`).join(", ")})`;
        const sql = retset ? `select coalesce(json_agg(x), '[]'::json) from ${call} x` : `select to_json(${call})`;
        const r = await pool.query(sql);
        log.push({ rpc: name });
        return { data: r.rows[0][0] == null ? null : JSON.parse(r.rows[0][0]), error: null };
      } catch (e) {
        return { data: null, error: toError(e) };
      }
    };
    return client;
  };
}
