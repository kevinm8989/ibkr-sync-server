export function parseTrades(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<FlexQueryResponse')) {
    return parseXML(trimmed);
  } else {
    return parseCSV(trimmed);
  }
}

function parseXML(xml) {
  const executions = [];
  const tradeRegex = /<(?:Trade|Execution)\s([^>]+)\/>/g;
  let m;
  while ((m = tradeRegex.exec(xml)) !== null) {
    const attrs = parseAttrs(m[1]);
    if (attrs.assetCategory && !['STK', 'STOCK'].includes(attrs.assetCategory.toUpperCase())) continue;
    if (!attrs.symbol && !attrs.Symbol) continue;
    const sym = (attrs.symbol || attrs.Symbol || '').toUpperCase();
    const qty = parseFloat(attrs.quantity || attrs.Quantity || 0);
    const price = parseFloat(attrs.tradePrice || attrs.price || attrs.Price || 0);
    const comm = Math.abs(parseFloat(attrs.ibCommission || attrs.commission || attrs.Commission || 0));
    const dateRaw = attrs.dateTime || attrs.tradeDate || attrs.TradeDate || '';
    const date = normalizeDate(dateRaw);
    const time = normalizeTime(dateRaw);
    const buySell = (attrs.buySell || attrs.Buy_Sell || '').toUpperCase();
    if (!sym || !qty || !price || !date) continue;
    executions.push({ sym, qty: Math.abs(qty), price, comm, date, time, buySell });
  }
  return groupExecutions(executions);
}

function parseCSV(csv) {
  const lines = csv.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());
  const col = (...keys) => { for (const k of keys) { const i = header.findIndex(h => h.includes(k)); if (i >= 0) return i; } return -1; };
  const iSym = col('symbol');
  const iQty = col('quantity', 'qty');
  const iPrice = col('tradeprice', 'trade price', 'price');
  const iComm = col('ibcommission', 'commission', 'comm');
  const iDate = col('datetime', 'tradedate', 'date');
  const iBuySell = col('buysell', 'buy/sell', 'action', 'side');
  const iAsset = col('assetcategory', 'asset category', 'type');
  if (iSym < 0 || iQty < 0 || iPrice < 0) return [];
  const executions = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.replace(/"/g, '').trim());
    if (cols.length < 3 || !cols[iSym]) continue;
    if (iAsset >= 0 && cols[iAsset] && !['STK', 'STOCK', 'STOCKS', ''].includes(cols[iAsset].toUpperCase())) continue;
    const sym = cols[iSym].toUpperCase();
    const qty = parseFloat(cols[iQty]) || 0;
    const price = parseFloat(cols[iPrice]) || 0;
    const comm = iComm >= 0 ? Math.abs(parseFloat(cols[iComm]) || 0) : 0;
    const dateRaw = iDate >= 0 ? cols[iDate] : '';
    const date = normalizeDate(dateRaw);
    const time = normalizeTime(dateRaw);
    const buySell = iBuySell >= 0 ? (cols[iBuySell] || '').toUpperCase() : (qty > 0 ? 'BUY' : 'SELL');
    if (!sym || !qty || !price) continue;
    executions.push({ sym, qty: Math.abs(qty), price, comm, date, time, buySell });
  }
  return groupExecutions(executions);
}

function groupExecutions(executions) {
  const bySymDate = {};
  for (const ex of executions) {
    const k = `${ex.date}|${ex.sym}`;
    if (!bySymDate[k]) bySymDate[k] = { buys: [], sells: [] };
    if (ex.buySell.startsWith('B')) bySymDate[k].buys.push({ ...ex });
    else bySymDate[k].sells.push({ ...ex });
  }

  const trades = [];

  for (const [key, { buys, sells }] of Object.entries(bySymDate)) {
    const [date, sym] = key.split('|');
    if (!buys.length || !sells.length) continue;

    const totalBuyQty = buys.reduce((a, e) => a + e.qty, 0);
    const totalSellQty = sells.reduce((a, e) => a + e.qty, 0);
    const isLong = totalBuyQty >= totalSellQty;

    if (isLong) {
      const buyPool = buys.map(b => ({ ...b }));
      for (const sell of sells) {
        let remaining = sell.qty;
        const matched = [];
        for (const buy of buyPool) {
          if (remaining <= 0) break;
          const take = Math.min(buy.qty, remaining);
          matched.push({ price: buy.price, qty: take, comm: (buy.comm / (buy.qty + take)) * take });
          buy.qty -= take;
          remaining -= take;
        }
        if (!matched.length) continue;
        const totalQty = matched.reduce((a, b) => a + b.qty, 0);
        const avgEntry = matched.reduce((a, b) => a + b.price * b.qty, 0) / totalQty;
        const tradeTime = buys[0]?.time || sell.time || '';
        trades.push({
          date, sym, side: 'Long',
          time: tradeTime,
          shares: Math.round(sell.qty),
          entry: round2(avgEntry),
          exit: round2(sell.price),
          comm: round2(matched.reduce((a, b) => a + b.comm, 0) + sell.comm),
          stop: 0, strat: 'Import', notes: '', emotion: 'Neutral'
        });
      }
    } else {
      const sellPool = sells.map(s => ({ ...s }));
      for (const buy of buys) {
        let remaining = buy.qty;
        const matched = [];
        for (const sell of sellPool) {
          if (remaining <= 0) break;
          const take = Math.min(sell.qty, remaining);
          matched.push({ price: sell.price, qty: take, comm: (sell.comm / (sell.qty + take)) * take });
          sell.qty -= take;
          remaining -= take;
        }
        if (!matched.length) continue;
        const totalQty = matched.reduce((a, s) => a + s.qty, 0);
        const avgEntry = matched.reduce((a, s) => a + s.price * s.qty, 0) / totalQty;
        const tradeTime = sells[0]?.time || buy.time || '';
        trades.push({
          date, sym, side: 'Short',
          time: tradeTime,
          shares: Math.round(buy.qty),
          entry: round2(avgEntry),
          exit: round2(buy.price),
          comm: round2(matched.reduce((a, s) => a + s.comm, 0) + buy.comm),
          stop: 0, strat: 'Import', notes: '', emotion: 'Neutral'
        });
      }
    }
  }

  return trades.sort((a, b) => new Date(b.date) - new Date(a.date));
}

function round2(n) { return Math.round(n * 100) / 100; }

function normalizeDate(raw) {
  if (!raw) return new Date().toISOString().slice(0, 10);
  // Handle "yyyyMMdd;HHmmss" or "yyyyMMdd HHmmss" or "yyyy-MM-dd"
  const datePart = raw.split(/[;\s]/)[0].replace(/[^0-9-]/g, '');
  if (datePart.length === 8) return `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`;
  return datePart.slice(0, 10) || new Date().toISOString().slice(0, 10);
}

function normalizeTime(raw) {
  if (!raw) return '';
  // IBKR format: "20260416;093000" (yyyyMMdd;HHmmss)
  const parts = raw.split(/[;\s]/);
  if (parts.length < 2) return '';
  const timePart = parts[1].trim();
  if (!timePart) return '';
  // timePart is HHmmss — convert to HH:MM
  if (timePart.length >= 4) {
    const hh = timePart.slice(0, 2);
    const mm = timePart.slice(2, 4);
    return `${hh}:${mm}`;
  }
  return '';
}

function parseAttrs(attrString) {
  const attrs = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(attrString)) !== null) attrs[m[1]] = m[2];
  return attrs;
}
