# CryptoPunk / Bitcoin Ratio Tracker

A free, self-hosted dashboard showing the valuation of non-rare CryptoPunks relative to Bitcoin over time.

**Live at:** `https://your-project.vercel.app`

## Stack

- **Hosting:** Vercel (free tier)
- **Database:** Supabase PostgreSQL (free tier)
- **Data Sources:** Etherscan V2 API, Binance API

## Setup

### 1. Create Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a free account
2. Create a new project
3. Go to **SQL Editor** and run the contents of `schema.sql`
4. Go to **Settings > API** and copy:
   - Project URL (e.g., `https://xxxxx.supabase.co`)
   - `anon` public key

### 2. Load Punk Rarity Data

Before the tracker works, you need to load the punk rarity data. Run this SQL in Supabase SQL Editor (or use the `/api/load-rarity` endpoint with your CSV):

```sql
-- Example: Insert a few punks manually (or bulk import from CSV)
INSERT INTO punk_rarity (punk_id, type, attr_count, has_hoodie, has_beanie, rank)
VALUES 
  (0, 'Female', 3, false, false, 5000),
  (1, 'Male', 2, false, false, 6000),
  -- ... add all 10,000 punks
;
```

For bulk import, use Supabase's CSV import feature in the Table Editor.

### 3. Deploy to Vercel

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) and import your repo
3. Add environment variables:
   - `SUPABASE_URL` — Your Supabase project URL
   - `SUPABASE_ANON_KEY` — Your Supabase anon key
   - `ETHERSCAN_API_KEY` — Your Etherscan API key
   - `CRON_SECRET` — A random string for securing the refresh endpoint

4. Deploy!

### 4. Initial Data Load

After deploying, trigger the first data sync:

```bash
curl -X POST https://your-project.vercel.app/api/refresh \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

This will take a few minutes to fetch all historical data.

### 5. Set Up Auto-Refresh (Optional)

Use Vercel Cron or an external service like cron-job.org to hit `/api/refresh` periodically:

**vercel.json** (add this):
```json
{
  "crons": [{
    "path": "/api/refresh",
    "schedule": "0 */6 * * *"
  }]
}
```

This refreshes every 6 hours.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/data` | GET | Returns weekly ratio data |
| `/api/refresh` | POST | Fetches new data and updates cache |

## Local Development

```bash
# Install dependencies
npm install

# Create .env.local with your keys
cp .env.example .env.local

# Run locally
npm run dev
```

## Cost

**$0/month** on free tiers:
- Vercel: 100GB bandwidth, 100K function invocations
- Supabase: 500MB database, 2GB bandwidth
- Etherscan: 5 calls/sec, 100K calls/day
- Binance: No API key required

## Credits

Built by [@DoggfatherCrew](https://x.com/DoggfatherCrew)

Data from Etherscan and Binance APIs.
