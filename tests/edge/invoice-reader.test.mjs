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

// Gulli Food Distributors (new layout from Oct 2026). Made-up products and
// prices at the column positions the real PDFs use. Cartons are stored as
// single units so prices compare with the older Global Food and Wine invoices.
function gulliInvoicePages({ wine = false } = {}) {
  y = 0;
  const H = wine
    ? { qty: 399, units: 450, rate: 506, amount: 567, wet: 645, gst: 701, total: 766, brand: 220 }
    : { qty: 427, units: 482, rate: 543, amount: 609, gst: 693, total: 763, brand: 234 };
  const words = [
    ...row(["Tax Invoice", 704]), ...row(["Invoice Number", 649], [": INVGUL-TEST-1", 722]), ...row(["Date", 746], [": 26/10/2026", 767]),
    ...row(["Gulli Food Distributors Pty Ltd", 26], ["Delivery Date:", 178], ["26/10/2026", 241], ["Due Date:", 386], ["02/11/2026", 430]),
    ...row(["Item", 27], ["Brand", H.brand], ["Status", 322], ["Qty", H.qty], ["Units", H.units], ["Rate", H.rate], ["Amount", H.amount],
      ...(wine ? [["WET", H.wet]] : []), ["GST", H.gst], ["Total", H.total]),
  ];
  if (wine) {
    words.push(...row(["90000001 Test Red Wine 750ml", 27], ["TestCo", 220], ["2", 404], ["Ctn [6]", 456], ["60.00", 516], ["$120.00", 588], ["$34.80", 648], ["$15.48", 703], ["$170.28", 780]));
    words.push(...row(["[6]", 27]));
    // Quantity printed a few points lower than its row; name continues with the brand.
    words.push(...row(["90000002 Test White Wine", 27], ["TestCo", 220], ["Ctn [12]", 451], ["96.00", 511], ["$96.00", 588], ["$27.84", 648], ["$12.38", 703], ["$136.22", 780]));
    words.push(...row(["1", 404]), ...row(["Reserve 750ml [12]", 27], ["Reserve", 220]));
  } else {
    words.push(...row(["90000003 Test Cheese Blend", 27], ["TestCo", 234], ["2", 433], ["Ctn [4]", 491], ["80.00", 555], ["$160.00", 633], ["$0.00", 702], ["$160.00", 780]));
    words.push(...row(["(Test Dairy) 2kg", 27]));
    words.push(...row(["90000004 Test Sugar 3kg", 27], ["TestCo", 234], ["2", 433], ["Bag", 502], ["9.00", 560], ["$18.00", 638], ["$0.00", 702], ["$18.00", 786]));
    words.push(...row(["90000005 Test Fish Portions 5kg", 27], ["TestCo", 234], ["Carton", 490], ["150.00", 549], ["$150.00", 633], ["$0.00", 702], ["$150.00", 780]));
  }
  words.push(...row(["Subject to any applicable rights and Gulli Food Distributors Pty Ltd's approved policy", 22]));
  const sub = wine ? 216 : 328, wet = 62.64, gstTotal = wine ? 28.31 : 0.45;
  words.push(...row(["NEW BANK DETAILS", 470], ["Subtotal", 715], [`$${sub.toFixed(2)}`, 786]),
    ...row(["Page:1of1", 371], ["Shipping Cost", 691], ["$4.50", 796]),
    ...(wine ? row(["WET Total", 709], [`$${wet.toFixed(2)}`, 786]) : []),
    ...row(["GST Total", 711], [`$${gstTotal.toFixed(2)}`, 796]),
    ...row(["Amount Due", 696], [`$${(sub + (wine ? wet : 0) + 4.5 + gstTotal).toFixed(2)}`, 786]));
  return [R.toRows(words)];
}

