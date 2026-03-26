// Server-side interaction log — Supabase backend (Vercel version)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tnjvbamehdhymmcktxuy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_7HdCbfsTLiI3IH7FFmEQdw_A9sIqTcI';

async function supabase(method, path, body) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=minimal' : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (method === 'GET') return res.json();
  return { ok: res.ok, status: res.status };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const data = await supabase('GET', 'interactions?order=created_at.desc&limit=2000');
      return res.status(200).json(data);
    } catch(e) { return res.status(200).json([]); }
  }

  if (req.method === 'POST') {
    try {
      const data = req.body || {};
      if (!data.type) return res.status(400).json({ error: 'type required' });

      const row = {
        user_id: data.userId || 'unknown',
        type: data.type,
        item_id: data.itemId || null,
        mode: data.mode || null,
        event: data.event || null,
        duration: data.duration || null,
        rating: data.rating || null,
        data: data,
        server_ts: Date.now(),
      };

      const result = await supabase('POST', 'interactions', row);
      if (result.ok) return res.status(200).json({ ok: true });
      return res.status(500).json({ error: 'Supabase insert failed: ' + result.status });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(405).json({ error: 'method not allowed' });
};
