// Server-side interaction log — Supabase backend
// POST: insert interaction
// GET: return interactions (for admin analytics)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tnjvbamehdhymmcktxuy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_7HdCbfsTLiI3IH7FFmEQdw_A9sIqTcI';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const headers = { ...CORS, 'Content-Type': 'application/json' };

  // GET: return interactions
  if (event.httpMethod === 'GET') {
    try {
      const data = await supabase('GET', 'interactions?order=created_at.desc&limit=2000');
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    } catch(e) {
      return { statusCode: 200, headers, body: '[]' };
    }
  }

  // POST: insert interaction
  if (event.httpMethod === 'POST') {
    try {
      const data = JSON.parse(event.body || '{}');
      if (!data.type) return { statusCode: 400, headers, body: '{"error":"type required"}' };

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
      if (result.ok) return { statusCode: 200, headers, body: '{"ok":true}' };
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase insert failed: ' + result.status }) };
    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 405, headers, body: '{"error":"method not allowed"}' };
};
