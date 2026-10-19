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
const js = ts.transpileModule(block + "\nreturn { computeVisaHours, visaFortnightStart };", {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const { computeVisaHours, visaFortnightStart } = new Function(js)();

const H = 60 * 60 * 1000;
const D = 24 * H;
// Brisbane is UTC+10 all year. bris("2026-10-20T10:00") -> epoch ms.
const bris = (local) => Date.parse(local + ":00+10:00");
// Tuesday 20 Oct 2026, 10:00 Brisbane. Fortnight = Mon 12 Oct 00:00 -> now.
const NOW = bris("2026-10-20T10:00");
const iso = (ms) => new Date(ms).toISOString();
const shift = (id, startMs, hours, breaks = [], open = false) => ({
  staff_id: id,
  clock_in: iso(startMs),
  clock_out: open ? null : iso(startMs + hours * H),
  breaks,
});
const staff = [{ id: "a", student_visa: true, active: true, visa_course_break: false }];

test("fortnight starts on Monday 00:00 (Brisbane) of last week", () => {
  assert.equal(visaFortnightStart(NOW), bris("2026-10-12T00:00"));
  // Sunday 23:59 still belongs to the same pair of weeks...
  assert.equal(visaFortnightStart(bris("2026-10-25T23:59")), bris("2026-10-12T00:00"));
  // ...and at Monday 00:00 the window moves forward one week.
  assert.equal(visaFortnightStart(bris("2026-10-26T00:00")), bris("2026-10-19T00:00"));
  // Monday itself: last Monday is the start.
  assert.equal(visaFortnightStart(bris("2026-10-19T09:00")), bris("2026-10-12T00:00"));
  // Early Monday in Brisbane is still Sunday in UTC: must count as Monday.
  assert.equal(visaFortnightStart(bris("2026-10-19T03:00")), bris("2026-10-12T00:00"));
});

test("sums shifts from last week and this week", () => {
  const r = computeVisaHours(staff, [
    shift("a", bris("2026-10-12T09:00"), 8), // Mon last week
    shift("a", bris("2026-10-17T17:00"), 6), // Sat last week
    shift("a", bris("2026-10-19T09:00"), 5), // Mon this week
  ], NOW);
  assert.equal(r[0].hours_14d, 19);
  assert.equal(r[0].remaining_hours, 29);
  assert.equal(r[0].limit_hours, 48);
  assert.equal(r[0].window_start, iso(bris("2026-10-12T00:00")));
  assert.equal(r[0].window_end, iso(bris("2026-10-26T00:00")));
});

test("the Sunday before last week is not counted", () => {
  const r = computeVisaHours(staff, [shift("a", bris("2026-10-11T10:00"), 8)], NOW);
  assert.equal(r[0].hours_14d, 0);
});

test("a shift crossing midnight into Monday counts only the Monday part", () => {
  // Sun 11 Oct 22:00 -> Mon 12 Oct 02:00: 2h inside
  const r = computeVisaHours(staff, [shift("a", bris("2026-10-11T22:00"), 4)], NOW);
  assert.equal(r[0].hours_14d, 2);
});

test("removes breaks", () => {
  const s = bris("2026-10-19T10:00");
  const r = computeVisaHours(staff, [shift("a", s, 8, [{ break_start: iso(s + 3 * H), break_end: iso(s + 3.5 * H) }])], NOW);
  assert.equal(r[0].hours_14d, 7.5);
});

test("a shift still in progress counts up to now, open break included", () => {
  const s = NOW - 5 * H;
  const r = computeVisaHours(staff, [shift("a", s, 0, [{ break_start: iso(NOW - 1 * H), break_end: null }], true)], NOW);
  assert.equal(r[0].hours_14d, 4);
});

test("over the limit: remaining never goes below zero", () => {
  const shifts = Array.from({ length: 7 }, (_, i) => shift("a", bris("2026-10-12T09:00") + i * D, 7.5));
  const r = computeVisaHours(staff, shifts, NOW);
  assert.equal(r[0].hours_14d, 52.5);
  assert.equal(r[0].remaining_hours, 0);
});

test("other people's shifts are not counted; course break is reported", () => {
  const two = [...staff, { id: "b", student_visa: true, active: true, visa_course_break: true }];
  const s = bris("2026-10-19T09:00");
  const r = computeVisaHours(two, [shift("a", s, 5), shift("x", s, 9)], NOW);
  assert.deepEqual(r.map((x) => [x.staff_id, x.hours_14d, x.course_break]), [["a", 5, false], ["b", 0, true]]);
});

test("a break recorded outside its shift does not reduce hours", () => {
  const s = bris("2026-10-19T09:00");
  const r = computeVisaHours(staff, [shift("a", s, 4, [{ break_start: iso(s + 5 * H), break_end: iso(s + 6 * H) }])], NOW);
  assert.equal(r[0].hours_14d, 4);
});
