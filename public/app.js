// ETF Pulse — client. Vanilla JS + hand-rolled SVG charts, no dependencies.

const REFRESH_MS = 60_000;
const $ = (sel) => document.querySelector(sel);
const SVG_NS = 'http://www.w3.org/2000/svg';

// ------------------------------------------------------------------ storage
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`etf-pulse:${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`etf-pulse:${key}`, JSON.stringify(value)); } catch { /* private mode etc. */ }
  },
};

const state = {
  range: store.get('range', '1Y'),
  sort: store.get('sort', 'score'),
  extra: store.get('extra', []),       // ["TSLA:QQQ", ...]
  data: null,
  tableSort: { key: 'score', dir: -1 },
  openSymbol: null,
};

// ------------------------------------------------------------------ format
const fmtPct = (x, d = 1, sign = true) => (x == null ? '—' : `${sign && x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const fmtNum = (x, d = 2) => (x == null ? '—' : x.toFixed(d));
const fmtPrice = (x, ccy = 'USD') => (x == null ? '—'
  : new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, maximumFractionDigits: 2 }).format(x));
const signClass = (x) => (x == null || Math.abs(x) < 1e-9 ? '' : x > 0 ? 'pos' : 'neg');
const fmtDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const VERDICT = {
  favorable: { label: 'Favorable', icon: '<path d="M7 1.5 13 12H1z"/>' },
  neutral: { label: 'Neutral', icon: '<circle cx="7" cy="7" r="5"/>' },
  unfavorable: { label: 'Unfavorable', icon: '<path d="M7 12.5 1 2h12z"/>' },
};
const badge = (c) => `<span class="badge ${c.verdict}">
  <svg viewBox="0 0 14 14" aria-hidden="true">${VERDICT[c.verdict].icon}</svg>
  ${VERDICT[c.verdict].label} <span class="score num">${c.score}</span></span>`;
const gauge = (c) => `<div class="gauge" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${c.score}" aria-label="Score ${c.score} of 100">
  <div class="fill ${c.verdict}" style="width:${Math.max(2, c.score)}%"></div>
  <span class="tick" style="left:35%"></span><span class="tick" style="left:65%"></span></div>`;

const RESULT = {
  1: { cls: 'pass', label: 'Pass', icon: '<path d="M2 6.5 5 9.5 10 3" stroke="currentColor" fill="none"/><circle cx="6" cy="6" r="6"/>' },
  0: { cls: 'tie', label: 'Neutral', icon: '<rect x="1" y="4.5" width="10" height="3" rx="1.5"/>' },
  '-1': { cls: 'fail', label: 'Fail', icon: '<path d="M6 0 12 6 6 12 0 6z"/>' },
};

// ------------------------------------------------------------------ theme
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
applyTheme(store.get('theme', null));
$('#theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  store.set('theme', next);
  render(); // charts read CSS variables at draw time
});

// ------------------------------------------------------------------ data
let inflight = null;
async function load({ quiet = false } = {}) {
  if (inflight) inflight.abort();
  inflight = new AbortController();
  $('#refresh').classList.add('spinning');
  if (!quiet) $('#grid').setAttribute('aria-busy', 'true');
  try {
    const qs = new URLSearchParams({ range: state.range });
    if (state.extra.length) qs.set('add', state.extra.join(','));
    const res = await fetch(`/api/dashboard?${qs}`, { signal: inflight.signal });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    state.data = body;
    render();
  } catch (err) {
    if (err.name === 'AbortError') return;
    showErrors([{ symbol: 'Dashboard', message: err.message }]);
  } finally {
    $('#refresh').classList.remove('spinning');
    $('#grid').setAttribute('aria-busy', 'false');
  }
}

function showErrors(errors) {
  const box = $('#errors');
  box.hidden = !errors.length;
  box.innerHTML = errors.map((e) => `<div><strong>${esc(e.symbol)}</strong>: ${esc(e.message)}</div>`).join('');
}

