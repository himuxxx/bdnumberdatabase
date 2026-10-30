// api/lookup.js  —  Vercel Node function (CommonJS)
// Holds the dataset inside the bundle; never served as a static file.
// Prefix search + per-IP rate limit + same-origin guard.

const DATA = require('./_data/data.json');

// --- normalize once at cold start ---
const DB = DATA
  .filter(r => r && r.number)
  .map(r => ({
    number: String(r.number).trim(),
    nid:    String(r.nid || ''),
    dob:    String(r.dob || '')
  }));

// --- in-memory sliding-window rate limiter ---
// Per warm instance. Good for casual abuse; upgrade to Vercel KV for global.
const WINDOW_MS = 60_000;
const MAX_REQ   = 30;
const buckets   = new Map(); // ip -> number[] (timestamps)

function nowMs() { return Date.now(); }

function rateLimited(ip) {
  const t = nowMs();
  const arr = (buckets.get(ip) || []).filter(x => t - x < WINDOW_MS);
  if (arr.length >= MAX_REQ) {
    buckets.set(ip, arr);
    return true;
  }
  arr.push(t);
  buckets.set(ip, arr);
  // opportunistic cleanup
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (!v.length || t - v[v.length - 1] > WINDOW_MS) buckets.delete(k);
    }
  }
  return false;
}

function json(status, body) {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    },
    body: JSON.stringify(body)
  };
}

module.exports = function handler(req, res) {
  // method lock
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  // same-origin guard — only accept calls coming from our own page
  const origin   = req.headers.origin   || '';
  const referer  = req.headers.referer  || '';
  const siteOrigin = req.headers.host ? 'https://' + req.headers.host : '';
  const sameOrigin =
    (origin && siteOrigin && origin === siteOrigin) ||
    (referer && siteOrigin && referer.startsWith(siteOrigin + '/'));
  if (!sameOrigin) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // per-IP rate limit
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  if (rateLimited(ip)) {
    res.setHeader('retry-after', '60');
    return res.status(429).json({ error: 'rate limit exceeded' });
  }

  // input validation
  const q = String(req.query.q || '').trim();
  if (!/^\d{3,20}$/.test(q)) {
    return res.status(400).json({ error: 'q must be 3–20 digits' });
  }

  // prefix search
  const matches = [];
  const HARD_CAP = 100;
  for (let i = 0; i < DB.length; i++) {
    if (DB[i].number.startsWith(q)) {
      matches.push({ number: DB[i].number, nid: DB[i].nid, dob: DB[i].dob });
      if (matches.length >= HARD_CAP) break;
    }
  }

  return res.status(200).json({
    count: matches.length,
    truncated: matches.length >= HARD_CAP,
    query: q,
    matches
  });
};
