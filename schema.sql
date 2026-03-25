-- Supabase Schema for CryptoPunks/BTC Ratio Tracker
-- Run this in your Supabase SQL Editor

-- Store individual punk sales (cached from Etherscan)
CREATE TABLE punk_sales (
  id SERIAL PRIMARY KEY,
  tx_hash TEXT UNIQUE NOT NULL,
  block_number BIGINT NOT NULL,
  timestamp BIGINT NOT NULL,
  punk_id INTEGER NOT NULL,
  price_wei TEXT NOT NULL,
  price_eth NUMERIC(20, 8) NOT NULL,
  is_rare BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_punk_sales_timestamp ON punk_sales(timestamp);
CREATE INDEX idx_punk_sales_block ON punk_sales(block_number);
CREATE INDEX idx_punk_sales_rare ON punk_sales(is_rare);

-- Store daily BTC/ETH prices (cached from Binance)
CREATE TABLE daily_prices (
  id SERIAL PRIMARY KEY,
  date DATE UNIQUE NOT NULL,
  btc_usd NUMERIC(12, 2) NOT NULL,
  eth_usd NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_daily_prices_date ON daily_prices(date);

-- Store pre-computed weekly ratios
CREATE TABLE weekly_ratios (
  id SERIAL PRIMARY KEY,
  week_start BIGINT UNIQUE NOT NULL,
  median_punk_usd NUMERIC(12, 2) NOT NULL,
  median_btc_usd NUMERIC(12, 2) NOT NULL,
  ratio NUMERIC(10, 6) NOT NULL,
  sales_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_weekly_ratios_week ON weekly_ratios(week_start);

-- Track sync status
CREATE TABLE sync_status (
  id SERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Initialize sync status
INSERT INTO sync_status (key, value) VALUES 
  ('last_block', '13450000'),
  ('last_sync', '0'),
  ('last_price_date', '2021-10-01');

-- Punk rarity data (loaded once from CSV)
CREATE TABLE punk_rarity (
  punk_id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  attr_count INTEGER NOT NULL,
  has_hoodie BOOLEAN DEFAULT false,
  has_beanie BOOLEAN DEFAULT false,
  rank INTEGER NOT NULL,
  is_rare BOOLEAN GENERATED ALWAYS AS (
    type IN ('Alien', 'Ape', 'Zombie') OR
    has_hoodie OR
    has_beanie OR
    attr_count IN (1, 7) OR
    rank <= 1000
  ) STORED
);

CREATE INDEX idx_punk_rarity_rare ON punk_rarity(is_rare);

-- Function to get week start (Monday) from timestamp
CREATE OR REPLACE FUNCTION get_week_start(ts BIGINT)
RETURNS BIGINT AS $$
DECLARE
  dt TIMESTAMPTZ;
  monday TIMESTAMPTZ;
BEGIN
  dt := TO_TIMESTAMP(ts);
  monday := DATE_TRUNC('week', dt);
  RETURN EXTRACT(EPOCH FROM monday)::BIGINT * 1000;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
