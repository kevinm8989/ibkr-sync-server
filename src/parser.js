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
    const buySell = iBuySell >= 0 ? (cols[iBuySell] || '').toUpperCase() : (qty > 0 ? 'BUY' : 'SELL');
    if (!sym || !qty || !price) continue;
    executions.push({ sym, qty: Math.abs(qty), price, comm, date, time, buySell });
  }
  return buildTrades(executions);
}

// Core logic: process executions in chronological order per symbol per day.
// Track running position — when position hits zero, close the trade.
// This correctly handles multiple round trips in the same ticker same day.
function buildTrades(executions) {
  // Group by date + symbol
  const bySymDate = {};
  for (const ex of executions) {
    const k = `${ex.date}|${ex.sym}`;
    if (!bySymDate[k]) bySymDate[k] = [];
    bySymDate[k].push({ ...ex });
  }

  const trades = [];

  for (const [key, execs] of Object.entries(bySymDate)) {
    const [date, sym] = key.split('|');

    // Sort chronologically by time
    execs.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

    // Position tracker
    let position = 0; // positive = long, negative = short
    let openLots = []; // { price, qty, comm, time }
    let tradeEntry = null; // { side, time }

    const closeTrade = (exitPrice, exitQty, exitComm, exitTime) => {
      if (!openLots.length) return;

      // Match against open lots FIFO
      let remaining = exitQty;
      const matched = [];
      for (const lot of openLots) {
        if (remaining <= 0) break;
        const take = Math.min(lot.qty, remaining);
        matched.push({ price: lot.price, qty: take, comm: lot.qty > 0 ? (lot.comm / lot.qty) * take : 0, time: lot.time });
        lot.qty -= take;
        remaining -= take;
      }
      // Remove exhausted lots
      openLots = openLots.filter(l => l.qty > 0);

      if (!matched.length) return;
      const totalQty = matched.reduce((a, b) => a + b.qty, 0);
      const avgEntry = matched.reduce((a, b) => a + b.price * b.qty, 0) / totalQty;
      const entryCost = matched.reduce((a, b) => a + b.comm, 0);
      const entryTime = matched[0].time || '';

      trades.push({
        date, sym,
        side: tradeEntry?.side || 'Long',
        time: entryTime,
        exitTime: exitTime || '',
        shares: Math.round(totalQty),
        entry: round2(avgEntry),
        exit: round2(exitPrice),
        comm: round2(entryCost + exitComm * (exitQty > 0 ? totalQty / exitQty : 1)),
        stop: 0, strat: 'Import', notes: '', emotion: 'Neutral'
      });
    };

    for (const ex of execs) {
      const isBuy = ex.buySell.startsWith('B');
      const isSell = !isBuy;

      if (position === 0) {
        // Opening new position
        tradeEntry = { side: isBuy ? 'Long' : 'Short', time: ex.time };
        openLots = [{ price: ex.price, qty: ex.qty, comm: ex.comm, time: ex.time }];
        position = isBuy ? ex.qty : -ex.qty;
      } else if (position > 0 && isBuy) {
        // Adding to long position (scale in)
        openLots.push({ price: ex.price, qty: ex.qty, comm: ex.comm, time: ex.time });
        position += ex.qty;
      } else if (position < 0 && isSell) {
        // Adding to short position (scale in)
        openLots.push({ price: ex.price, qty: ex.qty, comm: ex.comm, time: ex.time });
        position -= ex.qty;
      } else if (position > 0 && isSell) {
        // Closing/reducing long position
        closeTrade(ex.price, ex.qty, ex.comm, ex.time);
        position -= ex.qty;
        if (Math.abs(position) < 0.001) {
          // Fully flat — reset for next round trip
          position = 0;
          openLots = [];
          tradeEntry = null;
        } else if (position < 0) {
          // Flipped to short — start new short position with remaining qty
          const flipQty = Math.abs(position);
          openLots = [{ price: ex.price, qty: flipQty, comm: 0, time: ex.time }];
          tradeEntry = { side: 'Short', time: ex.time };
        }
      } else if (position < 0 && isBuy) {
        // Closing/reducing short position
        closeTrade(ex.price, ex.qty, ex.comm, ex.time);
        position += ex.qty;
        if (Math.abs(position) < 0.001) {
          position = 0;
          openLots = [];
          tradeEntry = null;
        } else if (position > 0) {
          // Flipped to long
          const flipQty = Math.abs(position);
          openLots = [{ price: ex.price, qty: flipQty, comm: 0, time: ex.time }];
          tradeEntry = { side: 'Long', time: ex.time };
        }
      }
    }

    // If position still open at end of day (e.g. overnight hold), close it as-is
    if (openLots.length && openLots.some(l => l.qty > 0)) {
      const lastEx = execs[execs.length - 1];
      const totalQty = openLots.reduce((a, l) => a + l.qty, 0);
      const avgEntry = openLots.reduce((a, l) => a + l.price * l.qty, 0) / totalQty;
      trades.push({
        date, sym,
        side: tradeEntry?.side || 'Long',
        time: openLots[0].time || '',
        exitTime: lastEx.time || '',
        shares: Math.round(totalQty),
        entry: round2(avgEntry),
        exit: round2(lastEx.price),
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

function normalizeTime(raw) {
  if (!raw) return '';
  const parts = raw.split(/[;\s]/);
  if (parts.length < 2) return '';
  const timePart = parts[1].trim();
  if (!timePart) return '';
  if (timePart.includes(':')) return timePart.slice(0, 5);
  if (timePart.length >= 4) return `${timePart.slice(0, 2)}:${timePart.slice(2, 4)}`;
  return '';
}

function parseAttrs(attrString) {
  const attrs = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(attrString)) !== null) attrs[m[1]] = m[2];
  return attrs;
}
