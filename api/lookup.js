// api/lookup.js
// Paginated prefix search + info endpoint (total DB count).
// Dataset read with a lenient parser — broken JSON can't crash the function.

const fs   = require('fs');
const path = require('path');

function parseLoose(raw) {
  raw = String(raw).replace(/^\uFEFF/, '').trim();

  try { const v = JSON.parse(raw); if (Array.isArray(v)) return v; } catch (_) {}

  const cleaned = raw.replace(/,\s*(?=[}\]])/g, '');
  try { const v = JSON.parse(cleaned); if (Array.isArray(v)) return v; } catch (_) {}

  const out = [];
  let i = 0; const n = raw.length;
  while (i < n) {
    if (raw[i] !== '{') { i++; continue; }
    let depth = 0, j = i, inStr = false, esc = false;
    for (; j < n; j++) {
      const c = raw[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
      }
    }
    if (depth !== 0) break;
    const block = raw.slice(i, j + 1).replace(/,\s*}/g, '}');
    try {
      const o = JSON.parse(block);
      if (o && o.number != null) out.push(o);
    } catch (_) {}
    i = j + 1;
  }
  return out;
}

let DB = [];
let LOAD_INFO = '';

(function init() {
  const candidates = [
    path.join(__dirname, '_data', 'data.json'),
    path.join(process.cwd(), 'api', '_data', 'data.json'),
    path.join(process.cwd(), 'data.json')
  ];

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const arr = parseLoose(raw);
      if (arr.length) {
        DB = arr
          .filter(r => r && r.number != null)
          .map(r => ({
            number: String(r.number).trim(),
            nid:    r.nid == null ? '' : String(r.nid),
            dob:    r.dob == null ? '' : String(r.dob)
          }));
        LOAD_INFO = 'loaded ' + DB.length + ' records from ' + file;
        return;
      }
    } catch (e) {
      LOAD_INFO += ' | ' + file + ': ' + e.message;
    }
  }
  LOAD_INFO = LOAD_INFO || 'no data file found in any candidate path';
})();

const WINDOW_MS = 60_000;
const MAX_REQ   = 300;   // pagination friendly
const buckets   = new Map();

function rateLimited(ip) {
  const t = Date.now();
  const arr = (buckets.get(ip) || []).filter(x => t - x < WINDOW_MS);
  if (arr.length >= MAX_REQ) { buckets.set(ip, arr); return true; }
  arr.push(t);
  buckets.set(ip, arr);
  return false;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(body));
}

module.exports = function handler(req, res) {
  try {
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });

    const origin  = req.headers.origin  || '';
    const referer = req.headers.referer || '';
    const host    = req.headers.host    || '';
    const site    = host ? 'https://' + host : '';
    const sameOrigin =
      (origin && site && origin === site) ||
      (referer && site && referer.startsWith(site + '/'));
    if (!sameOrigin) return send(res, 403, { error: 'forbidden' });

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
            || (req.socket && req.socket.remoteAddress) || 'unknown';
    if (rateLimited(ip)) {
      res.setHeader('retry-after', '60');
      return send(res, 429, { error: 'rate limit exceeded' });
    }

    if (!DB.length) {
      return send(res, 503, { error: 'dataset not loaded', diagnostic: LOAD_INFO });
    }

    // info mode: return total DB count, no query
    if (req.query && (req.query.info === '1' || req.query.info === 'true')) {
      return send(res, 200, { total: DB.length });
    }

    const q = String((req.query && req.query.q) || '').trim();
    if (!/^\d{3,20}$/.test(q)) return send(res, 400, { error: 'q must be 3–20 digits' });

    const limit  = Math.min(Math.max(parseInt(req.query.limit,  10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    let total_matches = 0;
    const matches = [];
    for (let i = 0; i < DB.length; i++) {
      if (DB[i].number.startsWith(q)) {
        if (total_matches >= offset && matches.length < limit) matches.push(DB[i]);
        total_matches++;
      }
    }

    return send(res, 200, {
      query: q,
      total: DB.length,
      total_matches,
      offset,
      limit,
      count: matches.length,
      matches
    });
  } catch (e) {
    return send(res, 500, {
      error: 'handler crash',
      message: e && e.message ? e.message : String(e),
      stack: e && e.stack ? String(e.stack).slice(0, 800) : ''
    });
  }
};
