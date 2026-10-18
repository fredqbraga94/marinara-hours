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

  function generate(report, groups) {
    const doc = new window.jspdf.jsPDF({orientation:'landscape', unit:'mm', format:'a4', compress:true});
    const width = 277;
    const columns = {0:{cellWidth:55.4},1:{cellWidth:55.4},2:{cellWidth:34.6},3:{cellWidth:34.6},4:{cellWidth:30.5},5:{cellWidth:33.2},6:{cellWidth:33.3}};
    // One continuous compact table: a single column header and weekly totals.
    // autoTable may paginate exceptionally long weeks rather than truncate data.
    const body = [];
    for (const group of groups) {
      for (const row of group.rows) body.push(row);
      body.push([
        {content:group.total[0],colSpan:5,styles:{fillColor:[235,235,235],fontStyle:'bold',fontSize:7.5,cellPadding:0.7}},
        {content:group.total[1],styles:{fillColor:[235,235,235],fontStyle:'bold',fontSize:7,cellPadding:0.7}},
        {content:'',styles:{fillColor:[235,235,235]}}
      ]);
      if (group !== groups[groups.length - 1]) body.push([{content:' ',colSpan:7,styles:{minCellHeight:2.6,cellPadding:0.3,fillColor:[255,255,255]}}]);
    }
    doc.autoTable({
      startY:52, margin:{top:52,bottom:14,left:10,right:10},tableWidth:width,
      head:[['Employee','Date','Clock In','Clock Out','Break','Total','Status']],
      body, showHead:'firstPage', pageBreak:'auto',rowPageBreak:'avoid',
      theme:'plain',
      styles:{font:'helvetica',fontSize:6.8,cellPadding:{top:0.45,bottom:0.45,left:1.3,right:1.3},textColor:32,overflow:'linebreak',minCellHeight:3.7},
      columnStyles:columns,
      headStyles:{cellPadding:1.1,fillColor:48,textColor:255,fontStyle:'bold',fontSize:7.5},
      didParseCell(data) {
        if(data.section==='body' && (data.column.index===0 || data.column.index===5)) data.cell.styles.fontStyle='bold';
        if(data.section==='body' && data.column.index===6) data.cell.styles.fontSize=6.7;
      }
    });
    const pages = doc.getNumberOfPages();
    for (let page=1; page<=pages; page++) {
      doc.setPage(page);
      doc.setFillColor(17); doc.rect(10,10,width,30,'F');
      doc.addImage(report.logo,'PNG',15,14,58,20.8);
      doc.setTextColor(255); doc.setFont('helvetica','bold'); doc.setFontSize(18);
      doc.text('WEEKLY TIMESHEETS',87,22);
      doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(204);
      doc.text('HAWTHORNE / STAFF HOURS',87,28);
      doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(255);
      doc.text(report.week,282,36,{align:'right',maxWidth:185});
      doc.setFontSize(8); doc.setTextColor(48); doc.text(report.department,10,46);
      doc.setFont('helvetica','normal'); doc.setTextColor(112);
      doc.text(`${report.employees} employees · ${report.shifts} shifts | Australia/Brisbane`,287,46,{align:'right'});
      doc.setDrawColor(215); doc.line(10,197,287,197);
      doc.setFontSize(7); doc.text('MARINARA HAWTHORNE',10,202);
      doc.text(`Generated from Marinara Hours · ${page} / ${pages}`,287,202,{align:'right'});
    }
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
    dialog.innerHTML = '<h2 style="margin-top:0">Your PDF is ready</h2><p>Share to save in Files, send by AirDrop or choose another app.</p><button type="button" class="btn primary" id="shareTimesheetPdf">Share PDF</button><a class="btn secondary" style="display:block;text-align:center;text-decoration:none" id="saveTimesheetPdf" target="_blank" rel="noopener">Save PDF</a><p role="status" id="pdfExportStatus"></p><button type="button" class="btn secondary" id="closeTimesheetPdf">Back to Marinara Hours</button>';
    const save = dialog.querySelector('#saveTimesheetPdf'); save.href=url; save.download=filename;
    const share = dialog.querySelector('#shareTimesheetPdf');
    const status = dialog.querySelector('#pdfExportStatus');
    let file;
    try {
      file = new File([blob],filename,{type:'application/pdf'});
      share.hidden = !(navigator.share && navigator.canShare?.({files:[file]}));
    } catch (_) { share.hidden = true; }
    if (share.hidden) status.textContent='Use Save PDF to download or open the file in a separate tab. Marinara Hours stays open.';
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
