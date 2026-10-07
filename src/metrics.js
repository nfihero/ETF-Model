// Pure performance / risk statistics. All price inputs are arrays of closes in
// chronological order; return inputs are simple daily returns.

export const TRADING_DAYS = 252;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function variance(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
}

function covariance(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return NaN;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let s = 0;
  for (let i = 0; i < n; i++) s += (xs[i] - mx) * (ys[i] - my);
  return s / (n - 1);
}

export function dailyReturns(prices) {
  const out = [];
  for (let i = 1; i < prices.length; i++) out.push(prices[i] / prices[i - 1] - 1);
  return out;
}

export function totalReturn(prices) {
  if (prices.length < 2) return NaN;
  return prices[prices.length - 1] / prices[0] - 1;
}

export function annualizedReturn(prices) {
  const periods = prices.length - 1;
  if (periods < 1) return NaN;
  return (1 + totalReturn(prices)) ** (TRADING_DAYS / periods) - 1;
}

export function annualizedVolatility(returns) {
  return Math.sqrt(variance(returns) * TRADING_DAYS);
}

// rfDaily: per-day risk-free rate (annual / 252).
export function sharpeRatio(returns, rfDaily = 0) {
  const excess = returns.map((r) => r - rfDaily);
  const sd = Math.sqrt(variance(excess));
  return sd > 0 ? (mean(excess) / sd) * Math.sqrt(TRADING_DAYS) : NaN;
}

export function sortinoRatio(returns, rfDaily = 0) {
  const excess = returns.map((r) => r - rfDaily);
  const downside = Math.sqrt(mean(excess.map((r) => Math.min(r, 0) ** 2)));
  return downside > 0 ? (mean(excess) / downside) * Math.sqrt(TRADING_DAYS) : NaN;
}

// Returns the worst peak-to-trough decline (negative number) and the
// running drawdown series.
export function drawdown(prices) {
  let peak = -Infinity;
  let max = 0;
  const series = prices.map((p) => {
    peak = Math.max(peak, p);
    const dd = p / peak - 1;
    max = Math.min(max, dd);
    return dd;
  });
  return { max, series };
}

export function beta(returns, benchReturns) {
  const v = variance(benchReturns);
  return v > 0 ? covariance(returns, benchReturns) / v : NaN;
}

// Jensen's alpha (CAPM), annualised.
export function jensensAlpha(returns, benchReturns, rfDaily = 0) {
  const b = beta(returns, benchReturns);
  const daily = mean(returns) - rfDaily - b * (mean(benchReturns) - rfDaily);
  return daily * TRADING_DAYS;
}

export function trackingError(returns, benchReturns) {
  const active = returns.map((r, i) => r - benchReturns[i]);
  return Math.sqrt(variance(active) * TRADING_DAYS);
}

export function informationRatio(returns, benchReturns) {
  const active = returns.map((r, i) => r - benchReturns[i]);
  const sd = Math.sqrt(variance(active));
  return sd > 0 ? (mean(active) / sd) * Math.sqrt(TRADING_DAYS) : NaN;
}

export function correlation(xs, ys) {
  const d = Math.sqrt(variance(xs) * variance(ys));
  return d > 0 ? covariance(xs, ys) / d : NaN;
}

// Simple moving average of the last n prices (NaN if not enough data).
export function sma(prices, n) {
  if (prices.length < n) return NaN;
  return mean(prices.slice(-n));
}

// Wilder's RSI.
export function rsi(prices, n = 14) {
  if (prices.length <= n) return NaN;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n;
  loss /= n;
  for (let i = n + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

// Inner-join two {date, close}[] series on date.
export function alignSeries(a, b) {
  const map = new Map(b.map((p) => [p.date, p.close]));
  const dates = [];
  const left = [];
  const right = [];
  for (const p of a) {
    if (map.has(p.date)) {
      dates.push(p.date);
      left.push(p.close);
      right.push(map.get(p.date));
    }
  }
  return { dates, left, right };
}
