# iPhone PDF export

The existing approved-shift filtering, report rows, break formatting and hour calculations in index.html are unchanged. The old window.open/document.write/window.print path is replaced by a local PDF file generator. The monochrome header, embedded original logo, Hawthorne, week, department labels, employee rows, weekly totals and approval labels are retained in landscape A4.

The export button opens an in-app dialog after generating the file. Share PDF calls the native Web Share API with a PDF File from a fresh tap. Save PDF remains available when file sharing is absent, fails or is cancelled; the download link opens a separate tab on browsers that display PDFs instead of downloading. Back to Marinara Hours closes the dialog without navigating or resetting the app. Blob URLs are released when the dialog closes or the page unloads. No PDFs or timesheets are uploaded to a service.

PDF libraries are loaded only on export, locally from vendor/, with a 15-second load timeout and retry. Vendored MIT packages: jsPDF 4.2.1 and jsPDF-AutoTable 5.0.8, pinned in package-lock.json. These are approximately 440 KB uncompressed combined; no canvas/HTML screenshot renderer is used. Licenses are included. To update them, copy the matching npm distribution files and licenses and rerun the PDF tests.

Normal employee groups stay together when space permits. Oversized groups split between complete rows with repeated table headings, continuation labels and a final total. Headers, footers and page numbers are repeated. The 373-shift fixture covers 40 employees including a 100-shift group.

## Validation

- `npm test`: existing 32 tests.
- `npm run test:pdf`: regression plus Chromium download, navigation, sharing capability simulation, cancel/failure handling, generation failure, approval gate and large report.
- `npm run test:pdf:webkit`: same browser checks in WebKit with the iPhone 13 profile.
- `python tests/e2e/check-pdf.py [webkit]`: inspect downloaded files using pdfplumber; real PDF, A4 landscape, 373 approved rows, 40 exact totals and no blank/orphan-total pages.

Browser tests block external network requests and use synthetic timesheets. Native sharing is simulated only at the navigator.share boundary; these tests do not establish OS sheet delivery. GitHub Actions runs both browser engines. Local WebKit cannot launch until its system libraries are installed.

## Physical acceptance before production

On an iPhone, test both Safari and the installed PWA: export a short and a long week; Share PDF > Save to Files; open the saved PDF; AirDrop to another device; cancel and retry; Save PDF fallback; Back to Marinara Hours. Confirm names/accents and totals match the app. On Mac Safari confirm download/open and return. Playwright WebKit is not an iPhone or Mac hardware test.

No Supabase, Edge Function, PIN/session code or time records are changed. No merge or production deployment is part of this PR.