// ------------------------------------------------------------------ render
function render() {
  const d = state.data;
  if (!d) return;
  renderRanges(d.ranges);
  renderStatus(d);
  renderSummary(d);
  showErrors(d.errors);
  renderGrid(sortEtfs(d.etfs, state.sort));
  renderTable(d.etfs);
  renderMethod(d.etfs[0]);
  if (state.openSymbol) {
    const etf = d.etfs.find((e) => e.symbol === state.openSymbol);
    if (etf && $('#detail').open) renderDetail(etf);
  }
}

function renderRanges(ranges) {
  const box = $('#ranges');
  box.innerHTML = ranges.map((r) => `<button role="radio" aria-checked="${r === state.range}" data-range="${r}">${r}</button>`).join('');
}
$('#ranges').addEventListener('click', (e) => {
  const r = e.target.closest('button')?.dataset.range;
  if (!r || r === state.range) return;
  state.range = r;
  store.set('range', r);
  renderRanges(state.data?.ranges || []);
  load();
});

function renderStatus(d) {
  const pill = $('#source-pill');
  const live = d.dataSource === 'live';
  const anyOpen = d.etfs.some((e) => e.quote?.marketState === 'open');
  pill.className = `pill ${live ? 'live' : 'demo'}`;
  pill.innerHTML = `<span class="dot"></span>${live ? (anyOpen ? 'Live · market open' : 'Live · market closed')
    : d.dataSource === 'mixed' ? 'Partly demo data' : 'Demo data'}`;
  pill.title = live ? 'Prices from Yahoo Finance, refreshed every 60s'
    : 'Yahoo Finance was unreachable for some or all symbols; showing synthetic data';
  $('#updated').textContent = `Updated ${new Date(d.generatedAt).toLocaleTimeString()}`;
}

function renderSummary(d) {
  const count = (v) => d.etfs.filter((e) => e.composite.verdict === v).length;
  const best = [...d.etfs].sort((a, b) => b.composite.score - a.composite.score)[0];
  const tile = (verdict, n) => `<div class="tile">
      <div class="label"><svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true" style="fill:var(--${verdict === 'favorable' ? 'good' : verdict === 'neutral' ? 'warning' : 'critical'})">${VERDICT[verdict].icon}</svg>${VERDICT[verdict].label}</div>
      <div class="value">${n}</div><div class="hint">of ${d.etfs.length} ETFs · ${d.range}</div></div>`;
  $('#summary').innerHTML = tile('favorable', count('favorable')) + tile('neutral', count('neutral'))
    + tile('unfavorable', count('unfavorable'))
    + `<div class="tile"><div class="label">Risk-free rate (13-wk T-bill)</div>
        <div class="value">${(d.riskFree.rate * 100).toFixed(2)}%</div>
        <div class="hint">Top score: ${best ? `${esc(best.symbol)} (${best.composite.score})` : '—'}</div></div>`;
}

function sortEtfs(etfs, key) {
  const by = {
    score: (e) => -e.composite.score,
    return: (e) => -(e.metrics.totalReturn ?? -Infinity),
    excess: (e) => -(e.metrics.excessReturn ?? -Infinity),
    day: (e) => -(e.quote?.changePct ?? -Infinity),
    symbol: (e) => e.symbol,
  }[key];
  return [...etfs].sort((a, b) => (by(a) < by(b) ? -1 : by(a) > by(b) ? 1 : 0));
}
$('#sort').value = state.sort;
$('#sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  store.set('sort', state.sort);
  render();
});

function deltaHtml(q) {
  if (!q || q.changePct == null) return '';
  const dir = Math.abs(q.changePct) < 1e-6 ? 'flat' : q.changePct > 0 ? 'up' : 'down';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■';
  return `<span class="delta ${dir} num">${arrow} ${fmtPct(q.changePct, 2)} today</span>`;
}

