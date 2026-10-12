// Minimal PostgreSQL client (wire protocol v3, simple queries) for the isolated
// integration test. Connects only to a local Unix socket with trust auth.
// No dependencies: npm is not required to run the tests.
import net from "node:net";

class Conn {
  constructor(socketPath, user, database) {
    this.socketPath = socketPath;
    this.user = user;
    this.database = database;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.current = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.createConnection(this.socketPath);
      this.sock.on("error", (e) => (this.current ? this.current.reject(e) : reject(e)));
      this.sock.on("data", (d) => this.onData(d));
      this.sock.on("connect", () => {
        const params = Buffer.from(`user\0${this.user}\0database\0${this.database}\0client_encoding\0UTF8\0\0`);
        const head = Buffer.alloc(8);
        head.writeInt32BE(8 + params.length, 0);
        head.writeInt32BE(196608, 4);
        this.sock.write(Buffer.concat([head, params]));
        this.current = { resolve, reject, rows: [], fields: null, error: null, startup: true };
      });
    });
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 5) {
      const type = String.fromCharCode(this.buf[0]);
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < 1 + len) return;
      const body = this.buf.subarray(5, 1 + len);
      this.buf = this.buf.subarray(1 + len);
      this.onMessage(type, body);
    }
  }

  onMessage(type, body) {
    const cur = this.current;
    if (!cur) return;
    switch (type) {
      case "R": {
        const code = body.readInt32BE(0);
        if (code !== 0) cur.error = { message: `unsupported auth method ${code}` };
        break;
      }
      case "T": {
        const n = body.readInt16BE(0);
        let off = 2;
        const fields = [];
        for (let i = 0; i < n; i++) {
          const end = body.indexOf(0, off);
          fields.push(body.toString("utf8", off, end));
          off = end + 1 + 18;
        }
        cur.fields = fields;
        break;
      }
      case "D": {
        const n = body.readInt16BE(0);
        let off = 2;
        const row = [];
        for (let i = 0; i < n; i++) {
          const l = body.readInt32BE(off);
          off += 4;
          if (l === -1) row.push(null);
          else { row.push(body.toString("utf8", off, off + l)); off += l; }
        }
        cur.rows.push(row);
        break;
      }
      case "E": {
        const err = {};
        let off = 0;
        while (off < body.length && body[off] !== 0) {
          const code = String.fromCharCode(body[off]);
          const end = body.indexOf(0, off + 1);
          err[code] = body.toString("utf8", off + 1, end);
          off = end + 1;
        }
        cur.error = { message: err.M, code: err.C, details: err.D ?? null, hint: err.H ?? null };
        break;
      }
      case "Z": {
        this.current = null;
        if (cur.error) cur.reject(Object.assign(new Error(cur.error.message), { pg: cur.error }));
        else cur.resolve({ fields: cur.fields, rows: cur.rows });
        const next = this.waiters.shift();
        if (next) next();
        break;
      }
      default:
        break; // S, K, C, N, I: ignored
    }
  }

  query(sql) {
    if (sql.includes("\0")) return Promise.reject(Object.assign(new Error("invalid byte sequence"), { pg: { message: "invalid byte sequence for encoding \"UTF8\": 0x00", code: "22021", details: null, hint: null } }));
    const run = () =>
      new Promise((resolve, reject) => {
        this.current = { resolve, reject, rows: [], fields: null, error: null };
        const q = Buffer.from(sql + "\0");
        const head = Buffer.alloc(5);
        head.write("Q", 0);
        head.writeInt32BE(4 + q.length, 1);
        this.sock.write(Buffer.concat([head, q]));
      });
    if (!this.current) return run();
    return new Promise((ok) => this.waiters.push(ok)).then(run);
  }

  close() { this.sock.end(); }
}

export class Pool {
  constructor({ socketPath, user = "postgres", database = "postgres", size = 6, init = [] }) {
    Object.assign(this, { socketPath, user, database, size, init });
    this.idle = [];
    this.all = [];
    this.queue = [];
    this.stats = { queries: 0 };
  }

  async open() {
    for (let i = 0; i < this.size; i++) {
      const c = new Conn(this.socketPath, this.user, this.database);
      await c.connect();
      for (const s of this.init) await c.query(s);
      this.idle.push(c);
      this.all.push(c);
    }
    return this;
  }

  async acquire() {
    if (this.idle.length) return this.idle.pop();
    return new Promise((ok) => this.queue.push(ok));
  }

  release(c) {
    const next = this.queue.shift();
    if (next) next(c); else this.idle.push(c);
  }

  async query(sql) {
    const c = await this.acquire();
    this.stats.queries++;
    try { return await c.query(sql); } finally { this.release(c); }
  }

  close() { for (const c of this.all) c.close(); }
}
