import { ETFS, RANGES, RISK_FREE_SYMBOL } from './config.js';
import { getSeries } from './data.js';
import * as M from './metrics.js';
import { buildSignals, compositeScore } from './scoring.js';

// Index of the first point inside the window (the bar before the window is
// kept as the base so a 1M return spans 21 daily moves).
export function windowStart(dates, range) {
  const spec = RANGES[range];
  if (spec === 'ytd') {
    const jan1 = `${dates[dates.length - 1].slice(0, 4)}-01-01`;
    const i = dates.findIndex((d) => d >= jan1);
    return Math.max(0, i - 1);
  }
  return Math.max(0, dates.length - 1 - spec);
}

function riskFreeRate(rfSeries, fromDate) {
  const ys = rfSeries.points.filter((p) => p.date >= fromDate).map((p) => p.close);
  const avg = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : rfSeries.points.at(-1).close;
  return avg / 100;
}

function seriesStats(prices, rfDaily) {
  const r = M.dailyReturns(prices);
  return {
    totalReturn: M.totalReturn(prices),
    annualizedReturn: M.annualizedReturn(prices),
    volatility: M.annualizedVolatility(r),
    sharpe: M.sharpeRatio(r, rfDaily),
    sortino: M.sortinoRatio(r, rfDaily),
    maxDrawdown: M.drawdown(prices).max,
  };
}

const finite = (x) => (Number.isFinite(x) ? x : null);
const round = (xs, d = 4) => xs.map((x) => Math.round(x * 10 ** d) / 10 ** d);

export function analyze(etf, etfSeries, benchSeries, rfSeries, range) {
  const { dates, left, right } = M.alignSeries(etfSeries.points, benchSeries.points);
  if (dates.length < 3) throw new Error(`${etf.symbol}: not enough overlapping history with ${etf.benchmark}`);

  const start = windowStart(dates, range);
  const wDates = dates.slice(start);
  const p = left.slice(start);
  const b = right.slice(start);
  const rf = riskFreeRate(rfSeries, wDates[0]);
  const rfDaily = rf / M.TRADING_DAYS;

  const r = M.dailyReturns(p);
  const rb = M.dailyReturns(b);
  const own = seriesStats(p, rfDaily);
  const bench = seriesStats(b, rfDaily);

  // Trend and momentum always use full history, independent of the window.
  const full = etfSeries.points.map((x) => x.close);
  const last = full[full.length - 1];
  const sma50 = M.sma(full, 50);
  const sma200 = M.sma(full, 200);
  const m3 = Math.min(63, left.length - 1);
  const momentum3m = m3 > 0
    ? M.totalReturn(left.slice(-m3 - 1)) - M.totalReturn(right.slice(-m3 - 1))
    : NaN;

  const metrics = {
    ...own,
    benchmarkSymbol: etf.benchmark,
    benchmark: bench,
    excessReturn: own.totalReturn - bench.totalReturn,
    riskFree: rf,
    beta: M.beta(r, rb),
    alpha: M.jensensAlpha(r, rb, rfDaily),
    correlation: M.correlation(r, rb),
    trackingError: M.trackingError(r, rb),
    informationRatio: M.informationRatio(r, rb),
    rsi14: M.rsi(full, 14),
    sma50,
    sma200,
    priceVsSma200: last / sma200 - 1,
    goldenCross: Number.isFinite(sma200) ? sma50 > sma200 : null,
    momentum3m,
  };

  const signals = buildSignals(metrics);
  const composite = compositeScore(signals);

  // Clean metrics for JSON (NaN -> null).
  const clean = Object.fromEntries(Object.entries(metrics).map(([k, v]) => [
    k, typeof v === 'number' ? finite(v) : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([k2, v2]) => [k2, finite(v2)])) : v,
  ]));

  const dd = M.drawdown(p).series;
  const ddb = M.drawdown(b).series;
  return {
    symbol: etf.symbol,
    name: etf.name || etfSeries.name,
    category: etf.category || '',
    benchmark: etf.benchmark,
    source: etfSeries.source === 'live' && benchSeries.source === 'live' ? 'live' : 'demo',
    quote: etfSeries.quote,
    metrics: clean,
    signals: signals.map((s) => ({ ...s, value: finite(s.value) })),
    composite,
    chart: {
      dates: wDates,
      etf: round(p.map((x) => (x / p[0]) * 100), 3),
      bench: round(b.map((x) => (x / b[0]) * 100), 3),
      drawdown: round(dd),
      benchDrawdown: round(ddb),
    },
  };
}

