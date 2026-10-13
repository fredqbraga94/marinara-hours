// Loads a real marinara-api-v2 source file (TypeScript, as deployed) under Node.
// supabase-js is replaced by the SQL adapter (pg-supabase.mjs) bound to a pool.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomUUID, randomBytes } from "node:crypto";
import { makeCreateClient } from "./pg-supabase.mjs";

const require = createRequire(import.meta.url);
const ts = (() => {
  for (const c of [process.env.TYPESCRIPT_PATH, "typescript", "/opt/node-tools/node_modules/typescript"].filter(Boolean)) {
    try { return require(c); } catch (_) { /* next */ }
  }
  throw new Error("TypeScript not found");
})();

export const SERVICE_KEY = "synthetic-service-role-key-" + randomBytes(8).toString("hex");
const dir = mkdtempSync(join(tmpdir(), "marinara-edge-"));
const shim = join(dir, "supabase-shim.mjs");
writeFileSync(shim, "export const createClient = (...a) => globalThis.__PG_CREATE_CLIENT(...a);\n");

// Background tasks (EdgeRuntime.waitUntil) are tracked so tests can wait for them.
const pending = [];
export const edgeRuntime = { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})) };
globalThis.EdgeRuntime = edgeRuntime;
export async function settle() { while (pending.length) await Promise.allSettled(pending.splice(0)); }

export async function loadHandler(sourcePath) {
  const js = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/from\s+["']https:\/\/esm\.sh\/@supabase\/supabase-js@2["']/, `from ${JSON.stringify(pathToFileURL(shim).href)}`);
  let handler = null;
  globalThis.Deno = {
    env: { get: (k) => ({ SUPABASE_URL: "http://isolated.local", SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY })[k] },
    serve: (h) => { handler = h; },
  };
  const file = join(dir, `api-${randomUUID()}.mjs`);
  writeFileSync(file, js);
  await import(pathToFileURL(file).href);
  if (!handler) throw new Error("Deno.serve not called");
  return handler;
}

// Points every loaded handler at a database pool (with optional failure injection).
export function useDatabase(pool, inject = null) {
  const log = [];
  globalThis.__PG_CREATE_CLIENT = makeCreateClient(pool, log, inject);
  return log;
}

export async function call(handler, body, headers = {}) {
  const req = new Request("http://isolated.local/functions/v1/marinara-api-v2", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const t0 = performance.now();
  const res = await handler(req);
  const ms = performance.now() - t0;
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json, ms };
}

export const newDeviceSecret = () => randomBytes(32).toString("base64url");
