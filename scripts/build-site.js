// Builds a static copy of the dashboard into dist/ for GitHub Pages:
// the front end plus pre-computed JSON snapshots for every window and ETF.
//   node scripts/build-site.js            (live data, demo fallback per symbol)
//   DATA_SOURCE=demo node scripts/build-site.js
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildDashboard, buildEtfDetail } from '../src/analysis.js';
import { ETFS, RANGES } from '../src/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}dist`;

await rm(out, { recursive: true, force: true });
await mkdir(`${out}/data/etf`, { recursive: true });
await cp(`${root}public`, out, { recursive: true });
// Tell the front end to read data/*.json instead of probing for the API.
const html = await readFile(`${out}/index.html`, 'utf8');
await writeFile(`${out}/index.html`, html.replace('<meta charset="utf-8">',
  '<meta charset="utf-8">\n  <meta name="etf-pulse-mode" content="static">'));

let source;
for (const range of Object.keys(RANGES)) {
  const payload = await buildDashboard({ range });
  source = payload.dataSource;
  await writeFile(`${out}/data/${range}.json`, JSON.stringify({ ...payload, static: true }));
  if (payload.errors.length) console.warn(`[build] ${range}:`, payload.errors);
}
for (const etf of ETFS) {
  const detail = await buildEtfDetail({ symbol: etf.symbol });
  await writeFile(`${out}/data/etf/${encodeURIComponent(etf.symbol)}.json`, JSON.stringify(detail));
}
// Pages serves files starting with "_" only when Jekyll is disabled.
await writeFile(`${out}/.nojekyll`, '');

console.log(`[build] dist/ ready — ${Object.keys(RANGES).length} windows, ${ETFS.length} ETFs, data source: ${source}`);
