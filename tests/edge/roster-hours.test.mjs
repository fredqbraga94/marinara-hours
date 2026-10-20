// Unit test for roster planned hours and the student-visa fortnight check.
// Extracts the shipped helpers (VISA-HOURS and ROSTER-HOURS blocks) from Index.ts.
// Run: node --test tests/edge/roster-hours.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const ts = createRequire(import.meta.url)("typescript");

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "../../supabase/functions/marinara-api-v2/Index.ts"), "utf8");
const block = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
const code =
  block("// VISA-HOURS-START", "// VISA-HOURS-END") +
  block("// ROSTER-HOURS-START", "// ROSTER-HOURS-END") +
  "\nreturn { plannedMinutes, spanMinutes, addDays, computeRosterHours };";
const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const { plannedMinutes, spanMinutes, addDays, computeRosterHours } = new Function(js)();

const H = 60 * 60 * 1000;
const bris = (local) => Date.parse(local + ":00+10:00");
const iso = (ms) => new Date(ms).toISOString();
const services = [
  { department: "Kitchen", service: "L", start_time: "10:30", end_time: "15:00" },
  { department: "Kitchen", service: "D", start_time: "16:30", end_time: "22:30" },
];

test("spans, including past midnight", () => {
  assert.equal(spanMinutes("17:00", "21:00"), 240);
  assert.equal(spanMinutes("17:00", "01:00"), 480);
  assert.equal(spanMinutes("17:00", "17:00"), 0);
  assert.equal(spanMinutes(null, "17:00"), 0);
});

test("kitchen codes use the service times; floor uses its own times", () => {
  assert.equal(plannedMinutes({ code: "L" }, "Kitchen", services), 270);
  assert.equal(plannedMinutes({ code: "D" }, "Kitchen", services), 360);
  assert.equal(plannedMinutes({ code: "LD" }, "Kitchen", services), 630);
  assert.equal(plannedMinutes({ code: "OFF" }, "Kitchen", services), 0);
  assert.equal(plannedMinutes({ code: "SHIFT", start_time: "17:00", end_time: "21:00" }, "Floor", services), 240);
  // Floor has no L/D service times -> 0 rather than a guess
  assert.equal(plannedMinutes({ code: "L" }, "Floor", services), 0);
  assert.equal(plannedMinutes(undefined, "Kitchen", services), 0);
});

test("addDays works in Brisbane dates", () => {
  assert.equal(addDays("2026-10-26", -7), "2026-10-19");
  assert.equal(addDays("2026-10-26", 6), "2026-11-01");
});

const cook = { id: "k", department: "Kitchen", student_visa: true, visa_course_break: false };
const waiter = { id: "f", department: "Floor", student_visa: false };
const cell = (staff_id, work_date, code, start_time = null, end_time = null) =>
  ({ staff_id, work_date, code, start_time, end_time });

test("planning next week: this week's past days use the clock, the rest the roster", () => {
  // Now: Wed 21 Oct 12:00. Planning week of Mon 26 Oct.
  const now = bris("2026-10-21T12:00");
  const entries = [
    cell("k", "2026-10-19", "LD"),   // past: roster says 10.5h but clock says 9h
    cell("k", "2026-10-20", "D"),    // past: no clock -> 0
    cell("k", "2026-10-22", "LD"),   // future this week: 10.5h
    cell("k", "2026-10-24", "D"),    // future: 6h
    cell("k", "2026-10-26", "LD"),   // next week: 10.5
    cell("k", "2026-10-27", "LD"),   // 10.5
    cell("k", "2026-10-28", "D"),    // 6
    cell("f", "2026-10-26", "SHIFT", "17:00", "21:00"),
    cell("f", "2026-10-27", "SHIFT", "17:00", "01:00"),
  ];
  const shifts = [{ staff_id: "k", clock_in: iso(bris("2026-10-19T10:00")), clock_out: iso(bris("2026-10-19T19:00")), breaks: [] }];
  const r = computeRosterHours([cook, waiter], entries, shifts, services, "2026-10-26", now);
  assert.equal(r.planned_hours.k, 27);
  assert.equal(r.planned_hours.f, 12);
  assert.equal(r.visa.length, 1);
  assert.equal(r.visa[0].prev_week_hours, 9 + 0 + 10.5 + 6);
  assert.equal(r.visa[0].week_hours, 27);
  assert.equal(r.visa[0].fortnight_hours, 52.5);
  assert.equal(r.visa[0].over, true);
});

test("today counts whichever is higher: worked so far or the roster", () => {
  const now = bris("2026-10-21T12:00");
  const entries = [cell("k", "2026-10-21", "L")]; // 4.5h planned
  const shifts = [{ staff_id: "k", clock_in: iso(bris("2026-10-21T06:00")), clock_out: null, breaks: [] }]; // 6h so far
  const r = computeRosterHours([cook], entries, shifts, services, "2026-10-19", now);
  assert.equal(r.visa[0].week_hours, 6);
});

test("course break: hours shown, never 'over'", () => {
  const onBreak = { ...cook, visa_course_break: true };
  const entries = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"].map(d => cell("k", d, "LD"));
  const r = computeRosterHours([onBreak], entries, [], services, "2026-10-26", bris("2026-10-20T09:00"));
  assert.equal(r.visa[0].fortnight_hours, 52.5);
  assert.equal(r.visa[0].over, false);
  assert.equal(r.visa[0].course_break, true);
});

test("exactly 48h is allowed", () => {
  const entries = [
    cell("k", "2026-10-26", "SHIFT", "08:00", "20:00"),
    cell("k", "2026-10-27", "SHIFT", "08:00", "20:00"),
    cell("k", "2026-10-28", "SHIFT", "08:00", "20:00"),
    cell("k", "2026-10-29", "SHIFT", "08:00", "20:00"),
  ];
  const r = computeRosterHours([cook], entries, [], services, "2026-10-26", bris("2026-10-20T09:00"));
  assert.equal(r.visa[0].fortnight_hours, 48);
  assert.equal(r.visa[0].over, false);
});
