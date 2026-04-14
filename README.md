# IBKR Sync Server

Auto-pulls trades from IBKR Flex Web Service and serves them to your trade journal.
Deploys to Railway in ~5 minutes.

---

## 1. Get your IBKR Flex Query credentials

### Create a Flex Query
1. Log in to **IBKR Client Portal** → Reports → Flex Queries
2. Click **Create** → choose **Activity Flex Query**
3. Under **Sections**, enable **Trades**
4. Set format to **XML** (recommended) or CSV
5. Date range: **Last Business Day** (auto-updates daily)
6. Save → note the **Query ID** shown

### Get your Token
1. In Flex Queries page → click **Generate Tokens**
2. Copy your token (treat it like a password)

---

## 2. Deploy to Railway

### Option A: Deploy from GitHub (recommended)
1. Push this folder to a new GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo
4. Railway auto-detects Node.js and builds it

### Option B: Railway CLI
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### Add environment variables
In Railway dashboard → your service → Variables → Add:

| Variable | Value |
|----------|-------|
| `IBKR_FLEX_TOKEN` | Your token from step 1 |
| `IBKR_FLEX_QUERY_ID` | Your query ID from step 1 |
| `PORT` | `3001` (Railway sets this automatically) |

### Add a Volume (for data persistence)
In Railway dashboard → your service → Volumes → Add Volume
- Mount path: `/data`

Without this, trades reset on each redeploy.

---

## 3. Wire up your trade journal

Once deployed, Railway gives you a public URL like:
`https://ibkr-sync-server-production-xxxx.up.railway.app`

In your trade journal's **Settings** tab, paste this URL into the "Sync server URL" field.

The journal will:
- Auto-sync when you open it
- Let you manually sync via the "Sync now" button
- Merge new trades without duplicating existing ones

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Server health check |
| `/trades` | GET | All trades + last sync time |
| `/sync` | POST | Trigger immediate sync from IBKR |
| `/trades` | DELETE | Clear all trades (reset) |

---

## How it works

```
IBKR Flex Web Service
        │
        │ 1. POST /SendRequest (token + queryId) → get reference code
        │ 2. Poll /GetStatement (reference code) → wait for report
        ▼
   Raw XML/CSV report
        │
        │ Parser groups executions into round-trip trades
        │ (buy legs + sell legs → one trade with avg entry/exit)
        ▼
   /data/db.json  ←→  GET /trades
        ▲
   Deduplication
   (date|sym|entry|shares|side key)
```

## Scheduled sync
The server runs a cron job at **11:00 UTC (6am ET)** Monday–Friday.
This fires after pre-market, so your overnight/morning session trades from the prior day are included.

## Troubleshooting

**"IBKR_FLEX_TOKEN and IBKR_FLEX_QUERY_ID env vars are required"**
→ Add the variables in Railway dashboard.

**"Unexpected IBKR response"**
→ Check that your Flex Query is set to XML or CSV format, not PDF.

**Trades missing**
→ IBKR Flex reports only include *closed* positions (completed round trips). Open positions won't appear until you close them.

**Duplicate trades after redeploy**
→ Make sure you've added a Railway Volume at `/data`. Without it, the DB resets each deploy.
