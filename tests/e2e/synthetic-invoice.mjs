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
