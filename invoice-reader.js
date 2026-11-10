/* Supplier invoice reader for Marinara. Reads the text that is already inside
   the PDF (no AI, nothing sent anywhere): pdf.js turns each page into rows of
   positioned words, then a reader written for each supplier's layout picks out
   the invoice number, date, lines and totals. Each result says whether its
   lines add up to the printed total, so the manager knows what to double-check.

   Works in the browser (window.MarinaraInvoiceReader) and in Node tests. */
(function (root) {
  "use strict";

  /* ---------- PDF -> rows ---------- */

  // Older Safari (iPhone before iOS 26) can't "for await" over a ReadableStream,
  // which pdf.js uses to read the text. Add that small piece when it's missing.
  function addStreamIteration() {
    const RS = typeof ReadableStream !== "undefined" ? ReadableStream : null;
    if (!RS || RS.prototype[Symbol.asyncIterator]) return;
    const values = function ({ preventCancel = false } = {}) {
      const reader = this.getReader();
      return {
        async next() {
          const r = await reader.read();
          if (r.done) reader.releaseLock();
          return r;
        },
        async return(value) {
          if (!preventCancel) { try { await reader.cancel(value); } catch (_) { /* ignore */ } }
          try { reader.releaseLock(); } catch (_) { /* ignore */ }
          return { done: true, value };
        },
        [Symbol.asyncIterator]() { return this; },
      };
    };
    Object.defineProperty(RS.prototype, "values", { value: values, configurable: true, writable: true });
    Object.defineProperty(RS.prototype, Symbol.asyncIterator, { value: values, configurable: true, writable: true });
  }

  let pdfjsPromise = null;
  function loadPdfjs(base) {
    addStreamIteration();
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
  // Weighed items (meat, fish: "AP9KG", unit RW or EA) are priced per kg; the
  // real weight is on the next row ("Total Net Weight of 10.200kg"), so that
  // weight becomes the quantity (in kg).
  // Columns: category, code, brand, description, pack, per, unit, qty, price,
  // line total (ex GST), GST, total. Weighed items (unit RW) are per kg.
  const moco = {
    supplier: "MOCO Food Services",
    test: t => /Acct #:/.test(t) && /Total Invoice:/.test(t) && /Total Net:/.test(t),
    read(pages) {
      const lines = [];
      for (const rows of pages) for (const r of rows) {
        const rt = rowText(r);
        if (/Total Net Weight of/i.test(rt)) {
          const m = rt.match(/Total Net Weight of\s*([\d.]+)\s*kg/i);
          const last = lines[lines.length - 1];
          if (m && last && last.code && Number(m[1]) > 0) { last.qty = Number(m[1]); last.unit = "kg"; last.weighed = true; }
          continue;
        }
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
      // No weight row printed but priced per kg: the weight is total / price.
      for (const l of lines) {
        if (l.weighed || !l.code || !(l.unit_price > 0) || l.qty == null) continue;
        if (/\bAP\s?\d/i.test(l.description) && Math.abs(l.qty * l.unit_price - l.line_total) > 0.05) {
          l.qty = Math.round(l.line_total / l.unit_price * 1000) / 1000; l.unit = "kg";
        }
      }
      lines.forEach(l => delete l.weighed);
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
  // Some of these PDFs print two cells as one piece of text: the unit with the
  // item code ("Carton 33941990") or the unit with the price ("Carton $165.00").
  // Split them back into their columns so the row is not skipped.
  function splitGlobalFoodCells(rows) {
    for (const r of rows) {
      const out = [];
      for (const it of r.items) {
        let m;
        if (it.x >= 75 && it.x < 115 && (m = it.s.match(/^(\S+(?: \[\d+\])?)\s+(\d{6,})$/))) {
          out.push({ ...it, s: m[1] }, { ...it, s: m[2], x: 123 });
        } else if (it.x >= 440 && it.x < 480 && (m = it.s.match(/^(\S+(?: \[\d+\])?)\s+(\$[\d,]+\.\d{2})$/))) {
          out.push({ ...it, s: m[1] }, { ...it, s: m[2], x: 494 });
        } else out.push(it);
      }
      r.items = out.sort((a, b) => a.x - b.x);
    }
    return rows;
  }

  const globalFood = {
    supplier: "Global Food and Wine (Gulli)",
    test: t => /Global Food and Wine/.test(t) && /Payment due by/.test(t),
    read(pages) {
      const lines = [];
      let gst = 0;
      let carry = null; // last item of the previous page, if its name runs on
      let number = null, date = null;
      for (const rows of pages) {
        splitGlobalFoodCells(rows);
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

  // Gulli Food Distributors (Global Food and Wine renamed itself Gulli in Oct
  // 2026): tax invoices and credit notes from the same system. Columns are found
  // from the header row of each page ("Item … Qty/Quantity … Units … Rate/Price
  // … Amount … WET … GST … Total/Gross $"), so a moved column still reads.
  // Quantities are in the printed unit: "1 Ctn [5] × 200.00" is one carton of 5
  // at $200 a carton. Cartons are stored as single units ("5 Ctn [5] × 40.00"),
  // like the older Global Food and Wine invoices, so prices stay comparable
  // across both layouts. Wine tax (WET) is part of the line total (ex GST).
  // Item names wrap onto the next row. Credit notes are stored as negative.
  const GULLI_COLS = [
    ["item", /^Item$/], ["brand", /Brand$/], ["status", /^Status$/], ["qty", /^(Qty|Quantity)$/],
    ["units", /^Units$/], ["rate", /^(Rate|Price)$/], ["crs", /^CRS$/], ["amount", /^Amount$/],
    ["wet", /^WET$/], ["gst", /^GST$/], ["total", /^(Total|Gross \$)$/],
  ];
  function gulliRead(pages, credit) {
    const lines = [];
    let last = null;
    for (const rows of pages) {
      const hi = rows.findIndex(r => r.items.some(i => i.s === "Item") && r.items.some(i => /^(Qty|Quantity)$/.test(i.s)));
      if (hi < 0) continue;
      const cols = [];
      for (const it of rows[hi].items) {
        const c = GULLI_COLS.find(([, re]) => re.test(it.s));
        if (c) cols.push({ key: c[0], x: it.x });
      }
      // Each word goes to the nearest column heading (numbers sit right-aligned
      // under their heading, text left-aligned).
      const cellsOf = r => {
        const out = {};
        for (const it of r.items) {
          let best = null;
          for (const c of cols) if (!best || Math.abs(c.x - it.x) < Math.abs(best.x - it.x)) best = c;
          if (best) out[best.key] = out[best.key] ? `${out[best.key]} ${it.s}` : it.s;
        }
        return out;
      };
      for (const r of rows.slice(hi + 1)) {
        const t = rowText(r);
        if (/^(Subtotal|Subject to|Claims or returns|NEW BANK DETAILS)/.test(t) || r.items.some(i => /^(Subtotal|Page:)/.test(i.s))) break;
        const c = cellsOf(r);
        const m = String(c.item || "").match(/^(\d{6,})\s+(.*)$/);
        const amount = money(c.amount);
        if (m && amount != null) {
          const rate = money(c.rate);
          let qty = num(c.qty);
          // Quantity a few points lower than the rest of the row: take it from
          // the next row (below); until then amount / rate.
          const qtyBelow = qty == null;
          if (qty == null && rate) qty = r2(amount / rate);
          let unit = String(c.units || "").trim();
          let unitPrice = rate;
          const pack = unit.match(/^c(?:tn|arton)s?\s*\[(\d+)\]$/i);
          if (pack && Number(pack[1]) > 1 && qty != null && rate != null) {
            const n = Number(pack[1]);
            qty = r2(qty * n);
            unitPrice = Math.round(rate / n * 10000) / 10000;
          }
          const sign = credit ? -1 : 1;
          last = {
            code: m[1], name: [m[2]], qty, unit, unit_price: unitPrice, qtyBelow, packN: pack ? Number(pack[1]) : 1,
            line_total: sign * r2(amount + (money(c.wet) || 0)),
            gst: sign * (money(c.gst) || 0),
            brand: String(c.brand || "").trim(),
          };
          lines.push(last);
        } else if (last && amount == null) {
          if (c.item && !m) last.name.push(c.item);           // name continues on this row
          const q = num(c.qty);
          if (q != null && last.qtyBelow) { last.qty = r2(q * (last.packN > 1 ? last.packN : 1)); last.qtyBelow = false; }
        }
      }
    }
    for (const l of lines) {
      l.description = l.name.join(" ").replace(/\s+/g, " ").trim() + (credit && l.brand ? ` · ${l.brand}` : "");
      delete l.name; delete l.brand; delete l.qtyBelow; delete l.packN;
    }
    return lines;
  }
  const after = (pages, label) => String(valueAfter(pages, label) || "").replace(/^[:\s]+/, "").trim();

  const gulliInvoice = {
    supplier: "Global Food and Wine (Gulli)",   // same name as before, so price history continues
    test: t => /Gulli Food Distributors/.test(t) && /Tax Invoice/.test(t) && /Amount Due/.test(t),
    read(pages) {
      const lines = gulliRead(pages, false);
      const shipping = money(valueAfter(pages, "Shipping Cost"));
      const gst = money(valueAfter(pages, "GST Total")) ?? 0;
      if (shipping) {
        const lineGst = r2(lines.reduce((a, l) => a + (l.gst || 0), 0));
        lines.push({ code: "DELIVERY", description: "Delivery Fee", qty: 1, unit: "EA", unit_price: shipping,
          line_total: shipping, gst: Math.max(0, r2(gst - lineGst)) });
      }
      const sub = money(valueAfter(pages, "Subtotal")), wet = money(valueAfter(pages, "WET Total")) || 0;
      return {
        number: after(pages, "Invoice Number") || null,
        date: isoDate(after(pages, "Date")),
        kind: "invoice",
        lines,
        subtotal: sub == null ? null : r2(sub + wet + (shipping || 0)),
        gst,
        total: money(valueAfter(pages, "Amount Due")),
      };
    },
  };

  const gulliCredit = {
    supplier: "Global Food and Wine (Gulli)",
    test: t => /Gulli Food Distributors/.test(t) && /Credit Note/.test(t),
    read(pages) {
      const lines = gulliRead(pages, true);
      const sub = money(valueAfter(pages, "Subtotal")), wet = money(valueAfter(pages, "WET Total")) || 0;
      return {
        number: after(pages, "Document Number") || null,
        date: isoDate(after(pages, "Date")),
        kind: "credit",
        lines,
        subtotal: sub == null ? null : -r2(sub + wet),
        gst: -(money(valueAfter(pages, "GST Total")) || 0),
        total: -(money(valueAfter(pages, "Total")) || 0),
      };
    },
  };

  // HTC Foods (seafood; "Fishman foods & HTC Foods"). One row per item with the
  // line number, code, description, cartons, quantity + unit ("10 pk"), price
  // with the tax code in one cell ("$16.95 FRE" / "$3.00 GST") and the line
  // total including GST. The description can continue on the next row(s)
  // ("(10 x 700g) Viet TASTY"); "Imported" under the code is the origin.
  // Line totals are stored ex GST (price x quantity), like the other suppliers.
  const htc = {
    supplier: "HTC Foods (seafood)",
    test: t => /HTC Foods/.test(t) && /TAX INVOICE/.test(t) && /Invoice Total/.test(t),
    read(pages) {
      const lines = [];
      let number = null, date = null;
      for (const rows of pages) {
        let last = null, inTable = false;
        for (const r of rows) {
          const rt = rowText(r);
          if (!number) { const m = rt.match(/TAX INVOICE\s+(\S+)/); if (m) number = m[1]; }
          if (!date) { const m = rt.match(/\bDate\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\b/); if (m) date = isoDate(m[1]); }
          if (/^Code\b/.test(rt) && /Description/.test(rt) && /Total/.test(rt)) { inTable = true; last = null; continue; }
          if (!inTable) continue;
          if (/How to pay|Subtotal/.test(rt)) { inTable = false; last = null; continue; }
          const n = firstIn(r, 20, 37), priceCell = textIn(r, 455, 525), totalCell = firstIn(r, 525, 600);
          const pm = priceCell.match(/^\$?(-?[\d,]*\.?\d+)\s*([A-Z]{3})?$/);
          if (n && /^\d+$/.test(n) && pm && money(totalCell) != null) {
            const qtyCell = textIn(r, 415, 455), ctnCell = textIn(r, 375, 415);
            const qm = (qtyCell || ctnCell).match(/^(-?[\d.]+)\s*([A-Za-z]*)$/);
            const price = money(pm[1]), qty = qm ? Number(qm[1]) : 1, inc = money(totalCell);
            const unit = qtyCell && qm ? qm[2] : "";   // charges (fuel levy) have no quantity
            const ex = r2(price * qty);
            last = {
              code: textIn(r, 37, 127),
              description: textIn(r, 127, 375),
              qty,
              unit,
              unit_price: price,
              // Printed total includes GST; when it does not match price x qty, trust the printed one.
              line_total: pm[2] === "GST" ? r2(inc / 1.1) : (Math.abs(ex - inc) <= 0.02 ? ex : inc),
              gst: pm[2] === "GST" ? r2(inc - r2(inc / 1.1)) : 0,
            };
            lines.push(last);
          } else if (last && r.items.length && r.items.every(i => (i.x >= 127 && i.x < 375) || (i.x < 127 && /^(Imported|Australian|Australia|Local|[A-Z][a-z]+)$/.test(i.s)))) {
            const extra = textIn(r, 127, 375);
            if (extra) last.description += " " + extra;
          } else if (r.items.length) {
            last = null;
          }
        }
      }
      // Price per pack: "(10 x 700g)" is the carton; the price is for one 700 g pack.
      for (const l of lines) {
        const m = l.description.match(/\(\s*(\d+)\s*x\s*(\d+(?:\.\d+)?\s*(?:kg|g|l|ml))\s*\)?/i)
          || l.description.match(/\(\s*(\d+)\s*\r?\n?\s*x\s*(\d+(?:\.\d+)?\s*(?:kg|g|l|ml))/i);
        if (m && /^(pk|pkt|pack|ea|each|bag)$/i.test(l.unit)) {
          l.unit = `${l.unit} ${m[2].replace(/\s+/g, "")}`;
          // Keep the carton in the name, but so the cost per kg reads the pack, not the carton.
          l.description = l.description.replace(m[0], m[0].replace(/\s*x\s*/i, " × "));
        }
      }
      return {
        number,
        date,
        kind: "invoice",
        lines,
        subtotal: money(valueAfter(pages, "Subtotal")),
        gst: money(valueAfter(pages, "GST")),
        total: money(valueAfter(pages, "Invoice Total")),
      };
    },
  };

  // Rivercity Wholesale Liquor (drinks, Floor). Columns: code, description, qty,
  // base price, discount, net price, total ex GST and WET, WET/GST-free flag.
  // Each column is read from its heading, so the quantity is never taken for a
  // price ("4.00 × 50.06", not "50.06 × 4.00"). "(24)" in the name is a carton
  // of 24; the rest are single bottles or casks. WET and GST are one amount at
  // the bottom; line totals are ex both. The fuel levy is a line.
  const rivercity = {
    supplier: "Rivercity Wholesale Liquor",
    test: t => /Rivercity Wholesale Liquor/i.test(t) && /TAX INVOICE/i.test(t) && /\bQty\b/.test(t) && /Net\s*Price/i.test(t),
    read(pages) {
      const lines = [];
      let number = null, date = null, subtotal = null, gst = null, total = null;
      const NUM = /^-?[\d,]*\d\.\d{2}$/;
      for (const rows of pages) {
        let head = null;
        for (const r of rows) {
          const rt = rowText(r);
          if (!number) { const m = rt.match(/\b(SI-\d+)\b/); if (m) number = m[1]; }
          if (!date) { const m = rt.match(/Invoice\s*Date:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i); if (m) date = isoDate(m[1]); }
          const ws = splitWords(r).flatMap(w => w.s.includes(" ") && !NUM.test(w.s) ? splitItem(w) : [w]);
          if (!head && /\bCode\b/.test(rt) && /\bDescription\b/.test(rt) && /\bQty\b/.test(rt)) {
            const at = re => ws.find(w => re.test(w.s))?.x;
            const net = ws.find((w, k) => /^Net$/i.test(w.s) || /^Net\s*Price$/i.test(w.s));
            head = { desc: at(/^Description$/i), qty: at(/^Qty$/i), net: net?.x };
            continue;
          }
          if (!head) continue;
          if (/Sub\s*Total/i.test(rt) && !/Charges/i.test(rt)) { const m = ws.filter(w => NUM.test(w.s)).pop(); if (m) subtotal = money(m.s); head = { ...head, done: true }; continue; }
          if (/WET\s*&\s*GST/i.test(rt)) { const m = ws.filter(w => NUM.test(w.s)).pop(); if (m) gst = money(m.s); continue; }
          if (/Invoice\s*Total/i.test(rt)) { const m = ws.filter(w => NUM.test(w.s)).pop(); if (m) total = money(m.s); continue; }
          if (/^Fuel\s*Levy\b/i.test(rt)) { const m = ws.filter(w => NUM.test(w.s)).pop(); if (m) lines.push({ code: "", description: "Fuel Levy", qty: 1, unit: "", unit_price: money(m.s), line_total: money(m.s), gst: 0 }); continue; }
          if (head.done) continue;
          const nums = ws.filter(w => NUM.test(w.s));
          if (nums.length < 3) continue;
          const near = x => nums.reduce((b, w) => (Math.abs(w.x - x) < Math.abs(b.x - x) ? w : b));
          const qtyW = near(head.qty), netW = head.net != null ? near(head.net) : nums[nums.length - 2], totW = nums[nums.length - 1];
          if (qtyW === totW || netW === totW || qtyW === netW) continue;
          const words = ws.filter(w => w.x < head.qty - 12);
          const code = words[0] && words[0].x < head.desc - 5 ? words[0].s : "";
          const description = words.filter(w => w.x >= head.desc - 5).map(w => w.s).join(" ").replace(/\s+/g, " ").trim();
          if (!description) continue;
          lines.push({ code, description, qty: num(qtyW.s), unit: /\(\s*\d+\s*\)/.test(description) ? "ctn" : "ea", unit_price: money(netW.s), line_total: money(totW.s), gst: 0 });
        }
      }
      if (total != null && gst != null) subtotal = r2(total - gst);
      return { number, date, kind: "invoice", lines, subtotal, gst, total };
    },
  };

  // Gulli Food Distributors, new layout (from Nov 2026, invoice "CI-484677"):
  // order qty, unit, item code, item name, ship qty, unit, unit price, taxes,
  // line total (with tax). Long codes and names wrap onto the rows just above
  // and below the row with the numbers.
  const gulliNew = {
    supplier: "Global Food and Wine (Gulli)",   // same name as before
    test: t => /Gulli Food Distributors/.test(t) && /Item code/.test(t) && /Total price includes Taxes/.test(t),
    read(pages) {
      const lines = [];
      let number = null, date = null, total = null;
      for (const rows of pages) {
        const head = rows.find(r => r.items.some(i => /^CI-\d+$/.test(i.s)));
        if (head && !number) {
          const i = head.items.findIndex(x => /^CI-\d+$/.test(x.s));
          number = head.items[i].s; date = isoDate(head.items.slice(i + 1).map(x => x.s).join(" ")) || date;
        }
        const top = rows.findIndex(r => r.items.some(i => i.s === "Item name"));
        const end = rows.findIndex(r => /Total price includes Taxes/.test(rowText(r)));
        const tot = rows.find(r => r.items.some(i => i.s === "Total") && r.items.some(i => money(i.s) != null));
        if (tot && total == null) total = money(tot.items.find(i => money(i.s) != null).s);
        if (top < 0) continue;
        const body = rows.slice(top + 1, end < 0 ? rows.length : end).filter(r => !/^(qty\.|Order|Ship|Line|total)$/.test(rowText(r)) && !/^qty\./.test(rowText(r)));
        // Column edges from the header: the item name column moves with the
        // length of the names (seen at x 190 and x 214).
        const hdr = rows[top];
        const nameX = (hdr.items.find(i => i.s === "Item name")?.x ?? 214) - 3;
        const shipX = (rows.slice(Math.max(0, top - 2), top + 1).flatMap(r => r.items).find(i => i.s === "Ship")?.x ?? 398) - 5;
        const isAnchor = r => /^\d+(\.\d+)?$/.test(firstIn(r, 25, 60) || "") && money(firstIn(r, 520, 600)) != null;
        const anchors = body.filter(isAnchor);
        const extra = new Map(anchors.map(a => [a, { above: [], below: [] }]));
        for (const r of body) {
          if (isAnchor(r)) continue;
          let best = null;
          for (const a of anchors) if (!best || Math.abs(a.y - r.y) < Math.abs(best.y - r.y)) best = a;
          if (best && Math.abs(best.y - r.y) < 18) extra.get(best)[r.y < best.y ? "above" : "below"].push(r);
        }
        for (const a of anchors) {
          const e = extra.get(a);
          const part = (rs, x0, x1) => rs.map(r => textIn(r, x0, x1)).filter(Boolean);
          let code = [...part(e.above, 100, nameX), textIn(a, 100, nameX), ...part(e.below, 100, nameX)].filter(Boolean).join("");
          let description = [...part(e.above, nameX, shipX), textIn(a, nameX, shipX), ...part(e.below, nameX, shipX)].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
          // The name starts with the code in brackets: "[BCPARM01-UC8] Big Cheese..."
          description = description.replace(/^\[[^\]]*\]\s*/, "") || code;
          const ship = num(firstIn(a, shipX, shipX + 40)), ordered = num(firstIn(a, 25, 60));
          const unit = textIn(a, 435, 462) || textIn(a, 60, 100);
          const monies = inX(a, 462, 540).flatMap(i => i.s.split(/\s+/)).map(money).filter(v => v != null);
          const inc = money(firstIn(a, 520, 600));
          const price = monies[0], tax = monies.length > 1 ? monies[1] : 0;
          if (price == null || inc == null) continue;
          if (/^DELIVERY/i.test(code)) { code = "DELIVERY"; description = "Delivery Fee"; }
          lines.push({ code, description, qty: ship ?? ordered ?? 1, unit, unit_price: price, line_total: r2(inc - tax), gst: r2(tax) });
        }
      }
      const gst = r2(lines.reduce((a, l) => a + (l.gst || 0), 0));
      return { number, date, kind: "invoice", lines, subtotal: r2(lines.reduce((a, l) => a + l.line_total, 0)), gst, total };
    },
  };

  /* ---------- any other supplier (no reader written for it) ----------
     Finds the table by its titles (Description / Item ... Total / Amount),
     takes the right-most amount on each row as the line total, the invoice
     number, the date and the totals from their labels, and a supplier name
     from the top of the page. The lines must add up to the printed total, as
     for the other readers, so the manager sees when something was missed. */
  const DESC_RE = /^(description|item name|item description|product|product description|products|item|items|particulars|details|goods)$/i;
  const AMOUNT_RE = /^(line )?(total|amount|ext\.?|extended|value|line total|total price|amount \(?aud\)?|total inc\.?( gst)?|total \(inc\.? gst\)|amount inc\.? gst)$/i;
  const PRICE_RE = /^(unit )?(price|rate|each|cost)( ex\.?( gst)?)?$/i;
  const TAX_RE = /^(tax|taxes|gst|gst amount|tax amount)$/i;
  const STOP_RE = /^(sub ?-?total|total|totals|grand total|amount due|balance due|invoice total|total due|total amount|total inc|total ex|gst|freight|net total|total price includes taxes)\b/i;
  const NOT_NAME_RE = /marinara|credit|note|memo|tax\b|remittance|invoice|statement|receipt|date|page|abn|acn|tel\b|phone|fax|mobile|email|@|www\.|\.com|\bpo box\b|street|\bst\b|\brd\b|road|avenue|\bave\b|drive|\bdr\b|\bnumber\b|due|order|customer|account|bsb|bill to|sold to|ship to|deliver|^\d/i;
  const moneyIn = s => {
    const m = String(s).match(/^\(?-?\$?\s?-?[\d,]*\.\d{2}\)?$/);
    if (!m) return null;
    const v = money(String(s).replace(/[()]/g, ""));
    return v == null ? null : (/^\(.*\)$/.test(s) ? -Math.abs(v) : v);
  };
  // One text piece can hold several columns ("$16.95 FRE", "Price Tax"): split
  // it into words, each at about where it is printed.
  const splitItem = i => {
    if (!/\s/.test(i.s)) return [i];
    const out = []; const re = /\S+/g; let m;
    while ((m = re.exec(i.s))) out.push({ s: m[0], x: Math.round(i.x + m.index * 4.4) });
    return out;
  };
  const splitWords = r => r.items.flatMap(i => /\$?[\d,]*\.\d{2}\b/.test(i.s) ? splitItem(i) : [i]);
  const HEAD_WORD = /^(price|rate|tax|taxes|gst|total|amount|qty|quantity|unit|units|ctns|code)$/i;
  const splitHead = i => { const w = i.s.trim().split(/\s+/); return w.length > 1 && w.every(x => HEAD_WORD.test(x)) ? splitItem(i) : [i]; };
  function findDate(s) {
    const t = String(s || "");
    let m = t.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4}|\d{2})\b/);
    if (m) return isoDate(`${m[1]}/${m[2]}/${m[3]}`);
    m = t.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = t.match(/(\d{1,2})(?:st|nd|rd|th)?[\s\-]+([A-Za-z]{3,9})[\s\-,]+(\d{4})/);
    if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return isoDate(`${m[1]} ${m[2].slice(0, 3)} ${m[3]}`);
    m = t.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
    if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return isoDate(`${m[2]} ${m[1].slice(0, 3)} ${m[3]}`);
    return null;
  }
  // The value of a label: the rest of the same word, the next word on the
  // row, or the word just below it.
  function labelValue(rows, re, ok) {
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k];
      for (let i = 0; i < r.items.length; i++) {
        const it = r.items[i];
        const m = it.s.match(re);
        if (!m) continue;
        const rest = it.s.slice(m.index + m[0].length).replace(/^[\s:#.\-]+/, "").trim();
        const tries = [rest, ...r.items.slice(i + 1, i + 3).map(x => x.s.replace(/^[:#\s]+/, ""))];
        for (let d = 1; d <= 3 && k + d < rows.length; d++) {
          if (rows[k + d].y - r.y > 30) break;
          const below = rows[k + d].items.find(x => Math.abs(x.x - it.x) <= 20);
          if (below) tries.push(below.s);
        }
        for (const v of tries) { const got = ok(v); if (got) return got; }
      }
    }
    return null;
  }
  const generic = {
    supplier: null,
    test: () => true,
    read(pages) {
      const lines = [];
      let total = null, gst = null, subtotal = null, supplier = null, taxIncluded = false;
      const all = allRows(pages);
      const text = all.map(rowText).join("\n");
      const number = labelValue(all, /(tax invoice|invoice)\s*(no\.?|number|num|#)?\s*:?/i,
        v => { const w = String(v).trim().split(/\s+/)[0] || ""; return /\d/.test(w) && w.length >= 3 && !findDate(w) && moneyIn(w) == null && !/^\d{1,2}$/.test(w) ? w.replace(/[:#]$/, "") : null; })
        || labelValue(all, /(inv\.?|document|reference|ref)\s*(no\.?|number|#)\s*:?/i, v => { const w = String(v).trim().split(/\s+/)[0] || ""; return /\d/.test(w) && w.length >= 3 && !findDate(w) ? w : null; });
      const date = labelValue(all, /(invoice date|tax date|date of invoice|date)\s*:?/i, findDate) || findDate(text);
      taxIncluded = /(prices?|total|amounts?)[^\n]{0,20}(include|includes|including|inc\.?)\s+(gst|tax)/i.test(text);
      for (const rows of pages) {
        // Supplier: the first line of words at the top of the first page that is not an address, a phone, a label.
        if (!supplier) {
          const maxY = Math.max(...rows.map(r => r.y));
          const cands = rows.filter(r => r.y <= maxY * 0.3).flatMap(r => r.items.map(i => i.s.trim()))
            .filter(s => /[A-Za-z]{3}/.test(s) && !/^[A-Z]{1,5}[\-\/]?\d/.test(s) && (s.match(/\d/g) || []).length < 3 && s.length >= 3 && s.length <= 60
              && !NOT_NAME_RE.test(s) && !/:/.test(s) && !/^(to|from|attention|attn|ship|australia|document|number|reference|terms|page)\b/i.test(s));
          const COMPANY = /\b(foods?|pty|ltd|produce|distributors?|wholesale|wholesalers|meats?|seafoods?|fish|bakery|bakehouse|wines?|beverages?|fruit|veg|vegetables|dairy|supplies|supply|services|trading|group|imports?|packaging|butchers?|cheese|coffee|liquor|cellars?)\b|&/i;
          const cand = cands.find(s => COMPANY.test(s)) || cands.find(s => /\s/.test(s));
          if (cand) supplier = cand.replace(/\s+-\s+(queensland|qld|brisbane|nsw|new south wales|victoria|vic)$/i, "").replace(/\s+(pty\.?\s*ltd\.?|p\/l|limited)$/i, "").trim();
        }
        const top = rows.findIndex(r => r.items.some(i => DESC_RE.test(i.s.trim())) && rows.some(o => Math.abs(o.y - r.y) <= 14 && o.items.some(i => AMOUNT_RE.test(i.s.trim()) || /total$/i.test(i.s.trim()))));
        if (top >= 0) {
          const band = rows.filter(r => Math.abs(r.y - rows[top].y) <= 14);
          const head = band.flatMap(r => r.items).flatMap(splitHead).sort((a, b) => a.x - b.x);
          // "Description" or "Item name" before a plain "Item" (often the code column).
          const desc = head.find(i => DESC_RE.test(i.s.trim()) && !/^items?$/i.test(i.s.trim())) || head.find(i => DESC_RE.test(i.s.trim()));
          const amountItems = head.filter(i => AMOUNT_RE.test(i.s.trim()) || /total$/i.test(i.s.trim()));
          const amount = amountItems[amountItems.length - 1];
          const price = head.find(i => PRICE_RE.test(i.s.trim()) || /\bprice$/i.test(i.s.trim()));
          const tax = head.find(i => TAX_RE.test(i.s.trim()));
          const codeH = head.find(i => /^(code|item code|product code|sku|item|item no\.?|part no\.?|stock code)$/i.test(i.s.trim()) && i.x < desc.x - 5);
          const after = head.filter(i => i.x > desc.x + 20).map(i => i.x);
          const descEnd = after.length ? Math.min(...after) - 3 : 9999;
          const bandEnd = Math.max(...band.map(r => r.y));
          let end = rows.findIndex((r, k) => r.y > bandEnd && r.items.some(i => STOP_RE.test(i.s.trim())) && !r.items.some(i => i.x >= desc.x - 5 && i.x < descEnd && !STOP_RE.test(i.s.trim()) && /[a-z]{3}/i.test(i.s)));
          if (end < 0) end = rows.length;
          const body = rows.filter((r, k) => r.y > bandEnd && k < end);
          const moneyOf = r => splitWords(r).map(i => ({ ...i, v: moneyIn(i.s) })).filter(i => i.v != null);
          const isAnchor = r => { const ms = moneyOf(r); return ms.length > 0 && ms[ms.length - 1].x >= amount.x - 60; };
          const anchors = body.filter(isAnchor);
          const extra = new Map(anchors.map(a => [a, { above: [], below: [] }]));
          for (const r of body) {
            if (isAnchor(r)) continue;
            let best = null;
            for (const a of anchors) if (!best || Math.abs(a.y - r.y) < Math.abs(best.y - r.y)) best = a;
            if (best && Math.abs(best.y - r.y) <= 16) extra.get(best)[r.y < best.y ? "above" : "below"].push(r);
          }
          const descFrom = Math.min(desc.x, ...anchors.map(a => (inX(a, desc.x - 40, desc.x + 5)[0]?.x ?? desc.x))) - 3;
          for (const a of anchors) {
            const e = extra.get(a);
            const col = (x0, x1) => [...e.above, a, ...e.below].map(r => textIn(r, x0, x1)).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
            let description = col(descFrom, descEnd).replace(/^\[[^\]]*\]\s*/, "");
            let code = codeH ? col(codeH.x - 5, descFrom).split(/\s+/).find(w => /^[A-Za-z0-9][\w\-\/.]{2,}$/.test(w) && (/\d/.test(w) || /^[A-Z_\-]{3,}$/.test(w)) && !/^\d{1,3}$/.test(w)) || "" : "";
            const ms = moneyOf(a);
            const line_total = ms[ms.length - 1].v;
            // Each other amount goes to the nearest of the Price and Tax titles.
            const rest = ms.slice(0, -1);
            const near = (m, h) => (h ? Math.abs(m.x - h.x) : 1e9);
            const priceM = price ? rest.find(m => near(m, price) <= 40 && near(m, price) <= near(m, tax)) : (rest.length ? rest[0] : null);
            const taxM = tax ? rest.find(m => m !== priceM && near(m, tax) <= 30 && near(m, tax) < near(m, price)) : null;
            const unit_price = priceM ? priceM.v : null;
            const taxV = taxM ? taxM.v : null;
            // A tax column with words instead of amounts: "GST" (taxed) or "FRE" (free).
            const taxFlag = tax ? splitWords(a).some(w => Math.abs(w.x - tax.x) <= 25 && /^(gst|y|yes|tax|t)$/i.test(w.s)) : false;
            let qty = null;
            if (unit_price) { const q = Math.round((line_total - (taxV || 0)) / unit_price * 1000) / 1000; if (q > 0 && Math.abs(q - Math.round(q * 100) / 100) < 0.001) qty = q; }
            // A product code printed at the start of the name: "30271122 Puopolo Salami".
            if (!code) { const m = description.match(/^(\d{5,}|[A-Z][A-Z0-9_\-\/]{3,}\d[A-Z0-9_\-\/]*)\s+(?=\S)/); if (m) { code = m[1]; description = description.slice(m[0].length); } }
            if (!description) continue;
            lines.push({ code, description, qty, unit: "", unit_price, line_total, gst: 0, _tax: taxV, _taxFlag: taxFlag, _price: unit_price });
          }
        }
        // Charges printed under the table (shipping, freight, fuel levy...) are lines too.
        if (top >= 0) {
          const LABEL = /^(shipping( cost)?|freight|delivery( fee| charge)?|fuel levy|fuel surcharge|cartage|handling( fee)?)$/i;
          for (const r of rows) {
            if (r.y <= rows[top].y) continue;
            const ws = splitWords(r);
            r.items.forEach(it => {
              if (!LABEL.test(it.s.trim())) return;
              const next = ws.filter(w => w.x > it.x);
              if (!next.length || /included|free/i.test(next[0].s)) return;
              const v = moneyIn(next[0].s);
              if (v) lines.push({ code: "", description: it.s.trim().replace(/\b\w/g, c => c.toUpperCase()), qty: 1, unit: "", unit_price: v, line_total: v, gst: 0, _tax: null, _taxFlag: false, _price: v });
            });
          }
        }
        // Totals, from the bottom up: the last label of each kind wins.
        for (const r of rows) {
          const t = rowText(r);
          const ms = moneyOf2(r);
          if (!ms.length) continue;
          const v = ms[ms.length - 1];
          if (/(amount due|balance due|total due|invoice total|grand total|total inc|total \(inc|total amount|total payable|^total\b|\btotal\s*(aud)?\s*\$?[\d,]*\.\d{2}$)/i.test(t) && !/sub ?-?total|total ex|excl|total gst|gst total|total tax|net weight|qty|quantity/i.test(t)) total = v;
          else if (/\b(gst|tax)\b/i.test(t) && !/includ|inc\.|exempt|free|abn|ex gst|excl/i.test(t) && !/^\s*\d+\s/.test(t) && Math.abs(v) < 1e6) gst = v;
          else if (/sub ?-?total|total ex|net total|total excl/i.test(t)) subtotal = v;
        }
      }
      const credit = /credit (note|memo|adjustment)|adjustment note/i.test(all.slice(0, 25).map(rowText).join(" "));
      return finish({ number, date, total, gst, subtotal, supplier, lines, taxIncluded, credit });
    },
  };
  function moneyOf2(r) { return splitWords(r).map(i => moneyIn(i.s)).filter(v => v != null); }
  // Line totals with or without GST: whichever adds up to the printed total.
  function finish({ number, date, total, gst, subtotal, supplier, lines, taxIncluded, credit }) {
    const sum = r2(lines.reduce((a, l) => a + l.line_total, 0));
    const tol = 0.01 * Math.max(1, lines.length);
    if (total == null && subtotal != null) total = r2(subtotal + (gst || 0));
    if (total == null) total = sum;
    if (gst == null) gst = subtotal != null ? r2(total - subtotal) : 0;
    if (Math.abs(sum - total) <= tol && (gst > 0 || lines.some(l => l._tax > 0)) && !(gst > 0 && Math.abs(r2(sum + gst) - total) <= tol)) {
      // The lines include GST: take each line's tax off (from its tax column,
      // or price x quantity when the total is 10% more).
      for (const l of lines) {
        let t = l._tax;
        if (t == null && l._price != null) {
          for (const q of [1, 2, 3, 4, 5, 6, 8, 10, 12, 20, 24]) if (Math.abs(r2(l._price * q * 1.1) - l.line_total) <= 0.02) { t = r2(l.line_total - l._price * q); l.qty = q; break; }
        }
        if (t == null && l._taxFlag) t = r2(l.line_total / 11);
        if (t) { l.gst = r2(t); l.line_total = r2(l.line_total - t); }
      }
      if (gst === 0) gst = r2(lines.reduce((a, l) => a + l.gst, 0));
    }
    for (const l of lines) { delete l._tax; delete l._taxFlag; delete l._price; delete l._extra; }
    // A credit note is stored with negative amounts, like the other readers do.
    const neg = v => (v == null ? v : -Math.abs(v));
    if (credit) { total = neg(total); gst = neg(gst); for (const l of lines) { l.line_total = neg(l.line_total); l.gst = neg(l.gst); } }
    return { number, date, kind: credit ? "credit" : "invoice", lines, total, gst, subtotal: r2(total - gst), supplierGuess: supplier || "", generic: true };
  }

  const READERS = [moco, pronto, angelos, globalFood, gulliInvoice, gulliCredit, gulliNew, htc, rivercity];

  // pages -> invoice, or { error } when the layout is not one we know.
  function parse(pages) {
    const text = allRows(pages).map(rowText).join("\n");
    const reader = READERS.find(rd => rd.test(text)) || generic;
    const inv = reader.read(pages);
    if (reader === generic && !inv.lines.length) return { error: "UNKNOWN_SUPPLIER" };
    inv.supplier = reader.supplier || inv.supplierGuess || "";
    inv.lines = inv.lines.filter(l => l.line_total != null);
    // A line always has a name to save (the server refuses a line without one).
    inv.lines.forEach(l => { if (!l.description) l.description = l.code || "Item"; });
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
    // Each line on its own: a quantity like "50.06" cartons, or price x quantity
    // far from the line total, means the columns were probably read wrong.
    let odd = 0;
    for (const l of inv.lines) {
      const why = lineProblem(l, reader === generic);
      if (why) { l.check = why; odd++; } else delete l.check;
    }
    inv.checks.lines_look_right = odd === 0;
    inv.odd_lines = odd;
    inv.ok = Object.values(inv.checks).every(Boolean);
    return inv;
  }
  // Why a line looks wrong, or "" when it looks fine.
  const WEIGHED = /(^|\s)(kg|kgs|g|gm|gr|l|lt|ltr|litre|ml|rw)(\s|$)/i;
  function lineProblem(l, generic) {
    if (/fuel|freight|delivery|levy|surcharge|charge/i.test(l.description || "")) return "";
    const qty = l.qty == null ? null : Math.abs(Number(l.qty)), price = l.unit_price == null ? null : Math.abs(Number(l.unit_price)), tot = Math.abs(Number(l.line_total) || 0);
    if (qty == null || !(qty > 0)) return "No quantity read";
    if (price == null || !(price > 0)) return "No price read";
    const frac = Math.round((qty % 1) * 100) / 100;
    if (!WEIGHED.test(l.unit || "") && ![0, 0.25, 0.5, 0.75].includes(frac)) return `Quantity ${qty}? Check the quantity and the price`;
    if (generic) {
      const p = qty * price, near = (a, b) => Math.abs(a - b) <= Math.max(0.05, b * 0.02);
      if (!near(p, tot) && !near(p * 1.1, tot) && !near(p, tot * 1.1)) return `${qty} × ${price.toFixed(2)} is not ${tot.toFixed(2)}. Check the line`;
    }
    return "";
  }

  async function readPdf(data, base) {
    const pdfjs = await loadPdfjs(base || "./");
    const pages = await extractPages(data, pdfjs);
    return parse(pages);
  }

  /* ---------- ingredient costs: helpers ---------- */

  // What one invoice price most likely buys, read from the product line:
  // "CREAM THICKENED · 5LT" -> 1 x 5 l, "[12x330ml]" -> 12 x 330 ml,
  // "3kg Beef Lasagna" + unit "x 6" -> 6 x 3 kg, "(Qty: 200)" -> 200 x 1 each,
  // weighed items (unit kg) -> 1 x 1 kg. Only a suggestion: the manager checks
  // it, because some suppliers price a whole carton of several packs.
  const UNIT = { kg: "kg", g: "g", gm: "g", gr: "g", l: "l", lt: "l", ltr: "l", litre: "l", ml: "ml", q: "each", pcs: "each", ea: "each" };
  function packGuess(description, unit) {
    const d = String(description || ""), u = String(unit || "").trim().toLowerCase();
    if (u === "kg") return { count: 1, size: 1, unit: "kg" };
    const one = (txt) => {
      const m = String(txt).match(/(\d+(?:\.\d+)?)\s*(kg|gm|gr|g|ltr|lt|litre|l|ml)(?![a-z])/i);
      return m ? { size: Number(m[1]), unit: UNIT[m[2].toLowerCase()] } : null;
    };
    let m = d.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(kg|gm|gr|g|ltr|lt|litre|l|ml)(?![a-z])/i);
    if (m) return { count: Number(m[1]), size: Number(m[2]), unit: UNIT[m[3].toLowerCase()] };
    m = d.match(/\(\s*qty\s*:\s*(\d+)/i) || d.match(/·\s*(\d+)\s*q\s*$/i) || u.match(/^pack\s+(\d+)$/);
    if (m) return { count: 1, size: Number(m[1]), unit: "each" };
    const uSize = one(u);
    if (uSize) return { count: 1, ...uSize };
    const many = u.match(/^x\s*(\d+)$/);
    const parts = d.split("·").map(x => x.trim());
    const size = one(parts[parts.length - 1]) || one(d);
    if (size) return { count: many ? Number(many[1]) : 1, ...size };
    return { count: 1, size: 1, unit: "each" };
  }
  const baseOf = (unit) => (unit === "g" ? "kg" : unit === "ml" ? "l" : unit);
  function perUnit(price, pack) {
    if (price == null || !pack || !(pack.count > 0) || !(pack.size > 0)) return null;
    const qty = pack.count * pack.size / (pack.unit === "g" || pack.unit === "ml" ? 1000 : 1);
    return Math.round(Number(price) / qty * 100) / 100;
  }
  // How well a product line matches an ingredient name (0 = not at all).
  const words = (s) => String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/)
    .filter(w => w.length > 2 && !["the", "and", "with", "for", "fresh"].includes(w))
    .map(w => w.replace(/(es|s)$/, ""));
  function matchScore(name, description) {
    const want = words(name);
    if (!want.length) return 0;
    const have = words(description);
    let score = 0;
    for (const w of want) {
      if (have.includes(w)) score += 2;
      else if (have.some(h => h.startsWith(w) || w.startsWith(h))) score += 1;
    }
    return score / want.length;
  }

  const api = { readGeneric: pages => generic.read(pages), readPdf, extractPages, parse, toRows, isoDate, READERS, packGuess, perUnit, baseOf, matchScore };
  root.MarinaraInvoiceReader = api;
})(typeof window !== "undefined" ? window : globalThis);
