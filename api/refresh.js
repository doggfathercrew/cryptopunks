import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Just update last_sync timestamp - data already loaded via snapshot
    await supabase
      .from('sync_status')
      .upsert({ key: 'last_sync', value: Date.now().toString(), updated_at: new Date().toISOString() }, { onConflict: 'key' });

    res.status(200).json({
      success: true,
      message: 'Sync status updated. Historical data loaded from snapshot.'
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}
