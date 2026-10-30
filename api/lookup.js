// api/lookup.js
const DATA = require('./_data/data.json');

// tolerant to: array or {matches:[...]} or {data:[...]}
const RAW = Array.isArray(DATA)
  ? DATA
  : (DATA && Array.isArray(DATA.matches) ? DATA.matches
  : (DATA && Array.isArray(DATA.data) ? DATA.data : []));

// force every field to a plain string
const DB = RAW
  .filter(r => r && r.number != null)
  .map(r => ({
    number: String(r.number).trim(),
    nid:    r.nid == null ? '' : String(r.nid),
    dob:    r.dob == null ? '' : String(r.dob)
  }));

const WINDOW_MS = 60_000;
const MAX_REQ   = 30;
const buckets   = new Map();

function rateLimited(ip) {
  const t = Date.now();
  const arr = (buckets.get(ip) || []).filter(x => t - x < WINDOW_MS);
  if (arr.length >= MAX_REQ) { buckets.set(ip, arr); return true; }
  arr.push(t);
  buckets.set(ip, arr);
  return false;
}

module.exports = function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  // same-origin guard
  const origin  = req.headers.origin  || '';
  const referer = req.headers.referer || '';
  const host    = req.headers.host    || '';
  const site    = host ? 'https://' + host : '';
  const sameOrigin =
    (origin && site && origin === site) ||
    (referer && site && referer.startsWith(site + '/'));
  if (!sameOrigin) return res.status(403).json({ error: 'forbidden' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket?.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    res.setHeader('retry-after', '60');
    return res.status(429).json({ error: 'rate limit exceeded' });
  }

  const q = String(req.query.q || '').trim();
  if (!/^\d{3,20}$/.test(q)) return res.status(400).json({ error: 'q must be 3-20 digits' });

  const matches = [];
  const HARD_CAP = 100;
  for (let i = 0; i < DB.length; i++) {
    if (DB[i].number.startsWith(q)) {
      matches.push(DB[i]);
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
