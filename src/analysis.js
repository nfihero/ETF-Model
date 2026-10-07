import { ETFS, RANGES, RISK_FREE_SYMBOL } from './config.js';
import { getSeries } from './data.js';
import * as M from './metrics.js';
import { buildSignals, compositeScore } from './scoring.js';

// Index of the first point inside the window (the bar before the window is
// kept as the base so a 1M return spans 21 daily moves).
function windowStart(dates, range) {
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