test("Gulli invoice (new layout): cartons stored as units, shipping as a fee, totals match", () => {
  const inv = R.parse(gulliInvoicePages());
  assert.equal(inv.ok, true, JSON.stringify(inv.checks));
  assert.equal(inv.supplier, "Global Food and Wine (Gulli)", "same supplier name, so price history continues");
  assert.equal(inv.kind, "invoice"); assert.equal(inv.number, "INVGUL-TEST-1"); assert.equal(inv.date, "2026-10-26");
  assert.deepEqual(inv.lines.map((l) => [l.code, l.description, l.qty, l.unit, l.unit_price, l.line_total]), [
    ["90000003", "Test Cheese Blend (Test Dairy) 2kg", 8, "Ctn [4]", 20, 160],
    ["90000004", "Test Sugar 3kg", 2, "Bag", 9, 18],
    ["90000005", "Test Fish Portions 5kg", 1, "Carton", 150, 150],
    ["DELIVERY", "Delivery Fee", 1, "EA", 4.5, 4.5],
  ]);
  assert.equal(inv.total, 332.95);
});

test("Gulli invoice with wine: WET in the line total, quantity printed lower, name with brand continues", () => {
  const inv = R.parse(gulliInvoicePages({ wine: true }));
  assert.equal(inv.ok, true, JSON.stringify(inv.checks));
  assert.deepEqual(inv.lines.map((l) => [l.description, l.qty, l.unit, l.unit_price, l.line_total, l.gst]), [
    ["Test Red Wine 750ml [6]", 12, "Ctn [6]", 10, 154.8, 15.48],
    ["Test White Wine Reserve 750ml [12]", 12, "Ctn [12]", 8, 123.84, 12.38],
    ["Delivery Fee", 1, "EA", 4.5, 4.5, 0.45],
  ]);
});

test("Gulli credit note: columns found from the header, stored as negative", () => {
  y = 0;
  const words = [
    ...row(["Credit Note", 701]), ...row(["Gulli Food Distributors Pty Ltd (ABN 00 000 000 000)", 34]),
    ...row(["Document Number", 637], [": CMGUL-TEST-1", 723]), ...row(["Date", 746], [": 28/10/2026", 767]),
    ...row(["Item", 26], ["GFW Brand", 255], ["Quantity", 347], ["Units", 419], ["Price", 480], ["CRS", 534], ["Amount", 593], ["WET", 665], ["GST", 722], ["Gross $", 782]),
    ...row(["90000006 Test Salami Sliced 1kg", 26], ["TestCo", 255], ["10", 362], ["Pkt", 429], ["$25.00", 474], ["$250.00", 596], ["$0.00", 661], ["$0.00", 716], ["$250.00", 781]),
    ...row(["Subtotal", 619], ["$250.00", 781]), ...row(["WET Total", 613], ["$0.00", 792]), ...row(["GST Total", 615], ["$0.00", 792]), ...row(["Total", 634], ["$250.00", 781]),
  ];
  const inv = R.parse([R.toRows(words)]);
  assert.equal(inv.ok, true, JSON.stringify(inv.checks));
  assert.equal(inv.kind, "credit"); assert.equal(inv.number, "CMGUL-TEST-1"); assert.equal(inv.total, -250);
  assert.deepEqual(inv.lines.map((l) => [l.code, l.qty, l.unit, l.unit_price, l.line_total]), [["90000006", 10, "Pkt", 25, -250]]);
});