function renderGrid(etfs) {
  const grid = $('#grid');
  grid.innerHTML = etfs.map((e) => {
    const m = e.metrics;
    const removable = state.extra.some((x) => x.split(':')[0] === e.symbol);
    return `<article class="card" tabindex="0" data-symbol="${esc(e.symbol)}" aria-label="${esc(e.symbol)} details">
      <div class="card-head">
        <div>
          <div class="ticker">${esc(e.symbol)}</div>
          <div class="name" title="${esc(e.name)}">${esc(e.name)}</div>
          <span class="chip">${esc(e.category || 'ETF')}</span>
        </div>
        ${badge(e.composite)}
      </div>
      <div class="price-row"><span class="price num">${fmtPrice(e.quote?.price)}</span>${deltaHtml(e.quote)}</div>
      <div>
        <svg class="spark" data-spark="${esc(e.symbol)}" preserveAspectRatio="none" aria-hidden="true"></svg>
        <div class="spark-legend"><span class="key"><i class="etf"></i>${esc(e.symbol)}</span><span class="key"><i class="bench"></i>${esc(e.benchmark)} (benchmark)</span></div>
      </div>
      <div class="checks" title="${e.composite.passed} passed · ${e.composite.failed} failed of ${e.composite.total} benchmark tests">
        ${e.signals.map((s) => `<span class="check ${RESULT[s.score].cls}"></span>`).join('')}
      </div>
      <div class="stats">
        <div class="stat"><div class="k">${state.range} return</div><div class="v num ${signClass(m.totalReturn)}">${fmtPct(m.totalReturn)}</div></div>
        <div class="stat"><div class="k">vs ${esc(e.benchmark)}</div><div class="v num ${signClass(m.excessReturn)}">${fmtPct(m.excessReturn)}</div></div>
        <div class="stat"><div class="k">Sharpe</div><div class="v num">${fmtNum(m.sharpe)}</div></div>
        <div class="stat"><div class="k">Max DD</div><div class="v num">${fmtPct(m.maxDrawdown, 1, false)}</div></div>
      </div>
      ${removable ? `<button class="chip" data-remove="${esc(e.symbol)}" style="position:absolute;right:16px;bottom:-10px;border:1px solid var(--border);cursor:pointer">Remove</button>` : ''}
    </article>`;
  }).join('');
  for (const svg of grid.querySelectorAll('[data-spark]')) {
    const e = etfs.find((x) => x.symbol === svg.dataset.spark);
    drawSparkline(svg, e.chart);
  }
}
$('#grid').addEventListener('click', (ev) => {
  const rm = ev.target.closest('[data-remove]');
  if (rm) {
    ev.stopPropagation();
    state.extra = state.extra.filter((x) => x.split(':')[0] !== rm.dataset.remove);
    store.set('extra', state.extra);
    load();
    return;
  }
  const card = ev.target.closest('.card');
  if (card) openDetail(card.dataset.symbol);
});
$('#grid').addEventListener('keydown', (ev) => {
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.classList.contains('card')) {
    ev.preventDefault();
    openDetail(ev.target.dataset.symbol);
  }
});

