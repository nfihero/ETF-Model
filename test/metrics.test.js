import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/metrics.js';
import { buildSignals, compositeScore } from '../src/scoring.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('returns and total return', () => {
  close(M.totalReturn([100, 110, 121]), 0.21);
  assert.deepEqual(M.dailyReturns([100, 110, 99]).map((x) => +x.toFixed(4)), [0.1, -0.1]);
});

test('annualised return over exactly one year of bars', () => {
  const prices = Array.from({ length: 253 }, (_, i) => 100 * 1.1 ** (i / 252));
  close(M.annualizedReturn(prices), 0.1, 1e-9);
});

test('drawdown finds the worst peak-to-trough', () => {
  const { max, series } = M.drawdown([100, 120, 90, 130, 117]);
  close(max, -0.25);
  close(series[4], -0.1);
});

test('beta of a 2x levered series is 2 and alpha is ~0 at zero rf', () => {
  const rb = [0.01, -0.02, 0.015, 0.003, -0.007, 0.012];
  const r = rb.map((x) => 2 * x);
  close(M.beta(r, rb), 2);
  close(M.jensensAlpha(r, rb, 0), 0, 1e-12);
  close(M.correlation(r, rb), 1);
});

test('identical series: zero tracking error, NaN information ratio', () => {
  const r = [0.01, -0.01, 0.02];
  close(M.trackingError(r, r), 0);
  assert.ok(Number.isNaN(M.informationRatio(r, r)));
});

test('sharpe sign follows excess return', () => {
  const r = [0.002, 0.001, 0.003, -0.001, 0.002];
  assert.ok(M.sharpeRatio(r, 0) > 0);
  assert.ok(M.sharpeRatio(r, 0.01) < 0);
});

test('sma and rsi', () => {
  close(M.sma([1, 2, 3, 4], 2), 3.5);
  assert.ok(Number.isNaN(M.sma([1, 2], 3)));
  assert.equal(M.rsi(Array.from({ length: 30 }, (_, i) => i + 1)), 100);
  const down = M.rsi(Array.from({ length: 30 }, (_, i) => 30 - i));
  close(down, 0);
});

test('alignSeries inner-joins on date', () => {
  const a = [{ date: 'd1', close: 1 }, { date: 'd2', close: 2 }, { date: 'd3', close: 3 }];
  const b = [{ date: 'd2', close: 20 }, { date: 'd3', close: 30 }, { date: 'd4', close: 40 }];
  assert.deepEqual(M.alignSeries(a, b), { dates: ['d2', 'd3'], left: [2, 3], right: [20, 30] });
});

const baseMetrics = {
  benchmarkSymbol: 'SPY',
  totalReturn: 0.2, excessReturn: 0.05, sharpe: 1.2, alpha: 0.03, beta: 1,
  informationRatio: 0.6, trackingError: 0.05, maxDrawdown: -0.08, riskFree: 0.04,
  priceVsSma200: 0.06, goldenCross: true, momentum3m: 0.02,
  benchmark: { totalReturn: 0.15, sharpe: 0.9, maxDrawdown: -0.12 },
};

test('strong ETF scores 100 and is favourable', () => {
  const c = compositeScore(buildSignals(baseMetrics));
  assert.equal(c.score, 100);
  assert.equal(c.verdict, 'favorable');
  assert.equal(c.passed, 8);
});

test('weak ETF is unfavourable', () => {
  const weak = {
    ...baseMetrics, totalReturn: 0.02, excessReturn: -0.13, sharpe: 0.1, alpha: -0.05,
    informationRatio: -0.8, maxDrawdown: -0.25, priceVsSma200: -0.05, momentum3m: -0.04,
  };
  const c = compositeScore(buildSignals(weak));
  assert.equal(c.score, 0);
  assert.equal(c.verdict, 'unfavorable');
});

test('missing inputs score neutral instead of failing', () => {
  const s = buildSignals({ ...baseMetrics, priceVsSma200: NaN, goldenCross: null, informationRatio: NaN });
  assert.equal(s.find((x) => x.key === 'trend').score, 0);
  assert.equal(s.find((x) => x.key === 'informationRatio').score, 0);
});
