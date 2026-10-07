import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_SOURCE = 'demo';
const { buildDashboard } = await import('../src/analysis.js');

test('dashboard builds for every range with demo data', async () => {
  for (const range of ['1M', '3M', '6M', 'YTD', '1Y', '3Y', '5Y']) {
    const d = await buildDashboard({ range, extra: [{ symbol: 'TSLA', benchmark: 'QQQ', category: 'Custom' }] });
    assert.equal(d.dataSource, 'demo');
    assert.deepEqual(d.errors, []);
    assert.equal(d.etfs.length, 11);
    for (const e of d.etfs) {
      assert.ok(e.composite.score >= 0 && e.composite.score <= 100);
      assert.equal(e.chart.etf[0], 100);
      assert.equal(e.chart.dates.length, e.chart.bench.length);
      assert.equal(e.signals.length, 8);
      assert.ok(Number.isFinite(e.quote.price));
    }
  }
});

test('1Y window spans 252 daily moves', async () => {
  const d = await buildDashboard({ range: '1Y' });
  assert.equal(d.etfs[0].chart.dates.length, 253);
});

test('ETF detail has history, trailing returns and alt-benchmark scorecards', async () => {
  const { buildEtfDetail } = await import('../src/analysis.js');
  const d = await buildEtfDetail({ symbol: 'QQQ' });
  assert.equal(d.benchmark, 'SPY');
  assert.equal(d.history.dates.length, d.history.price.length);
  assert.equal(d.history.sma200.length, d.history.price.length);
  assert.deepEqual(d.trailing.map((t) => t.range), ['1M', '3M', '6M', 'YTD', '1Y', '3Y', '5Y']);
  assert.ok(d.trailing.find((t) => t.range === '5Y').annualized);
  assert.ok(d.monthly.every((row) => row.months.length === 12));
  assert.equal(d.rollingExcess.dates.length, d.rollingExcess.values.length);
  // Primary benchmark first, then the shared yardsticks, never the ETF itself.
  const syms = d.scorecards['1Y'].map((s) => s.symbol);
  assert.deepEqual(syms, ['SPY', 'VT', 'AGG', 'BIL']);
  assert.ok(d.scorecards['1Y'][0].isPrimary);
});

test('custom benchmark override is respected', async () => {
  const { buildEtfDetail } = await import('../src/analysis.js');
  const d = await buildEtfDetail({ symbol: 'TSLA', benchmark: 'QQQ' });
  assert.equal(d.benchmark, 'QQQ');
  assert.equal(d.scorecards['1Y'][0].symbol, 'QQQ');
});
