// Private single-user relay: login page with an access code (env ACCESS_CODE), then a signed session cookie. Serves the player UI itself.
// (Older header follows.) Generic single-upstream relay with a secret path token. No upstream, user or token is hard-coded.
// Env (required): UPSTREAM (e.g. http://host), ALLOWED_ORIGINS (comma list), RELAY_TOKEN (16+ chars, unguessable). Optional: PORT, MAX_CONN.
// A request must start with /t/<RELAY_TOKEN>/ (constant-time compare). The token prefix is removed and the rest is forwarded
// to the ONE upstream, only if it matches the Xtream path shapes below. No redirects are followed, nothing is logged.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const need = (k) => { const v = (process.env[k] || '').trim(); if (!v) { console.error('missing env ' + k); process.exit(1); } return v; };
const UP = new URL(need('UPSTREAM'));
if ((UP.protocol !== 'http:' && UP.protocol !== 'https:') || UP.username || UP.pathname !== '/') { console.error('UPSTREAM must be a bare http(s) origin'); process.exit(1); }
const ACCESS_CODE = need('ACCESS_CODE');
if (ACCESS_CODE.length < 10) { console.error('ACCESS_CODE too short'); process.exit(1); }
const PREFIX = '';
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

const fsx = require('fs');
const zl = require('zlib');
const hmac = (m) => crypto.createHmac('sha256', ACCESS_CODE).update(m).digest('hex');
const mkCookie = () => { const exp = Date.now() + 12 * 3600 * 1000; return 'sid=' + exp + '.' + hmac('v1.' + exp) + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200'; };
const okCookie = (c) => { const m = /(?:^|;\s*)sid=(\d+)\.([0-9a-f]{64})/.exec(c || ''); return !!m && Number(m[1]) > Date.now() && eq(m[2], hmac('v1.' + m[1])); };
let UIBUF = null;
const ui = () => {
  if (UIBUF) return UIBUF;
  const dir = __dirname;
  const raw = zl.gunzipSync(Buffer.from(fsx.readdirSync(dir).filter(f => /^uib_\d+\.txt$/.test(f)).sort().map(f => fsx.readFileSync(dir + '/' + f, 'utf8')).join(''), 'base64')).toString('utf8');
  UIBUF = Buffer.from(raw
    .replace('set(s,R);set(u,"test");set(p,"test");', 'set(s,location.origin);')
    .replace('new MutationObserver(fill)', 'fill();setInterval(fill,300);new MutationObserver(fill)')
    .replace('position:fixed;top:0;left:0;right:0;z-index:99', 'position:relative;width:100%;box-sizing:border-box')
    .replace('document.body.appendChild(n)', 'document.body.insertBefore(n,document.body.firstChild)')
    .replace('نسخة تجريبية: سيرفر وهمي. مش اشتراكك. ماتكتبش بياناتك الحقيقية.', 'نسخة خاصة. بيانات الدخول بتعدّي على Render وبعدها للسيرفر بدون تشفير.'), 'utf8');
  return UIBUF;
};
const loginPage = (err) => '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>دخول</title><body style="margin:0;background:#0b0816;color:#fff;font:18px sans-serif;text-align:center;padding:40px 20px"><h2>Light IPTV</h2><form method="post" action="/login"><p>كود الدخول</p><p><input name="code" type="text" autocorrect="off" spellcheck="false" autocomplete="current-password" autocapitalize="off" style="font-size:20px;padding:12px;width:85%;max-width:360px;direction:ltr"></p><p><button type="submit" style="font-size:20px;padding:12px 36px">دخول</button></p>' + (err ? '<p style="color:#f77">' + err + '</p>' : '') + '</form></body></html>';
const norm = (x) => String(x).normalize('NFKC').replace(/\s+/g, '').toLowerCase().replace(/[o]/g, '0').replace(/[il|]/g, '1');
const fails = new Map();
const clientIp = (q) => String(q.headers['x-forwarded-for'] || q.socket.remoteAddress || '').split(',')[0].trim();
function handleLogin(q, r) {
  const ip = clientIp(q); const now = Date.now();
  const f = (fails.get(ip) || []).filter(t => now - t < 600000);
  if (f.length >= 5) { r.statusCode = 429; r.setHeader('content-type', 'text/html; charset=utf-8'); return r.end(loginPage('محاولات كتير. استنى شوية.')); }
  let body = ''; q.on('data', d => { body += d; if (body.length > 2048) q.destroy(); });
  q.on('end', () => {
    const code = new URLSearchParams(body).get('code') || '';
    if (eq(norm(code), norm(ACCESS_CODE))) { fails.delete(ip); r.statusCode = 303; r.setHeader('set-cookie', mkCookie()); r.setHeader('location', '/'); return r.end(); }
    f.push(now); fails.set(ip, f);
    setTimeout(() => { r.statusCode = 401; r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(loginPage('الكود غلط.')); }, 800);
  });
}
http.createServer((q, r) => {
  r.setHeader('cache-control', 'no-store'); r.setHeader('x-content-type-options', 'nosniff');
  const raw = q.url || '';
  const pathOnly = raw.split('?')[0];
  if (pathOnly === '/login' && q.method === 'POST') return handleLogin(q, r);
  if (!okCookie(q.headers.cookie)) {
    if ((pathOnly === '/' || pathOnly === '/login') && (q.method === 'GET' || q.method === 'HEAD')) { r.setHeader('content-type', 'text/html; charset=utf-8'); return r.end(loginPage('')); }
    r.statusCode = 401; return r.end();
  }
  if (q.method !== 'GET' && q.method !== 'HEAD') { r.statusCode = 405; return r.end(); }
  if (pathOnly === '/') { r.setHeader('content-type', 'text/html; charset=utf-8'); return r.end(ui()); }
  const rest = raw;
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
    if (/\.m3u8$/.test(u.pathname) || /^\/(live|series|movie)\//.test(u.pathname)) { let lh = ''; try { if (ur.headers.location) lh = new URL(ur.headers.location, 'http://' + UP.host).hostname; } catch (e) { lh = 'unparsable'; } LAST = { at: new Date().toISOString(), kind: 'upstream-response', section: u.pathname.split('/')[1].slice(0, 8), ext: ((u.pathname.match(/\.([A-Za-z0-9]{1,5})$/) || [])[1] || ''), status: ur.statusCode, content_length: String(ur.headers['content-length'] || '').slice(0, 12), accept_ranges: String(ur.headers['accept-ranges'] || '').slice(0, 10), location_host: lh, location_scheme: (ur.headers.location || '').split(':')[0].slice(0, 6), content_type: String(ur.headers['content-type'] || '').slice(0, 60) }; }
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
