# ETF Pulse

A live ETF dashboard. It scores each fund against its category benchmark and the risk-free rate, then labels it **Favorable**, **Neutral** or **Unfavorable**.

**▶ Open the dashboard: https://nfihero.github.io/ETF-Model/**

The published page is rebuilt by GitHub Actions about every 15 minutes during US market hours. To get prices that refresh every 60 seconds and to add your own tickers, run it locally.

There are no dependencies to install. You need Node 18 or newer.

```bash
npm start            # live data from Yahoo Finance → http://localhost:3000
npm run demo         # synthetic data, works offline
npm test
npm run build        # static site → dist/ (what GitHub Pages serves)
```

## What you get

- **Cards** for each ETF show the live price, today's move, a sparkline against its benchmark, the verdict with its score, and a strip showing which of the 8 benchmark tests passed (green), were neutral (amber) or failed (red).
- **A full analysis page for each ETF.** Click a card or a table row, or link straight to one, e.g. `#/etf/QQQ`. It shows:
  - price with 50- and 200-day moving averages
  - growth of 100 and drawdown, each against the benchmark
  - every benchmark test with its result
  - the same tests re-run against other yardsticks: the S&P 500, global stocks, bonds and cash
  - trailing returns from 1 month to 5 years
  - risk/return stats
  - calendar-year returns
  - rolling 3-month excess return
  - a monthly returns heatmap
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

## Publishing (GitHub Pages)

`.github/workflows/pages.yml` runs the tests and builds a static copy of the site with `npm run build`. The build fetches prices and writes JSON snapshots for every window and every ETF into `dist/`, then deploys it to GitHub Pages. It runs:

- on every push to `main`
- every 15 minutes during US market hours, plus once after the close
- on demand: **Actions → Publish dashboard → Run workflow**

**One-time setup:** go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.

GitHub can delay scheduled runs at busy times. It also pauses them after 60 days without commits; re-enable them from the Actions tab. The published page can only show the ETFs in `src/config.js`, because adding custom tickers needs the local server.

## Configuration

- **Watchlist and benchmarks:** `src/config.js`. Any Yahoo Finance symbol works.
- **`PORT`:** defaults to 3000.
- **`DATA_SOURCE`:** `live` (the default) or `demo`. In live mode, any symbol Yahoo can't serve falls back to synthetic data. When that happens, the header pill reads **Demo data** or **Partly demo data**, so fake numbers are never shown as live ones.

## Layout

```
server.js          HTTP server: static files, GET /api/dashboard?range=1Y&add=TSLA:QQQ,
                   GET /api/etf/QQQ?benchmark=SPY
scripts/build-site.js  Static build for GitHub Pages (dist/)
src/data.js        Yahoo Finance fetch, caching, demo generator
src/metrics.js     Return / risk statistics (pure functions)
src/scoring.js     Benchmark tests + composite verdict
src/analysis.js    Builds the dashboard payload
public/            Front end (vanilla JS, hand-drawn SVG charts)
test/              node:test suites
```

*An analytical tool, not investment advice.*
