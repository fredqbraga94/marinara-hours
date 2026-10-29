/* Stock order PDF, made on the phone. No stock data is sent to any PDF service. */
(function () {
  let libraries;
  function script(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      const timer = setTimeout(() => finish(new Error('PDF tools took too long to load.')), 15000);
      function finish(error) {
        clearTimeout(timer); el.onload = el.onerror = null;
        if (error) { el.remove(); reject(error); } else resolve();
      }
      el.onload = () => finish();
      el.onerror = () => finish(new Error('PDF tools could not load. Check your connection.'));
      el.src = src; document.head.append(el);
    });
  }
  function load() {
    if (!libraries) libraries = (async () => {
      if (!window.jspdf) await script('./vendor/jspdf.umd.min.js');
      if (!window.jspdf.jsPDF.API.autoTable) await script('./vendor/jspdf.plugin.autotable.min.js');
    })().catch(error => { libraries = null; throw error; });
    return libraries;
  }

  // A4 portrait, mm. Header band 8–28, info line 34, content from 40.
  const W = 210, L = 12, R = 12, BOTTOM = 282;
  // jsPDF's built-in fonts only cover Latin-1: replace the few characters
  // outside it so names never print as garbage.
  const clean = s => String(s ?? '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[✘✱✷∼]/g, '').replace(/[^\x00-\xFF]/g, '');

  function drawFrame(doc, report, page, pages) {
    doc.setPage(page);
    doc.setFillColor(17); doc.rect(L, 8, W - L - R, 20, 'F');
    if (report.logo) { try { doc.addImage(report.logo, 'PNG', 15, 10.2, 44, 15.8); } catch (_) {} }
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
    doc.text('STOCK ORDER', 66, 17.2);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(200);
    doc.text(clean(report.place).toUpperCase(), 66, 23.2);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(255);
    doc.text(clean(report.when), W - R - 3, 23.2, { align: 'right' });
    doc.setFontSize(8); doc.setTextColor(40);
    doc.text(clean(report.status), L, 34);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(110);
    doc.text(clean(report.summary), W - R, 34, { align: 'right' });
    doc.setDrawColor(205); doc.setLineWidth(0.2); doc.line(L, 285, W - R, 285);
    doc.setFontSize(6.5); doc.setTextColor(130);
    doc.text('MARINARA HAWTHORNE', L, 289);
    doc.text(`Marinara Ristorante Cafe · ${page} / ${pages}`, W - R, 289, { align: 'right' });
  }

  // report: {place, when, status, summary, logo, suppliers:[{name, warn, lines:[[item, counted, par, order]]}], notCounted}
  function generate(report) {
    const doc = new window.jspdf.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
    let y = 40;
    if (!report.suppliers.length) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(60);
      doc.text('Everything counted is at par. Nothing to order.', L, y + 6);
    }
    report.suppliers.forEach(sup => {
      if (y > BOTTOM - 25) { doc.addPage(); y = 40; }
      doc.autoTable({
        startY: y,
        margin: { left: L, right: R, top: 40, bottom: 18 },
        head: [[{ content: clean(sup.name), colSpan: 4, styles: { halign: 'left', fontSize: 10.5, fillColor: 55, textColor: 255 } }],
               ['Item', 'Counted', 'Par', 'Order']],
        body: sup.lines.map(r => r.map(clean)),
        theme: 'grid',
        styles: { font: 'helvetica', fontSize: 9, cellPadding: 1.6, lineColor: 215, lineWidth: 0.15, textColor: 30, overflow: 'linebreak' },
        headStyles: { fillColor: 232, textColor: 30, fontStyle: 'bold' },
        columnStyles: { 0: { cellWidth: 92 }, 1: { cellWidth: 28, halign: 'center' }, 2: { cellWidth: 30, halign: 'center' }, 3: { cellWidth: 36, halign: 'right', fontStyle: 'bold' } },
        showHead: 'everyPage',
      });
      y = doc.lastAutoTable.finalY + 2;
      if (sup.warn) {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(122, 75, 0);
        doc.text(clean(sup.warn), L, y + 3.5);
        y += 5;
      }
      y += 5;
    });
    if (report.notCounted) {
      if (y > BOTTOM - 8) { doc.addPage(); y = 40; }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(110);
      doc.text(clean(report.notCounted), L, y + 2);
    }
    const pages = doc.getNumberOfPages();
    for (let page = 1; page <= pages; page++) drawFrame(doc, report, page, pages);
    generate.lastPages = pages;
    return doc.output('blob');
  }

  let closeCurrent;
  async function open(report) {
    await load();
    const blob = generate(report);
    closeCurrent?.();
    const url = URL.createObjectURL(blob);
    const filename = 'Marinara-Stock-Order-' + clean(report.fileDate || 'order').replace(/[^a-zA-Z0-9]+/g, '-') + '.pdf';
    const dialog = document.createElement('dialog');
    dialog.id = 'stockPdfDialog';
    dialog.style.cssText = 'width:min(440px,92vw);max-height:85dvh;overflow:auto;border:0;border-radius:20px;padding:24px;color:#17211b;background:white;';
    dialog.innerHTML = '<h2 style="margin-top:0">Your PDF is ready</h2><p>Share it to send by WhatsApp, email or AirDrop, or save it in Files.</p><button type="button" class="btn primary" id="shareStockPdf">Share PDF</button><a class="btn secondary" style="display:block;text-align:center;text-decoration:none" id="saveStockPdf" target="_blank" rel="noopener">Save PDF</a><p role="status" id="stockPdfStatus"></p><button type="button" class="btn secondary" id="closeStockPdf">Back to the app</button>';
    const save = dialog.querySelector('#saveStockPdf'); save.href = url; save.download = filename;
    const share = dialog.querySelector('#shareStockPdf');
    const status = dialog.querySelector('#stockPdfStatus');
    let file;
    try {
      file = new File([blob], filename, { type: 'application/pdf' });
      share.hidden = !(navigator.share && navigator.canShare?.({ files: [file] }));
    } catch (_) { share.hidden = true; }
    if (share.hidden) status.textContent = 'Use Save PDF to download or open the file in a separate tab. The app stays open.';
    share.onclick = async () => {
      share.disabled = true;
      try {
        // No await before share: keep the fresh tap Safari/iOS requires.
        await navigator.share({ files: [file], title: 'Marinara stock order' });
        status.textContent = 'PDF shared.';
      } catch (error) {
        status.textContent = error.name === 'AbortError' ? 'Sharing cancelled. You can try again or save the PDF.' : 'Sharing is unavailable. Use Save PDF instead.';
      } finally { share.disabled = false; }
    };
    function close() {
      dialog.remove(); URL.revokeObjectURL(url); file = null;
      window.removeEventListener('pagehide', close);
      closeCurrent = null;
      document.getElementById('stockPdfBtn')?.focus();
    }
    closeCurrent = close;
    dialog.querySelector('#closeStockPdf').onclick = close;
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    window.addEventListener('pagehide', close, { once: true });
    document.body.append(dialog); dialog.showModal();
  }
  window.MarinaraStockPdf = { open, generate };
})();
