// Unit test for the student visa 14-day hours calculation in Index.ts.
// Extracts the pure helper between the VISA-HOURS markers, so the test runs
// the exact code that ships. Run: node --test tests/edge/visa-hours.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
// require() also honours NODE_PATH, so a global TypeScript works locally too.
const ts = createRequire(import.meta.url)("typescript");

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(here, "../../supabase/functions/marinara-api-v2/Index.ts"),
  "utf8"
);
const block = src.slice(
  src.indexOf("// VISA-HOURS-START"),
  src.indexOf("// VISA-HOURS-END")
);
assert.ok(block.length > 100, "helper block not found in Index.ts");
const js = ts.transpileModule(block + "\nreturn computeVisaHours;", {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const computeVisaHours = new Function(js)();

const H = 60 * 60 * 1000;
const D = 24 * H;
const NOW = Date.parse("2026-10-20T00:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const shift = (id, startMs, hours, breaks = [], open = false) => ({
  staff_id: id,
  clock_in: iso(startMs),
  clock_out: open ? null : iso(startMs + hours * H),
  breaks,
});
const staff = [{ id: "a", student_visa: true, active: true, visa_course_break: false }];

test("sums completed shifts inside the 14 days", () => {
  const r = computeVisaHours(staff, [shift("a", NOW - 2 * D, 8), shift("a", NOW - 5 * D, 6)], NOW);
  assert.equal(r[0].hours_14d, 14);
  assert.equal(r[0].remaining_hours, 34);
  assert.equal(r[0].limit_hours, 48);
});

test("removes breaks", () => {
  const s = NOW - 1 * D;
  const r = computeVisaHours(staff, [shift("a", s, 8, [{ break_start: iso(s + 3 * H), break_end: iso(s + 3.5 * H) }])], NOW);
  assert.equal(r[0].hours_14d, 7.5);
});

test("ignores shifts entirely before the window", () => {
  const r = computeVisaHours(staff, [shift("a", NOW - 15 * D, 8)], NOW);
  assert.equal(r[0].hours_14d, 0);
});

test("counts only the part of a shift inside the window", () => {
  // starts 2h before the window opens, lasts 6h -> 4h inside
  const r = computeVisaHours(staff, [shift("a", NOW - 14 * D - 2 * H, 6)], NOW);
  assert.equal(r[0].hours_14d, 4);
});

test("a shift still in progress counts up to now, open break included", () => {
  const s = NOW - 5 * H;
  const r = computeVisaHours(staff, [shift("a", s, 0, [{ break_start: iso(NOW - 1 * H), break_end: null }], true)], NOW);
  assert.equal(r[0].hours_14d, 4);
});

test("over the limit: remaining never goes below zero", () => {
  const shifts = Array.from({ length: 7 }, (_, i) => shift("a", NOW - (i + 1) * D, 7.5));
  const r = computeVisaHours(staff, shifts, NOW);
  assert.equal(r[0].hours_14d, 52.5);
  assert.equal(r[0].remaining_hours, 0);
});

test("other people's shifts are not counted; course break is reported", () => {
  const two = [...staff, { id: "b", student_visa: true, active: true, visa_course_break: true }];
  const r = computeVisaHours(two, [shift("a", NOW - D, 5), shift("x", NOW - D, 9)], NOW);
  assert.deepEqual(r.map((x) => [x.staff_id, x.hours_14d, x.course_break]), [["a", 5, false], ["b", 0, true]]);
});

test("a break recorded outside its shift does not reduce hours twice", () => {
  const s = NOW - 2 * D;
  const r = computeVisaHours(staff, [shift("a", s, 4, [{ break_start: iso(s + 5 * H), break_end: iso(s + 6 * H) }])], NOW);
  assert.equal(r[0].hours_14d, 4);
});
