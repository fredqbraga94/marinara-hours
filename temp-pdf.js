/* Temperature records PDF, made on the phone (iPhone home-screen apps cannot
   print a page). No data is sent to any PDF service. Same delivery as the
   stock order PDF: Share (print, AirDrop, email, Files) or Save. */
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
  const clean = s => String(s ?? '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^\x00-\xFF]/g, '');
  const RED = [179, 38, 30];

  function frame(doc, report, page, pages, W, H) {
    doc.setPage(page);
    doc.setFillColor(17); doc.rect(10, 8, W - 20, 18, 'F');
    if (report.logo) { try { doc.addImage(report.logo, 'PNG', 13, 9.6, 41, 14.7); } catch (_) {} }
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
    doc.text(clean(report.title), 60, 16.2);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(200);
    doc.text(clean(report.place).toUpperCase(), 60, 22);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(255);
    doc.text(clean(report.when), W - 13, 22, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(70);
    doc.text(clean(report.limits), 10, 31);
    doc.setDrawColor(205); doc.setLineWidth(0.2); doc.line(10, H - 10, W - 10, H - 10);
    doc.setFontSize(6.5); doc.setTextColor(120);
    doc.text(clean(report.foot), 10, H - 6);
    doc.text(`Page ${page} / ${pages}`, W - 10, H - 6, { align: 'right' });
  }

  // week: {title, place, when, limits, foot, logo, days:[label], rows:[{name, sub, cells:[{opening:{t,bad}|null, closing:..}]}], notes:[[day, equipment, time, temp, action, by]]}
  // records: {..., records:[[date, time, what, temp, action, by, bad]]}
  function generate(report) {
    const week = report.kind === 'week';
    const doc = new window.jspdf.jsPDF({ orientation: week ? 'landscape' : 'portrait', unit: 'mm', format: 'a4', compress: true });
    const W = week ? 297 : 210, H = week ? 210 : 297;
    const base = { font: 'helvetica', fontSize: 8.5, cellPadding: 1.4, lineColor: 120, lineWidth: 0.2, textColor: 20, valign: 'middle', overflow: 'linebreak' };
    const margin = { left: 10, right: 10, top: 35, bottom: 14 };
    if (week) {
      const body = [];
      for (const r of report.rows) {
        for (const slot of ['opening', 'closing']) {
          const row = [];
          if (slot === 'opening') row.push({ content: `${clean(r.name)}\n${clean(r.sub)}`, rowSpan: 2, styles: { fontStyle: 'bold', valign: 'middle' } });
          row.push(slot === 'opening' ? 'Opening' : 'Closing');
          for (const c of r.cells) {
            const v = c[slot];
            row.push(v ? { content: clean(v.t), styles: v.bad ? { textColor: RED, fontStyle: 'bold' } : {} } : '');
          }
          body.push(row);
        }
      }
      doc.autoTable({
        startY: 35, margin, theme: 'grid', styles: { ...base, halign: 'center' },
        head: [['Equipment', 'Time', ...report.days.map(clean)]],
        headStyles: { fillColor: 17, textColor: 255, fontStyle: 'bold', halign: 'center' },
        columnStyles: { 0: { cellWidth: 46, halign: 'left' }, 1: { cellWidth: 20, halign: 'left', textColor: 90 } },
        body, rowPageBreak: 'avoid',
      });
      let y = doc.lastAutoTable.finalY + 6;
      if (y > H - 30) { doc.addPage(); y = 35; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(20);
      doc.text('Notes - readings outside the safe range and what was done', 10, y);
      if (report.notes.length) {
        doc.autoTable({
          startY: y + 2, margin, theme: 'grid', styles: base,
          head: [['Day', 'Equipment', 'Time', 'Temp', 'Action taken', 'Checked by']],
          headStyles: { fillColor: 232, textColor: 20, fontStyle: 'bold' },
          columnStyles: { 3: { textColor: RED, fontStyle: 'bold' }, 4: { cellWidth: 100 } },
          body: report.notes.map(r => r.map(clean)),
        });
      } else {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(90);
        doc.text('None this week.', 10, y + 6);
      }
    } else {
      doc.autoTable({
        startY: 35, margin, theme: 'grid', styles: base,
        head: [['Date', 'Time', 'Check', 'Temp', 'Action taken', 'Checked by']],
        headStyles: { fillColor: 17, textColor: 255, fontStyle: 'bold' },
        columnStyles: { 0: { cellWidth: 26 }, 1: { cellWidth: 16 }, 3: { cellWidth: 16, halign: 'right' }, 4: { cellWidth: 52 } },
        body: report.records.length ? report.records.map(r => r.slice(0, 6).map((x, i) => i === 3 && r[6] ? { content: clean(x), styles: { textColor: RED, fontStyle: 'bold' } } : clean(x)))
                                    : [[{ content: 'No records yet.', colSpan: 6 }]],
        showHead: 'everyPage',
      });
    }
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) frame(doc, report, p, pages, W, H);
    generate.lastPages = pages;
    return doc.output('blob');
  }

  let closeCurrent;
  async function open(report) {
    await load();
    const blob = generate(report);
    closeCurrent?.();
    const url = URL.createObjectURL(blob);
    const filename = 'Marinara-Temperatures-' + clean(report.fileDate || 'records').replace(/[^a-zA-Z0-9]+/g, '-') + '.pdf';
    const dialog = document.createElement('dialog');
    dialog.id = 'tempPdfDialog';
    dialog.style.cssText = 'width:min(440px,92vw);max-height:85dvh;overflow:auto;border:0;border-radius:20px;padding:24px;color:#17211b;background:white;';
    dialog.innerHTML = '<h2 style="margin-top:0">Your PDF is ready</h2><p>Tap Share, then Print to print it, or send it by email or AirDrop, or save it in Files.</p><button type="button" class="btn primary" id="shareTempPdf">Share or print PDF</button><a class="btn secondary" style="display:block;text-align:center;text-decoration:none" id="saveTempPdf" target="_blank" rel="noopener">Open PDF</a><p role="status" id="tempPdfStatus"></p><button type="button" class="btn secondary" id="closeTempPdf">Back to Marinara Hours</button>';
    const save = dialog.querySelector('#saveTempPdf'); save.href = url; save.download = filename;
    const share = dialog.querySelector('#shareTempPdf');
    const status = dialog.querySelector('#tempPdfStatus');
    let file;
    try {
      file = new File([blob], filename, { type: 'application/pdf' });
      share.hidden = !(navigator.share && navigator.canShare?.({ files: [file] }));
    } catch (_) { share.hidden = true; }
    if (share.hidden) status.textContent = 'Use Open PDF, then print or save it from there. Marinara Hours stays open.';
    share.onclick = async () => {
      share.disabled = true;
      try {
        // No await before share: keep the fresh tap Safari/iOS requires.
        await navigator.share({ files: [file], title: 'Marinara temperature records' });
        status.textContent = 'Done.';
      } catch (error) {
        status.textContent = error.name === 'AbortError' ? 'Cancelled. You can try again or open the PDF.' : 'Sharing is unavailable. Use Open PDF instead.';
      } finally { share.disabled = false; }
    };
    function close() {
      dialog.remove(); URL.revokeObjectURL(url); file = null;
      window.removeEventListener('pagehide', close);
      closeCurrent = null;
    }
    closeCurrent = close;
    dialog.querySelector('#closeTempPdf').onclick = close;
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    window.addEventListener('pagehide', close, { once: true });
    document.body.append(dialog); dialog.showModal();
  }
  window.MarinaraTempPdf = { open, generate };
})();
