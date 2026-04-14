/**
 * Parses IBKR Flex Query reports into normalized trade objects.
 * Handles both XML (FlexQueryResponse) and CSV formats.
 * 
 * Expected output shape (matches the journal's trade schema):
 * {
 *   date: "2025-04-14",
 *   sym: "TSLA",
 *   side: "Long" | "Short",
 *   shares: 100,
 *   entry: 185.42,
 *   exit: 188.10,
 *   comm: 1.05,
 *   stop: 0,
 *   strat: "Import",
 *   notes: "",
 *   emotion: "Neutral"
 * }
 *
 * Note: IBKR reports individual executions (legs), not round-trip trades.
 * This parser groups buy+sell legs into complete trades by symbol + date.
 */

export function parseTrades(raw) {
  const trimmed = raw.trim();

  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<FlexQueryResponse')) {
    return parseXML(trimmed);
  } else {
    return parseCSV(trimmed);
  }
}

// ── XML Parser ────────────────────────────────────────────────────────────────
function parseXML(xml) {
  const executions = [];

  // Match all Trade or Execution elements
  const tradeRegex = /<(?:Trade|Execution)\s([^>]+)\/>/g;
  let m;

  while ((m = tradeRegex.exec(xml)) !== null) {
    const attrs = parseAttrs(m[1]);

    // Skip non-stock rows (e.g. options, forex)
    if (attrs.assetCategory && !['STK', 'STOCK'].includes(attrs.assetCategory.toUpperCase())) continue;
    if (!attrs.symbol && !attrs.Symbol) continue;

    const sym = (attrs.symbol || attrs.Symbol || '').toUpperCase();
    const qty = parseFloat(attrs.quantity || attrs.Quantity || 0);
    const price = parseFloat(attrs.tradePrice || attrs.price || attrs.Price || 0);
    const comm = Math.abs(parseFloat(attrs.ibCommission || attrs.commission || attrs.Commission || 0));
    const dateRaw = attrs.tradeDate || attrs.dateTime || attrs.TradeDate || '';
    const date = normalizeDate(dateRaw);
    const buySell = (attrs.buySell || attrs.Buy_Sell || '').toUpperCase();

    if (!sym || !qty || !price || !date) continue;

    executions.push({ sym, qty, price, comm, date, buySell });
  }

  return groupExecutions(executions);
}

// ── CSV Parser ────────────────────────────────────────────────────────────────
function parseCSV(csv) {
  const lines = csv.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const header = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());

  const col = (...keys) => {
    for (const k of keys) {
      const i = header.findIndex(h => h.includes(k));
      if (i >= 0) return i;
    }
    return -1;
  };

  const iSym = col('symbol');
  const iQty = col('quantity', 'qty');
  const iPrice = col('tradeprice', 'trade price', 'price');
  const iComm = col('ibcommission', 'commission', 'comm');
  const iDate = col('tradedate', 'datetime', 'date');
  const iBuySell = col('buysell', 'buy/sell', 'action', 'side');
  const iAsset = col('assetcategory', 'asset category', 'type');

  if (iSym < 0 || iQty < 0 || iPrice < 0) return [];

  const executions = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.replace(/"/g, '').trim());
    if (cols.length < 3 || !cols[iSym]) continue;

    // Skip non-stock rows
    if (iAsset >= 0 && cols[iAsset] && !['STK', 'STOCK', 'STOCKS', ''].includes(cols[iAsset].toUpperCase())) continue;

    const sym = cols[iSym].toUpperCase();
    const qty = parseFloat(cols[iQty]) || 0;
    const price = parseFloat(cols[iPrice]) || 0;
    const comm = iComm >= 0 ? Math.abs(parseFloat(cols[iComm]) || 0) : 0;
    const dateRaw = iDate >= 0 ? cols[iDate] : '';
    const date = normalizeDate(dateRaw);
    const buySell = iBuySell >= 0 ? (cols[iBuySell] || '').toUpperCase() : (qty > 0 ? 'BUY' : 'SELL');

    if (!sym || !qty || !price) continue;
    executions.push({ sym, qty: Math.abs(qty), price, comm, date, buySell });
  }

  return groupExecutions(executions);
}

// ── Group executions into round-trip trades ───────────────────────────────────
function groupExecutions(executions) {
  // Group by date + symbol
  const groups = {};
  for (const ex of executions) {
    const k = `${ex.date}|${ex.sym}`;
    if (!groups[k]) groups[k] = { date: ex.date, sym: ex.sym, buys: [], sells: [] };
    if (ex.buySell.includes('B')) {
      groups[k].buys.push(ex);
    } else {
      groups[k].sells.push(ex);
    }
  }

  const trades = [];

  for (const g of Object.values(groups)) {
    const { date, sym, buys, sells } = g;
    if (!buys.length || !sells.length) continue; // Skip open positions

    const totalBuyQty = buys.reduce((a, e) => a + e.qty, 0);
    const totalSellQty = sells.reduce((a, e) => a + e.qty, 0);
    const shares = Math.min(totalBuyQty, totalSellQty); // Completed portion

    const avgBuy = wavg(buys);
    const avgSell = wavg(sells);
    const totalComm = [...buys, ...sells].reduce((a, e) => a + e.comm, 0);

    // Determine direction: more buy qty = long trade, more sell qty = short
    const side = totalBuyQty >= totalSellQty ? 'Long' : 'Short';
    const entry = side === 'Long' ? avgBuy : avgSell;
    const exit = side === 'Long' ? avgSell : avgBuy;

    trades.push({
      date,
      sym,
      side,
      shares: Math.round(shares),
      entry: round2(entry),
      exit: round2(exit),
      comm: round2(totalComm),
      stop: 0,
      strat: 'Import',
      notes: '',
      emotion: 'Neutral'
    });
  }

  return trades.sort((a, b) => new Date(b.date) - new Date(a.date));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function wavg(execs) {
  const totalQty = execs.reduce((a, e) => a + e.qty, 0);
  return execs.reduce((a, e) => a + e.price * e.qty, 0) / totalQty;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function normalizeDate(raw) {
  if (!raw) return new Date().toISOString().slice(0, 10);
  // IBKR formats: "20250414" or "2025-04-14" or "2025-04-14;10:30:00"
  const clean = raw.replace(/[;\s].*/, '').replace(/[^0-9-]/g, '');
  if (clean.length === 8) {
    return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
  }
  return clean.slice(0, 10) || new Date().toISOString().slice(0, 10);
}

function parseAttrs(attrString) {
  const attrs = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(attrString)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}
