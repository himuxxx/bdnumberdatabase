// api/lookup.js
// Never require()s the data file — reads it with a lenient parser,
// so a stray trailing comma can't crash the function.

const fs   = require('fs');
const path = require('path');

function parseLoose(raw) {
  raw = String(raw).replace(/^\uFEFF/, '').trim();

  try { const v = JSON.parse(raw); if (Array.isArray(v)) return v; } catch (_) {}

  const cleaned = raw.replace(/,\s*(?=[}\]])/g, '');
  try { const v = JSON.parse(cleaned); if (Array.isArray(v)) return v; } catch (_) {}

  // per-object rescue
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

/* ---------- load once at cold start ---------- */
let DB = [];
let LOAD_INFO = '';

(function init() {
  const candidates = [
    path.join(__dirname, '_data', 'data.json'),                // bundled with fn
    path.join(process.cwd(), 'api', '_data', 'data.json'),      // project root
    path.join(process.cwd(), 'data.json')                       // last resort
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

/* ---------- rate limit ---------- */
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

/* ---------- plain Node response helper (no Vercel extensions needed) ---------- */
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(body));
}

/* ---------- handler ---------- */
module.exports = function handler(req, res) {
  try {
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });

    // same-origin guard
    const origin  = req.headers.origin  || '';
    const referer = req.headers.referer || '';
    const host    = req.headers.host    || '';
    const site    = host ? 'https://' + host : '';
    const sameOrigin =
      (origin && site && origin === site) ||
      (referer && site && referer.startsWith(site + '/'));
    if (!sameOrigin) return send(res, 403, { error: 'forbidden', hint: 'same-origin only' });

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
            || (req.socket && req.socket.remoteAddress) || 'unknown';
    if (rateLimited(ip)) {
      res.setHeader('retry-after', '60');
      return send(res, 429, { error: 'rate limit exceeded' });
    }

    // dataset health
    if (!DB.length) {
      return send(res, 503, {
        error: 'dataset not loaded',
        diagnostic: LOAD_INFO
      });
    }

    // input
    const q = String((req.query && req.query.q) || '').trim();
    if (!/^\d{3,20}$/.test(q)) return send(res, 400, { error: 'q must be 3–20 digits' });

    // prefix search
    const matches = [];
    const HARD_CAP = 100;
    for (let i = 0; i < DB.length; i++) {
      if (DB[i].number.startsWith(q)) {
        matches.push(DB[i]);
        if (matches.length >= HARD_CAP) break;
      }
    }

    return send(res, 200, {
      count: matches.length,
      truncated: matches.length >= HARD_CAP,
      query: q,
      total: DB.length,
      matches
    });
  } catch (e) {
    // never throw — always JSON, so we can see the real cause
    return send(res, 500, {
      error: 'handler crash',
      message: e && e.message ? e.message : String(e),
      stack: e && e.stack ? String(e.stack).slice(0, 800) : ''
    });
  }
};
