// User auth & profile sync — Supabase backend (Vercel version)
// Table: user_profiles (email text UNIQUE, password_hash text, display_name text, profile_data jsonb, created_at, updated_at)
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tnjvbamehdhymmcktxuy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_7HdCbfsTLiI3IH7FFmEQdw_A9sIqTcI';

async function supabase(method, path, body) {
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
  };
  if (method === 'POST') headers['Prefer'] = 'return=representation';
  if (method === 'PATCH') headers['Prefer'] = 'return=representation';
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

function hashPassword(email, password) {
  return crypto.createHash('sha256').update(email.toLowerCase() + ':' + password).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { action, email, password, displayName, profileData, token } = req.body || {};

  if (!action) return res.status(400).json({ error: 'action required' });

  try {
    // ---- REGISTER ----
    if (action === 'register') {
      if (!email || !password) return res.status(400).json({ error: 'email and password required' });
      if (password.length < 4) return res.status(400).json({ error: 'password must be at least 4 characters' });

      const emailLower = email.toLowerCase().trim();
      // Check if email exists
      const existing = await supabase('GET', `user_profiles?email=eq.${encodeURIComponent(emailLower)}&select=email`);
      if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
        return res.status(409).json({ error: 'An account with this email already exists. Try logging in!' });
      }

      const sessionToken = generateToken();
      const row = {
        email: emailLower,
        password_hash: hashPassword(emailLower, password),
        display_name: (displayName || '').trim().substring(0, 60) || null,
        session_token: sessionToken,
        profile_data: profileData || {},
        updated_at: new Date().toISOString(),
      };
      const result = await supabase('POST', 'user_profiles', row);
      if (!result.ok) return res.status(500).json({ error: 'Registration failed. The profiles table may not exist yet.' });

      return res.status(200).json({
        ok: true,
        token: sessionToken,
        displayName: row.display_name,
        profileData: row.profile_data,
      });
    }

    // ---- LOGIN ----
    if (action === 'login') {
      if (!email || !password) return res.status(400).json({ error: 'email and password required' });

      const emailLower = email.toLowerCase().trim();
      const result = await supabase('GET', `user_profiles?email=eq.${encodeURIComponent(emailLower)}&select=*`);
      if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) {
        return res.status(401).json({ error: 'No account found with this email.' });
      }

      const user = result.data[0];
      if (user.password_hash !== hashPassword(emailLower, password)) {
        return res.status(401).json({ error: 'Wrong password.' });
      }

      // Refresh session token
      const sessionToken = generateToken();
      await supabase('PATCH', `user_profiles?email=eq.${encodeURIComponent(emailLower)}`, {
        session_token: sessionToken,
        updated_at: new Date().toISOString(),
      });

      return res.status(200).json({
        ok: true,
        token: sessionToken,
        displayName: user.display_name,
        profileData: user.profile_data || {},
      });
    }

    // ---- SAVE PROFILE ----
    if (action === 'save') {
      if (!email || !token) return res.status(401).json({ error: 'not authenticated' });
      const emailLower = email.toLowerCase().trim();

      // Verify token
      const check = await supabase('GET', `user_profiles?email=eq.${encodeURIComponent(emailLower)}&session_token=eq.${token}&select=email`);
      if (!check.ok || !Array.isArray(check.data) || check.data.length === 0) {
        return res.status(401).json({ error: 'Session expired. Please log in again.' });
      }

      const update = { profile_data: profileData || {}, updated_at: new Date().toISOString() };
      if (displayName) update.display_name = displayName.substring(0, 60);
      const result = await supabase('PATCH', `user_profiles?email=eq.${encodeURIComponent(emailLower)}`, update);
      if (!result.ok) return res.status(500).json({ error: 'Save failed' });

      return res.status(200).json({ ok: true });
    }

    // ---- LOAD PROFILE ----
    if (action === 'load') {
      if (!email || !token) return res.status(401).json({ error: 'not authenticated' });
      const emailLower = email.toLowerCase().trim();

      const result = await supabase('GET', `user_profiles?email=eq.${encodeURIComponent(emailLower)}&session_token=eq.${token}&select=display_name,profile_data,updated_at`);
      if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) {
        return res.status(401).json({ error: 'Session expired. Please log in again.' });
      }

      return res.status(200).json({
        ok: true,
        displayName: result.data[0].display_name,
        profileData: result.data[0].profile_data || {},
        updatedAt: result.data[0].updated_at,
      });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
