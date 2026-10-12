// In-memory stand-in for the parts of supabase-js used by marinara-api-v2.
// Lets the real Edge Function code run under Node with synthetic data only.
// It never talks to the network or to the real database.

export function createClient() {
  const db = globalThis.__FAKE_DB;
  if (!db) throw new Error("No fake DB installed");
  return {
    from: (table) => new Query(db, table),
    rpc: async (name, args) => {
      db.rpcCalls.push({ name, args });
      const fn = db.rpc[name];
      if (!fn) return { data: null, error: { message: `function ${name} does not exist` } };
      try {
        return { data: await fn(args, db), error: null };
      } catch (e) {
        return { data: null, error: { message: String(e.message || e) } };
      }
    },
  };
}

function parseSelect(cols) {
  const s = String(cols || "*");
  return {
    staffJoin: /staff!inner\s*\(/.test(s),
    breaksJoin: /breaks\s*\(/.test(s),
  };
}

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.op = "select";
    this.payload = null;
    this.sel = parseSelect("*");
    this.wantSingle = null;
    this.returning = false;
    this.orders = [];
  }
  select(cols) {
    if (this.op === "select") this.sel = parseSelect(cols);
    else { this.returning = true; this.sel = parseSelect(cols); }
    return this;
  }
  insert(obj) { this.op = "insert"; this.payload = obj; return this; }
  update(obj) { this.op = "update"; this.payload = obj; return this; }
  upsert(obj, opts) { this.op = "upsert"; this.payload = obj; this.onConflict = opts?.onConflict; return this; }
  delete() { this.op = "delete"; return this; }
  eq(c, v) { this.filters.push((r) => get(r, c) === v); return this; }
  is(c, v) { this.filters.push((r) => (get(r, c) ?? null) === v); return this; }
  gt(c, v) { this.filters.push((r) => get(r, c) > v); return this; }
  gte(c, v) { this.filters.push((r) => get(r, c) >= v); return this; }
  lt(c, v) { this.filters.push((r) => get(r, c) < v); return this; }
  in(c, vs) { this.filters.push((r) => vs.includes(get(r, c))); return this; }
  not(c, op, v) {
    if (op === "is" && v === null) this.filters.push((r) => get(r, c) != null);
    return this;
  }
  order(c, o) { this.orders.push([c, o?.ascending !== false]); return this; }
  maybeSingle() { this.wantSingle = "maybe"; return this; }
  single() { this.wantSingle = "single"; return this; }
  then(res, rej) { return this.exec().then(res, rej); }

  rows() { return this.db.tables[this.table]; }

  hydrate(row) {
    const out = { ...row };
    if (this.table === "shifts" && this.sel.staffJoin) {
      out.staff = this.db.tables.staff.find((s) => s.id === row.staff_id) || null;
    }
    if (this.table === "shifts" && this.sel.breaksJoin) {
      out.breaks = this.db.tables.breaks.filter((b) => b.shift_id === row.id).map((b) => ({ ...b }));
    }
    return out;
  }

  async exec() {
    const db = this.db;
    if (db.failNext && db.failNext.table === this.table && db.failNext.op === this.op) {
      db.failNext = null;
      return { data: null, error: { message: "simulated failure" } };
    }
    let result;
    if (this.op === "select") {
      let rows = this.rows().map((r) => this.hydrate(r));
      rows = rows.filter((r) => !(this.sel.staffJoin && !r.staff));
      rows = rows.filter((r) => this.filters.every((f) => f(r)));
      for (const [c, asc] of this.orders.slice().reverse()) {
        rows.sort((a, b) => (get(a, c) > get(b, c) ? 1 : get(a, c) < get(b, c) ? -1 : 0) * (asc ? 1 : -1));
      }
      result = rows;
    } else if (this.op === "insert") {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload];
      result = items.map((it) => {
        const row = { id: it.id || crypto.randomUUID(), created_at: new Date().toISOString(), ...it };
        this.rows().push(row);
        return { ...row };
      });
    } else if (this.op === "update") {
      const rows = this.rows().filter((r) => this.filters.every((f) => f(this.hydrate(r))));
      rows.forEach((r) => Object.assign(r, this.payload));
      result = rows.map((r) => this.hydrate(r));
    } else if (this.op === "delete") {
      const keep = [];
      const removed = [];
      for (const r of this.rows()) (this.filters.every((f) => f(r)) ? removed : keep).push(r);
      db.tables[this.table] = keep;
      if (this.table === "shifts") {
        const ids = new Set(removed.map((r) => r.id));
        db.tables.breaks = db.tables.breaks.filter((b) => !ids.has(b.shift_id));
      }
      result = removed;
    } else if (this.op === "upsert") {
      const key = this.onConflict;
      const existing = this.rows().find((r) => r[key] === this.payload[key]);
      if (existing) Object.assign(existing, this.payload);
      else this.rows().push({ id: crypto.randomUUID(), ...this.payload });
      result = [];
    }
    if (this.wantSingle) {
      if (result.length === 0) {
        return this.wantSingle === "single"
          ? { data: null, error: { message: "no rows" } }
          : { data: null, error: null };
      }
      return { data: result[0], error: null };
    }
    return { data: result, error: null };
  }
}

function get(row, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), row);
}
