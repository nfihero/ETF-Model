// Default watchlist. Each ETF is measured against its own category benchmark
// (an index or a broad-market ETF) plus the risk-free rate. Edit freely — any
// Yahoo Finance symbol works for both `symbol` and `benchmark`.
export const ETFS = [
  { symbol: 'SPY',  name: 'SPDR S&P 500',                 category: 'US Large Cap',       benchmark: 'VT'  },
  { symbol: 'QQQ',  name: 'Invesco QQQ (Nasdaq-100)',     category: 'US Large Growth',    benchmark: 'SPY' },
  { symbol: 'VTI',  name: 'Vanguard Total Stock Market',  category: 'US Total Market',    benchmark: 'SPY' },
  { symbol: 'IWM',  name: 'iShares Russell 2000',         category: 'US Small Cap',       benchmark: 'SPY' },
  { symbol: 'SCHD', name: 'Schwab US Dividend Equity',    category: 'US Dividend',        benchmark: 'SPY' },
  { symbol: 'XLK',  name: 'Technology Select Sector',     category: 'Sector: Technology', benchmark: 'QQQ' },
  { symbol: 'VXUS', name: 'Vanguard Total International', category: 'International',      benchmark: 'VT'  },
  { symbol: 'AGG',  name: 'iShares Core US Aggregate Bond', category: 'US Bonds',         benchmark: 'BIL' },
  { symbol: 'GLD',  name: 'SPDR Gold Shares',             category: 'Commodity: Gold',    benchmark: 'SPY' },
  { symbol: 'ARKK', name: 'ARK Innovation',               category: 'Thematic Growth',    benchmark: 'QQQ' },
];

// 13-week US Treasury bill yield (annualised %), used as the risk-free rate.
export const RISK_FREE_SYMBOL = '^IRX';

// Look-back windows the UI can choose from, in trading days.
export const RANGES = {
  '1M': 21,
  '3M': 63,
  '6M': 126,
  'YTD': 'ytd',
  '1Y': 252,
  '3Y': 756,
  '5Y': 1260,
};
export const DEFAULT_RANGE = '1Y';

export const PORT = Number(process.env.PORT) || 3000;
// "live" (Yahoo Finance, falls back to demo per symbol on failure) or "demo".
export const DATA_SOURCE = (process.env.DATA_SOURCE || 'live').toLowerCase();
export const HISTORY_TTL_MS = 60 * 60 * 1000; // daily bars change slowly
export const QUOTE_TTL_MS = 30 * 1000;        // intraday price
