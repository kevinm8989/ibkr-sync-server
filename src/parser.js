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
    const time = normalizeTime(dateRaw);      // HH:mm
    const timeFull = normalizeTimeFull(dateRaw); // HH:mm:ss for sorting
    const buySell = (attrs.buySell || attrs.Buy_Sell || '').toUpperCase();
    if (!sym || !qty || !price || !date) continue;
    executions.push({ sym, qty: Math.abs(qty), price, comm, date, time, timeFull, buySell });
  }
  return buildTrades(executions);
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
    const timeFull = normalizeTimeFull(dateRaw);
    const buySell = iBuySell >= 0 ? (cols[iBuySell] || '').toUpperCase() : (qty > 0 ? 'BUY' : 'SELL');
    if (!sym || !qty || !price) continue;
    executions.push({ sym, qty: Math.abs(qty), price, comm, date, time, timeFull, buySell });
  }
  return buildTrades(executions);
}

function buildTrades(executions) {
  const bySymDate = {};
  for (const ex of executions) {
    const k = `${ex.date}|${ex.sym}`;
    if (!bySymDate[k]) bySymDate[k] = [];
    bySymDate[k].push({ ...ex });
  }

  const trades = [];

  for (const [key, execs] of Object.entries(bySymDate)) {
    const [date, sym] = key.split('|');

    // Sort by full time including seconds
    execs.sort((a, b) => (a.timeFull || a.time || '').localeCompare(b.timeFull || b.time || ''));

    // Merge partial fills: same buySell + same timeFull → combine into one execution
    // IBKR often breaks single orders into multiple fills at the same second
    const merged = [];
    for (const ex of execs) {
      const last = merged[merged.length - 1];
      if (last && last.buySell === ex.buySell && last.timeFull === ex.timeFull) {
        // Same second, same side — merge (weighted avg price)
        const totalQty = last.qty + ex.qty;
        last.price = (last.price * last.qty + ex.price * ex.qty) / totalQty;
        last.comm += ex.comm;
        last.qty = totalQty;
      } else {
        merged.push({ ...ex });
      }
    }

    let position = 0;
    let openLots = [];
    let side = 'Long';

    const closeTrade = (exitPrice, exitQty, exitComm, exitTime) => {
      if (!openLots.length) return;
      let remaining = exitQty;
      const matched = [];
      for (const lot of openLots) {
        if (remaining <= 0) break;
        const take = Math.min(lot.qty, remaining);
        matched.push({ price: lot.price, qty: take, comm: lot.qty > 0 ? (lot.comm / lot.qty) * take : 0, time: lot.time });
        lot.qty -= take;
        remaining -= take;
      }
      openLots = openLots.filter(l => l.qty > 0);
      if (!matched.length) return;
      const totalQty = matched.reduce((a, b) => a + b.qty, 0);
      const avgEntry = matched.reduce((a, b) => a + b.price * b.qty, 0) / totalQty;
      const entryTime = matched[0].time || '';
      trades.push({
        date, sym, side,
        time: entryTime,
        exitTime: exitTime || '',
        shares: Math.round(totalQty),
        entry: round2(avgEntry),
        exit: round2(exitPrice),
        comm: round2(matched.reduce((a, b) => a + b.comm, 0) + (exitQty > 0 ? exitComm * totalQty / exitQty : 0)),
        stop: 0, strat: 'Import', notes: '', emotion: 'Neutral'
      });
    };

    for (const ex of merged) {
      const isBuy = ex.buySell.startsWith('B');

      if (position === 0) {
        side = isBuy ? 'Long' : 'Short';
        openLots = [{ price: ex.price, qty: ex.qty, comm: ex.comm, time: ex.time }];
        position = isBuy ? ex.qty : -ex.qty;
      } else if (position > 0 && isBuy) {
        // Scale into long
        openLots.push({ price: ex.price, qty: ex.qty, comm: ex.comm, time: ex.time });
        position += ex.qty;
      } else if (position < 0 && !isBuy) {
        // Scale into short
        openLots.push({ price: ex.price, qty: ex.qty, comm: ex.comm, time: ex.time });
        position -= ex.qty;
      } else if (position > 0 && !isBuy) {
        // Closing long
        closeTrade(ex.price, ex.qty, ex.comm, ex.time);
        position -= ex.qty;
        if (Math.abs(position) < 0.001) {
          position = 0; openLots = [];
        } else if (position < 0) {
          side = 'Short';
          openLots = [{ price: ex.price, qty: Math.abs(position), comm: 0, time: ex.time }];
        }
      } else if (position < 0 && isBuy) {
        // Closing short
        closeTrade(ex.price, ex.qty, ex.comm, ex.time);
        position += ex.qty;
        if (Math.abs(position) < 0.001) {
          position = 0; openLots = [];
        } else if (position > 0) {
          side = 'Long';
          openLots = [{ price: ex.price, qty: Math.abs(position), comm: 0, time: ex.time }];
        }
      }
    }

    // Close any remaining open position
    if (openLots.length && openLots.some(l => l.qty > 0)) {
      const last = merged[merged.length - 1];
      const totalQty = openLots.reduce((a, l) => a + l.qty, 0);
      const avgEntry = openLots.reduce((a, l) => a + l.price * l.qty, 0) / totalQty;
      trades.push({
        date, sym, side,
        time: openLots[0].time || '',
        exitTime: last.time || '',
        shares: Math.round(totalQty),
        entry: round2(avgEntry),
        exit: round2(last.price),
        comm: round2(openLots.reduce((a, l) => a + l.comm, 0)),
        stop: 0, strat: 'Import', notes: '', emotion: 'Neutral'
      });
    }
  }

  return trades.sort((a, b) => {
    const dd = new Date(b.date) - new Date(a.date);
    if (dd !== 0) return dd;
    return (b.time || '').localeCompare(a.time || '');
  });
}

function round2(n) { return Math.round(n * 100) / 100; }

function normalizeDate(raw) {
  if (!raw) return new Date().toISOString().slice(0, 10);
  const datePart = raw.split(/[;\s]/)[0].replace(/[^0-9-]/g, '');
  if (datePart.length === 8) return `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`;
  return datePart.slice(0, 10) || new Date().toISOString().slice(0, 10);
}

// HH:mm for display
function normalizeTime(raw) {
  if (!raw) return '';
  const parts = raw.split(/[;\s]/);
  if (parts.length < 2) return '';
  const t = parts[1].trim();
  if (!t) return '';
  if (t.includes(':')) return t.slice(0, 5);
  if (t.length >= 4) return `${t.slice(0, 2)}:${t.slice(2, 4)}`;
  return '';
}

// HH:mm:ss for sorting — preserves seconds so same-minute executions sort correctly
function normalizeTimeFull(raw) {
  if (!raw) return '';
  const parts = raw.split(/[;\s]/);
  if (parts.length < 2) return '';
  const t = parts[1].trim();
  if (!t) return '';
  if (t.includes(':')) return t.slice(0, 8); // HH:mm:ss
  if (t.length >= 6) return `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
  if (t.length >= 4) return `${t.slice(0, 2)}:${t.slice(2, 4)}:00`;
  return '';
}

function parseAttrs(attrString) {
  const attrs = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(attrString)) !== null) attrs[m[1]] = m[2];
  return attrs;
}