export async function buildDashboard({ range, extra = [] }) {
  const etfs = [...ETFS];
  for (const e of extra) {
    if (!etfs.some((x) => x.symbol === e.symbol)) etfs.push(e);
  }
  const symbols = new Set([RISK_FREE_SYMBOL]);
  for (const e of etfs) { symbols.add(e.symbol); symbols.add(e.benchmark); }

  const entries = await Promise.all([...symbols].map(async (s) => [s, await getSeries(s)]));
  const data = Object.fromEntries(entries);
  const rf = data[RISK_FREE_SYMBOL];

  const results = [];
  const errors = [];
  for (const etf of etfs) {
    try {
      results.push(analyze(etf, data[etf.symbol], data[etf.benchmark], rf, range));
    } catch (err) {
      errors.push({ symbol: etf.symbol, message: err.message });
    }
  }

  const sources = new Set(results.map((r) => r.source));
  return {
    generatedAt: new Date().toISOString(),
    range,
    ranges: Object.keys(RANGES),
    dataSource: sources.size === 1 ? [...sources][0] : 'mixed',
    riskFree: { symbol: RISK_FREE_SYMBOL, rate: rf.points.at(-1).close / 100, source: rf.source },
    etfs: results,
    errors,
  };
}

// ------------------------------------------------------------------ ETF detail

// Benchmarks every ETF is also scored against, besides its own.
export const ALT_BENCHMARKS = [
  { symbol: 'SPY', label: 'US stock market (S&P 500)' },
  { symbol: 'VT', label: 'Global stock market' },
  { symbol: 'AGG', label: 'US bond market' },
  { symbol: 'BIL', label: 'Cash (T-bills)' },
];
const HISTORY_POINTS = 1261; // ~5 years of daily bars for the price chart

function lookupEtf(symbol, benchmark) {
  const known = ETFS.find((e) => e.symbol === symbol);
  const etf = known ? { ...known } : { symbol, name: symbol, category: 'Custom', benchmark: 'SPY' };
  if (benchmark) etf.benchmark = benchmark;
  return etf;
}

