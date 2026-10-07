// Market data access: Yahoo Finance's public chart endpoint (no API key) with
// an in-memory cache, and a deterministic synthetic generator used when the
// live source is disabled or unreachable. Every series is tagged with its
// source so the UI can say plainly when it is showing demo data.

import { DATA_SOURCE, HISTORY_TTL_MS, QUOTE_TTL_MS } from './config.js';

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (etf-model dashboard)', Accept: 'application/json' };

const cache = new Map(); // key -> { at, promise }

function cached(key, ttl, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = load().catch((err) => {
    cache.delete(key); // never cache failures
    throw err;
  });
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

// Yahoo throttles bursts, so keep a few requests in flight and retry
// rate-limit / server errors with backoff, alternating between its two hosts.
const MAX_CONCURRENT = 4;
let active = 0;
const waiting = [];
async function throttled(fn) {
  if (active >= MAX_CONCURRENT) await new Promise((resolve) => waiting.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function yahooChart(symbol, params) {
  const query = `${encodeURIComponent(symbol)}?${new URLSearchParams(params)}`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(500 * 2 ** attempt);
    const host = attempt % 2 ? YAHOO.replace('query1', 'query2') : YAHOO;
    try {
      const res = await throttled(() => fetch(host + query, { headers: HEADERS, signal: AbortSignal.timeout(10_000) }));
      if (!res.ok) {
        lastError = new Error(`Yahoo ${symbol}: HTTP ${res.status}`);
        if (res.status === 429 || res.status >= 500) continue;
        throw lastError;
      }
      const body = await res.json();
      const result = body?.chart?.result?.[0];
      if (!result) throw new Error(`Yahoo ${symbol}: ${body?.chart?.error?.description || 'empty response'}`);
      return result;
    } catch (err) {
      if (err === lastError) throw err;
      lastError = err;
      if (!/timeout|fetch failed|network/i.test(err.message)) throw err;
    }
  }
  throw lastError;
}

const toDate = (ts, offset = 0) => new Date((ts + offset) * 1000).toISOString().slice(0, 10);

async function liveHistory(symbol) {
  const r = await yahooChart(symbol, { range: '10y', interval: '1d', includeAdjustedClose: 'true' });
  const ts = r.timestamp || [];
  const close = r.indicators?.quote?.[0]?.close || [];
  // Adjusted closes include dividends, so returns are total returns.
  const adj = r.indicators?.adjclose?.[0]?.adjclose || close;
  const offset = r.meta?.gmtoffset || 0;
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    if (adj[i] == null || close[i] == null) continue;
    points.push({ date: toDate(ts[i], offset), close: adj[i], raw: close[i] });
  }
  if (points.length < 2) throw new Error(`Yahoo ${symbol}: no history`);
  return {
    symbol,
    source: 'live',
    name: r.meta?.longName || r.meta?.shortName || symbol,
    currency: r.meta?.currency || 'USD',
    points,
  };
}

async function liveQuote(symbol) {
  const r = await yahooChart(symbol, { range: '1d', interval: '5m' });
  const m = r.meta || {};
  const price = m.regularMarketPrice;
  const prev = m.previousClose ?? m.chartPreviousClose;
  if (price == null) throw new Error(`Yahoo ${symbol}: no quote`);
  return {
    symbol,
    source: 'live',
    price,
    previousClose: prev,
    change: prev ? price - prev : null,
    changePct: prev ? price / prev - 1 : null,
    time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
    date: m.regularMarketTime ? toDate(m.regularMarketTime, m.gmtoffset || 0) : null,
    marketState: marketStateFrom(m),
  };
}

function marketStateFrom(meta) {
  const p = meta.currentTradingPeriod?.regular;
  if (!p) return 'unknown';
  const now = Date.now() / 1000;
  return now >= p.start && now < p.end ? 'open' : 'closed';
}

// ---------------------------------------------------------------- demo data

function hashString(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// Rough, plausible characteristics so the demo looks like a real market.
const DEMO_PROFILE = {
  SPY: [1.0, 0.004, 100], VT: [0.95, 0.004, 100], VTI: [1.02, 0.005, 210],
  QQQ: [1.2, 0.007, 350], IWM: [1.15, 0.009, 190], SCHD: [0.8, 0.007, 75],
  XLK: [1.3, 0.008, 180], VXUS: [0.85, 0.006, 55], AGG: [0.05, 0.003, 98],
  BIL: [0, 0.0002, 91.5], GLD: [0.1, 0.009, 180], ARKK: [1.7, 0.02, 45],
};

function businessDays(count) {
  const days = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  while (days.length < count) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return days.reverse();
}

const DEMO_DAYS = 2520;
let demoMarket = null;
function marketFactor() {
  if (!demoMarket) {
    const rand = mulberry32(42);
    demoMarket = businessDays(DEMO_DAYS).map(() => 0.00035 + 0.0105 * gaussian(rand));
  }
  return demoMarket;
}

const demoCache = new Map();
function demoHistory(symbol) {
  if (!demoCache.has(symbol)) demoCache.set(symbol, makeDemoHistory(symbol));
  return demoCache.get(symbol);
}

function makeDemoHistory(symbol) {
  const dates = businessDays(DEMO_DAYS);
  if (symbol === '^IRX') {
    const rand = mulberry32(hashString(symbol));
    let y = 1.5;
    const points = dates.map((date, i) => {
      y = Math.min(5.5, Math.max(0.05, y + 0.02 * gaussian(rand) + (i > 600 && i < 1300 ? 0.004 : -0.0003)));
      return { date, close: y, raw: y };
    });
    return { symbol, source: 'demo', name: '13 Week Treasury Bill', currency: 'USD', points };
  }
  const seed = hashString(symbol);
  const rand = mulberry32(seed);
  const [beta, idio, start] = DEMO_PROFILE[symbol] || [0.6 + (seed % 100) / 100, 0.008, 20 + (seed % 200)];
  const m = marketFactor();
  const drift = symbol === 'BIL' ? 0.00012 : 0.00005 * ((seed % 7) - 2);
  let price = 1;
  const path = dates.map((_, i) => {
    if (i > 0) price *= 1 + beta * m[i] + drift + idio * gaussian(rand);
    return price;
  });
  // Rescale so the latest price lands near a realistic level.
  const k = start / price;
  const points = dates.map((date, i) => ({ date, close: path[i] * k, raw: path[i] * k }));
  return { symbol, source: 'demo', name: symbol, currency: 'USD', points };
}

function demoQuote(symbol, history) {
  const pts = history.points;
  const last = pts[pts.length - 1].raw;
  const prev = pts[pts.length - 2].raw;
  // Small deterministic wiggle that changes every 30s so "live" refresh is visible.
  const tick = mulberry32(hashString(symbol) ^ Math.floor(Date.now() / QUOTE_TTL_MS))();
  const price = last * (1 + (tick - 0.5) * 0.002);
  return {
    symbol, source: 'demo', price, previousClose: prev,
    change: price - prev, changePct: price / prev - 1,
    time: new Date().toISOString(), date: pts[pts.length - 1].date, marketState: 'demo',
  };
}

// ---------------------------------------------------------------- public API

export async function getHistory(symbol) {
  if (DATA_SOURCE === 'demo') return demoHistory(symbol);
  try {
    return await cached(`h:${symbol}`, HISTORY_TTL_MS, () => liveHistory(symbol));
  } catch (err) {
    console.warn(`[data] ${err.message} — using demo history`);
    return demoHistory(symbol);
  }
}

export async function getQuote(symbol, history) {
  if (history.source === 'demo') return demoQuote(symbol, history);
  try {
    return await cached(`q:${symbol}`, QUOTE_TTL_MS, () => liveQuote(symbol));
  } catch (err) {
    console.warn(`[data] ${err.message} — using last close`);
    return demoQuote(symbol, history);
  }
}

// History with today's bar replaced/extended by the live price, converted to
// the adjusted-close scale so returns stay consistent.
export async function getSeries(symbol) {
  const history = await getHistory(symbol);
  const quote = await getQuote(symbol, history);
  const points = history.points.slice();
  const last = points[points.length - 1];
  if (quote.source === 'live' && quote.date) {
    const adjFactor = last.close / last.raw;
    const bar = { date: quote.date, close: quote.price * adjFactor, raw: quote.price };
    if (quote.date === last.date) points[points.length - 1] = bar;
    else if (quote.date > last.date) points.push(bar);
  }
  return { ...history, points, quote };
}
