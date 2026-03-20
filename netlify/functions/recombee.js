const crypto = require('crypto');

const DB = process.env.RECOMBEE_DB || 'cvachond-land-free-pbook-kids';
const TOKEN = process.env.RECOMBEE_TOKEN || '';
const REGION = process.env.RECOMBEE_REGION || 'rapi-eu-west';

function signUrl(path) {
  var ts = Math.floor(Date.now() / 1000);
  var sep = path.includes('?') ? '&' : '?';
  var pathWithTs = path + sep + 'hmac_timestamp=' + ts;
  var hmac = crypto.createHmac('sha1', TOKEN).update(pathWithTs).digest('hex');
  return pathWithTs + '&hmac_sign=' + hmac;
}

var CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  if (!TOKEN) {
    var h1 = Object.assign({}, CORS, { 'Content-Type': 'application/json' });
    return { statusCode: 500, headers: h1, body: '{"error":"RECOMBEE_TOKEN not set"}' };
  }

  var endpoint, body;
  try {
    var json = JSON.parse(event.body || '{}');
    endpoint = json.endpoint;
    body = json.body;
  } catch (e) {
    var h2 = Object.assign({}, CORS, { 'Content-Type': 'application/json' });
    return { statusCode: 400, headers: h2, body: '{"error":"Invalid JSON"}' };
  }

  if (!endpoint) {
    var h3 = Object.assign({}, CORS, { 'Content-Type': 'application/json' });
    return { statusCode: 400, headers: h3, body: '{"error":"endpoint required"}' };
  }

  var basePath = '/' + DB + endpoint;
  var signedPath = signUrl(basePath);
  var url = 'https://' + REGION + '.recombee.com' + signedPath;

  try {
    var response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    var data = await response.text();
    var h4 = Object.assign({}, CORS, { 'Content-Type': 'application/json' });
    return { statusCode: response.status, headers: h4, body: data };
  } catch (e) {
    var h5 = Object.assign({}, CORS, { 'Content-Type': 'application/json' });
    return { statusCode: 502, headers: h5, body: JSON.stringify({ error: e.message }) };
  }
};