// ------------------------------------------------------------------ table
const COLUMNS = [
  { key: 'symbol', label: 'ETF', get: (e) => e.symbol, fmt: (v, e) => `<strong>${esc(v)}</strong> <span class="muted small">vs ${esc(e.benchmark)}</span>` },
  { key: 'score', label: 'Score', get: (e) => e.composite.score, fmt: (v, e) => badge(e.composite) },
  { key: 'price', label: 'Price', get: (e) => e.quote?.price, fmt: (v) => fmtPrice(v) },
  { key: 'day', label: 'Today', get: (e) => e.quote?.changePct, fmt: (v) => `<span class="${signClass(v)}">${fmtPct(v, 2)}</span>` },
  { key: 'ret', label: 'Return', get: (e) => e.metrics.totalReturn, fmt: (v) => `<span class="${signClass(v)}">${fmtPct(v)}</span>` },
  { key: 'excess', label: 'vs Bench', get: (e) => e.metrics.excessReturn, fmt: (v) => `<span class="${signClass(v)}">${fmtPct(v)}</span>` },
  { key: 'vol', label: 'Volatility', get: (e) => e.metrics.volatility, fmt: (v) => fmtPct(v, 1, false) },
  { key: 'sharpe', label: 'Sharpe', get: (e) => e.metrics.sharpe, fmt: (v) => fmtNum(v) },
  { key: 'sortino', label: 'Sortino', get: (e) => e.metrics.sortino, fmt: (v) => fmtNum(v) },
  { key: 'alpha', label: 'Alpha', get: (e) => e.metrics.alpha, fmt: (v) => `<span class="${signClass(v)}">${fmtPct(v)}</span>` },
  { key: 'beta', label: 'Beta', get: (e) => e.metrics.beta, fmt: (v) => fmtNum(v) },
  { key: 'ir', label: 'Info ratio', get: (e) => e.metrics.informationRatio, fmt: (v) => fmtNum(v) },
  { key: 'dd', label: 'Max DD', get: (e) => e.metrics.maxDrawdown, fmt: (v) => fmtPct(v, 1, false) },
  { key: 'rsi', label: 'RSI 14', get: (e) => e.metrics.rsi14, fmt: (v) => fmtNum(v, 0) },
];

