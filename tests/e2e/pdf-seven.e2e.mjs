// Reference week for the single-page timesheet PDF: 7 employees, 21 shifts,
// mixed Kitchen/Floor (so department labels are shown), one long name.
// 100% synthetic data: fictitious names and times, nothing from Supabase.
//
// Run: node tests/e2e/pdf-seven.e2e.mjs          (Chromium)
//      E2E_BROWSER=webkit node tests/e2e/pdf-seven.e2e.mjs   (WebKit, iPhone 13 profile)
// Then: python3 tests/e2e/check-pdf-seven.py [engine]
import {createServer} from 'node:http';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve, extname} from 'node:path';
import assert from 'node:assert/strict';
import {chromium, webkit, devices} from 'playwright';

// [name, department, number of shifts] -> 21 shifts in total.
export const PEOPLE = [
  ['Aiyana Brooks', 'Floor', 4],
  ['Bruno Costa', 'Kitchen', 3],
  ['Chloe Martin', 'Floor', 3],
  ['Dmitri Ivanov', 'Kitchen', 3],
  ['Mariana Albuquerque', 'Kitchen', 3],
  ['Leo Park', 'Floor', 3],
  ['Zara Novak', 'Floor', 2],
];

// Brisbane is UTC+10 (no DST). Week of Mon 12/10/2026 – Sun 18/10/2026.
const START = [[9, 0], [10, 30], [16, 0], [7, 15]];
const LENGTH_MIN = [480, 390, 330, 510];
const BREAK_MIN = [30, 0, 15, 45];

export function buildWeek() {
  const summary = [], shifts = [], expected = [];
  PEOPLE.forEach(([name, department, count], p) => {
    const staff_id = 'synthetic-' + p;
    summary.push({staff_id, name, department});
    let totalMin = 0;
    for (let s = 0; s < count; s++) {
      const day = 12 + ((p + s * 2) % 7);
      const [h, m] = START[(p + s) % 4];
      const len = LENGTH_MIN[(p * 3 + s) % 4];
      const brk = BREAK_MIN[(p + 2 * s) % 4];
      const clockIn = new Date(Date.UTC(2026, 9, day, h - 10, m));
      const clockOut = new Date(clockIn.getTime() + len * 60000);
      const breaks = brk ? [{break_start: new Date(clockIn.getTime() + 120 * 60000).toISOString(), break_end: new Date(clockIn.getTime() + (120 + brk) * 60000).toISOString()}] : [];
      shifts.push({staff_id, clock_in: clockIn.toISOString(), clock_out: clockOut.toISOString(), status: 'completed', approved: true, break_minutes: brk, breaks});
      totalMin += len - brk;
    }
    expected.push({name, department, count, total: `${Math.floor(totalMin / 60)}h ${String(totalMin % 60).padStart(2, '0')}m`});
  });
  return {summary, shifts, expected};
}

const engine = process.env.E2E_BROWSER || 'chromium';
const root = resolve(process.env.APP_ROOT || '.');
const server = createServer((req, res) => {
  try {
    const p = resolve(root + (req.url === '/' ? '/index.html' : req.url.split('?')[0]));
    res.setHeader('Content-Type', extname(p) === '.js' ? 'text/javascript' : 'text/html');
    res.end(readFileSync(p));
  } catch { res.writeHead(404).end(); }
});

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await ({chromium, webkit}[engine]).launch(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {});
  try {
    const context = await browser.newContext(engine === 'webkit' ? {...devices['iPhone 13'], acceptDownloads: true} : {acceptDownloads: true});
    const page = await context.newPage();
    await page.route('https://**/*', r => r.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const week = buildWeek();
    await page.evaluate(week => {
      document.querySelectorAll('main > section').forEach(e => e.classList.add('hidden'));
      timesheetsScreen.classList.remove('hidden');
      timesheetsWeek.textContent = '12/10/2026 – 18/10/2026';
      currentTimesheetsData = {summary: week.summary, shifts: week.shifts};
    }, week);

    // Export -> dialog -> Save PDF (real download) -> Back.
    await page.locator('#exportTimesheetsPdfBtn').click();
    await page.locator('#timesheetPdfDialog').waitFor({state: 'visible', timeout: 10000});
    assert.equal(context.pages().length, 1, 'export must keep the app open');
    const download = page.waitForEvent('download');
    await page.getByRole('link', {name: 'Save PDF'}).click();
    mkdirSync('tmp/pdfs', {recursive: true});
    const out = `tmp/pdfs/${engine}-seven.pdf`;
    await (await download).saveAs(out);
    assert.ok(readFileSync(out).subarray(0, 5).equals(Buffer.from('%PDF-')));
    writeFileSync('tmp/pdfs/seven-expected.json', JSON.stringify(week.expected, null, 1));

    // Share keeps working with the same real file (OS share sheet replaced only).
    await page.evaluate(() => {
      window.shared = [];
      Object.defineProperty(navigator, 'canShare', {configurable: true, value: () => true});
      Object.defineProperty(navigator, 'share', {configurable: true, value: async data => { window.shared.push({type: data.files[0].type, size: data.files[0].size}); }});
    });
    await page.getByRole('button', {name: 'Back to the app'}).click();
    assert.equal(await page.locator('#timesheetPdfDialog').count(), 0);
    assert.equal(await page.locator('#exportTimesheetsPdfBtn').isEnabled(), true);
    await page.locator('#exportTimesheetsPdfBtn').click();
    await page.getByRole('button', {name: 'Share PDF', exact: true}).click();
    await page.waitForFunction(() => document.querySelector('#pdfExportStatus').textContent === 'PDF shared.');
    assert.equal(await page.evaluate(() => shared[0].type), 'application/pdf');
    assert.equal(await page.evaluate(() => shared[0].size), readFileSync(out).length, 'shared file is the same PDF');
    await page.getByRole('button', {name: 'Back to the app'}).click();
    assert.equal(await page.locator('#timesheetPdfDialog').count(), 0);
    console.log(`${engine}: 7 employees / 21 shifts exported; save, share and back passed -> ${out}`);
  } finally { await browser.close(); server.close(); }
}
