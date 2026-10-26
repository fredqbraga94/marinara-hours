// Reader checks on made-up invoice rows (no PDF needed): words at the x
// positions the MOCO layout uses. Synthetic data only: this repository is public.
// Run: node --test tests/edge/invoice-reader.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
await import("../../invoice-reader.js");
const R = globalThis.MarinaraInvoiceReader;

let y = 0;
const row = (...cells) => { y += 12; return cells.map(([s, x]) => ({ s, x, y })); };
function mocoPages(lines) {
  const words = [
    ...row(["Acct #:", 40], ["TEST", 80]), ...row(["Invoice #:", 400], ["T-9", 450]), ...row(["Date:", 400], ["14/10/2026", 450]),
  ];
  let net = 0;
  for (const l of lines) {
    words.push(...row(["R", 29], [l.code, 50], ["TESTCO", 92], [l.desc, 172], [l.pack, 328], ["1", 357], [l.unit, 374], ["1", 403],
      [l.price.toFixed(2), 433], [l.total.toFixed(2), 483], [".00", 538], [l.total.toFixed(2), 575]));
    if (l.weight) words.push(...row(["Pack size Net Weight(s);", 29], ["|________kg|", 118], [l.weight.toFixed(3), 130], ["Total Net Weight of", 395], [`${l.weight.toFixed(3)}kg`, 479]));
    net += l.total;
  }
  words.push(...row(["Total Net:", 450], [net.toFixed(2), 540]), ...row(["Total GST:", 450], ["0.00", 540]), ...row(["Total Invoice:", 450], [net.toFixed(2), 540]));
  return [R.toRows(words)];
}

test("weighed meat: the printed net weight is the quantity, priced per kg", () => {
  const inv = R.parse(mocoPages([
    { code: "90001", desc: "TEST PORK FILLET", pack: "AP9KG", unit: "RW", price: 10, total: 102, weight: 10.2 },
    { code: "90002", desc: "TEST SAUSAGE", pack: "AP2.5KG", unit: "EA", price: 20, total: 54, weight: 2.7 },
    { code: "90003", desc: "TEST NAPKINS", pack: "100Q", unit: "CTN", price: 30, total: 30 },
  ]));
  assert.equal(inv.ok, true, JSON.stringify(inv.checks));
  assert.deepEqual(inv.lines.map((l) => [l.code, l.qty, l.unit]), [["90001", 10.2, "kg"], ["90002", 2.7, "kg"], ["90003", 1, "CTN"]]);
});

test("weighed item without a weight row: weight = total / price per kg", () => {
  const inv = R.parse(mocoPages([{ code: "90004", desc: "TEST BEEF", pack: "AP1.6KG", unit: "EA", price: 50, total: 81 }]));
  assert.equal(inv.lines[0].qty, 1.62);
  assert.equal(inv.lines[0].unit, "kg");
});

test("pack size guesses", () => {
  assert.deepEqual(R.packGuess("X · CREAM · 5LT", "CTN"), { count: 1, size: 5, unit: "l" });
  assert.deepEqual(R.packGuess("X [12x330ml] BTL", "Carton"), { count: 12, size: 330, unit: "ml" });
  assert.deepEqual(R.packGuess("3kg Lasagna (Ctn)", "x 6"), { count: 6, size: 3, unit: "kg" });
  assert.deepEqual(R.packGuess("TEST PORK · AP9KG", "kg"), { count: 1, size: 1, unit: "kg" });
  assert.equal(R.perUnit(38.23, { count: 3, size: 5, unit: "l" }), 2.55);
});