function renderTable(etfs) {
  const { key, dir } = state.tableSort;
  const col = COLUMNS.find((c) => c.key === key);
  const rows = [...etfs].sort((a, b) => {
    const x = col.get(a); const y = col.get(b);
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
  $('#table').innerHTML = `<thead><tr>${COLUMNS.map((c) => `<th class="sortable" data-key="${c.key}" ${c.key === key ? `aria-sort="${dir > 0 ? 'ascending' : 'descending'}"` : ''}>${c.label}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((e) => `<tr data-symbol="${esc(e.symbol)}">${COLUMNS.map((c) => `<td>${c.fmt(c.get(e), e)}</td>`).join('')}</tr>`).join('')}</tbody>`;
}
$('#table').addEventListener('click', (ev) => {
  const th = ev.target.closest('th[data-key]');
  if (th) {
    const k = th.dataset.key;
    state.tableSort = { key: k, dir: state.tableSort.key === k ? -state.tableSort.dir : k === 'symbol' ? 1 : -1 };
    renderTable(state.data.etfs);
    return;
  }
  const tr = ev.target.closest('tr[data-symbol]');
  if (tr) openDetail(tr.dataset.symbol);
});

function renderMethod(sample) {
  if (!sample) return;
  $('#method-list').innerHTML = sample.signals.map((s) =>
    `<li><strong>${esc(s.label)}</strong> · weight ${s.weight}<br>${esc(s.rule)}</li>`).join('');
}

// ------------------------------------------------------------------ add ticker
$('#add-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const sym = $('#add-symbol').value.trim().toUpperCase();
  const bench = ($('#add-bench').value.trim() || 'SPY').toUpperCase();
  if (!/^[A-Z0-9^.=-]{1,12}$/.test(sym) || !/^[A-Z0-9^.=-]{1,12}$/.test(bench)) return;
  state.extra = [...state.extra.filter((x) => x.split(':')[0] !== sym), `${sym}:${bench}`];
  store.set('extra', state.extra);
  $('#add-symbol').value = '';
  $('#add-bench').value = '';
  load();
});

// ------------------------------------------------------------------ detail
function openDetail(symbol) {
  const etf = state.data.etfs.find((e) => e.symbol === symbol);
  if (!etf) return;
  state.openSymbol = symbol;
  const dlg = $('#detail');
  if (!dlg.open) dlg.showModal();
  renderDetail(etf);
}
$('#detail').addEventListener('close', () => { state.openSymbol = null; hideTooltip(); });
$('#detail').addEventListener('click', (ev) => {
  if (ev.target === ev.currentTarget || ev.target.closest('[data-close]')) $('#detail').close();
});

function renderDetail(e) {
  const m = e.metrics;
  const b = m.benchmark;
  const row = (label, a, bv, fmt) => `<tr><td>${label}</td><td>${fmt(a)}</td><td>${fmt(bv)}</td></tr>`;
  $('#detail-body').innerHTML = `
    <div class="detail-head">
      <div>
        <h2 id="detail-title">${esc(e.symbol)} <span class="muted" style="font-weight:500;font-size:15px">${esc(e.name)}</span></h2>
        <div class="price-row" style="margin-top:4px"><span class="price num">${fmtPrice(e.quote?.price)}</span>${deltaHtml(e.quote)}</div>
        <div class="muted small">${esc(e.category)} · benchmark ${esc(e.benchmark)} · ${e.source === 'live' ? 'live data' : 'demo data'} · ${state.range} window</div>
      </div>
      <div style="display:flex;align-items:flex-start">
        <div class="detail-score">
          <div class="big num">${e.composite.score}</div>
          <div style="flex:1">${badge(e.composite)}<div style="margin-top:8px">${gauge(e.composite)}</div>
          <div class="muted small" style="margin-top:4px">${e.composite.passed} passed · ${e.composite.failed} failed · ${e.composite.total - e.composite.passed - e.composite.failed} neutral</div></div>
        </div>
        <button class="icon-btn close" data-close aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </div>
    </div>

    <div class="panel">
      <h3>Growth of 100</h3>
      <p class="muted">Total return, indexed to 100 at the start of the window</p>
      <div class="legend"><span class="key"><i class="etf"></i>${esc(e.symbol)}</span><span class="key"><i class="bench"></i>${esc(e.benchmark)}</span></div>
      <svg class="chart" id="perf-chart" role="img" aria-label="${esc(e.symbol)} versus ${esc(e.benchmark)} growth of 100"></svg>
    </div>

    <div class="two">
      <div class="panel">
        <h3>Drawdown</h3>
        <p class="muted">Decline from running peak</p>
        <div class="legend"><span class="key"><i class="etf"></i>${esc(e.symbol)}</span><span class="key"><i class="bench"></i>${esc(e.benchmark)}</span></div>
        <svg class="chart" id="dd-chart" role="img" aria-label="Drawdown chart"></svg>
      </div>
      <div class="panel">
        <h3>Risk & return</h3>
        <p class="muted">Selected window; risk-free ${fmtPct(m.riskFree, 2, false)}</p>
        <table class="data">
          <thead><tr><th>Metric</th><th>${esc(e.symbol)}</th><th>${esc(e.benchmark)}</th></tr></thead>
          <tbody>
            ${row('Total return', m.totalReturn, b.totalReturn, (v) => `<span class="${signClass(v)}">${fmtPct(v)}</span>`)}
            ${row('Annualised return', m.annualizedReturn, b.annualizedReturn, (v) => fmtPct(v))}
            ${row('Volatility', m.volatility, b.volatility, (v) => fmtPct(v, 1, false))}
            ${row('Sharpe', m.sharpe, b.sharpe, (v) => fmtNum(v))}
            ${row('Sortino', m.sortino, b.sortino, (v) => fmtNum(v))}
            ${row('Max drawdown', m.maxDrawdown, b.maxDrawdown, (v) => fmtPct(v, 1, false))}
            <tr><td>Beta · correlation</td><td>${fmtNum(m.beta)} · ${fmtNum(m.correlation)}</td><td>1.00 · 1.00</td></tr>
            <tr><td>RSI(14)</td><td>${fmtNum(m.rsi14, 0)}</td><td>—</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <h3>Benchmark tests</h3>
      <p class="muted">What drives the score</p>
      <div class="scroll-x"><table class="data">
        <thead><tr><th>Test</th><th>Compared against</th><th>Result</th><th>Value</th><th style="text-align:left">Detail</th><th>Weight</th></tr></thead>
        <tbody>${e.signals.map((s) => {
          const r = RESULT[s.score];
          return `<tr style="cursor:default"><td><strong>${esc(s.label)}</strong></td><td>${esc(s.against)}</td>
            <td><span class="signal-result ${r.cls}"><svg viewBox="0 0 12 12" aria-hidden="true">${r.icon}</svg>${r.label}</span></td>
            <td class="num">${esc(s.display)}</td><td class="wrap">${esc(s.detail)}</td><td>${s.weight}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>`;

  const c = e.chart;
  lineChart($('#perf-chart'), {
    dates: c.dates, height: 260,
    series: [
      { name: e.symbol, values: c.etf, color: 'var(--series-1)' },
      { name: e.benchmark, values: c.bench, color: 'var(--series-2)' },
    ],
    fmt: (v) => v.toFixed(1), baseline: 100, endLabels: true,
  });
  lineChart($('#dd-chart'), {
    dates: c.dates, height: 180,
    series: [
      { name: e.symbol, values: c.drawdown, color: 'var(--series-1)', area: true },
      { name: e.benchmark, values: c.benchDrawdown, color: 'var(--series-2)' },
    ],
    fmt: (v) => `${(v * 100).toFixed(1)}%`, baseline: 0, maxZero: true,
  });
}

// ------------------------------------------------------------------ charts
const el = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => span / s <= count) || 10 * mag;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) ticks.push(+t.toFixed(10));
  return ticks;
}

function drawSparkline(svg, chart) {
  const w = 300; const h = 64; const pad = 3;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.innerHTML = '';
  const all = chart.etf.concat(chart.bench);
  const min = Math.min(...all); const max = Math.max(...all);
  const x = (i) => (i / Math.max(1, chart.etf.length - 1)) * w;
  const y = (v) => h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
  const path = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  svg.append(el('line', { x1: 0, x2: w, y1: y(100), y2: y(100), stroke: 'var(--grid)', 'stroke-dasharray': '3 3', 'vector-effect': 'non-scaling-stroke' }));
  // Soft area under the ETF line.
  const area = el('path', { d: `${path(chart.etf)}L${w},${h}L0,${h}Z`, fill: 'var(--series-1)', opacity: 0.08 });
  svg.append(area);
  svg.append(el('path', { d: path(chart.bench), fill: 'none', stroke: 'var(--series-2)', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke', opacity: 0.9 }));
  svg.append(el('path', { d: path(chart.etf), fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }));
}

function lineChart(svg, opt) {
  const width = Math.max(280, svg.clientWidth || svg.parentElement.clientWidth);
  const height = opt.height;
  const m = { top: 10, right: opt.endLabels ? 56 : 12, bottom: 24, left: 54 };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('height', height);
  svg.innerHTML = '';

  const n = opt.dates.length;
  const all = opt.series.flatMap((s) => s.values);
  let min = Math.min(...all, opt.baseline ?? Infinity);
  let max = opt.maxZero ? 0 : Math.max(...all, opt.baseline ?? -Infinity);
  const padY = (max - min) * 0.06 || 1;
  min -= padY; if (!opt.maxZero) max += padY;
  const iw = width - m.left - m.right;
  const ih = height - m.top - m.bottom;
  const x = (i) => m.left + (i / Math.max(1, n - 1)) * iw;
  const y = (v) => m.top + (1 - (v - min) / (max - min || 1)) * ih;

  for (const t of niceTicks(min, max, 4)) {
    svg.append(el('line', { class: t === opt.baseline ? 'baseline' : 'grid-line', x1: m.left, x2: m.left + iw, y1: y(t), y2: y(t) }));
    const label = el('text', { x: m.left - 8, y: y(t) + 4, 'text-anchor': 'end' });
    label.textContent = opt.fmt(t);
    svg.append(label);
  }
  const xTicks = Math.min(5, n);
  for (let k = 0; k < xTicks; k++) {
    const i = Math.round((k / Math.max(1, xTicks - 1)) * (n - 1));
    const label = el('text', { x: x(i), y: height - 6, 'text-anchor': k === 0 ? 'start' : k === xTicks - 1 ? 'end' : 'middle' });
    label.textContent = new Date(`${opt.dates[i]}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: '2-digit', ...(n < 130 ? { day: 'numeric' } : {}) });
    svg.append(label);
  }

  // Draw benchmark first so the ETF sits on top.
  for (const s of [...opt.series].reverse()) {
    const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    if (s.area) svg.append(el('path', { d: `${d}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`, fill: s.color, opacity: 0.12 }));
    svg.append(el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }

  if (opt.endLabels) {
    // Direct labels at line ends, nudged apart if they collide.
    const ends = opt.series.map((s) => ({ s, y: y(s.values[n - 1]) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    for (const { s, y: ly } of ends) {
      svg.append(el('circle', { cx: x(n - 1), cy: y(s.values[n - 1]), r: 3.5, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 }));
      const t = el('text', { x: x(n - 1) + 8, y: ly + 4, class: 'end-label' });
      t.textContent = s.name;
      svg.append(t);
    }
  }

  // Hover layer: crosshair + dots + tooltip.
  const cross = el('line', { class: 'crosshair', y1: m.top, y2: m.top + ih, visibility: 'hidden' });
  const dots = opt.series.map((s) => el('circle', { r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }));
  svg.append(cross, ...dots);
  const hit = el('rect', { x: m.left, y: m.top, width: iw, height: ih, fill: 'transparent' });
  svg.append(hit);
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * width;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.left) / iw) * (n - 1))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    opt.series.forEach((s, k) => {
      dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(s.values[i])); dots[k].setAttribute('visibility', 'visible');
    });
    showTooltip(ev.clientX, ev.clientY, `<div class="t-date">${fmtDate(opt.dates[i])}</div>${opt.series.map((s) =>
      `<div class="t-row"><span><i style="width:10px;height:2px;background:${s.color};display:inline-block;border-radius:2px"></i>${esc(s.name)}</span><strong>${opt.fmt(s.values[i])}</strong></div>`).join('')}`);
  };
  const leave = () => {
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
    hideTooltip();
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', leave);
}

function showTooltip(cx, cy, html) {
  const tip = $('#tooltip');
  // Inside a modal <dialog> the top layer hides body-level elements, so host it there.
  const host = $('#detail').open ? $('#detail') : document.body;
  if (tip.parentElement !== host) host.append(tip);
  tip.innerHTML = html;
  tip.hidden = false;
  const { width, height } = tip.getBoundingClientRect();
  const left = cx + 14 + width > innerWidth ? cx - width - 14 : cx + 14;
  const top = Math.min(innerHeight - height - 8, Math.max(8, cy - height / 2));
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
function hideTooltip() { $('#tooltip').hidden = true; }

// ------------------------------------------------------------------ boot
function skeleton() {
  $('#grid').innerHTML = Array.from({ length: 6 }, () => '<div class="card skeleton"></div>').join('');
}
let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const etf = state.data?.etfs.find((e) => e.symbol === state.openSymbol);
    if (etf && $('#detail').open) renderDetail(etf);
  }, 150);
});
$('#refresh').addEventListener('click', () => load({ quiet: true }));
document.addEventListener('visibilitychange', () => { if (!document.hidden) load({ quiet: true }); });
setInterval(() => { if (!document.hidden) load({ quiet: true }); }, REFRESH_MS);

skeleton();
load();
