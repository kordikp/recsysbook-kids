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

  const basePath = '/' + DB + parsed.endpoint;
  const signedPath = signUrl(basePath);
  const url = 'https://' + REGION + '.recombee.com' + signedPath;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: parsed.body ? JSON.stringify(parsed.body) : undefined,
    });
    const data = await response.text();
    res.writeHead(response.status, { ...CORS, 'Content-Type': 'application/json' });
    res.end(data);
  } catch (e) {
    res.writeHead(502, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

const server = http.createServer(async (req, res) => {
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
