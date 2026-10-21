/* Supplier invoice reader for Marinara. Reads the text that is already inside
   the PDF (no AI, nothing sent anywhere): pdf.js turns each page into rows of
   positioned words, then a reader written for each supplier's layout picks out
   the invoice number, date, lines and totals. Each result says whether its
   lines add up to the printed total, so the manager knows what to double-check.

   Works in the browser (window.MarinaraInvoiceReader) and in Node tests. */
(function (root) {
  "use strict";

  /* ---------- PDF -> rows ---------- */

  let pdfjsPromise = null;
  function loadPdfjs(base) {
    if (!pdfjsPromise) {
      pdfjsPromise = import(base + "vendor/pdfjs/pdf.min.mjs").then(pdfjs => {
        pdfjs.GlobalWorkerOptions.workerSrc = base + "vendor/pdfjs/pdf.worker.min.mjs";
        return pdfjs;
      }).catch(error => { pdfjsPromise = null; throw error; });
    }
    return pdfjsPromise;
  }

  // Rows of words per page, top to bottom; page rotation is applied, so
  // sideways invoices (MOCO) read like the printed page.
  async function extractPages(data, pdfjs) {
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false, verbosity: 0 }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const vp = page.getViewport({ scale: 1 });
      const words = content.items.filter(i => i.str && i.str.trim()).map(i => {
        const t = pdfjs.Util.transform(vp.transform, i.transform);
        return { s: i.str.trim(), x: Math.round(t[4]), y: Math.round(t[5]) };
      });
      pages.push(toRows(words));
    }
    try { await (doc.destroy ? doc.destroy() : doc.cleanup?.()); } catch (_) { /* ignore */ }
    return pages;
  }

  function toRows(words) {
    const rows = [];
    words.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const w of words) {
      const r = rows.find(r => Math.abs(r.y - w.y) <= 2);
      if (r) r.items.push(w); else rows.push({ y: w.y, items: [w] });
    }
    rows.forEach(r => r.items.sort((a, b) => a.x - b.x));
    return rows.sort((a, b) => a.y - b.y);
  }

  /* ---------- helpers ---------- */

  const money = s => {
    if (s == null) return null;
    const t = String(s).replace(/[$,\s]/g, "");
    if (!/^-?\d*\.?\d+$/.test(t)) return null;
    return Math.round(Number(t) * 100) / 100;
  };
  const num = s => {
    const t = String(s ?? "").replace(/,/g, "").trim();
    return /^-?\d*\.?\d+$/.test(t) ? Number(t) : null;
  };
  const r2 = n => Math.round(n * 100) / 100;
  const rowText = r => r.items.map(i => i.s).join(" ");
  const inX = (r, a, b) => r.items.filter(i => i.x >= a && i.x < b);
  const textIn = (r, a, b) => inX(r, a, b).map(i => i.s).join(" ").replace(/\s+/g, " ").trim();
  const firstIn = (r, a, b) => inX(r, a, b)[0]?.s ?? null;
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  // "8/10/2026", "08/10/26", "6 Oct 2026" -> "2026-10-08"
  function isoDate(s) {
    const t = String(s || "").trim();
    let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (m) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      return `${y}-${String(m[2]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
    }
    m = t.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
    if (m && MONTHS[m[2].toLowerCase()]) {
      return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
    }
    return null;
  }
  // Find a value to the right of a label on the same row, anywhere in the document.
  function valueAfter(pages, label, from = 0) {
    for (const rows of pages) for (const r of rows) {
      const i = r.items.findIndex(it => it.s.replace(/\s+/g, " ").startsWith(label));
      if (i < 0) continue;
      const after = r.items.slice(i + 1).filter(it => it.x > (r.items[i].x + from));
      if (after.length) return after[0].s;
      const rest = r.items[i].s.slice(label.length).replace(/^[:\s]+/, "");
      if (rest) return rest;
    }
    return null;
  }
  const allRows = pages => pages.flat();

  /* ---------- suppliers ---------- */

  // MOCO Food Services (sideways page; no supplier name printed on it).
  // Columns: category, code, brand, description, pack, per, unit, qty, price,
  // line total (ex GST), GST, total. Weighed items (unit RW) are per kg.
  const moco = {
    supplier: "MOCO Food Services",
    test: t => /Acct #:/.test(t) && /Total Invoice:/.test(t) && /Total Net:/.test(t),
    read(pages) {
      const lines = [];
      for (const rows of pages) for (const r of rows) {
        const code = firstIn(r, 45, 70);
        const total = money(firstIn(r, 565, 600));
        // Charges without a product code (e.g. FUEL LEVY): text on the left, amounts on the right.
        if ((!code || !/^\d{4,6}$/.test(code)) && total != null && money(firstIn(r, 470, 520)) != null && /[A-Z]/.test(textIn(r, 85, 330))) {
          lines.push({ code: "", description: textIn(r, 85, 330), qty: 1, unit: "", unit_price: money(firstIn(r, 470, 520)),
            line_total: money(firstIn(r, 470, 520)), gst: money(firstIn(r, 520, 560)) || 0 });
          continue;
        }
        if (!code || !/^\d{4,6}$/.test(code) || total == null) continue;
        const unit = firstIn(r, 365, 395) || "";
        lines.push({
          code,
          description: [textIn(r, 85, 165), textIn(r, 165, 322), textIn(r, 322, 350)].filter(Boolean).join(" · "),
          qty: num(firstIn(r, 395, 420)),
          unit: unit === "RW" ? "kg" : unit,
          unit_price: money(firstIn(r, 420, 470)),
          line_total: money(firstIn(r, 470, 520)),
          gst: money(firstIn(r, 520, 560)) || 0,
        });
      }
      return {
        number: valueAfter(pages, "Invoice #:"),
        date: isoDate(valueAfter(pages, "Date:")),
        kind: "invoice",
        lines,
        subtotal: money(valueAfter(pages, "Total Net:")),
        gst: money(valueAfter(pages, "Total GST:")),
        total: money(valueAfter(pages, "Total Invoice:")),
      };
    },
  };

  // Pronto Packaging. Description can wrap onto the next row(s).
  const pronto = {
    supplier: "Pronto Packaging",
    test: t => /PRONTO PACKAGING/i.test(t),
    read(pages) {
      const lines = [];
      for (const rows of pages) {
        let last = null;
        for (const r of rows) {
          const n = firstIn(r, 35, 55), code = firstIn(r, 55, 125), price = money(firstIn(r, 760, 820));
          if (n && /^\d+$/.test(n) && code && price != null) {
            const pct = num(String(firstIn(r, 640, 690) || "").replace("%", ""));
            const lineTotal = price;
            last = {
              code,
              description: textIn(r, 125, 395),
              qty: num(firstIn(r, 455, 500)),
              unit: "",
              pack: firstIn(r, 570, 630) || "",
              unit_price: money(firstIn(r, 690, 760)),
              line_total: lineTotal,
              gst: pct ? r2(lineTotal * pct / 100) : 0,
            };
            lines.push(last);
          } else if (last && r.items.length && r.items.every(i => i.x >= 125 && i.x < 395)) {
            last.description += " " + rowText(r);
          } else if (r.items.length) {
            last = null;
          }
        }
      }
      lines.forEach(l => { if (l.pack) l.unit = `pack ${l.pack}`; delete l.pack; });
      return {
        number: valueAfter(pages, "Inv Number:"),
        date: isoDate(valueAfter(pages, "Date:")),
        kind: "invoice",
        lines,
        subtotal: money(valueAfter(pages, "Subtotal:")),
        gst: money(valueAfter(pages, "GST:")),
        total: money(valueAfter(pages, "Total:")),
      };
    },
  };

  // Angelo's Fresh Pasta. Prices are ex GST with a GST column.
  const angelos = {
    supplier: "Angelo's Fresh Pasta",
    test: t => /angelospasta|Angelo's Fresh Pasta/i.test(t),
    read(pages) {
      const lines = [];
      let number = null, date = null;
      for (const rows of pages) for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (/^Invoice Number/.test(r.items[0]?.s || "")) number = r.items[1]?.s || number;
        if (r.items.some(it => it.s === "Code") && r.items.some(it => it.s === "Order No.")) {
          const next = rows[i + 1];
          if (next) date = isoDate(next.items[next.items.length - 1].s);
        }
        const code = firstIn(r, 20, 80), inc = money(firstIn(r, 500, 560)), ex = money(firstIn(r, 425, 470));
        if (!code || inc == null || ex == null || !/^[A-Z0-9]+$/.test(code)) continue;
        lines.push({
          code,
          description: textIn(r, 170, 385),
          qty: num(firstIn(r, 95, 135)),
          unit: textIn(r, 135, 170),
          unit_price: money(firstIn(r, 385, 425)),
          line_total: ex,
          gst: money(firstIn(r, 470, 500)) || 0,
        });
      }
      const total = money(valueAfter(pages, "Total Amount Payable"));
      const gst = money(valueAfter(pages, "Total Includes GST of"));
      return { number, date, kind: "invoice", lines, subtotal: total != null && gst != null ? r2(total - gst) : null, gst, total };
    },
  };

  // Global Food and Wine (Gulli invoices). Item names wrap above and below the
  // row that holds the numbers, and an item can continue on the next page.
  // GST is its own line ("GST"); line totals are ex GST.
  const globalFood = {
    supplier: "Global Food and Wine (Gulli)",
    test: t => /Global Food and Wine/.test(t) && /Payment due by/.test(t),
    read(pages) {
      const lines = [];
      let gst = 0;
      let carry = null; // last item of the previous page, if its name runs on
      let number = null, date = null;
      for (const rows of pages) {
        const head = rows.find(r => r.items.some(i => /^INV[A-Z]*-/.test(i.s)));
        if (head && !number) {
          number = head.items.find(i => /^INV[A-Z]*-/.test(i.s)).s;
          date = isoDate(head.items[head.items.length - 1].s);
        }
        const start = rows.findIndex(r => r.items.some(i => i.s === "qty."));
        const body = rows.slice(start + 1);
        const anchors = body.filter(r => /^\d+$/.test(firstIn(r, 25, 45) || "") && money(firstIn(r, 480, 500)) != null);
        const pageItems = anchors.map(a => {
          const code = firstIn(a, 115, 170);
          return {
            y: a.y, code,
            nameParts: [], unitParts: [],
            qty: num(firstIn(a, 25, 45)),
            unit_price: money(firstIn(a, 480, 520)),
            line_total: money(firstIn(a, 520, 600)),
          };
        });
        for (const r of body) {
          if (r.items.some(i => i.s === "Total")) break;
          const name = textIn(r, 170, 400), unit = textIn(r, 75, 115);
          if (!name && !unit) continue;
          // Nearest numbers row within 10pt; otherwise it belongs to the item
          // carried over from the previous page.
          let best = null;
          for (const it of pageItems) if (Math.abs(it.y - r.y) <= 10 && (!best || Math.abs(it.y - r.y) < Math.abs(best.y - r.y))) best = it;
          const target = best || (pageItems.length && r.y < pageItems[0].y - 10 ? carry : null);
          if (!target) continue;
          if (name) target.nameParts.push({ y: r.y, s: name });
          if (unit) target.unitParts.push({ y: r.y, s: unit });
        }
        for (const it of pageItems) {
          if (it.code === "GST") { gst = r2(gst + (it.line_total || 0)); continue; }
          lines.push(it);
        }
        carry = pageItems.filter(i => i.code !== "GST").slice(-1)[0] || carry;
      }
      for (const l of lines) {
        l.description = l.nameParts.sort((a, b) => a.y - b.y).map(p => p.s).join(" ").replace(/\s+/g, " ").trim();
        l.unit = l.unitParts.sort((a, b) => a.y - b.y).map(p => p.s).join(" ").trim();
        l.gst = 0;
        delete l.nameParts; delete l.unitParts; delete l.y;
      }
      const totalRow = allRows(pages).filter(r => r.items.some(i => i.s === "Total")).slice(-1)[0];
      const total = totalRow ? money(totalRow.items[totalRow.items.length - 1].s) : null;
      const sum = r2(lines.reduce((a, l) => a + (l.line_total || 0), 0));
      return { number, date, kind: "invoice", lines, subtotal: sum, gst, total };
    },
  };

  // Gulli credit notes (refunds). Amounts are stored as negative.
  const gulliCredit = {
    supplier: "Global Food and Wine (Gulli)",
    test: t => /Gulli Food Distributors/.test(t) && /Credit Note/.test(t),
    read(pages) {
      const lines = [];
      for (const rows of pages) for (const r of rows) {
        const first = r.items[0]?.s || "";
        const m = first.match(/^(\d{6,})\s+(.*)$/);
        const gross = money(firstIn(r, 770, 820));
        if (!m || gross == null) continue;
        const wet = money(firstIn(r, 660, 710)) || 0;
        lines.push({
          code: m[1],
          description: [m[2], textIn(r, 300, 385)].filter(Boolean).join(" · "),
          qty: num(firstIn(r, 385, 445)),
          unit: textIn(r, 445, 500),
          unit_price: money(firstIn(r, 500, 550)),
          line_total: -r2((money(firstIn(r, 600, 660)) || 0) + wet),
          gst: -(money(firstIn(r, 710, 760)) || 0),
        });
      }
      const sub = money(valueAfter(pages, "Subtotal")), wet = money(valueAfter(pages, "WET Total")) || 0;
      return {
        number: String(valueAfter(pages, "Document Number") || "").replace(/^[:\s]+/, "") || null,
        date: isoDate(String(valueAfter(pages, "Date") || "").replace(/^[:\s]+/, "")),
        kind: "credit",
        lines,
        subtotal: sub == null ? null : -r2(sub + wet),
        gst: -(money(valueAfter(pages, "GST Total")) || 0),
        total: -(money(valueAfter(pages, "Total")) || 0),
      };
    },
  };

  const READERS = [moco, pronto, angelos, globalFood, gulliCredit];

  // pages -> invoice, or { error } when the layout is not one we know.
  function parse(pages) {
    const text = allRows(pages).map(rowText).join("\n");
    const reader = READERS.find(rd => rd.test(text));
    if (!reader) return { error: "UNKNOWN_SUPPLIER" };
    const inv = reader.read(pages);
    inv.supplier = reader.supplier;
    inv.lines = inv.lines.filter(l => l.line_total != null);
    const sum = r2(inv.lines.reduce((a, l) => a + l.line_total, 0));
    const lineGst = r2(inv.lines.reduce((a, l) => a + (l.gst || 0), 0));
    const gst = inv.gst ?? lineGst;
    inv.gst = gst;
    if (inv.subtotal == null) inv.subtotal = sum;
    // Lines add up to the printed total (1 cent per line allowed for rounding)?
    const tolerance = 0.01 * Math.max(1, inv.lines.length);
    inv.checks = {
      lines_match_subtotal: inv.subtotal != null && Math.abs(sum - inv.subtotal) <= tolerance,
      total_matches: inv.total != null && Math.abs(r2(sum + gst) - inv.total) <= tolerance,
      has_number: !!inv.number,
      has_date: !!inv.date,
      has_lines: inv.lines.length > 0,
    };
    inv.ok = Object.values(inv.checks).every(Boolean);
    return inv;
  }

  async function readPdf(data, base) {
    const pdfjs = await loadPdfjs(base || "./");
    const pages = await extractPages(data, pdfjs);
    return parse(pages);
  }

  const api = { readPdf, extractPages, parse, toRows, isoDate, READERS };
  root.MarinaraInvoiceReader = api;
})(typeof window !== "undefined" ? window : globalThis);
