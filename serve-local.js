#!/usr/bin/env node
// Local dev server: static files + Recombee proxy (same as Netlify function)
// Usage: node serve-local.js [port]
// Set RECOMBEE_TOKEN env var or create .env file

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.argv[2] || '8000', 10);
const ROOT = __dirname;

// Load .env file if exists (no dependencies needed)
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  });
}

const DB = process.env.RECOMBEE_DB || 'cvachond-land-free-pbook-kids';
const TOKEN = process.env.RECOMBEE_TOKEN || '';
const REGION = process.env.RECOMBEE_REGION || 'rapi-eu-west';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.md': 'text/plain', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

function signUrl(urlPath) {
  const ts = Math.floor(Date.now() / 1000);
  const sep = urlPath.includes('?') ? '&' : '?';
  const pathWithTs = urlPath + sep + 'hmac_timestamp=' + ts;
  const hmac = crypto.createHmac('sha1', TOKEN).update(pathWithTs).digest('hex');
  return pathWithTs + '&hmac_sign=' + hmac;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function handleProxy(req, res) {
  // Read body
  let body = '';
  for await (const chunk of req) body += chunk;

  if (!TOKEN) {
    res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
    res.end('{"error":"RECOMBEE_TOKEN not set. Create .env file with RECOMBEE_TOKEN=your_token"}');
    return;
  }

  let parsed;
  try { parsed = JSON.parse(body || '{}'); } catch (e) {
    res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
    res.end('{"error":"Invalid JSON"}');
    return;
  }

  if (!parsed.endpoint) {
    res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
    res.end('{"error":"endpoint required"}');
    return;
  }

  // Build URL — auto-detect method from request or body presence
  let basePath = '/' + DB + parsed.endpoint;
  const method = parsed.method || (parsed.body ? 'POST' : 'GET');
  if (method === 'GET' && parsed.body) {
    const params = Object.entries(parsed.body).map(([k,v]) => k + '=' + encodeURIComponent(v)).join('&');
    basePath += (basePath.includes('?') ? '&' : '?') + params;
  }
  const signedPath = signUrl(basePath);
  const url = 'https://' + REGION + '.recombee.com' + signedPath;

  try {
    const fetchOpts = { method, headers: { 'Content-Type': 'application/json' } };
    if (method !== 'GET' && parsed.body) fetchOpts.body = JSON.stringify(parsed.body);
    const response = await fetch(url, fetchOpts);
    const data = await response.text();
    res.writeHead(response.status, { ...CORS, 'Content-Type': 'application/json' });
    res.end(data);
  } catch (e) {
    res.writeHead(502, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// --- Interaction log (Supabase + local file fallback) ---
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tnjvbamehdhymmcktxuy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_7HdCbfsTLiI3IH7FFmEQdw_A9sIqTcI';
const LOG_FILE = path.join(ROOT, '.log-interactions.jsonl');

async function handleLog(req, res) {
  if (req.method === 'GET') {
    try {
      // Try Supabase first
      const sbRes = await fetch(SUPABASE_URL + '/rest/v1/interactions?order=created_at.desc&limit=2000', {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
      });
      if (sbRes.ok) { const data = await sbRes.json(); res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); return; }
    } catch(e) {}
    // Fallback to local file
    try {
      if (!fs.existsSync(LOG_FILE)) { res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' }); res.end('[]'); return; }
      const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
      const entries = lines.map(l => { try { return JSON.parse(l); } catch(e) { return null; } }).filter(Boolean);
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(entries));
    } catch(e) { res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' }); res.end('[]'); }
    return;
  }
  // POST
  let body = ''; for await (const c of req) body += c;
  try {
    const data = JSON.parse(body || '{}');
    if (!data.type) { res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' }); res.end('{"error":"type required"}'); return; }
    // Write to Supabase
    const row = { user_id: data.userId || 'unknown', type: data.type, item_id: data.itemId || null, mode: data.mode || null, event: data.event || null, duration: data.duration || null, rating: data.rating || null, data: data, server_ts: Date.now() };
    fetch(SUPABASE_URL + '/rest/v1/interactions', {
      method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify(row)
    }).catch(() => {});
    // Also write to local file as backup
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ...data, serverTs: Date.now() }) + '\n');
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  } catch(e) { res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
}

const server = http.createServer(async (req, res) => {
  // Interaction log
  if (req.url === '/.netlify/functions/log' || req.url === '/api/log') {
    if (req.method === 'OPTIONS') { res.writeHead(200, CORS); res.end(); return; }
    await handleLog(req, res); return;
  }

  // Recombee proxy
  if (req.url === '/.netlify/functions/recombee') {
    if (req.method === 'OPTIONS') { res.writeHead(200, CORS); res.end(); return; }
    if (req.method === 'POST') { await handleProxy(req, res); return; }
  }

  // Static files
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/admin') urlPath = '/admin.html';
  if (urlPath === '/book') urlPath = '/index.html';

  const filePath = path.join(ROOT, urlPath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  if (!TOKEN) console.log('\n  WARNING: RECOMBEE_TOKEN not set. Recombee API calls will fail.\n  Create .env file: echo "RECOMBEE_TOKEN=your_token_here" > .env\n');
});
