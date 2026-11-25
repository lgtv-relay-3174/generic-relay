// Generic single-upstream relay with a secret path token. No upstream, user or token is hard-coded.
// Env (required): UPSTREAM (e.g. http://host), ALLOWED_ORIGINS (comma list), RELAY_TOKEN (16+ chars, unguessable). Optional: PORT, MAX_CONN.
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
let LAST = null;
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const NODE_HOST = '172.110.221.238';
let NODE_PORT = null;
const SAFE_NODE_PATH = /^\/[A-Za-z0-9%._~\/:+,@=&?-]*$/;
function rewritePlaylist(b, port, nodePath, self) {
  const base = 'http://' + NODE_HOST + ':' + port + nodePath;
  const map = (ref) => { try { const a = new URL(ref, base); if (a.protocol === 'http:' && a.hostname === NODE_HOST && (a.port || '80') === port) return self + '/node/' + port + a.pathname + a.search; } catch (e) {} return ref; };
  return b.split(/\r?\n/).map(l => { if (!l.trim()) return l; if (l.startsWith('#')) return l.replace(/URI="([^"]*)"/g, (m, u) => 'URI="' + map(u) + '"'); return map(l.trim()); }).join('\n');
}
function nodeProxy(pq, port, q, r, self) {
  const pth = pq.split('?')[0];
  if (pq.includes('..') || pq.includes('//') || !SAFE_NODE_PATH.test(pq) || port !== NODE_PORT) { r.statusCode = 403; return r.end('forbidden'); }
  const h = { host: NODE_HOST + (port === '80' ? '' : ':' + port), 'user-agent': q.headers['user-agent'] || 'Mozilla/5.0' };
  if (q.headers.range) h.range = q.headers.range;
  const rq = http.request({ host: NODE_HOST, port: parseInt(port, 10), path: pq, method: 'GET', headers: h }, (ur) => {
    LAST = { at: new Date().toISOString(), kind: 'node-response', status: ur.statusCode, content_type: String(ur.headers['content-type'] || '').slice(0, 60), redirect_again: ur.statusCode >= 300 && ur.statusCode < 400 };
    if (ur.statusCode >= 300 && ur.statusCode < 400) { ur.resume(); r.statusCode = 502; return r.end(); }
    r.statusCode = ur.statusCode;
    for (const k of ['content-type', 'content-range', 'accept-ranges']) if (ur.headers[k]) r.setHeader(k, ur.headers[k]);
    const ct = String(ur.headers['content-type'] || '');
    if (/mpegurl/i.test(ct) || /\.m3u8$/.test(pth)) {
      let b = ''; ur.setEncoding('utf8'); ur.on('data', d => b += d);
      ur.on('end', () => r.end(rewritePlaylist(b, port, pth, self)));
    } else ur.pipe(r);
  });
  rq.on('error', (e) => { LAST = { at: new Date().toISOString(), kind: 'node-connect-error', code: String(e && e.code || 'unknown') }; r.statusCode = 502; r.end(); });
  rq.end();
}
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
  if (rest === '/__diag') { r.setHeader('content-type', 'application/json'); return r.end(JSON.stringify(LAST)); }
  const u = new URL(rest, 'http://x');
  if (u.pathname.startsWith('/node/')) {
    const m = u.pathname.match(/^\/node\/(\d{1,5})(\/.*)$/);
    if (!m || !NODE_PORT) { r.statusCode = 403; return r.end('forbidden'); }
    const selfN = (q.headers['x-forwarded-proto'] || process.env.PUBLIC_PROTO || 'https') + '://' + q.headers.host + PREFIX;
    return nodeProxy(m[2] + u.search, m[1], q, r, selfN);
  }
  if (rest.includes('..') || rest.includes('//') || !OK_PATH.test(u.pathname)) { r.statusCode = 403; return r.end('forbidden'); }
  if (active >= MAX) { r.statusCode = 429; return r.end(); }
  active++; r.on('close', () => { active--; });
  const self = (q.headers['x-forwarded-proto'] || process.env.PUBLIC_PROTO || 'https') + '://' + q.headers.host + PREFIX;
  const h = { host: UP.host, 'user-agent': q.headers['user-agent'] || 'Mozilla/5.0' };
  if (q.headers.range) h.range = q.headers.range;
  const req = (UP.protocol === 'https:' ? https : http).request({ host: UP.hostname, port: UP.port || (UP.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: q.method, headers: h }, (ur) => {
    if (ur.statusCode >= 300 && ur.statusCode < 400 && /^\/live\//.test(u.pathname)) {
      ur.resume();
      let L2 = null; try { L2 = new URL(ur.headers.location, 'http://' + UP.host); } catch (e) {}
      if (!L2 || L2.protocol !== 'http:' || L2.hostname !== NODE_HOST || L2.username || L2.password) { LAST = { at: new Date().toISOString(), kind: 'redirect-refused', location_host: L2 ? L2.hostname : 'unparsable' }; r.statusCode = 502; return r.end(); }
      if (NODE_PORT && NODE_PORT !== (L2.port || '80')) { LAST = { at: new Date().toISOString(), kind: 'redirect-port-changed', port: L2.port || '80' }; r.statusCode = 502; return r.end(); }
      NODE_PORT = L2.port || '80';
      LAST = { at: new Date().toISOString(), kind: 'followed-redirect', host: NODE_HOST, port: NODE_PORT };
      return nodeProxy(L2.pathname + L2.search, NODE_PORT, q, r, self);
    }
    const ct = ur.headers['content-type'] || '';
    if (/\.m3u8$/.test(u.pathname) || /^\/live\//.test(u.pathname)) { let lh = ''; try { if (ur.headers.location) lh = new URL(ur.headers.location, 'http://' + UP.host).hostname; } catch (e) { lh = 'unparsable'; } LAST = { at: new Date().toISOString(), kind: 'upstream-response', status: ur.statusCode, location_host: lh, location_scheme: (ur.headers.location || '').split(':')[0].slice(0, 6), content_type: String(ur.headers['content-type'] || '').slice(0, 60) }; }
    r.statusCode = ur.statusCode >= 300 && ur.statusCode < 400 ? 502 : ur.statusCode;
    for (const k of ['content-type', 'content-range', 'accept-ranges']) if (ur.headers[k]) r.setHeader(k, ur.headers[k]);
    if (/mpegurl/i.test(ct) || /\.m3u8$/.test(u.pathname)) {
      let b = ''; ur.setEncoding('utf8'); ur.on('data', d => b += d);
      ur.on('end', () => r.end(b.split(UP.origin).join(self)));
    } else ur.pipe(r);
  });
  req.on('error', (e) => { LAST = { at: new Date().toISOString(), kind: 'connect-error', code: String(e && e.code || 'unknown') }; r.statusCode = 502; r.end(); });
  req.end();
}).listen(process.env.PORT || 10000);
