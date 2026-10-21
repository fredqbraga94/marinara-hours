/* Weekly roster PDF, made on the phone. No roster data is sent to any PDF service. */
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

  // A4 landscape, mm. Header band 8-28, info line 34, table from 38.
  const W = 297, L = 10, R = 10;
  const clean = s => String(s ?? '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^\x00-\xFF]/g, '');

  function drawFrame(doc, report, page, pages) {
    doc.setPage(page);
    doc.setFillColor(17); doc.rect(L, 8, W - L - R, 20, 'F');
    if (report.logo) { try { doc.addImage(report.logo, 'PNG', 13, 10.2, 44, 15.8); } catch (_) {} }
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
    doc.text('ROSTER', 64, 17.2);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(200);
    doc.text(clean(report.place).toUpperCase(), 64, 23.2);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(255);
    doc.text(clean(report.week), W - R - 3, 20.5, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(90);
    doc.text(clean(report.legend), L, 33.5, { maxWidth: W - L - R });
    doc.setDrawColor(205); doc.setLineWidth(0.2); doc.line(L, 199, W - R, 199);
    doc.setFontSize(6.5); doc.setTextColor(130);
    doc.text('MARINARA HAWTHORNE', L, 203.2);
    doc.text(`Generated from Marinara Hours · ${page} / ${pages}`, W - R, 203.2, { align: 'right' });
  }

  // report: {place, week, legend, logo, days:[{label, holiday}], groups:[{name, rows:[{name, cells:[7], hours}]}], noHours?}
  // noHours: leave out the Hours column (Floor: no finish times on the PDF).
  function generate(report) {
    const doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
    const head = [[
      { content: 'Name', styles: { halign: 'left' } },
      ...report.days.map(d => ({ content: clean(d.label) + (d.holiday ? '\nPublic holiday' : ''),
                                styles: d.holiday ? { fillColor: [253, 231, 199], textColor: [122, 75, 0] } : {} })),
      ...(report.noHours ? [] : ['Hours']),
    ]];
    const cols = report.noHours ? 8 : 9;
    const body = [];
    report.groups.forEach(g => {
      if (g.name) body.push([{ content: clean(g.name).toUpperCase(), colSpan: cols,
        styles: { fontStyle: 'bold', textColor: 40, fillColor: 232, fontSize: 8 } }]);
      g.rows.forEach(r => body.push([
        { content: clean(r.name), styles: { fontStyle: 'bold' } },
        ...r.cells.map(c => ({ content: clean(c.text),
          styles: c.kind === 'off' ? { textColor: 150 } : c.kind === 'leave' ? { textColor: [91, 75, 168], fontStyle: 'bold' }
            : c.kind === 'work' ? { fontStyle: 'bold' } : {} })),
        ...(report.noHours ? [] : [clean(r.hours)]),
      ]));
    });
    if (!body.length) body.push([{ content: 'No staff on this roster.', colSpan: cols }]);
    doc.autoTable({
      startY: 38,
      margin: { left: L, right: R, top: 38, bottom: 14 },
      head, body,
      theme: 'grid',
      styles: { font: 'helvetica', fontSize: 9, cellPadding: 1.8, halign: 'center', valign: 'middle',
                lineColor: 205, lineWidth: 0.15, textColor: 30, minCellHeight: 8 },
      headStyles: { fillColor: 55, textColor: 255, fontStyle: 'bold', fontSize: 8.5 },
      columnStyles: report.noHours ? { 0: { cellWidth: 46, halign: 'left' } } : { 0: { cellWidth: 46, halign: 'left' }, 8: { cellWidth: 18 } },
      showHead: 'everyPage',
    });
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
    const filename = 'Marinara-Roster-' + clean(report.fileName || 'week').replace(/[^a-zA-Z0-9]+/g, '-') + '.pdf';
    const dialog = document.createElement('dialog');
    dialog.id = 'rosterPdfDialog';
    dialog.style.cssText = 'width:min(440px,92vw);max-height:85dvh;overflow:auto;border:0;border-radius:20px;padding:24px;color:#17211b;background:white;';
    dialog.innerHTML = '<h2 style="margin-top:0">Your roster PDF is ready</h2><p>Share it to send by WhatsApp, email or AirDrop, or save it in Files.</p><button type="button" class="btn primary" id="shareRosterPdf">Share PDF</button><a class="btn secondary" style="display:block;text-align:center;text-decoration:none" id="saveRosterPdf" target="_blank" rel="noopener">Save PDF</a><p role="status" id="rosterPdfStatus"></p><button type="button" class="btn secondary" id="closeRosterPdf">Back to Marinara Hours</button>';
    const save = dialog.querySelector('#saveRosterPdf'); save.href = url; save.download = filename;
    const share = dialog.querySelector('#shareRosterPdf');
    const status = dialog.querySelector('#rosterPdfStatus');
    let file;
    try {
      file = new File([blob], filename, { type: 'application/pdf' });
      share.hidden = !(navigator.share && navigator.canShare?.({ files: [file] }));
    } catch (_) { share.hidden = true; }
    if (share.hidden) status.textContent = 'Use Save PDF to download or open the file in a separate tab. Marinara Hours stays open.';
    share.onclick = async () => {
      share.disabled = true;
      try {
        await navigator.share({ files: [file], title: 'Marinara roster' });
        status.textContent = 'PDF shared.';
      } catch (error) {
        status.textContent = error.name === 'AbortError' ? 'Sharing cancelled. You can try again or save the PDF.' : 'Sharing is unavailable. Use Save PDF instead.';
      } finally { share.disabled = false; }
    };
    function close() {
      dialog.remove(); URL.revokeObjectURL(url); file = null;
      window.removeEventListener('pagehide', close);
      closeCurrent = null;
      document.getElementById('rosterPdfBtn')?.focus();
    }
    closeCurrent = close;
    dialog.querySelector('#closeRosterPdf').onclick = close;
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    window.addEventListener('pagehide', close, { once: true });
    document.body.append(dialog); dialog.showModal();
  }
  window.MarinaraRosterPdf = { open, generate };
})();
