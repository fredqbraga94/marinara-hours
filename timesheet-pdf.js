/* Local-only PDF export. No staff data is sent to any PDF service. */
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

  // ---- Layout (A4 landscape, mm) -------------------------------------------
  // Header band 8–30, info line 36, table 39–198, footer rule 199.
  const PAGE = {width:297, left:10, right:10, tableTop:39, tableBottom:198};
  const TABLE_WIDTH = PAGE.width - PAGE.left - PAGE.right; // 277
  const COLUMNS = {0:{cellWidth:55.4},1:{cellWidth:55.4},2:{cellWidth:34.6},3:{cellWidth:34.6},4:{cellWidth:30.5},5:{cellWidth:33.2},6:{cellWidth:33.3}};
  // Density levels, most comfortable first. A row is
  // max(minRow, fontPt * 0.3528 * 1.15 + 2 * pad) mm; the first level whose
  // real autoTable layout ends on page 1 is used. The last level is the
  // smallest size we accept as readable; longer weeks paginate at a
  // comfortable size instead of shrinking further. Data is never dropped.
  const LEVELS = [
    {font:8.4, pad:1.0,  minRow:5.2, gap:3.0},
    {font:8.0, pad:0.9,  minRow:4.9, gap:2.8},
    {font:7.6, pad:0.8,  minRow:4.6, gap:2.6},
    {font:7.2, pad:0.7,  minRow:4.3, gap:2.4},
    {font:6.9, pad:0.6,  minRow:4.0, gap:2.2},
    {font:6.6, pad:0.5,  minRow:3.75, gap:2.0},
  ];
  const PAGINATED_LEVEL = LEVELS[2];
  const TOTAL_FILL = [218,218,218];
  const DEPT_GREY = 110;

  // Department labels used to sit on a second line inside each employee's
  // first row, doubling the height of 7 rows. Put the label in the (empty)
  // employee cell of the second row instead; one-shift employees get
  // "Name · Department" on a single line.
  function bodyRows(groups) {
    const rows = [];
    groups.forEach((group, g) => {
      const shiftRows = group.rows.map(row => row.slice());
      const [name, dept] = String(shiftRows[0]?.[0] || '').split('\n');
      shiftRows.forEach((row, i) => {
        const cells = row.map(content => ({content}));
        if (i === 0) cells[0] = {content: dept && shiftRows.length === 1 ? `${name} · ${dept}` : name, styles:{fontStyle:'bold', textColor:20}};
        else if (i === 1 && dept) cells[0] = {content: dept, styles:{fontStyle:'normal', textColor:DEPT_GREY}};
        else if (i > 0) cells[0] = {content:''};
        cells.kind = i === 0 ? 'first' : 'shift';
        rows.push(cells);
      });
      const total = [
        {content:group.total[0], colSpan:5, styles:{fillColor:TOTAL_FILL, fontStyle:'bold', textColor:20}},
        {content:group.total[1], styles:{fillColor:TOTAL_FILL, fontStyle:'bold', textColor:20}},
        {content:'', styles:{fillColor:TOTAL_FILL}},
      ];
      total.kind = 'total';
      rows.push(total);
      if (g < groups.length - 1) {
        const gap = [{content:'', colSpan:7}];
        gap.kind = 'gap';
        rows.push(gap);
      }
    });
    return rows;
  }

  function tableOptions(rows, level, paginate) {
    return {
      startY:PAGE.tableTop,
      margin:{top:PAGE.tableTop, bottom:210 - PAGE.tableBottom, left:PAGE.left, right:PAGE.right},
      tableWidth:TABLE_WIDTH,
      head:[['Employee','Date','Clock In','Clock Out','Break','Total','Status']],
      body:rows,
      showHead:paginate ? 'everyPage' : 'firstPage',
      pageBreak:'auto', rowPageBreak:'avoid',
      theme:'plain',
      styles:{font:'helvetica', fontSize:level.font, cellPadding:{top:level.pad, bottom:level.pad, left:1.4, right:1.4},
        textColor:40, overflow:'linebreak', minCellHeight:level.minRow, valign:'middle', lineWidth:0},
      columnStyles:COLUMNS,
      headStyles:{fillColor:30, textColor:255, fontStyle:'bold', fontSize:Math.min(level.font, 8), cellPadding:{top:level.pad + 0.4, bottom:level.pad + 0.4, left:1.4, right:1.4}, minCellHeight:level.minRow},
      didParseCell(data) {
        if (data.section !== 'body') return;
        const kind = data.row.raw.kind;
        if (kind === 'gap') {
          data.cell.styles.minCellHeight = level.gap;
          data.cell.styles.cellPadding = 0;
          data.cell.styles.fontSize = 1;
          return;
        }
        if (data.column.index === 5) data.cell.styles.fontStyle = 'bold';
        if (data.column.index === 6 && kind !== 'total') data.cell.styles.fontSize = Math.max(level.font - 0.4, 6.2);
        if (data.column.index === 0 && kind === 'shift' && data.cell.raw?.content) data.cell.styles.fontSize = Math.max(level.font - 0.6, 6);
      },
      didDrawCell(data) {
        // Thin rule above each employee's first row: a visible but quiet separator.
        if (data.section === 'body' && data.row.raw.kind === 'first' && data.column.index === 0) {
          data.doc.setDrawColor(170); data.doc.setLineWidth(0.25);
          data.doc.line(PAGE.left, data.cell.y, PAGE.left + TABLE_WIDTH, data.cell.y);
        }
      },
    };
  }

  // Measures the real layout with autoTable on a scratch document.
  function fitsOnePage(rows, level) {
    const probe = new window.jspdf.jsPDF({orientation:'landscape', unit:'mm', format:'a4'});
    probe.autoTable(tableOptions(rows, level, false));
    return probe.getNumberOfPages() === 1 && probe.lastAutoTable.finalY <= PAGE.tableBottom + 0.01;
  }

  function chooseLayout(rows) {
    for (const level of LEVELS) if (fitsOnePage(rows, level)) return {level, paginate:false};
    return {level:PAGINATED_LEVEL, paginate:true};
  }

  function drawFrame(doc, report, page, pages) {
    doc.setPage(page);
    doc.setFillColor(17); doc.rect(PAGE.left, 8, TABLE_WIDTH, 22, 'F');
    doc.addImage(report.logo, 'PNG', 13, 10.6, 47, 16.9);
    doc.setTextColor(255); doc.setFont('helvetica','bold'); doc.setFontSize(16);
    doc.text('WEEKLY TIMESHEETS', 70, 18.2);
    doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(200);
    doc.text('HAWTHORNE / STAFF HOURS', 70, 24.2);
    doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(255);
    doc.text(report.week, 283, 24.2, {align:'right', maxWidth:120});
    doc.setFontSize(8); doc.setTextColor(40); doc.text(report.department, PAGE.left, 35.4);
    doc.setFont('helvetica','normal'); doc.setTextColor(110);
    doc.text(`${report.employees} employees · ${report.shifts} shifts | Australia/Brisbane`, 287, 35.4, {align:'right'});
    doc.setDrawColor(205); doc.setLineWidth(0.2); doc.line(PAGE.left, 199, 287, 199);
    doc.setFontSize(6.5); doc.setTextColor(130);
    doc.text('MARINARA HAWTHORNE', PAGE.left, 203.2);
    doc.text(`Marinara Ristorante Cafe · ${page} / ${pages}`, 287, 203.2, {align:'right'});
  }

  function generate(report, groups) {
    const rows = bodyRows(groups);
    const {level, paginate} = chooseLayout(rows);
    const doc = new window.jspdf.jsPDF({orientation:'landscape', unit:'mm', format:'a4', compress:true});
    doc.autoTable(tableOptions(rows, level, paginate));
    const pages = doc.getNumberOfPages();
    for (let page = 1; page <= pages; page++) drawFrame(doc, report, page, pages);
    generate.lastLayout = {font:level.font, paginate, pages};
    return doc.output('blob');
  }

  let closeCurrent;
  async function open(report) {
    await load();
    const table = document.createElement('table');
    table.innerHTML = report.rows;
    const groups = [...table.querySelectorAll('tbody')].map(body => ({
      rows:[...body.querySelectorAll('tr:not(.weekly-total):not(.employee-gap)')].map(row =>
        [...row.cells].map(cell => {
          const copy = cell.cloneNode(true);
          const department = copy.querySelector('small');
          const label = department?.textContent.trim();
          department?.remove();
          return copy.textContent.replace(/\s+/g,' ').trim() + (label ? '\n' + label : '');
        })),
      total:[...body.querySelector('.weekly-total').cells].map(cell => cell.textContent.trim())
    }));
    if (!groups.length) throw new Error('No employee rows are available.');
    const blob = generate(report, groups);
    closeCurrent?.();
    const url = URL.createObjectURL(blob);
    const filename = 'Marinara-Hawthorne-Timesheets-' + report.week.replace(/[^a-zA-Z0-9]+/g,'-') + '.pdf';
    const dialog = document.createElement('dialog');
    dialog.id = 'timesheetPdfDialog';
    dialog.style.cssText = 'width:min(440px,92vw);max-height:85dvh;overflow:auto;border:0;border-radius:20px;padding:24px;color:#17211b;background:white;';
    dialog.innerHTML = '<h2 style="margin-top:0">Your PDF is ready</h2><p>Share to save in Files, send by AirDrop or choose another app.</p><button type="button" class="btn primary" id="shareTimesheetPdf">Share PDF</button><a class="btn secondary" style="display:block;text-align:center;text-decoration:none" id="saveTimesheetPdf" target="_blank" rel="noopener">Save PDF</a><p role="status" id="pdfExportStatus"></p><button type="button" class="btn secondary" id="closeTimesheetPdf">Back to the app</button>';
    const save = dialog.querySelector('#saveTimesheetPdf'); save.href=url; save.download=filename;
    const share = dialog.querySelector('#shareTimesheetPdf');
    const status = dialog.querySelector('#pdfExportStatus');
    let file;
    try {
      file = new File([blob],filename,{type:'application/pdf'});
      share.hidden = !(navigator.share && navigator.canShare?.({files:[file]}));
    } catch (_) { share.hidden = true; }
    if (share.hidden) status.textContent='Use Save PDF to download or open the file in a separate tab. The app stays open.';
    share.onclick = async () => {
      share.disabled=true;
      try {
        // No await before share: retain the fresh tap required by Safari/iOS.
        await navigator.share({files:[file],title:'Marinara Hawthorne Timesheets'});
        status.textContent='PDF shared.';
      } catch (error) {
        status.textContent=error.name==='AbortError'?'Sharing cancelled. You can try again or save the PDF.':'Sharing is unavailable. Use Save PDF instead.';
      } finally { share.disabled=false; }
    };
    function close() {
      dialog.remove(); URL.revokeObjectURL(url); file=null;
      window.removeEventListener('pagehide',close);
      closeCurrent=null;
      document.getElementById('exportTimesheetsPdfBtn')?.focus();
    }
    closeCurrent=close;
    dialog.querySelector('#closeTimesheetPdf').onclick=close;
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    window.addEventListener('pagehide',close,{once:true});
    document.body.append(dialog); dialog.showModal();
  }
  window.MarinaraPdf = {open, generate};
})();
