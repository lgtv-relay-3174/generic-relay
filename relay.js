// Generic single-upstream relay with a secret path token. No upstream, user or token is hard-coded.
// Env (required): UPSTREAM (bare http or https origin), ALLOWED_ORIGINS (comma list), RELAY_TOKEN (16+ chars, unguessable). Optional: PORT, MAX_CONN.
// A request must start with /t/<RELAY_TOKEN>/ (constant-time compare). The token prefix is removed and the rest is forwarded
// to the ONE upstream, only if it matches the Xtream path shapes below. No redirects are followed, nothing is logged.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const need = (k) => { const v = (process.env[k] || '').trim(); if (!v) { console.error('missing env ' + k); process.exit(1); } return v; };
const UP = new URL(need('UPSTREAM'));
if ((UP.protocol !== 'http:' && UP.protocol !== 'https:') || UP.username || UP.pathname !== '/') { console.error('UPSTREAM must be a bare http(s) origin'); process.exit(1); }
const ORIGINS = need('ALLOWED_ORIGINS').split(',').map(s => s.trim()).filter(Boolean);
const TOKEN = need('RELAY_TOKEN');
if (TOKEN.length < 16 || !/^[A-Za-z0-9_-]+$/.test(TOKEN)) { console.error('RELAY_TOKEN must be 16+ chars of A-Z a-z 0-9 _ -'); process.exit(1); }
const PREFIX = '/t/' + TOKEN;
const OK_PATH = /^\/(player_api\.php|(live|movie|series|timeshift)\/[A-Za-z0-9%._~-]+\/[A-Za-z0-9%._~-]+\/[A-Za-z0-9%._~\/-]+|(hls|seg)\/[A-Za-z0-9%._~\/-]+)$/;
const MAX = parseInt(process.env.MAX_CONN || '8', 10);
let active = 0;
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
http.createServer((q, r) => {
  const origin = q.headers.origin;
  if (origin && ORIGINS.includes(origin)) { r.setHeader('access-control-allow-origin', origin); r.setHeader('vary', 'origin'); }
  if (q.method === 'OPTIONS') { r.setHeader('access-control-allow-headers', 'range'); r.statusCode = 204; return r.end(); }
  if (q.method !== 'GET' && q.method !== 'HEAD') { r.statusCode = 405; return r.end(); }
  const raw = q.url || '';
  const i = raw.indexOf('/', 3);
  const given = raw.startsWith('/t/') && i > 0 ? raw.slice(3, i) : '';
  if (!eq(given, TOKEN)) { r.statusCode = 404; return r.end(); }
  const rest = raw.slice(i);
  const u = new URL(rest, 'http://x');
  if (rest.includes('..') || rest.includes('//') || !OK_PATH.test(u.pathname)) { r.statusCode = 403; return r.end('forbidden'); }
  if (active >= MAX) { r.statusCode = 429; return r.end(); }
  active++; r.on('close', () => { active--; });
  const self = (q.headers['x-forwarded-proto'] || process.env.PUBLIC_PROTO || 'https') + '://' + q.headers.host + PREFIX;
  const h = { host: UP.host, 'user-agent': q.headers['user-agent'] || 'Mozilla/5.0' };
  if (q.headers.range) h.range = q.headers.range;
  const req = (UP.protocol === 'https:' ? https : http).request({ host: UP.hostname, port: UP.port || (UP.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: q.method, headers: h }, (ur) => {
    const ct = ur.headers['content-type'] || '';
    r.statusCode = ur.statusCode >= 300 && ur.statusCode < 400 ? 502 : ur.statusCode;
    for (const k of ['content-type', 'content-range', 'accept-ranges']) if (ur.headers[k]) r.setHeader(k, ur.headers[k]);
    if (/mpegurl/i.test(ct) || /\.m3u8$/.test(u.pathname)) {
      let b = ''; ur.setEncoding('utf8'); ur.on('data', d => b += d);
      ur.on('end', () => r.end(b.split(UP.origin).join(self)));
    } else ur.pipe(r);
  });
  req.on('error', () => { r.statusCode = 502; r.end(); });
  req.end();
}).listen(process.env.PORT || 10000);
