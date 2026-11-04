// Builds made-up invoices in the MOCO layout (columns at the x positions the
// reader expects). Synthetic numbers and products only: this repository is public.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { root } from "../integration/pgenv.mjs";

// The vendored browser build, run in a small sandbox (the app's own copy).
const sandbox = { console, setTimeout, clearTimeout, TextEncoder, TextDecoder, atob, btoa, exports: {} };
sandbox.module = { exports: sandbox.exports };
vm.runInNewContext(readFileSync(resolve(root, "vendor/jspdf.umd.min.js"), "utf8"), sandbox);
const { jsPDF } = sandbox.exports;

const f2 = (n) => n.toFixed(2);
// lines: [{ code, brand, desc, unit, qty, price, gst }]
export function mocoStylePdf({ number, date, lines, wrongTotal = false }) {
  const doc = new jsPDF({ unit: "pt", format: [612, 792] });
  doc.setFontSize(7);
  doc.text("Acct #:", 40, 60); doc.text("TEST-ACCT", 80, 60);
  doc.text("Invoice #:", 400, 60); doc.text(number, 450, 60);
  doc.text("Date:", 400, 72); doc.text(date, 450, 72);
  let y = 120, net = 0, gst = 0;
  for (const l of lines) {
    const ex = Math.round(l.qty * l.price * 100) / 100, g = l.gst ? Math.round(ex * 10) / 100 : 0;
    net += ex; gst += g;
    doc.text(l.code, 50, y); doc.text(l.brand, 90, y); doc.text(l.desc, 170, y);
    doc.text(l.unit, 370, y); doc.text(String(l.qty), 400, y); doc.text(f2(l.price), 425, y);
    doc.text(f2(ex), 475, y); doc.text(f2(g), 525, y); doc.text(f2(ex + g), 570, y);
    y += 14;
  }
  y += 20;
  doc.text("Total Net:", 450, y); doc.text(f2(net), 540, y);
  doc.text("Total GST:", 450, y + 12); doc.text(f2(gst), 540, y + 12);
  doc.text("Total Invoice:", 450, y + 24); doc.text(f2(net + gst + (wrongTotal ? 5 : 0)), 540, y + 24);
  return Buffer.from(new Uint8Array(doc.output("arraybuffer")));
}

export function unknownPdf() {
  const doc = new jsPDF({ unit: "pt" });
  doc.text("A letter that is not an invoice.", 40, 60);
  return Buffer.from(new Uint8Array(doc.output("arraybuffer")));
}

// A made-up supplier with no reader of its own: a plain tax invoice table
// (Qty, Description, Unit Price, Amount), GST added at the bottom.
export function genericPdf({ number, date }) {
  const doc = new jsPDF({ unit: "pt", format: [595, 842] });
  doc.setFontSize(14); doc.text("Test Fresh Foods Pty Ltd", 40, 50);
  doc.setFontSize(8); doc.text("ABN 00 000 000 000", 40, 64); doc.text("1 Test Street, Testville QLD 4000", 40, 76);
  doc.setFontSize(12); doc.text("TAX INVOICE", 420, 50);
  doc.setFontSize(9); doc.text("Invoice No:", 400, 70); doc.text(number, 470, 70); doc.text("Date:", 400, 82); doc.text(date, 470, 82);
  doc.text("Bill To", 40, 110); doc.text("Test Restaurant", 40, 122);
  doc.text("Qty", 40, 160); doc.text("Description", 80, 160); doc.text("Unit Price", 380, 160); doc.text("Amount", 500, 160);
  const rows = [[2, "Test Olive Oil 4L", 30], [3, "Test Flour 12.5kg", 20], [1, "Test Napkins carton", 15]];
  let y = 178, net = 0;
  for (const [q, d, p] of rows) { doc.text(String(q), 40, y); doc.text(d, 80, y); doc.text(`$${p.toFixed(2)}`, 380, y); doc.text(`$${(q * p).toFixed(2)}`, 500, y); net += q * p; y += 14; }
  doc.text("Delivery Fee", 380, y + 16); doc.text("$5.00", 500, y + 16); net += 5;
  doc.text("Subtotal", 380, y + 30); doc.text(`$${net.toFixed(2)}`, 500, y + 30);
  doc.text("GST", 380, y + 44); doc.text("$2.00", 500, y + 44);
  doc.text("Total", 380, y + 58); doc.text(`$${(net + 2).toFixed(2)}`, 500, y + 58);
  return Buffer.from(new Uint8Array(doc.output("arraybuffer")));
}