function smaSeries(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function trailingReturns(dates, p, b) {
  return Object.entries(RANGES).map(([range, spec]) => {
    const enough = spec === 'ytd' || dates.length - 1 >= spec;
    if (!enough) return { range, etf: null, bench: null, excess: null, annualized: false };
    const i = windowStart(dates, range);
    const annualize = typeof spec === 'number' && spec > 252;
    const ret = (xs) => (annualize ? M.annualizedReturn(xs.slice(i)) : M.totalReturn(xs.slice(i)));
    const etf = ret(p);
    const bench = ret(b);
    return { range, etf: finite(etf), bench: finite(bench), excess: finite(etf - bench), annualized: annualize };
  });
}

// Year-end to year-end returns; the current year is year-to-date.
function calendarYears(dates, p, b, years = 6) {
  const lastIdx = new Map();
  dates.forEach((d, i) => lastIdx.set(d.slice(0, 4), i));
  const ys = [...lastIdx.keys()];
  const out = [];
  for (let k = 1; k < ys.length; k++) {
    const from = lastIdx.get(ys[k - 1]);
    const to = lastIdx.get(ys[k]);
    out.push({
      year: ys[k],
      ytd: k === ys.length - 1,
      etf: finite(p[to] / p[from] - 1),
      bench: finite(b[to] / b[from] - 1),
    });
  }
  return out.slice(-years);
}

function monthlyReturns(points, years = 5) {
  const monthEnd = new Map(); // "YYYY-MM" -> close
  for (const pt of points) monthEnd.set(pt.date.slice(0, 7), pt.close);
  const keys = [...monthEnd.keys()];
  const byYear = new Map();
  for (let k = 1; k < keys.length; k++) {
    const [y, m] = keys[k].split('-');
    if (!byYear.has(y)) byYear.set(y, new Array(12).fill(null));
    byYear.get(y)[Number(m) - 1] = finite(monthEnd.get(keys[k]) / monthEnd.get(keys[k - 1]) - 1);
  }
  return [...byYear.entries()].slice(-years).reverse().map(([year, months]) => {
    const total = months.reduce((acc, r) => (r == null ? acc : acc * (1 + r)), 1) - 1;
    return { year, months, total: finite(total) };
  });
}

function rollingExcess(dates, p, b, n = 63) {
  const start = Math.max(n, dates.length - HISTORY_POINTS);
  const outDates = [];
  const values = [];
  for (let i = start; i < dates.length; i++) {
    outDates.push(dates[i]);
    values.push(Math.round(((p[i] / p[i - n]) - (b[i] / b[i - n])) * 1e4) / 1e4);
  }
  return { window: n, dates: outDates, values };
}

export async function buildEtfDetail({ symbol, benchmark }) {
  const etf = lookupEtf(symbol, benchmark);
  const alts = [{ symbol: etf.benchmark, label: `Category benchmark` }, ...ALT_BENCHMARKS]
    .filter((a, i, all) => a.symbol !== etf.symbol && all.findIndex((x) => x.symbol === a.symbol) === i);
  const symbols = [...new Set([etf.symbol, RISK_FREE_SYMBOL, ...alts.map((a) => a.symbol)])];
  const data = Object.fromEntries(await Promise.all(symbols.map(async (s) => [s, await getSeries(s)])));
  const own = data[etf.symbol];
  const bench = data[etf.benchmark];
  const rf = data[RISK_FREE_SYMBOL];

  const pts = own.points;
  const raw = pts.map((x) => x.raw);
  const sma50 = smaSeries(raw, 50);
  const sma200 = smaSeries(raw, 200);
  const from = Math.max(0, pts.length - HISTORY_POINTS);
  const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

  const { dates, left, right } = M.alignSeries(pts, bench.points);

  const scorecards = {};
  for (const range of Object.keys(RANGES)) {
    scorecards[range] = alts.map((alt) => {
      try {
        const a = analyze({ ...etf, benchmark: alt.symbol }, own, data[alt.symbol], rf, range);
        return {
          symbol: alt.symbol,
          label: alt.label,
          isPrimary: alt.symbol === etf.benchmark,
          benchReturn: a.metrics.benchmark.totalReturn,
          excessReturn: a.metrics.excessReturn,
          beta: a.metrics.beta,
          correlation: a.metrics.correlation,
          alpha: a.metrics.alpha,
          informationRatio: a.metrics.informationRatio,
          composite: a.composite,
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  return {
    generatedAt: new Date().toISOString(),
    symbol: etf.symbol,
    name: etf.name || own.name,
    category: etf.category,
    benchmark: etf.benchmark,
    source: own.source === 'live' && bench.source === 'live' ? 'live' : 'demo',
    quote: own.quote,
    history: {
      dates: pts.slice(from).map((x) => x.date),
      price: raw.slice(from).map(r2),
      sma50: sma50.slice(from).map(r2),
      sma200: sma200.slice(from).map(r2),
    },
    trailing: trailingReturns(dates, left, right),
    calendarYears: calendarYears(dates, left, right),
    monthly: monthlyReturns(pts),
    rollingExcess: rollingExcess(dates, left, right),
    scorecards,
  };
}
