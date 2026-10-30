// node --test reporter: failing tests become GitHub annotations (the job log
// is not always reachable). Prints nothing else.
export default async function* ghaReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail' || !process.env.GITHUB_ACTIONS) continue;
    const d = event.data;
    const err = d.details?.error;
    const msg = String(err?.cause?.stack || err?.cause || err?.stack || err || 'failed').replace(/\r?\n/g, ' | ').slice(0, 1500);
    yield `::error title=${String(d.name).replace(/[:,\n]/g, ' ').slice(0, 120)}::${d.file || ''} ${msg}\n`;
  }
}
