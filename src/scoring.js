// Turns raw metrics into a set of benchmark tests and a composite verdict.
// Each signal scores +1 (favourable), 0 (neutral) or -1 (unfavourable) and is
// weighted; the composite maps the weighted mean from [-1, 1] onto [0, 100].

export const VERDICT_THRESHOLDS = { favorable: 65, unfavorable: 35 };

const pct = (x, d = 1) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
const num = (x, d = 2) => x.toFixed(d);

// Three-way classification with a dead-band around zero.
const band = (x, hi, lo = -hi) => (x > hi ? 1 : x < lo ? -1 : 0);

export function buildSignals(m) {
  const b = m.benchmarkSymbol;
  const signals = [
    {
      key: 'relativeReturn',
      rule: 'Total return beats the category benchmark by more than 1 pt',
      label: 'Return vs benchmark',
      against: b,
      weight: 2,
      value: m.excessReturn,
      display: pct(m.excessReturn),
      detail: `${pct(m.totalReturn)} vs ${pct(m.benchmark.totalReturn)} for ${b}`,
      score: band(m.excessReturn, 0.01),
    },
    {
      key: 'relativeSharpe',
      rule: 'Sharpe ratio beats the benchmark’s by more than 0.10',
      label: 'Risk-adjusted return vs benchmark',
      against: `${b} Sharpe`,
      weight: 2,
      value: m.sharpe - m.benchmark.sharpe,
      display: `${num(m.sharpe)} vs ${num(m.benchmark.sharpe)}`,
      detail: 'Sharpe ratio difference; ±0.10 is treated as a tie',
      score: band(m.sharpe - m.benchmark.sharpe, 0.1),
    },
    {
      key: 'absoluteSharpe',
      rule: 'Sharpe ratio vs T-bills: ≥ 0.75 passes, < 0.25 fails',
      label: 'Compensation over cash',
      against: `T-bills (${pct(m.riskFree, 2)})`,
      weight: 1.5,
      value: m.sharpe,
      display: `Sharpe ${num(m.sharpe)}`,
      detail: 'Sharpe ≥ 0.75 is favourable; below 0.25 the risk is poorly paid',
      score: m.sharpe >= 0.75 ? 1 : m.sharpe < 0.25 ? -1 : 0,
    },
    {
      key: 'alpha',
      rule: 'CAPM alpha above +1%/yr passes, below −1%/yr fails',
      label: "Jensen's alpha (CAPM)",
      against: b,
      weight: 1.5,
      value: m.alpha,
      display: `${pct(m.alpha)} / yr`,
      detail: `Return beyond what beta ${num(m.beta)} to ${b} explains`,
      score: band(m.alpha, 0.01),
    },
    {
      key: 'informationRatio',
      rule: 'Active return per unit of tracking error beyond ±0.3',
      label: 'Information ratio',
      against: b,
      weight: 1,
      value: m.informationRatio,
      display: num(m.informationRatio),
      detail: `Consistency of out-performance; tracking error ${pct(m.trackingError).replace('+', '')}`,
      score: band(m.informationRatio, 0.3),
    },
    {
      key: 'drawdown',
      rule: 'Worst peak-to-trough decline at least 2 pts shallower than benchmark',
      label: 'Drawdown vs benchmark',
      against: `${b} max drawdown`,
      weight: 1,
      value: m.maxDrawdown - m.benchmark.maxDrawdown,
      display: `${pct(m.maxDrawdown)} vs ${pct(m.benchmark.maxDrawdown)}`,
      detail: 'Shallower worst decline is favourable; ±2 pts is a tie',
      score: band(m.maxDrawdown - m.benchmark.maxDrawdown, 0.02),
    },
    {
      key: 'trend',
      rule: 'Price more than 1% above its 200-day moving average',
      label: 'Long-term trend',
      against: '200-day average',
      weight: 1,
      value: m.priceVsSma200,
      display: Number.isFinite(m.priceVsSma200) ? `${pct(m.priceVsSma200)} vs SMA200` : 'n/a',
      detail: m.goldenCross == null ? 'Not enough history for a 200-day average'
        : m.goldenCross ? '50-day average is above the 200-day (golden cross)'
          : '50-day average is below the 200-day (death cross)',
      score: Number.isFinite(m.priceVsSma200) ? band(m.priceVsSma200, 0.01) : 0,
    },
    {
      key: 'momentum',
      rule: 'Trailing 3-month return beats the benchmark by more than 1 pt',
      label: '3-month relative momentum',
      against: b,
      weight: 1,
      value: m.momentum3m,
      display: Number.isFinite(m.momentum3m) ? pct(m.momentum3m) : 'n/a',
      detail: 'Trailing 3-month return minus benchmark’s',
      score: Number.isFinite(m.momentum3m) ? band(m.momentum3m, 0.01) : 0,
    },
  ];

  // A signal with a non-finite input carries no information.
  for (const s of signals) if (!Number.isFinite(s.value)) s.score = 0;
  return signals;
}

export function compositeScore(signals) {
  const totalWeight = signals.reduce((a, s) => a + s.weight, 0);
  const weighted = signals.reduce((a, s) => a + s.weight * s.score, 0);
  const score = Math.round(50 + 50 * (weighted / totalWeight));
  const verdict = score >= VERDICT_THRESHOLDS.favorable ? 'favorable'
    : score <= VERDICT_THRESHOLDS.unfavorable ? 'unfavorable' : 'neutral';
  return {
    score,
    verdict,
    passed: signals.filter((s) => s.score > 0).length,
    failed: signals.filter((s) => s.score < 0).length,
    total: signals.length,
  };
}
