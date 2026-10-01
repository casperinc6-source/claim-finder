const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { STATES, AUCTIONS, NAUPA, MISSINGMONEY } = require('./sources');
const { listClaims, createClaim, updateStatus, deleteClaim } = require('./db');

const PORT = process.env.PORT || 3007;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, data) {
  const isStr = typeof data === 'string';
  res.writeHead(status, {
    'Content-Type': isStr ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
  });
  res.end(isStr ? data : JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e5) {
        const err = new Error('Body too large');
        reject(err);
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, '<h1>404</h1>');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Routes

const STATUSES = ['researching', 'filed', 'waiting', 'paid', 'closed'];

const routes = [
  {
    method: 'GET', pattern: /^\/api\/states$/,
    handler: (req, res) => {
      const states = STATES.map(([code, name, url]) => ({
        code,
        name,
        url,
        fallback: NAUPA,
        source: 'official state program (free to search & claim)',
      }));
      return send(res, 200, { count: states.length, states, auctions: AUCTIONS, missingmoney: MISSINGMONEY });
    },
  },
  {
    method: 'GET', pattern: /^\/api\/claims$/,
    handler: (req, res) => send(res, 200, listClaims()),
  },
  {
    method: 'POST', pattern: /^\/api\/claims$/,
    handler: async (req, res) => {
      try {
        const b = await readBody(req);
        const item = String(b.item || '').trim();
        const stateInput = String(b.state || '').trim();
        const value = Math.round(Number(b.value) * 100); // dollars -> cents
        const status = STATUSES.includes(b.status) ? b.status : 'researching';
        const notes = String(b.notes || '').trim().slice(0, 2000);

        if (item.length < 2) return send(res, 400, { error: 'item required (2+ chars)' });
        if (stateInput.length > 40) return send(res, 400, { error: 'state too long' });
        if (!Number.isFinite(value) || value < 0) return send(res, 400, { error: 'value must be >= 0' });
        if (!/^https?:\/\//.test(String(b.url || ''))) return send(res, 400, { error: 'url must start with http(s)://' });

        const row = createClaim({ item, state: stateInput, url: String(b.url), value_cents: value, status, notes });
        return send(res, 201, row);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    },
  },
  {
    method: 'PATCH', pattern: /^\/api\/claims\/(\d+)$/,
    handler: async (req, res, m) => {
      try {
        const b = await readBody(req);
        if (!STATUSES.includes(b.status)) return send(res, 400, { error: 'bad status' });
        const row = updateStatus(Number(m[1]), b.status);
        if (!row) return send(res, 404, { error: 'Claim not found' });
        return send(res, 200, row);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    },
  },
  {
    method: 'DELETE', pattern: /^\/api\/claims\/(\d+)$/,
    handler: (req, res, m) => {
      const changes = deleteClaim(Number(m[1]));
      if (!changes) return send(res, 404, { error: 'Claim not found' });
      return send(res, 200, { deleted: Number(m[1]) });
    },
  },
];

process.on('uncaughtException', (err) => console.error('[claims] uncaught:', err.message));

const server = http.createServer(async (req, res) => {
  let urlPath;
  try { urlPath = new URL(req.url, 'http://x').pathname; }
  catch { return send(res, 400, { error: 'Bad request URL' }); }
  for (const r of routes) {
    const m = urlPath.match(r.pattern);
    if (m && req.method === r.method) {
      try { return await r.handler(req, res, m); } catch { return send(res, 500, { error: 'Server error' }); }
    }
  }
  if (urlPath.startsWith('/api/')) return send(res, 404, { error: 'Unknown endpoint' });
  return serveStatic(res, urlPath);
});

server.listen(PORT, () => {
  console.log(`claim-finder serving on http://localhost:${PORT}`);
});
