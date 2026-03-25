import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  try {
    // Get weekly ratios from database
    const { data: weeklyData, error } = await supabase
      .from('weekly_ratios')
      .select('week_start, median_punk_usd, median_btc_usd, ratio, sales_count')
      .order('week_start', { ascending: true });

    if (error) throw error;

    // Get sync status
    const { data: syncStatus } = await supabase
      .from('sync_status')
      .select('key, value, updated_at')
      .in('key', ['last_block', 'last_sync']);

    const statusMap = {};
    syncStatus?.forEach(s => {
      statusMap[s.key] = s.value;
      if (s.key === 'last_sync') statusMap.last_sync_at = s.updated_at;
    });

    res.status(200).json({
      success: true,
      data: weeklyData || [],
      meta: {
        lastBlock: parseInt(statusMap.last_block || '0'),
        lastSync: statusMap.last_sync_at || null,
        weeksCount: weeklyData?.length || 0
      }
    });
  } catch (error) {
    console.error('Error fetching data:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
