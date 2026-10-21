// Unit test for the Web Push helpers in Index.ts (VAPID signature + aes128gcm
// encryption), using the code between the WEBPUSH markers. The message is
// decrypted here the way a phone would, to prove it can be read.
// Run: node --test tests/edge/webpush.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const ts = createRequire(import.meta.url)("typescript");

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "../../supabase/functions/marinara-api-v2/Index.ts"), "utf8");
const block = src.slice(src.indexOf("// WEBPUSH-START"), src.indexOf("// WEBPUSH-END"));
assert.ok(block.length > 500, "WEBPUSH block not found");
const js = ts.transpileModule(block + "\nreturn { b64uToBytes, bytesToB64u, hkdf, vapidAuthorization, encryptPushPayload, sendWebPush };",
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const W = new Function(js)();
const subtle = crypto.subtle;

async function newKeys() {
  const kp = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  return { kp, pub };
}

test("encrypted message can be decrypted by the phone (RFC 8291)", async () => {
  const ua = await newKeys();
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const msg = JSON.stringify({ title: "Time off request", body: "Noah asked for a holiday · 3–7 Nov" });
  const body = await W.encryptPushPayload(W.bytesToB64u(ua.pub), W.bytesToB64u(auth), new TextEncoder().encode(msg));
  // header
  const salt = body.slice(0, 16);
  const rs = (body[16] << 24) | (body[17] << 16) | (body[18] << 8) | body[19];
  const idlen = body[20];
  const asPub = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  assert.equal(rs, 4096); assert.equal(idlen, 65);
  // phone side
  const asKey = await subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: asKey }, ua.kp.privateKey, 256));
  const enc = new TextEncoder();
  const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...ua.pub, ...asPub]);
  const ikm = await W.hkdf(auth, shared, info, 32);
  const cek = await W.hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await W.hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, cipher));
  assert.equal(plain[plain.length - 1], 2, "last-record delimiter");
  assert.equal(new TextDecoder().decode(plain.slice(0, -1)), msg);
});

test("VAPID header: valid ES256 signature for the push service origin", async () => {
  const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = W.bytesToB64u(new Uint8Array(await subtle.exportKey("raw", kp.publicKey)));
  const d = (await subtle.exportKey("jwk", kp.privateKey)).d;
  const now = 1792540000;
  const h = await W.vapidAuthorization("https://web.push.apple.com/QAbc/xyz", pub, d, "https://example.test/", now);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
  assert.ok(m, h);
  assert.equal(m[4], pub);
  const claims = JSON.parse(new TextDecoder().decode(W.b64uToBytes(m[2])));
  assert.deepEqual(claims, { aud: "https://web.push.apple.com", exp: now + 43200, sub: "https://example.test/" });
  const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, kp.publicKey, W.b64uToBytes(m[3]),
    new TextEncoder().encode(`${m[1]}.${m[2]}`));
  assert.equal(ok, true);
});

test("sendWebPush posts the encrypted body with the right headers; 410 = gone", async () => {
  const ua = await newKeys();
  const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const vapid = { publicKey: W.bytesToB64u(new Uint8Array(await subtle.exportKey("raw", kp.publicKey))),
    privateKey: (await subtle.exportKey("jwk", kp.privateKey)).d, subject: "https://example.test/" };
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { status: calls.length === 1 ? 201 : 410 }; };
  try {
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: W.bytesToB64u(ua.pub), auth: W.bytesToB64u(crypto.getRandomValues(new Uint8Array(16))) };
    const a = await W.sendWebPush(sub, { title: "x" }, vapid);
    const b = await W.sendWebPush(sub, { title: "y" }, vapid);
    assert.deepEqual([a.ok, a.gone, b.ok, b.gone], [true, false, false, true]);
    const h = calls[0].init.headers;
    assert.equal(h["Content-Encoding"], "aes128gcm"); assert.equal(h.TTL, "86400");
    assert.match(h.Authorization, /^vapid t=.+, k=/);
  } finally { globalThis.fetch = realFetch; }
});
