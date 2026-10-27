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

  const READERS = [moco, pronto, angelos, globalFood, gulliInvoice, gulliCredit];

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

  const api = { readPdf, extractPages, parse, toRows, isoDate, READERS, packGuess, perUnit, baseOf, matchScore };
  root.MarinaraInvoiceReader = api;
})(typeof window !== "undefined" ? window : globalThis);