test("Global Food and Wine (older layout): unit printed together with the code or the price", () => {
  y = 0;
  const words = [
    ...row(["Invoice", 393], ["Date", 504]), ...row(["Global Food and Wine", 180]),
    ...row(["INVGUL-TEST-2", 393], ["21 Oct 2026", 504]), ...row(["Payment due by", 393], ["28 Oct 2026", 490]),
    ...row(["Order", 33], ["Item", 123], ["Ship", 410], ["Line", 560]),
    ...row(["qty.", 33], ["code", 123], ["qty.", 410], ["total", 557]),
    ...row(["Test Cheese 2kg", 177]),
    ...row(["4", 33], ["Ctn [4]", 84], ["90000007", 123], ["4", 410], ["Ctn [4]", 455], ["$20.00", 494], ["$80.00", 545]),
    // Merged cells: "Carton 90000008" and "Carton $150.00".
    ...row(["Test Fish Portions 5kg", 177]),
    ...row(["1", 33], ["Carton 90000008", 84], ["1", 410], ["Carton $150.00", 455], ["$150.00", 544]),
    ...row(["1", 33], ["EA", 84], ["DELIVERY", 123], ["Delivery Fee", 177], ["1", 410], ["EA", 455], ["$4.95", 494], ["$4.95", 555]),
    ...row(["Total", 478], ["$234.95", 546]),
  ];
  const inv = R.parse([R.toRows(words)]);
  assert.equal(inv.ok, true, JSON.stringify(inv.checks));
  assert.deepEqual(inv.lines.map((l) => [l.code, l.qty, l.unit, l.unit_price, l.line_total]), [
    ["90000007", 4, "Ctn [4]", 20, 80], ["90000008", 1, "Carton", 150, 150], ["DELIVERY", 1, "EA", 4.95, 4.95],
  ]);
});

// HTC Foods (seafood). Made-up products and prices at the column positions the
// real PDFs use: description continues on the next row, price and tax code in
// one cell, printed line total includes GST.
function htcPages() {
  y = 0;
  const words = [
    ...row(["HTC Foods", 383]), ...row(["TAX INVOICE", 28], ["HSIN-TEST-1", 121]), ...row(["Date 03/11/2026", 28], ["Customer", 120], ["TEST", 195]),
    ...row(["Code", 38], ["(origin)", 68], ["Description", 127], ["Ctns", 377], ["Qty", 421], ["Price Tax", 467], ["Total", 538]),
    ...row(["1", 28], ["TST01 T7", 38], ["Test Prawn Raw 16/20 (10", 127], ["2 ctn", 387], ["20 pk", 419], ["$10.00 FRE", 462], ["$200.00", 533]),
    ...row(["Imported", 40], ["x 500g) TESTBRAND", 127]),
    ...row(["2", 28], ["TST02", 38], ["Test Squid Rings (4kg/ctn)", 127], ["1 ctn", 387], ["1 ctn", 425], ["$40.00 FRE", 462], ["$40.00", 539]),
    ...row(["3", 28], ["FLEVY", 38], ["Fuel Levy", 127], ["1 ctn", 387], ["$5.00 GST", 468], ["$5.50", 544]),
    ...row(["How to pay this invoice", 28]), ...row(["Subtotal", 446], ["$245.00", 490]), ...row(["GST", 462], ["$0.50", 490]),
    ...row(["Invoice Total", 426], ["$245.50", 490]),
  ];
  return [R.toRows(words)];
}

test("HTC Foods: lines, wrapped description, ex-GST totals and price per pack", () => {
  const inv = R.parse(htcPages());
  assert.equal(inv.supplier, "HTC Foods (seafood)");
  assert.equal(inv.ok, true, JSON.stringify(inv.checks));
  assert.equal(inv.number, "HSIN-TEST-1");
  assert.equal(inv.date, "2026-11-03");
  assert.deepEqual(inv.lines.map((l) => [l.code, l.qty, l.unit, l.unit_price, l.line_total, l.gst]), [
    ["TST01 T7", 20, "pk 500g", 10, 200, 0],
    ["TST02", 1, "ctn", 40, 40, 0],
    ["FLEVY", 1, "", 5, 5, 0.5],
  ]);
  assert.match(inv.lines[0].description, /Test Prawn Raw 16\/20 \(10 × 500g\) TESTBRAND/);
  const pack = R.packGuess(inv.lines[0].description, inv.lines[0].unit);
  assert.deepEqual(pack, { count: 1, size: 500, unit: "g" });
  assert.equal(R.perUnit(10, pack), 20, "A$20 per kg, not per carton");
  assert.equal(R.perUnit(40, R.packGuess(inv.lines[1].description, inv.lines[1].unit)), 10);
});
