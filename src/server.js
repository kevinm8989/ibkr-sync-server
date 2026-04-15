import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { fetchFlexReport } from './flex.js';
import { parseTrades } from './parser.js';
import { db } from './db.js';

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/debug', (_req, res) => {
  res.json({
    hasToken: !!process.env.IBKR_FLEX_TOKEN,
    hasQueryId: !!process.env.IBKR_FLEX_QUERY_ID,
    tokenLength: (process.env.IBKR_FLEX_TOKEN || '').length,
    queryId: process.env.IBKR_FLEX_QUERY_ID || 'not set'
  });
});

app.get('/trades', (_req, res) => {
  const trades = db.get('trades') || [];
  const lastSync = db.get('lastSync');
  res.json({ trades, lastSync, count: trades.length });
});

app.post('/sync', async (_req, res) => {
  try {
    const result = await runSync();
    res.json(result);
  } catch (err) {
    console.error('Sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/trades', (_req, res) => {
  db.set('trades', []);
  res.json({ ok: true });
});

async function runSync() {
  console.log('[sync] Starting IBKR Flex pull...');
  const token = process.env.IBKR_FLEX_TOKEN || '296850575658907783704576';
  const queryId = process.env.IBKR_FLEX_QUERY_ID || '1472333';
  console.log('[sync] Token length:', token.length, 'QueryId:', queryId);
  const raw = await fetchFlexReport(token, queryId);
  const incoming = parseTrades(raw);
  const existing = db.get('trades') || [];
  const key = t => `${t.date}|${t.sym}|${t.entry}|${t.shares}|${t.side}`;
  const existingKeys = new Set(existing.map(key));
  const newTrades = incoming.filter(t => !existingKeys.has(key(t)));
  const merged = [...existing, ...newTrades].sort((a, b) => new Date(b.date) - new Date(a.date));
  db.set('trades', merged);
  db.set('lastSync', new Date().toISOString());
  console.log(`[sync] Done. ${newTrades.length} new trades added (${merged.length} total).`);
  return { added: newTrades.length, total: merged.length, lastSync: db.get('lastSync') };
}

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
