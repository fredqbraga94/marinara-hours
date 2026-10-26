// New version check: a phone that keeps old files in its cache is offered a
// one-tap update when the published files change; nothing is offered when they
// do not; after Update the new file runs and the offer goes away.
// Run: node tests/e2e/update-check.e2e.mjs   (E2E_BROWSER=webkit for Safari's engine)
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_PATH || "playwright");
const ENGINE = process.env.E2E_BROWSER === "webkit" ? "webkit" : "chromium";

let published = 1; // which version of manager-ui.js the "server" publishes
const types = { ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };
const server = createServer((req, res) => {
  try {
    const path = req.url.split("?")[0];
    const file = resolve("." + (path === "/" ? "/index.html" : path));
    let body = readFileSync(file);
    if (path === "/manager-ui.js") body = Buffer.concat([body, Buffer.from(`\nwindow.__publishedVersion=${published};\n`)]);
    res.setHeader("Content-Type", types[extname(file)] || "text/html");
    res.setHeader("Cache-Control", "max-age=600"); // like GitHub Pages
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await pw[ENGINE].launch();
try {
  const context = await browser.newContext({ ...pw.devices["iPhone 13"], serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // No request interception here: it would switch off the browser cache this test needs.

  await page.goto(url);
  assert.equal(await page.evaluate(() => window.__publishedVersion), 1);
  await page.waitForTimeout(5500);
  assert.equal(await page.locator("#appUpdateBar").count(), 0, "nothing changed: no offer");

  // A release happens while the phone still has version 1 in its cache.
  published = 2;
  await page.goto(url + "?again"); // opening the app again (not a forced reload): cached files are used
  assert.equal(await page.evaluate(() => window.__publishedVersion), 1, "the phone runs its cached copy (the problem)");
  await page.locator("#appUpdateBar").waitFor({ state: "visible", timeout: 10000 });
  assert.match(await page.locator("#appUpdateBar").innerText(), /new version is ready/i);

  await page.locator("#appUpdateBar button").click();
  await page.waitForLoadState("load");
  assert.equal(await page.evaluate(() => window.__publishedVersion), 2, "after Update the new version runs");
  await page.waitForTimeout(5500);
  assert.equal(await page.locator("#appUpdateBar").count(), 0, "up to date: no offer");
  assert.deepEqual(errors, []);
  console.log(`PASS (${ENGINE}): cached old files are detected, one-tap update loads the new version, no false offers.`);
} finally {
  await browser.close();
  server.close();
}
