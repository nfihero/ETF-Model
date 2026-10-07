// ETF Pulse — client. Vanilla JS + hand-rolled SVG charts, no dependencies.
//
// Runs in two modes, picked automatically:
//   server — talks to `node server.js` (live prices, custom tickers)
//   static — reads pre-built JSON snapshots (the GitHub Pages build)

const $ = (sel) => document.querySelector(sel);
const SVG_NS = 'http://www.w3.org/2000/svg';
const RANGES = ['1M', '3M', '6M', 'YTD', '1Y', '3Y', '5Y'];
const REFRESH_MS = { server: 60_000, static: 5 * 60_000 };

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
  // 'server' | 'static'. The Pages build marks itself static; otherwise detected on first load.
  mode: document.querySelector('meta[name="etf-pulse-mode"]')?.content === 'static' ? 'static' : null,
  range: RANGES.includes(store.get('range', '1Y')) ? store.get('range', '1Y') : '1Y',
  sort: store.get('sort', 'score'),
  extra: store.get('extra', []),       // ["TSLA:QQQ", ...] — server mode only
  data: null,                          // dashboard payload for state.range
  details: new Map(),                  // symbol -> detail payload
  tableSort: { key: 'score', dir: -1 },
  route: { view: 'dashboard' },
};

// ------------------------------------------------------------------ format
const fmtPct = (x, d = 1, sign = true) => (x == null ? '—' : `${sign && x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const fmtNum = (x, d = 2) => (x == null ? '—' : x.toFixed(d));
const fmtPrice = (x, ccy = 'USD') => (x == null ? '—'
  : new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, maximumFractionDigits: 2 }).format(x));
const signClass = (x) => (x == null || Math.abs(x) < 1e-9 ? '' : x > 0 ? 'pos' : 'neg');
const fmtDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pctCell = (v, d = 1) => `<span class="${signClass(v)}">${fmtPct(v, d)}</span>`;

const VERDICT = {
  favorable: { label: 'Favorable', icon: '<path d="M7 1.5 13 12H1z"/>', color: 'good' },
  neutral: { label: 'Neutral', icon: '<circle cx="7" cy="7" r="5"/>', color: 'warning' },
  unfavorable: { label: 'Unfavorable', icon: '<path d="M7 12.5 1 2h12z"/>', color: 'critical' },
};
const badge = (c) => `<span class="badge ${c.verdict}">
  <svg viewBox="0 0 14 14" aria-hidden="true">${VERDICT[c.verdict].icon}</svg>
  ${VERDICT[c.verdict].label} <span class="score num">${c.score}</span></span>`;
const gauge = (c) => `<div class="gauge" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${c.score}" aria-label="Score ${c.score} of 100">
  <div class="fill ${c.verdict}" style="width:${Math.max(2, c.score)}%"></div>
  <span class="tick" style="left:35%"></span><span class="tick" style="left:65%"></span></div>`;

const RESULT = {
  1: { cls: 'pass', label: 'Pass', icon: '<circle cx="6" cy="6" r="6"/>' },
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
  render();
});

// ------------------------------------------------------------------ data
async function getJson(url, signal) {
  const res = await fetch(url, { signal, cache: 'no-cache' });
  const type = res.headers.get('content-type') || '';
  if (!type.includes('json')) throw Object.assign(new Error(`Not JSON: ${url}`), { notApi: true });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function dashboardUrl() {
  if (state.mode === 'static') return `data/${state.range}.json`;
  const qs = new URLSearchParams({ range: state.range });
  if (state.extra.length) qs.set('add', state.extra.join(','));
  return `api/dashboard?${qs}`;
}

function detailUrl(symbol) {
  if (state.mode === 'static') return `data/etf/${encodeURIComponent(symbol)}.json`;
  const custom = state.extra.find((x) => x.split(':')[0] === symbol);
  const qs = custom ? `?benchmark=${encodeURIComponent(custom.split(':')[1])}` : '';
  return `api/etf/${encodeURIComponent(symbol)}${qs}`;
}

let inflight = null;
async function load({ quiet = false } = {}) {
  if (inflight) inflight.abort();
  inflight = new AbortController();
  const { signal } = inflight;
  $('#refresh').classList.add('spinning');
  if (!quiet) $('#grid').setAttribute('aria-busy', 'true');
  try {
    if (!state.mode) {
      // No API behind us (e.g. GitHub Pages) → switch to the static snapshots.
      try {
        state.mode = 'server';
        state.data = await getJson(dashboardUrl(), signal);
      } catch (err) {
        if (!err.notApi && !/404|Not Found/i.test(err.message)) throw err;
        state.mode = 'static';
        state.data = await getJson(dashboardUrl(), signal);
      }
      applyMode();
    } else {
      state.data = await getJson(dashboardUrl(), signal);
      if (!applyMode.timer) applyMode();
    }
    if (state.route.view === 'etf') {
      await loadDetail(state.route.symbol, { signal, force: true }).catch((err) => {
        if (err.name === 'AbortError') throw err;
        if (!state.details.has(state.route.symbol)) state.details.set(state.route.symbol, { error: err.message });
      });
    }
    render();
  } catch (err) {
    if (err.name === 'AbortError') return;
    showErrors([{ symbol: 'Dashboard', message: err.message }]);
  } finally {
    $('#refresh').classList.remove('spinning');
    $('#grid').setAttribute('aria-busy', 'false');
  }
}

async function loadDetail(symbol, { signal, force = false } = {}) {
  if (!force && state.details.has(symbol)) return state.details.get(symbol);
  const d = await getJson(detailUrl(symbol), signal);
  state.details.set(symbol, d);
  return d;
}

function applyMode() {
  const isStatic = state.mode === 'static';
  $('#add-form').hidden = isStatic;
  clearInterval(applyMode.timer);
  applyMode.timer = setInterval(() => { if (!document.hidden) load({ quiet: true }); }, REFRESH_MS[state.mode]);
}

function showErrors(errors) {
  const box = $('#errors');
  box.hidden = !errors.length;
  box.innerHTML = errors.map((e) => `<div><strong>${esc(e.symbol)}</strong>: ${esc(e.message)}</div>`).join('');
}

// ------------------------------------------------------------------ routing
function parseRoute() {
  const m = location.hash.match(/^#\/etf\/([^/?]+)/);
  return m ? { view: 'etf', symbol: decodeURIComponent(m[1]).toUpperCase() } : { view: 'dashboard' };
}

let dashboardScroll = 0;
async function onRoute() {
  const prev = state.route;
  state.route = parseRoute();
  if (prev.view === 'dashboard' && state.route.view === 'etf') dashboardScroll = scrollY;
  render();
  if (state.route.view === 'etf') {
    scrollTo(0, 0);
    if (state.mode && !state.details.has(state.route.symbol)) {
      try {
        await loadDetail(state.route.symbol);
      } catch (err) {
        state.details.set(state.route.symbol, { error: err.message });
      }
      render();
    }
  } else if (prev.view === 'etf') {
    requestAnimationFrame(() => scrollTo(0, dashboardScroll));
  }
}
addEventListener('hashchange', onRoute);
const openEtf = (symbol) => { location.hash = `#/etf/${encodeURIComponent(symbol)}`; };

// ------------------------------------------------------------------ render
function render() {
  const d = state.data;
  renderRanges();
  const onEtf = state.route.view === 'etf';
  $('#view-dashboard').hidden = onEtf;
  $('#view-etf').hidden = !onEtf;
  $('#back').hidden = !onEtf;
  $('.sort').hidden = onEtf;
  $('#add-form').hidden = onEtf || state.mode === 'static';
  hideTooltip();
  if (!d) return;
  renderStatus(d);
  showErrors(d.errors);
  if (onEtf) {
    renderEtfPage(state.route.symbol);
    return;
  }
  document.title = 'ETF Pulse';
  renderSummary(d);
  renderGrid(sortEtfs(d.etfs, state.sort));
  renderTable(d.etfs);
  renderMethod(d.etfs[0]);
}

function renderRanges() {
  $('#ranges').innerHTML = RANGES.map((r) => `<button role="radio" aria-checked="${r === state.range}" data-range="${r}">${r}</button>`).join('');
}
$('#ranges').addEventListener('click', (e) => {
  const r = e.target.closest('button')?.dataset.range;
  if (!r || r === state.range) return;
  state.range = r;
  store.set('range', r);
  renderRanges();
  load();
});

function renderStatus(d) {
  const pill = $('#source-pill');
  const live = d.dataSource === 'live';
  const when = new Date(d.generatedAt);
  if (state.mode === 'static') {
    pill.className = `pill ${live ? 'live snapshot' : 'demo'}`;
    pill.innerHTML = `<span class="dot"></span>${live ? 'Snapshot' : 'Demo data'}`;
    pill.title = 'Static build: prices are refreshed by GitHub Actions about every 15 minutes during US market hours';
    $('#updated').textContent = `Prices as of ${when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
    return;
  }
  const anyOpen = d.etfs.some((e) => e.quote?.marketState === 'open');
  pill.className = `pill ${live ? 'live' : 'demo'}`;
  pill.innerHTML = `<span class="dot"></span>${live ? (anyOpen ? 'Live · market open' : 'Live · market closed')
    : d.dataSource === 'mixed' ? 'Partly demo data' : 'Demo data'}`;
  pill.title = live ? 'Prices from Yahoo Finance, refreshed every 60s'
    : 'Yahoo Finance was unreachable for some or all symbols; showing synthetic data';
  $('#updated').textContent = `Updated ${when.toLocaleTimeString()}`;
}

function renderSummary(d) {
  const count = (v) => d.etfs.filter((e) => e.composite.verdict === v).length;
  const best = [...d.etfs].sort((a, b) => b.composite.score - a.composite.score)[0];
  const tile = (verdict, n) => `<div class="tile">
      <div class="label"><svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true" style="fill:var(--${VERDICT[verdict].color})">${VERDICT[verdict].icon}</svg>${VERDICT[verdict].label}</div>
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
    const removable = state.mode === 'server' && state.extra.some((x) => x.split(':')[0] === e.symbol);
    return `<article class="card" tabindex="0" role="link" data-symbol="${esc(e.symbol)}" aria-label="Open ${esc(e.symbol)} analysis">
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
      <div class="card-foot"><span class="more">View full analysis →</span>
        ${removable ? `<button class="chip remove" data-remove="${esc(e.symbol)}">Remove</button>` : ''}</div>
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
  const card = ev.target.closest('.card[data-symbol]');
  if (card) openEtf(card.dataset.symbol);
});
$('#grid').addEventListener('keydown', (ev) => {
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.classList.contains('card')) {
    ev.preventDefault();
    openEtf(ev.target.dataset.symbol);
  }
});

// ------------------------------------------------------------------ table
const COLUMNS = [
  { key: 'symbol', label: 'ETF', get: (e) => e.symbol, fmt: (v, e) => `<strong>${esc(v)}</strong> <span class="muted small">vs ${esc(e.benchmark)}</span>` },
  { key: 'score', label: 'Score', get: (e) => e.composite.score, fmt: (v, e) => badge(e.composite) },
  { key: 'price', label: 'Price', get: (e) => e.quote?.price, fmt: (v) => fmtPrice(v) },
  { key: 'day', label: 'Today', get: (e) => e.quote?.changePct, fmt: (v) => pctCell(v, 2) },
  { key: 'ret', label: 'Return', get: (e) => e.metrics.totalReturn, fmt: (v) => pctCell(v) },
  { key: 'excess', label: 'vs Bench', get: (e) => e.metrics.excessReturn, fmt: (v) => pctCell(v) },
  { key: 'vol', label: 'Volatility', get: (e) => e.metrics.volatility, fmt: (v) => fmtPct(v, 1, false) },
  { key: 'sharpe', label: 'Sharpe', get: (e) => e.metrics.sharpe, fmt: (v) => fmtNum(v) },
  { key: 'sortino', label: 'Sortino', get: (e) => e.metrics.sortino, fmt: (v) => fmtNum(v) },
  { key: 'alpha', label: 'Alpha', get: (e) => e.metrics.alpha, fmt: (v) => pctCell(v) },
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
  if (tr) openEtf(tr.dataset.symbol);
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
  state.details.delete(sym);
  $('#add-symbol').value = '';
  $('#add-bench').value = '';
  load();
});

// ------------------------------------------------------------------ ETF page

// Index of the first point in the window, mirroring the server's windowStart().
function windowStart(dates, range) {
  if (range === 'YTD') {
    const jan1 = `${dates[dates.length - 1].slice(0, 4)}-01-01`;
    return Math.max(0, dates.findIndex((d) => d >= jan1) - 1);
  }
  const n = { '1M': 21, '3M': 63, '6M': 126, '1Y': 252, '3Y': 756, '5Y': 1260 }[range];
  return Math.max(0, dates.length - 1 - n);
}

function renderEtfPage(symbol) {
  const view = $('#view-etf');
  const e = state.data.etfs.find((x) => x.symbol === symbol);
  const d = state.details.get(symbol);
  if (!e) {
    view.innerHTML = `<div class="panel empty"><h2>${esc(symbol)} isn’t on the dashboard</h2>
      <p class="muted">${state.mode === 'static' ? 'This published page only covers the ETFs in <code>src/config.js</code>.' : 'Add it with the “Add ticker” box on the dashboard.'}</p>
      <a class="button" href="#/">Back to all ETFs</a></div>`;
    return;
  }
  document.title = `${e.symbol} · ETF Pulse`;
  const m = e.metrics;
  const b = m.benchmark;
  const tile = (k, v, cls = '') => `<div class="mini"><div class="k">${k}</div><div class="v num ${cls}">${v}</div></div>`;

  view.innerHTML = `
    <section class="etf-hero">
      <div class="etf-id">
        <div class="eyebrow">${esc(e.category || 'ETF')} · benchmark ${esc(e.benchmark)}</div>
        <h2 class="etf-title">${esc(e.symbol)} <span>${esc(e.name)}</span></h2>
        <div class="price-row"><span class="price big-price num">${fmtPrice(e.quote?.price)}</span>${deltaHtml(e.quote)}</div>
      </div>
      <div class="verdict-card ${e.composite.verdict}">
        <div class="verdict-top"><span class="big num">${e.composite.score}</span>${badge(e.composite)}</div>
        ${gauge(e.composite)}
        <div class="muted small">${e.composite.passed} passed · ${e.composite.failed} failed · ${e.composite.total - e.composite.passed - e.composite.failed} neutral · ${state.range} window</div>
      </div>
    </section>

    <section class="mini-row">
      ${tile(`${state.range} return`, fmtPct(m.totalReturn), signClass(m.totalReturn))}
      ${tile(`vs ${esc(e.benchmark)}`, fmtPct(m.excessReturn), signClass(m.excessReturn))}
      ${tile('Volatility', fmtPct(m.volatility, 1, false))}
      ${tile('Sharpe', fmtNum(m.sharpe))}
      ${tile('Max drawdown', fmtPct(m.maxDrawdown, 1, false))}
      ${tile('Beta', fmtNum(m.beta))}
      ${tile('RSI (14)', fmtNum(m.rsi14, 0))}
    </section>

    <div class="panel">
      <div class="panel-head"><div><h3>Price & trend</h3><p class="muted">Closing price with 50- and 200-day moving averages</p></div>
        <div class="legend"><span class="key"><i style="background:var(--series-1)"></i>Price</span><span class="key"><i style="background:var(--sma50)"></i>50-day</span><span class="key"><i style="background:var(--sma200)"></i>200-day</span></div></div>
      ${d && !d.error ? '<svg class="chart" id="price-chart" role="img" aria-label="Price chart"></svg>' : detailPlaceholder(d)}
    </div>

    <div class="two">
      <div class="panel">
        <div class="panel-head"><div><h3>Growth of 100</h3><p class="muted">Total return vs ${esc(e.benchmark)}, indexed to 100</p></div>
          <div class="legend"><span class="key"><i class="etf"></i>${esc(e.symbol)}</span><span class="key"><i class="bench"></i>${esc(e.benchmark)}</span></div></div>
        <svg class="chart" id="perf-chart" role="img" aria-label="${esc(e.symbol)} versus ${esc(e.benchmark)} growth of 100"></svg>
      </div>
      <div class="panel">
        <div class="panel-head"><div><h3>Drawdown</h3><p class="muted">Decline from running peak</p></div>
          <div class="legend"><span class="key"><i class="etf"></i>${esc(e.symbol)}</span><span class="key"><i class="bench"></i>${esc(e.benchmark)}</span></div></div>
        <svg class="chart" id="dd-chart" role="img" aria-label="Drawdown chart"></svg>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><div><h3>Benchmark tests</h3><p class="muted">What drives the ${e.composite.score} score over the ${state.range} window</p></div></div>
      <div class="scroll-x"><table class="data">
        <thead><tr><th>Test</th><th>Compared against</th><th>Result</th><th>Value</th><th style="text-align:left">Detail</th><th>Weight</th></tr></thead>
        <tbody>${e.signals.map((s) => {
          const r = RESULT[s.score];
          return `<tr class="static"><td><strong>${esc(s.label)}</strong></td><td>${esc(s.against)}</td>
            <td><span class="signal-result ${r.cls}"><svg viewBox="0 0 12 12" aria-hidden="true">${r.icon}</svg>${r.label}</span></td>
            <td class="num">${esc(s.display)}</td><td class="wrap">${esc(s.detail)}</td><td>${s.weight}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>

    <div class="panel">
      <div class="panel-head"><div><h3>Against other benchmarks</h3>
        <p class="muted">The same eight tests, re-run with a different yardstick (${state.range} window)</p></div></div>
      ${d && !d.error ? scorecardTable(d, e) : detailPlaceholder(d)}
    </div>

    <div class="two">
      <div class="panel">
        <div class="panel-head"><div><h3>Trailing returns</h3><p class="muted">3Y and 5Y are annualised</p></div></div>
        ${d && !d.error ? trailingTable(d, e) : detailPlaceholder(d)}
      </div>
      <div class="panel">
        <div class="panel-head"><div><h3>Risk & return</h3><p class="muted">${state.range} window; risk-free ${fmtPct(m.riskFree, 2, false)}</p></div></div>
        <table class="data">
          <thead><tr><th>Metric</th><th>${esc(e.symbol)}</th><th>${esc(e.benchmark)}</th></tr></thead>
          <tbody>
            <tr class="static"><td>Total return</td><td>${pctCell(m.totalReturn)}</td><td>${pctCell(b.totalReturn)}</td></tr>
            <tr class="static"><td>Annualised return</td><td>${fmtPct(m.annualizedReturn)}</td><td>${fmtPct(b.annualizedReturn)}</td></tr>
            <tr class="static"><td>Volatility</td><td>${fmtPct(m.volatility, 1, false)}</td><td>${fmtPct(b.volatility, 1, false)}</td></tr>
            <tr class="static"><td>Sharpe</td><td>${fmtNum(m.sharpe)}</td><td>${fmtNum(b.sharpe)}</td></tr>
            <tr class="static"><td>Sortino</td><td>${fmtNum(m.sortino)}</td><td>${fmtNum(b.sortino)}</td></tr>
            <tr class="static"><td>Max drawdown</td><td>${fmtPct(m.maxDrawdown, 1, false)}</td><td>${fmtPct(b.maxDrawdown, 1, false)}</td></tr>
            <tr class="static"><td>Alpha · beta</td><td>${fmtPct(m.alpha)} · ${fmtNum(m.beta)}</td><td>— · 1.00</td></tr>
            <tr class="static"><td>Correlation · tracking error</td><td>${fmtNum(m.correlation)} · ${fmtPct(m.trackingError, 1, false)}</td><td>1.00 · —</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><div><h3>Calendar-year returns</h3><p class="muted">Total return per year; the latest year is year-to-date</p></div>
        <div class="legend"><span class="key"><i class="etf"></i>${esc(e.symbol)}</span><span class="key"><i class="bench"></i>${esc(e.benchmark)}</span></div></div>
      ${d && !d.error ? '<svg class="chart" id="years-chart" role="img" aria-label="Calendar-year returns"></svg>' : detailPlaceholder(d)}
    </div>

    <div class="panel">
      <div class="panel-head"><div><h3>Rolling 3-month excess return</h3>
        <p class="muted">${esc(e.symbol)}’s trailing 3-month return minus ${esc(e.benchmark)}’s. Above zero means it was ahead.</p></div></div>
      ${d && !d.error ? '<svg class="chart" id="rolling-chart" role="img" aria-label="Rolling excess return"></svg>' : detailPlaceholder(d)}
    </div>

    <div class="panel">
      <div class="panel-head"><div><h3>Monthly returns</h3><p class="muted">Blue months gained, red months lost; deeper colour means a bigger move</p></div></div>
      ${d && !d.error ? monthlyTable(d) : detailPlaceholder(d)}
    </div>

    <p class="muted small footnote">Returns include dividends. This is an analytical tool, not investment advice.</p>`;

  const c = e.chart;
  lineChart($('#perf-chart'), {
    dates: c.dates, height: 240,
    series: [
      { name: e.symbol, values: c.etf, color: 'var(--series-1)' },
      { name: e.benchmark, values: c.bench, color: 'var(--series-2)' },
    ],
    fmt: (v) => v.toFixed(1), baseline: 100, endLabels: true,
  });
  lineChart($('#dd-chart'), {
    dates: c.dates, height: 240,
    series: [
      { name: e.symbol, values: c.drawdown, color: 'var(--series-1)', area: true },
      { name: e.benchmark, values: c.benchDrawdown, color: 'var(--series-2)' },
    ],
    fmt: (v) => `${(v * 100).toFixed(1)}%`, baseline: 0, maxZero: true,
  });
  if (!d || d.error) return;

  const h = d.history;
  const i0 = windowStart(h.dates, state.range);
  lineChart($('#price-chart'), {
    dates: h.dates.slice(i0), height: 280,
    series: [
      { name: 'Price', values: h.price.slice(i0), color: 'var(--series-1)' },
      { name: '50-day', values: h.sma50.slice(i0), color: 'var(--sma50)', width: 1.5 },
      { name: '200-day', values: h.sma200.slice(i0), color: 'var(--sma200)', width: 1.5 },
    ],
    fmt: (v) => fmtPrice(v), axisFmt: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)),
  });
  barChart($('#years-chart'), {
    categories: d.calendarYears.map((y) => (y.ytd ? `${y.year} YTD` : y.year)),
    series: [
      { name: e.symbol, values: d.calendarYears.map((y) => y.etf), color: 'var(--series-1)' },
      { name: e.benchmark, values: d.calendarYears.map((y) => y.bench), color: 'var(--series-2)' },
    ],
    fmt: (v) => fmtPct(v),
  });
  const r = d.rollingExcess;
  const j0 = windowStart(r.dates, state.range === '1M' || state.range === '3M' ? '6M' : state.range);
  lineChart($('#rolling-chart'), {
    dates: r.dates.slice(j0), height: 200,
    series: [{ name: `vs ${e.benchmark}`, values: r.values.slice(j0), color: 'var(--series-1)', area: true }],
    fmt: (v) => fmtPct(v), baseline: 0,
  });
}

function detailPlaceholder(d) {
  return d?.error ? `<p class="muted">Couldn’t load the detailed history: ${esc(d.error)}</p>` : '<div class="placeholder"></div>';
}

function scorecardTable(d, e) {
  const rows = d.scorecards[state.range] || [];
  return `<div class="scroll-x"><table class="data">
    <thead><tr><th>Benchmark</th><th>Its return</th><th>${esc(e.symbol)} ahead by</th><th>Alpha</th><th>Beta</th><th>Correlation</th><th>Info ratio</th><th>Verdict</th></tr></thead>
    <tbody>${rows.map((s) => `<tr class="static">
      <td><strong>${esc(s.symbol)}</strong> <span class="muted small">${esc(s.label)}${s.isPrimary ? ' · primary' : ''}</span></td>
      <td>${pctCell(s.benchReturn)}</td><td>${pctCell(s.excessReturn)}</td><td>${pctCell(s.alpha)}</td>
      <td>${fmtNum(s.beta)}</td><td>${fmtNum(s.correlation)}</td><td>${fmtNum(s.informationRatio)}</td><td>${badge(s.composite)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function trailingTable(d, e) {
  return `<table class="data">
    <thead><tr><th>Period</th><th>${esc(e.symbol)}</th><th>${esc(e.benchmark)}</th><th>Difference</th></tr></thead>
    <tbody>${d.trailing.map((t) => `<tr class="static${t.range === state.range ? ' current' : ''}">
      <td>${t.range}${t.annualized ? ' <span class="muted small">/yr</span>' : ''}</td>
      <td>${pctCell(t.etf)}</td><td>${pctCell(t.bench)}</td><td>${pctCell(t.excess)}</td></tr>`).join('')}
    </tbody></table>`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthlyTable(d) {
  const cell = (v) => {
    if (v == null) return '<td class="hm empty"></td>';
    const k = Math.min(1, Math.abs(v) / 0.08); // ±8% saturates
    const pct = Math.round(15 + k * 70);
    const pole = v >= 0 ? 'var(--div-pos)' : 'var(--div-neg)';
    return `<td class="hm${pct > 55 ? ' strong' : ''}" style="background:color-mix(in srgb, ${pole} ${pct}%, var(--div-mid))">${(v * 100).toFixed(1)}</td>`;
  };
  return `<div class="scroll-x"><table class="data heatmap">
    <thead><tr><th>Year</th>${MONTHS.map((mo) => `<th>${mo}</th>`).join('')}<th>Year</th></tr></thead>
    <tbody>${d.monthly.map((row) => `<tr class="static"><td><strong>${row.year}</strong></td>${row.months.map(cell).join('')}
      <td class="num">${pctCell(row.total)}</td></tr>`).join('')}</tbody></table></div>
    <p class="muted small">Values in %.</p>`;
}

// ------------------------------------------------------------------ charts
const el = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const mag = 10 ** Math.floor(Math.log10(span / count));
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
  svg.append(el('path', { d: `${path(chart.etf)}L${w},${h}L0,${h}Z`, fill: 'var(--series-1)', opacity: 0.08 }));
  svg.append(el('path', { d: path(chart.bench), fill: 'none', stroke: 'var(--series-2)', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke', opacity: 0.9 }));
  svg.append(el('path', { d: path(chart.etf), fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }));
}

function chartFrame(svg, height, margin) {
  const width = Math.max(260, svg.clientWidth || svg.parentElement.clientWidth);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('height', height);
  svg.innerHTML = '';
  return { width, iw: width - margin.left - margin.right, ih: height - margin.top - margin.bottom };
}

function yAxis(svg, { min, max, y, m, iw, fmt, baseline }) {
  for (const t of niceTicks(min, max, 4)) {
    svg.append(el('line', { class: Math.abs(t - (baseline ?? NaN)) < 1e-12 ? 'baseline' : 'grid-line', x1: m.left, x2: m.left + iw, y1: y(t), y2: y(t) }));
    const label = el('text', { x: m.left - 8, y: y(t) + 4, 'text-anchor': 'end' });
    label.textContent = fmt(t);
    svg.append(label);
  }
}

// Multi-series line chart with crosshair tooltip. Null values leave gaps.
function lineChart(svg, opt) {
  if (!svg) return;
  const m = { top: 10, right: opt.endLabels ? 60 : 12, bottom: 24, left: 56 };
  const { width, iw, ih } = chartFrame(svg, opt.height, m);
  const height = opt.height;
  const n = opt.dates.length;
  if (n < 2) return;

  const all = opt.series.flatMap((s) => s.values).filter((v) => v != null);
  let min = Math.min(...all, opt.baseline ?? Infinity);
  let max = opt.maxZero ? 0 : Math.max(...all, opt.baseline ?? -Infinity);
  const padY = (max - min) * 0.06 || 1;
  min -= padY; if (!opt.maxZero) max += padY;
  const x = (i) => m.left + (i / (n - 1)) * iw;
  const y = (v) => m.top + (1 - (v - min) / (max - min || 1)) * ih;

  yAxis(svg, { min, max, y, m, iw, fmt: opt.axisFmt || opt.fmt, baseline: opt.baseline });
  const xTicks = Math.min(width < 500 ? 3 : 5, n);
  for (let k = 0; k < xTicks; k++) {
    const i = Math.round((k / (xTicks - 1)) * (n - 1));
    const label = el('text', { x: x(i), y: height - 6, 'text-anchor': k === 0 ? 'start' : k === xTicks - 1 ? 'end' : 'middle' });
    label.textContent = new Date(`${opt.dates[i]}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: '2-digit', ...(n < 130 ? { day: 'numeric' } : {}) });
    svg.append(label);
  }

  const toPath = (vals) => {
    let d = ''; let pen = false;
    vals.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  // Draw back-to-front so the first series (the ETF) sits on top.
  for (const s of [...opt.series].reverse()) {
    const d = toPath(s.values);
    if (s.area) {
      const zero = y(Math.min(Math.max(0, min), max));
      svg.append(el('path', { d: `${d}L${x(n - 1)},${zero}L${x(0)},${zero}Z`, fill: s.color, opacity: 0.12 }));
    }
    svg.append(el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }

  if (opt.endLabels) {
    const ends = opt.series.map((s) => ({ s, y: y(s.values[n - 1]) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    for (const { s, y: ly } of ends) {
      svg.append(el('circle', { cx: x(n - 1), cy: y(s.values[n - 1]), r: 3.5, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 }));
      const t = el('text', { x: x(n - 1) + 8, y: ly + 4, class: 'end-label' });
      t.textContent = s.name;
      svg.append(t);
    }
  }

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
      const v = s.values[i];
      dots[k].setAttribute('visibility', v == null ? 'hidden' : 'visible');
      if (v != null) { dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(v)); }
    });
    showTooltip(ev.clientX, ev.clientY, `<div class="t-date">${fmtDate(opt.dates[i])}</div>${opt.series.map((s) =>
      `<div class="t-row"><span><i style="background:${s.color}"></i>${esc(s.name)}</span><strong>${s.values[i] == null ? '—' : opt.fmt(s.values[i])}</strong></div>`).join('')}`);
  };
  const leave = () => {
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((dot) => dot.setAttribute('visibility', 'hidden'));
    hideTooltip();
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', leave);
}

// Grouped bar chart with a zero baseline and per-group hover.
function barChart(svg, opt) {
  if (!svg) return;
  const height = 230;
  const m = { top: 12, right: 12, bottom: 26, left: 56 };
  const { iw, ih } = chartFrame(svg, height, m);
  const all = opt.series.flatMap((s) => s.values).filter((v) => v != null);
  let min = Math.min(0, ...all); let max = Math.max(0, ...all);
  const pad = (max - min) * 0.08 || 0.01;
  if (min < 0) min -= pad;
  max += pad;
  const y = (v) => m.top + (1 - (v - min) / (max - min)) * ih;
  yAxis(svg, { min, max, y, m, iw, fmt: (v) => `${Math.round(v * 100)}%`, baseline: 0 });

  const hits = [];
  const groups = opt.categories.length;
  const gw = iw / groups;
  const gap = 2;
  const bw = Math.min(28, (gw * 0.6 - gap) / opt.series.length);
  opt.categories.forEach((cat, gi) => {
    const gx = m.left + gi * gw + (gw - (bw * opt.series.length + gap)) / 2;
    opt.series.forEach((s, si) => {
      const v = s.values[gi];
      if (v == null) return;
      const top = y(Math.max(v, 0));
      const h = Math.max(1, Math.abs(y(v) - y(0)));
      const r = Math.min(4, bw / 2, h);
      const bx = gx + si * (bw + gap);
      // Round only the end away from the baseline.
      const d = v >= 0
        ? `M${bx},${top + h}V${top + r}Q${bx},${top} ${bx + r},${top}H${bx + bw - r}Q${bx + bw},${top} ${bx + bw},${top + r}V${top + h}Z`
        : `M${bx},${top}V${top + h - r}Q${bx},${top + h} ${bx + r},${top + h}H${bx + bw - r}Q${bx + bw},${top + h} ${bx + bw},${top + h - r}V${top}Z`;
      svg.append(el('path', { d, fill: s.color }));
    });
    const label = el('text', { x: m.left + gi * gw + gw / 2, y: height - 7, 'text-anchor': 'middle' });
    label.textContent = gw < 64 ? cat.replace(/^\d{2}(\d{2}) YTD$/, "'$1 YTD") : cat;
    svg.append(label);
    const hit = el('rect', { x: m.left + gi * gw, y: m.top, width: gw, height: ih, fill: 'transparent', class: 'bar-hit' });
    hit.addEventListener('pointermove', (ev) => showTooltip(ev.clientX, ev.clientY, `<div class="t-date">${esc(cat)}</div>${opt.series.map((s) =>
      `<div class="t-row"><span><i style="background:${s.color}"></i>${esc(s.name)}</span><strong>${opt.fmt(s.values[gi])}</strong></div>`).join('')}`));
    hit.addEventListener('pointerleave', hideTooltip);
    hits.push(hit);
  });
  svg.append(...hits);
}

function showTooltip(cx, cy, html) {
  const tip = $('#tooltip');
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
let resizeTimer;
let lastWidth = innerWidth;
addEventListener('resize', () => {
  if (innerWidth === lastWidth) return; // ignore mobile URL-bar height changes
  lastWidth = innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.route.view === 'etf') render(); }, 150);
});
$('#refresh').addEventListener('click', () => load({ quiet: true }));
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.mode) load({ quiet: true }); });

$('#grid').innerHTML = Array.from({ length: 6 }, () => '<div class="card skeleton"></div>').join('');
state.route = parseRoute();
load();
