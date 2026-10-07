import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboard, buildEtfDetail } from './src/analysis.js';
import { DATA_SOURCE, DEFAULT_RANGE, PORT, RANGES } from './src/config.js';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const SYMBOL_RE = /^[A-Z0-9^.=-]{1,12}$/;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// ?add=TICKER:BENCHMARK,TICKER2 — extra symbols the user added in the UI.
function parseExtra(param) {
  if (!param) return [];
  return param.split(',').slice(0, 20).map((pair) => {
    const [symbol, benchmark = 'SPY'] = pair.toUpperCase().split(':');
    return { symbol, benchmark, category: 'Custom' };
  }).filter((e) => SYMBOL_RE.test(e.symbol) && SYMBOL_RE.test(e.benchmark));
}

async function handleApi(url, res) {
  const range = url.searchParams.get('range') || DEFAULT_RANGE;
  if (!(range in RANGES)) return sendJson(res, 400, { error: `Unknown range ${range}` });
  const payload = await buildDashboard({ range, extra: parseExtra(url.searchParams.get('add')) });
  sendJson(res, 200, payload);
}

// /api/etf/QQQ?benchmark=SPY — deep-dive data for one ETF.
async function handleDetail(url, res) {
  const symbol = decodeURIComponent(url.pathname.slice('/api/etf/'.length)).toUpperCase();
  const benchmark = url.searchParams.get('benchmark')?.toUpperCase();
  if (!SYMBOL_RE.test(symbol) || (benchmark && !SYMBOL_RE.test(benchmark))) {
    return sendJson(res, 400, { error: 'Invalid symbol' });
  }
  sendJson(res, 200, await buildEtfDetail({ symbol, benchmark }));
}

async function serveStatic(pathname, res) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/dashboard') return await handleApi(url, res);
    if (url.pathname.startsWith('/api/etf/')) return await handleDetail(url, res);
    return await serveStatic(url.pathname, res);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`ETF dashboard on http://localhost:${PORT}  (data source: ${DATA_SOURCE})`);
});
