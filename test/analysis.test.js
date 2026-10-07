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
