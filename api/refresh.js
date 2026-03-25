import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const ETHERSCAN_V2_BASE = 'https://api.etherscan.io/v2/api?chainid=1';
const CRYPTOPUNKS_CONTRACT = '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb';
const PUNK_BOUGHT_TOPIC = '0x58e5d5a525e3b40bc15abaa38b5882678db1ee68befd2f60bafe3a7fd06db9e3';

function getWeekStart(timestamp) {
  const date = new Date(timestamp);
  const day = date.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day;
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() + diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.getTime();
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export default async function handler(req, res) {
  // Auth check - support both manual calls and Vercel cron
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  
  // Allow if: Vercel cron, or correct Bearer token, or secret in query
  const querySecret = req.query.secret;
  const isAuthorized = isVercelCron || 
    (cronSecret && authHeader === `Bearer ${cronSecret}`) ||
    (cronSecret && querySecret === cronSecret);
  
  if (!isAuthorized) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // 1. Get last synced block
    const { data: statusData } = await supabase
      .from('sync_status')
      .select('value')
      .eq('key', 'last_block')
      .single();

    const lastBlock = parseInt(statusData?.value || '24707009');

    // 2. Get current block from Etherscan
    const blockResp = await fetch(
      `${ETHERSCAN_V2_BASE}&module=proxy&action=eth_blockNumber&apikey=${ETHERSCAN_API_KEY}`
    );
    const blockData = await blockResp.json();
    const currentBlock = parseInt(blockData.result, 16);

    if (lastBlock >= currentBlock) {
      return res.status(200).json({ 
        success: true, 
        message: 'Already up to date', 
        lastBlock 
      });
    }

    // 3. Fetch new punk sales from Etherscan
    const logsUrl = `${ETHERSCAN_V2_BASE}&module=logs&action=getLogs` +
      `&address=${CRYPTOPUNKS_CONTRACT}` +
      `&topic0=${PUNK_BOUGHT_TOPIC}` +
      `&fromBlock=${lastBlock + 1}&toBlock=${currentBlock}` +
      `&apikey=${ETHERSCAN_API_KEY}`;

    const logsResp = await fetch(logsUrl);
    const logsData = await logsResp.json();

    // 4. Get current prices from Binance
    const [btcResp, ethResp] = await Promise.all([
      fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'),
      fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT')
    ]);
    const btcData = await btcResp.json();
    const ethData = await ethResp.json();
    const btcPrice = parseFloat(btcData.price);
    const ethPrice = parseFloat(ethData.price);

    // 5. Get rare punk IDs from database
    const { data: rarePunks } = await supabase
      .from('punk_rarity')
      .select('punk_id')
      .eq('is_rare', true);
    
    const rareSet = new Set(rarePunks?.map(p => p.punk_id) || []);

    // 6. Parse sales and filter out rare punks
    const sales = [];
    if (logsData.status === '1' && logsData.result?.length > 0) {
      for (const log of logsData.result) {
        const punkId = parseInt(log.topics[1], 16);
        
        // Skip rare punks
        if (rareSet.has(punkId)) continue;
        
        const priceWei = BigInt(log.topics[3]);
        const priceEth = Number(priceWei) / 1e18;
        const timestamp = parseInt(log.timeStamp, 16) * 1000;
        const priceUsd = priceEth * ethPrice;

        sales.push({
          punkId,
          timestamp,
          priceEth,
          priceUsd,
          weekStart: getWeekStart(timestamp)
        });
      }
    }

    // 7. Group sales by week
    const weeklyGroups = {};
    for (const sale of sales) {
      if (!weeklyGroups[sale.weekStart]) {
        weeklyGroups[sale.weekStart] = [];
      }
      weeklyGroups[sale.weekStart].push(sale.priceUsd);
    }

    // 8. Update weekly_ratios for each affected week
    let weeksUpdated = 0;
    for (const [weekStart, prices] of Object.entries(weeklyGroups)) {
      const weekStartNum = parseInt(weekStart);
      const newMedian = median(prices);
      const newCount = prices.length;

      // Check if week exists
      const { data: existing } = await supabase
        .from('weekly_ratios')
        .select('*')
        .eq('week_start', weekStartNum)
        .single();

      if (existing) {
        // Merge with existing data (weighted average for simplicity)
        const totalCount = existing.sales_count + newCount;
        const mergedMedian = (existing.median_punk_usd * existing.sales_count + newMedian * newCount) / totalCount;
        const mergedRatio = mergedMedian / btcPrice;

        await supabase
          .from('weekly_ratios')
          .update({
            median_punk_usd: mergedMedian,
            median_btc_usd: btcPrice,
            ratio: mergedRatio,
            sales_count: totalCount,
            updated_at: new Date().toISOString()
          })
          .eq('week_start', weekStartNum);
      } else {
        // Insert new week
        await supabase
          .from('weekly_ratios')
          .insert({
            week_start: weekStartNum,
            median_punk_usd: newMedian,
            median_btc_usd: btcPrice,
            ratio: newMedian / btcPrice,
            sales_count: newCount
          });
      }
      weeksUpdated++;
    }

    // 9. Update sync status
    await supabase
      .from('sync_status')
      .upsert([
        { key: 'last_block', value: currentBlock.toString(), updated_at: new Date().toISOString() },
        { key: 'last_sync', value: Date.now().toString(), updated_at: new Date().toISOString() }
      ], { onConflict: 'key' });

    res.status(200).json({
      success: true,
      blocksProcessed: currentBlock - lastBlock,
      salesFound: sales.length,
      weeksUpdated,
      lastBlock: currentBlock,
      btcPrice: btcPrice.toFixed(2),
      ethPrice: ethPrice.toFixed(2)
    });

  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}
