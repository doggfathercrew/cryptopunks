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
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const querySecret = req.query.secret;
  const isAuthorized = isVercelCron || 
    (cronSecret && authHeader === `Bearer ${cronSecret}`) ||
    (cronSecret && querySecret === cronSecret);
  
  if (!isAuthorized) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { data: statusData } = await supabase
      .from('sync_status').select('value').eq('key', 'last_block').single();
    const lastBlock = parseInt(statusData?.value || '24707009');

    const blockResp = await fetch(
      `${ETHERSCAN_V2_BASE}&module=proxy&action=eth_blockNumber&apikey=${ETHERSCAN_API_KEY}`
    );
    const blockData = await blockResp.json();
    const currentBlock = parseInt(blockData.result, 16);

    if (lastBlock >= currentBlock) {
      return res.status(200).json({ success: true, message: 'Already up to date', lastBlock });
    }

    const logsUrl = `${ETHERSCAN_V2_BASE}&module=logs&action=getLogs` +
      `&address=${CRYPTOPUNKS_CONTRACT}&topic0=${PUNK_BOUGHT_TOPIC}` +
      `&fromBlock=${lastBlock + 1}&toBlock=${currentBlock}&apikey=${ETHERSCAN_API_KEY}`;
    const logsResp = await fetch(logsUrl);
    const logsData = await logsResp.json();

    let btcPrice, ethPrice;
    try {
      const priceResp = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd'
      );
      const priceData = await priceResp.json();
      btcPrice = priceData.bitcoin?.usd;
      ethPrice = priceData.ethereum?.usd;
    } catch (e) {}
    
    if (!btcPrice || !ethPrice) {
      const [btcResp, ethResp] = await Promise.all([
        fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'),
        fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT')
      ]);
      btcPrice = parseFloat((await btcResp.json()).price);
      ethPrice = parseFloat((await ethResp.json()).price);
    }
    
    if (!btcPrice || !ethPrice || isNaN(btcPrice) || isNaN(ethPrice)) {
      return res.status(500).json({ success: false, error: 'Failed to fetch prices' });
    }

    const { data: rarePunks } = await supabase
      .from('punk_rarity').select('punk_id').eq('is_rare', true);
    const rareSet = new Set(rarePunks?.map(p => p.punk_id) || []);

    const sales = [];
    if (logsData.status === '1' && logsData.result?.length > 0) {
      for (const log of logsData.result) {
        const punkId = parseInt(log.topics[1], 16);
        if (rareSet.has(punkId)) continue;
        const priceWei = BigInt(log.topics[3]);
        const priceEth = Number(priceWei) / 1e18;
        const timestamp = parseInt(log.timeStamp, 16) * 1000;
        sales.push({ punkId, timestamp, priceUsd: priceEth * ethPrice, weekStart: getWeekStart(timestamp) });
      }
    }

    const weeklyGroups = {};
    for (const sale of sales) {
      if (!weeklyGroups[sale.weekStart]) weeklyGroups[sale.weekStart] = [];
      weeklyGroups[sale.weekStart].push(sale.priceUsd);
    }
    
    const weeksWithSales = Object.keys(weeklyGroups).map(w => ({
      weekStart: parseInt(w),
      weekDate: new Date(parseInt(w)).toISOString().split('T')[0],
      salesCount: weeklyGroups[w].length,
      prices: weeklyGroups[w]
    }));

    let weeksUpdated = 0;
    const errors = [];
    const debugValues = [];
    
    for (const [weekStart, prices] of Object.entries(weeklyGroups)) {
      const weekStartNum = parseInt(weekStart);
      const newMedian = median(prices);
      const newCount = prices.length;
      
      // Calculate the values we would insert
      const insertValues = {
        week_start: weekStartNum,
        median_punk_usd: Math.round(newMedian * 100) / 100,
        median_btc_usd: Math.round(btcPrice * 100) / 100,
        ratio: Math.round((newMedian / btcPrice) * 100000000) / 100000000,
        sales_count: newCount,
        raw_median: newMedian,
        raw_btc: btcPrice
      };
      debugValues.push(insertValues);

      const { data: existing, error: selectError } = await supabase
        .from('weekly_ratios').select('*').eq('week_start', weekStartNum).maybeSingle();

      if (selectError) { errors.push(`Select: ${selectError.message}`); continue; }

      if (existing) {
        const totalCount = existing.sales_count + newCount;
        const mergedMedian = (existing.median_punk_usd * existing.sales_count + newMedian * newCount) / totalCount;
        const { error: updateError } = await supabase
          .from('weekly_ratios')
          .update({ 
            median_punk_usd: Math.round(mergedMedian * 100) / 100, 
            median_btc_usd: Math.round(btcPrice * 100) / 100, 
            ratio: Math.round((mergedMedian / btcPrice) * 100000000) / 100000000, 
            sales_count: totalCount, 
            updated_at: new Date().toISOString() 
          })
          .eq('week_start', weekStartNum);
        if (updateError) errors.push(`Update: ${updateError.message}`);
        else weeksUpdated++;
      } else {
        const { error: insertError } = await supabase
          .from('weekly_ratios')
          .insert({ 
            week_start: weekStartNum, 
            median_punk_usd: Math.round(newMedian * 100) / 100, 
            median_btc_usd: Math.round(btcPrice * 100) / 100, 
            ratio: Math.round((newMedian / btcPrice) * 100000000) / 100000000, 
            sales_count: newCount 
          });
        if (insertError) errors.push(`Insert: ${insertError.message}`);
        else weeksUpdated++;
      }
    }

    await supabase.from('sync_status').upsert([
      { key: 'last_block', value: currentBlock.toString(), updated_at: new Date().toISOString() },
      { key: 'last_sync', value: Date.now().toString(), updated_at: new Date().toISOString() }
    ], { onConflict: 'key' });

    res.status(200).json({
      success: true, blocksProcessed: currentBlock - lastBlock, salesFound: sales.length,
      weeksWithSales, weeksUpdated, debugValues, errors: errors.length > 0 ? errors : undefined,
      lastBlock: currentBlock, btcPrice: btcPrice.toFixed(2), ethPrice: ethPrice.toFixed(2)
    });

  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}