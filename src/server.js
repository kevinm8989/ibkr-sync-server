import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { fetchFlexReport } from './flex.js';
import { parseTrades } from './parser.js';
import { db } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── Get all trades ────────────────────────────────────────────────────────────
app.get('/trades', (_req, res) => {
  const trades = db.get('trades') || [];
  const lastSync = db.get('lastSync');
  res.json({ trades, lastSync, count: trades.length });
});

// ── Manual sync trigger ───────────────────────────────────────────────────────
app.post('/sync', async (_req, res) => {
  try {
    const result = await runSync();
    res.json(result);
  } catch (err) {
    console.error('Sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Clear trades (dev/reset) ──────────────────────────────────────────────────
app.delete('/trades', (_req, res) => {
  db.set('trades', []);
  res.json({ ok: true });
});

// ── Core sync logic ───────────────────────────────────────────────────────────
async function runSync() {
  console.log('[sync] Starting IBKR Flex pull...');

  const token = process.env.IBKR_FLEX_TOKEN;
  const queryId = process.env.IBKR_FLEX_QUERY_ID;

  if (!token || !queryId) {
    throw new Error('IBKR_FLEX_TOKEN and IBKR_FLEX_QUERY_ID env vars are required.');
  }

  const raw = await fetchFlexReport(token, queryId);
  const incoming = parseTrades(raw);

  const existing = db.get('trades') || [];

  // Deduplicate by a composite key: date + symbol + entry + shares
  const key = t => `${t.date}|${t.sym}|${t.entry}|${t.shares}|${t.side}`;
  const existingKeys = new Set(existing.map(key));
  const newTrades = incoming.filter(t => !existingKeys.has(key(t)));

  const merged = [...existing, ...newTrades].sort((a, b) => new Date(b.date) - new Date(a.date));
  db.set('trades', merged);
  db.set('lastSync', new Date().toISOString());

  console.log(`[sync] Done. ${newTrades.length} new trades added (${merged.length} total).`);
  return { added: newTrades.length, total: merged.length, lastSync: db.get('lastSync') };
}

// ── Scheduled sync: 6:00 AM ET Mon–Fri ───────────────────────────────────────
// Cron runs in server timezone; Railway servers are typically UTC.
// 6am ET = 11am UTC (EST) or 10am UTC (EDT). Using 11am UTC to be safe.
cron.schedule('0 11 * * 1-5', async () => {
  console.log('[cron] Running scheduled morning sync...');
  try {
    await runSync();
  } catch (err) {
    console.error('[cron] Sync failed:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`IBKR sync server running on port ${PORT}`);
  console.log('Scheduled sync: 6am ET on weekdays');
});
