import {createServer} from 'node:http';
import {readFileSync, mkdirSync} from 'node:fs';
import {resolve, extname} from 'node:path';
import assert from 'node:assert/strict';
import {chromium, webkit, devices} from 'playwright';
const server=createServer((req,res)=>{try{const p=resolve('.'+(req.url==='/'?'/index.html':req.url));res.setHeader('Content-Type',extname(p)==='.js'?'text/javascript':'text/html');res.end(readFileSync(p));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const engine=process.env.E2E_BROWSER||'chromium';
const browser=await ({chromium,webkit}[engine]).launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
try {
 const context=await browser.newContext(engine==='webkit'?{...devices['iPhone 13'],acceptDownloads:true}:{acceptDownloads:true});
 const page=await context.newPage();
 await page.route('https://**/*',r=>r.abort());
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(()=>{
   document.querySelectorAll('main > section').forEach(e=>e.classList.add('hidden'));
   timesheetsScreen.classList.remove('hidden');
   timesheetsWeek.textContent='12/10/2026 – 18/10/2026';
   currentTimesheetsData={summary:[{staff_id:'a',name:'Ana Silva',department:'Kitchen'}],shifts:[{staff_id:'a',clock_in:'2026-10-12T00:00:00Z',clock_out:'2026-10-12T08:00:00Z',status:'completed',approved:true,break_minutes:30}]};
 });
 await page.locator('#exportTimesheetsPdfBtn').click();
 await page.locator('#timesheetPdfDialog').waitFor({state:'visible',timeout:5000});
 assert.equal(context.pages().length,1,'export must keep the app open');
 const download=page.waitForEvent('download');
 await page.getByRole('link',{name:'Save PDF'}).click();
 const file=await download;
 mkdirSync('tmp/pdfs',{recursive:true});
 await file.saveAs(`tmp/pdfs/${engine}.pdf`);
 assert.ok(readFileSync(`tmp/pdfs/${engine}.pdf`).subarray(0,5).equals(Buffer.from('%PDF-')));
 await page.getByRole('button',{name:'Back to Marinara Hours'}).click();
 assert.equal(await page.locator('#timesheetPdfDialog').count(),0);
 assert.equal(await page.locator('#exportTimesheetsPdfBtn').isEnabled(),true);

 // Share API is replaced only at the OS boundary; generated files remain real.
 await page.evaluate(()=>{
   window.shared=[];window.revoked=[];
   const revoke=URL.revokeObjectURL.bind(URL);
   URL.revokeObjectURL=url=>{window.revoked.push(url);revoke(url);};
   Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});
   Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{
     window.shared.push({type:data.files[0].type,bytes:await data.files[0].text()});
     if(window.shareError) throw new DOMException('Test',window.shareError);
   }});
 });
 await page.locator('#exportTimesheetsPdfBtn').click();
 await page.getByRole('button',{name:'Share PDF',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#pdfExportStatus').textContent==='PDF shared.');
 assert.equal(await page.evaluate(()=>shared[0].type),'application/pdf');
 assert.ok(await page.evaluate(()=>shared[0].bytes.startsWith('%PDF-')));
 for(const name of ['AbortError','NotAllowedError']) {
   await page.evaluate(name=>window.shareError=name,name);
   await page.getByRole('button',{name:'Share PDF',exact:true}).click();
   await page.waitForFunction(()=>!document.querySelector('#shareTimesheetPdf').disabled);
   assert.match(await page.locator('#pdfExportStatus').textContent(),name==='AbortError'?/cancelled/:/Save PDF/);
 }
 await page.getByRole('button',{name:'Back to Marinara Hours'}).click();
 assert.equal(await page.evaluate(()=>revoked.length),1);
 // The original approval gate must still block incomplete exports.
 await page.evaluate(()=>currentTimesheetsData.shifts[0].approved=false);
 await page.locator('#exportTimesheetsPdfBtn').click();
 assert.equal(await page.locator('#timesheetPdfDialog').count(),0);
 assert.match(await page.locator('#timesheetsMessage').textContent(),/not ready/);
 await page.evaluate(()=>currentTimesheetsData.shifts[0].approved=true);
 // A generation error must release the button and show a visible error.
 await page.evaluate(()=>{window.originalPdfOpen=MarinaraPdf.open;MarinaraPdf.open=async()=>{throw Error('Synthetic failure');};});
 await page.locator('#exportTimesheetsPdfBtn').click();
 assert.match(await page.locator('#timesheetsMessage').textContent(),/Synthetic failure/);
 assert.equal(await page.locator('#exportTimesheetsPdfBtn').isEnabled(),true);
 await page.evaluate(()=>MarinaraPdf.open=window.originalPdfOpen);
 // Large report includes an employee whose shifts span several pages.
 await page.evaluate(()=>{
   const shift=currentTimesheetsData.shifts[0];
   currentTimesheetsData.summary=[];currentTimesheetsData.shifts=[];
   for(let i=0;i<40;i++) {
     currentTimesheetsData.summary.push({staff_id:String(i),name:'Employee '+String(i).padStart(2,'0'),department:i%2?'Floor':'Kitchen'});
     for(let j=0;j<(i===0?100:7);j++) currentTimesheetsData.shifts.push({...shift,staff_id:String(i)});
   }
 });
 await page.locator('#exportTimesheetsPdfBtn').click();
 const largeDownload=page.waitForEvent('download');
 await page.getByRole('link',{name:'Save PDF'}).click();
 await (await largeDownload).saveAs(`tmp/pdfs/${engine}-large.pdf`);
 await page.getByRole('button',{name:'Back to Marinara Hours'}).click();
 assert.equal(await page.locator('#timesheetPdfDialog').count(),0);
 console.log(`${engine}: download, return, share success/cancel/failure, cleanup, approval gate, generation error, large report passed`);
} finally {await browser.close();server.close();}
