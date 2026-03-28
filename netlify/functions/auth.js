// User auth & profile sync — Supabase backend (Netlify version)
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tnjvbamehdhymmcktxuy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_7HdCbfsTLiI3IH7FFmEQdw_A9sIqTcI';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function supabase(method, path, body) {
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
  };
  if (method === 'POST') headers['Prefer'] = 'return=representation';
  if (method === 'PATCH') headers['Prefer'] = 'return=representation';
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

function hashPassword(email, password) {
  return crypto.createHash('sha256').update(email.toLowerCase() + ':' + password).digest('hex');
}
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: '{"error":"POST only"}' };

  const h = { ...CORS, 'Content-Type': 'application/json' };
  const { action, email, password, displayName, profileData, token } = JSON.parse(event.body || '{}');
  if (!action) return { statusCode: 400, headers: h, body: '{"error":"action required"}' };

  try {
    if (action === 'register') {
      if (!email || !password) return { statusCode: 400, headers: h, body: '{"error":"email and password required"}' };
      if (password.length < 4) return { statusCode: 400, headers: h, body: '{"error":"password must be at least 4 characters"}' };
      const emailLower = email.toLowerCase().trim();
      const existing = await supabase('GET', `user_profiles?email=eq.${encodeURIComponent(emailLower)}&select=email`);
      if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
        return { statusCode: 409, headers: h, body: '{"error":"An account with this email already exists. Try logging in!"}' };
      }
      const sessionToken = generateToken();
      const row = { email: emailLower, password_hash: hashPassword(emailLower, password), display_name: (displayName || '').trim().substring(0, 60) || null, session_token: sessionToken, profile_data: profileData || {}, updated_at: new Date().toISOString() };
      const result = await supabase('POST', 'user_profiles', row);
      if (!result.ok) return { statusCode: 500, headers: h, body: '{"error":"Registration failed. The profiles table may not exist yet."}' };
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, token: sessionToken, displayName: row.display_name, profileData: row.profile_data }) };
    }

    if (action === 'login') {
      if (!email || !password) return { statusCode: 400, headers: h, body: '{"error":"email and password required"}' };
      const emailLower = email.toLowerCase().trim();
      const result = await supabase('GET', `user_profiles?email=eq.${encodeURIComponent(emailLower)}&select=*`);
      if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return { statusCode: 401, headers: h, body: '{"error":"No account found with this email."}' };
      const user = result.data[0];
      if (user.password_hash !== hashPassword(emailLower, password)) return { statusCode: 401, headers: h, body: '{"error":"Wrong password."}' };
      const sessionToken = generateToken();
      await supabase('PATCH', `user_profiles?email=eq.${encodeURIComponent(emailLower)}`, { session_token: sessionToken, updated_at: new Date().toISOString() });
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, token: sessionToken, displayName: user.display_name, profileData: user.profile_data || {} }) };
    }

    if (action === 'save') {
      if (!email) return { statusCode: 401, headers: h, body: '{"error":"not authenticated"}' };
      const emailLower = email.toLowerCase().trim();
      const update = { profile_data: profileData || {}, updated_at: new Date().toISOString() };
      if (displayName) update.display_name = displayName.substring(0, 60);
      const result = await supabase('PATCH', `user_profiles?email=eq.${encodeURIComponent(emailLower)}`, update);
      if (!result.ok) return { statusCode: 500, headers: h, body: '{"error":"Save failed"}' };
      return { statusCode: 200, headers: h, body: '{"ok":true}' };
    }

    if (action === 'load') {
      if (!email) return { statusCode: 401, headers: h, body: '{"error":"not authenticated"}' };
      const emailLower = email.toLowerCase().trim();
      const result = await supabase('GET', `user_profiles?email=eq.${encodeURIComponent(emailLower)}&select=display_name,profile_data,updated_at`);
      if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return { statusCode: 401, headers: h, body: '{"error":"Account not found."}' };
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, displayName: result.data[0].display_name, profileData: result.data[0].profile_data || {}, updatedAt: result.data[0].updated_at }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
  } catch (e) { return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) }; }
};
