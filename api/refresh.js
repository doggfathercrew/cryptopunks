import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const ETHERSCAN_V2_BASE = 'https://api.etherscan.io/v2/api?chainid=1';
const CRYPTOPUNKS_CONTRACT = '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb';
const PUNK_BOUGHT_TOPIC = '0x58e5d5a525e3b40bc15abaa38b5882678db1ee68befd2f60bafe3a7fd06db9e3';
const START_BLOCK = 13450000; // Oct 2021

// Helper: delay for rate limiting
const delay = ms => new Promise(r => setTimeout(r, ms));

// Helper: get week start (Monday) from timestamp
function getWeekStart(timestamp) {
  const date = new Date(timestamp);
  const day = date.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day;
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() + diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.getTime();
}

// Helper: calculate median
function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Fetch ETH price for a date from Binance
async function getEthPrice(dateStr) {
  const startTime = new Date(dateStr).getTime();
  const endTime = startTime + 86400000;
  const url = `https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1d&startTime=${startTime}&endTime=${endTime}&limit=1`;
  
  const resp = await fetch(url);
  const data = await resp.json();
  if (data && data[0]) {
    return parseFloat(data[0][4]); // Close price
  }
  return null;
}

// Fetch BTC price for a date from Binance
async function getBtcPrice(dateStr) {
  const startTime = new Date(dateStr).getTime();
  const endTime = startTime + 86400000;
  const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=${startTime}&endTime=${endTime}&limit=1`;
  
  const resp = await fetch(url);
  const data = await resp.json();
  if (data && data[0]) {
    return parseFloat(data[0][4]); // Close price
  }
  return null;
}

// Fetch punk sales from Etherscan
async function fetchPunkSales(fromBlock, toBlock) {
  const url = `${ETHERSCAN_V2_BASE}&module=logs&action=getLogs` +
    `&address=${CRYPTOPUNKS_CONTRACT}` +
    `&topic0=${PUNK_BOUGHT_TOPIC}` +
    `&fromBlock=${fromBlock}&toBlock=${toBlock}` +
    `&apikey=${ETHERSCAN_API_KEY}`;

  const resp = await fetch(url);
  const data = await resp.json();

  if (data.status !== '1' || !data.result) {
    return [];
  }

  return data.result.map(log => {
    const punkId = parseInt(log.topics[1], 16);
    const priceWei = BigInt(log.topics[3]);
    const priceEth = Number(priceWei) / 1e18;
    const timestamp = parseInt(log.timeStamp, 16) * 1000;

    return {
      tx_hash: log.transactionHash,
      block_number: parseInt(log.blockNumber, 16),
      timestamp,
      punk_id: punkId,
      price_wei: priceWei.toString(),
      price_eth: priceEth
    };
  });
}

export default async function handler(req, res) {
  // Only allow POST or GET with secret
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Get current sync status
    const { data: statusData } = await supabase
      .from('sync_status')
      .select('key, value')
      .in('key', ['last_block', 'last_price_date']);

    const statusMap = {};
    statusData?.forEach(s => statusMap[s.key] = s.value);

    let lastBlock = parseInt(statusMap.last_block || START_BLOCK.toString());
    let lastPriceDate = statusMap.last_price_date || '2021-10-01';

    // Get current block from Etherscan
    const blockResp = await fetch(
      `${ETHERSCAN_V2_BASE}&module=proxy&action=eth_blockNumber&apikey=${ETHERSCAN_API_KEY}`
    );
    const blockData = await blockResp.json();
    const currentBlock = parseInt(blockData.result, 16);

    const logs = [];

    // Fetch punk sales in chunks
    const CHUNK_SIZE = 50000;
    let fromBlock = lastBlock + 1;

    while (fromBlock < currentBlock) {
      const toBlock = Math.min(fromBlock + CHUNK_SIZE - 1, currentBlock);
      console.log(`Fetching blocks ${fromBlock} to ${toBlock}`);

      const sales = await fetchPunkSales(fromBlock, toBlock);
      logs.push(...sales);

      fromBlock = toBlock + 1;
      await delay(250); // Rate limit
    }

    // Get rarity data for filtering
    const { data: rarityData } = await supabase
      .from('punk_rarity')
      .select('punk_id, is_rare');

    const rarityMap = {};
    rarityData?.forEach(r => rarityMap[r.punk_id] = r.is_rare);

    // Insert new sales
    if (logs.length > 0) {
      const salesWithRarity = logs.map(sale => ({
        ...sale,
        is_rare: rarityMap[sale.punk_id] ?? false
      }));

      const { error: insertError } = await supabase
        .from('punk_sales')
        .upsert(salesWithRarity, { onConflict: 'tx_hash' });

      if (insertError) console.error('Insert error:', insertError);
    }

    // Update prices for missing dates
    const today = new Date().toISOString().split('T')[0];
    let currentDate = new Date(lastPriceDate);
    const todayDate = new Date(today);

    while (currentDate <= todayDate) {
      const dateStr = currentDate.toISOString().split('T')[0];

      const { data: existing } = await supabase
        .from('daily_prices')
        .select('id')
        .eq('date', dateStr)
        .single();

      if (!existing) {
        const btcPrice = await getBtcPrice(dateStr);
        const ethPrice = await getEthPrice(dateStr);

        if (btcPrice && ethPrice) {
          await supabase.from('daily_prices').insert({
            date: dateStr,
            btc_usd: btcPrice,
            eth_usd: ethPrice
          });
        }
        await delay(100);
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Recompute weekly ratios
    // Get all non-rare sales
    const { data: allSales } = await supabase
      .from('punk_sales')
      .select('timestamp, price_eth')
      .eq('is_rare', false)
      .order('timestamp', { ascending: true });

    // Get all prices
    const { data: allPrices } = await supabase
      .from('daily_prices')
      .select('date, btc_usd, eth_usd')
      .order('date', { ascending: true });

    // Build price lookup
    const priceByDate = {};
    allPrices?.forEach(p => {
      priceByDate[p.date] = { btc: p.btc_usd, eth: p.eth_usd };
    });

    // Group sales by week
    const weeklyGroups = {};
    allSales?.forEach(sale => {
      const weekStart = getWeekStart(sale.timestamp);
      if (!weeklyGroups[weekStart]) {
        weeklyGroups[weekStart] = [];
      }

      const saleDate = new Date(sale.timestamp).toISOString().split('T')[0];
      const prices = priceByDate[saleDate];
      if (prices) {
        const punkUsd = sale.price_eth * prices.eth;
        weeklyGroups[weekStart].push({ punkUsd, btcUsd: prices.btc });
      }
    });

    // Compute weekly medians
    const weeklyRatios = Object.entries(weeklyGroups).map(([weekStart, sales]) => {
      const punkPrices = sales.map(s => s.punkUsd);
      const btcPrices = sales.map(s => s.btcUsd);

      const medianPunkUsd = median(punkPrices);
      const medianBtcUsd = median(btcPrices);
      const ratio = medianBtcUsd > 0 ? medianPunkUsd / medianBtcUsd : 0;

      return {
        week_start: parseInt(weekStart),
        median_punk_usd: medianPunkUsd,
        median_btc_usd: medianBtcUsd,
        ratio,
        sales_count: sales.length,
        updated_at: new Date().toISOString()
      };
    });

    // Upsert weekly ratios
    if (weeklyRatios.length > 0) {
      const { error: ratioError } = await supabase
        .from('weekly_ratios')
        .upsert(weeklyRatios, { onConflict: 'week_start' });

      if (ratioError) console.error('Ratio upsert error:', ratioError);
    }

    // Update sync status
    await supabase
      .from('sync_status')
      .upsert([
        { key: 'last_block', value: currentBlock.toString(), updated_at: new Date().toISOString() },
        { key: 'last_sync', value: Date.now().toString(), updated_at: new Date().toISOString() },
        { key: 'last_price_date', value: today, updated_at: new Date().toISOString() }
      ], { onConflict: 'key' });

    res.status(200).json({
      success: true,
      newSales: logs.length,
      weeksUpdated: weeklyRatios.length,
      lastBlock: currentBlock
    });

  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}
