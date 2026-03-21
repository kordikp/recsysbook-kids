// Vercel serverless function — proxies Recombee API calls
// Same logic as netlify/functions/recombee.js

const crypto = require('crypto');

const DB = process.env.RECOMBEE_DB || 'cvachond-land-free-pbook-kids';
const TOKEN = process.env.RECOMBEE_TOKEN || '';
const REGION = process.env.RECOMBEE_REGION || 'rapi-eu-west';

function signUrl(path) {
  const ts = Math.floor(Date.now() / 1000);
  const sep = path.includes('?') ? '&' : '?';
  const pathWithTs = path + sep + 'hmac_timestamp=' + ts;
  const hmac = crypto.createHmac('sha1', TOKEN).update(pathWithTs).digest('hex');
  return pathWithTs + '&hmac_sign=' + hmac;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!TOKEN) return res.status(500).json({ error: 'RECOMBEE_TOKEN not configured' });

  const { endpoint, body, method: reqMethod } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });

  let basePath = '/' + DB + endpoint;
  const method = reqMethod || (body ? 'POST' : 'GET');

  if (method === 'GET' && body) {
    const params = Object.entries(body).map(function(e) { return e[0] + '=' + encodeURIComponent(e[1]); }).join('&');
    basePath += (basePath.includes('?') ? '&' : '?') + params;
  }

  const signedPath = signUrl(basePath);
  const url = 'https://' + REGION + '.recombee.com' + signedPath;

  try {
    const fetchOpts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (method !== 'GET' && body) fetchOpts.body = JSON.stringify(body);
    const response = await fetch(url, fetchOpts);
    const data = await response.text();
    res.status(response.status).setHeader('Content-Type', 'application/json').send(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
