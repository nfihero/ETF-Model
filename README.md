# ETF Pulse

A live ETF dashboard. It scores each fund against its category benchmark and the risk-free rate, then labels it **Favorable**, **Neutral** or **Unfavorable**.

There are no dependencies to install. You need Node 18 or newer.

```bash
npm start            # live data from Yahoo Finance → http://localhost:3000
npm run demo         # synthetic data, works offline
npm test
```

## What you get

- **Cards** for each ETF show the live price, today's move, a sparkline against its benchmark, the verdict with its score, and a strip showing which of the 8 benchmark tests passed (green), were neutral (amber) or failed (red).
- **Detail view** (click a card or a table row) has a growth-of-100 chart and a drawdown chart, both with hover tooltips. It also has risk/return stats next to the benchmark's and a breakdown of every test.
- **Comparison table** lists price, return, excess return, volatility, Sharpe, Sortino, alpha, beta, information ratio, max drawdown and RSI. Click a column header to sort.
- **Look-back windows** are 1M, 3M, 6M, YTD, 1Y, 3Y and 5Y. Prices refresh every 60 seconds.
- **Add any ticker** with its own benchmark (for example `TSLA` vs `QQQ`). Your list, chosen window and theme are saved in the browser. There are light and dark themes.

## The score

Each test scores +1, 0 or −1. The weighted mean is mapped onto 0–100: **65 or above** is Favorable and **35 or below** is Unfavorable.

| Test | Compared against | Weight |
|---|---|---|
| Total return beats the benchmark by more than 1 pt | Category benchmark | 2 |
| Sharpe ratio beats the benchmark's by more than 0.10 | Benchmark Sharpe | 2 |
| Sharpe ≥ 0.75 passes, < 0.25 fails | 13-week T-bill (`^IRX`) | 1.5 |
| Jensen's alpha beyond ±1%/yr | Benchmark (CAPM) | 1.5 |
| Information ratio beyond ±0.3 | Benchmark | 1 |
| Max drawdown at least 2 pts shallower | Benchmark drawdown | 1 |
| Price more than 1% above its 200-day average | 200-day SMA | 1 |
| 3-month return beats the benchmark by more than 1 pt | Benchmark | 1 |

Returns use adjusted closes, so dividends are counted. The thresholds and weights are in `src/scoring.js`.

## Configuration

- **Watchlist and benchmarks:** `src/config.js`. Any Yahoo Finance symbol works.
- **`PORT`:** defaults to 3000.
- **`DATA_SOURCE`:** `live` (the default) or `demo`. In live mode, any symbol Yahoo can't serve falls back to synthetic data. When that happens, the header pill reads **Demo data** or **Partly demo data**, so fake numbers are never shown as live ones.

## Layout

```
server.js          HTTP server: static files + GET /api/dashboard?range=1Y&add=TSLA:QQQ
src/data.js        Yahoo Finance fetch, caching, demo generator
src/metrics.js     Return / risk statistics (pure functions)
src/scoring.js     Benchmark tests + composite verdict
src/analysis.js    Builds the dashboard payload
public/            Front end (vanilla JS, hand-drawn SVG charts)
test/              node:test suites
```

*An analytical tool, not investment advice.*
