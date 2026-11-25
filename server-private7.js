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
function rewritePlaylist(b, port, nodePath, self, cr) {
  const base = 'http://' + NODE_HOST + ':' + port + nodePath;
  const map = (ref) => { try { const a = new URL(ref, base); if (a.protocol === 'http:' && a.hostname === NODE_HOST && (a.port || '80') === port) return self + '/node/' + port + hidePath(a.pathname, cr) + a.search; } catch (e) {} return ref; };
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
      ur.on('end', () => r.end(rewritePlaylist(b, port, pth, self, readCred(q))));
    } else ur.pipe(r);
  });
  rq.on('error', (e) => { LAST = { at: new Date().toISOString(), kind: 'node-connect-error', code: String(e && e.code || 'unknown') }; r.statusCode = 502; r.end(); });
  rq.end();
}

const SERIES_HOST = '45.155.226.48';
let SERIES_PORT = null;
function seriesProxy(L2, q, r, ext) {
  const port = L2.port || '80';
  const pq = L2.pathname + L2.search;
  if (!/^\d{1,5}$/.test(port) || pq.includes('..') || pq.includes('//') || !SAFE_NODE_PATH.test(pq)) { r.statusCode = 403; return r.end('forbidden'); }
  if (SERIES_PORT && SERIES_PORT !== port) { LAST = { at: new Date().toISOString(), kind: 'series-port-changed' }; r.statusCode = 502; return r.end(); }
  SERIES_PORT = port;
  const h = { host: SERIES_HOST + (port === '80' ? '' : ':' + port), 'user-agent': q.headers['user-agent'] || 'Mozilla/5.0' };
  if (q.headers.range) h.range = q.headers.range;
  const rq = http.request({ host: SERIES_HOST, port: parseInt(port, 10), path: pq, method: 'GET', headers: h }, (ur) => {
    LAST = { at: new Date().toISOString(), kind: 'series-node-response', ext: ext, status: ur.statusCode, content_type: String(ur.headers['content-type'] || '').slice(0, 60), content_length: String(ur.headers['content-length'] || '').slice(0, 12), accept_ranges: String(ur.headers['accept-ranges'] || '').slice(0, 10), redirect_again: ur.statusCode >= 300 && ur.statusCode < 400 };
    if (ur.statusCode >= 300 && ur.statusCode < 400) { ur.resume(); r.statusCode = 502; return r.end(); }
    r.statusCode = ur.statusCode;
    for (const k of ['content-type', 'content-range', 'accept-ranges', 'content-length']) if (ur.headers[k]) r.setHeader(k, ur.headers[k]);
    ur.pipe(r);
    r.on('close', () => ur.destroy());
  });
  rq.on('error', (e) => { LAST = { at: new Date().toISOString(), kind: 'series-connect-error', code: String(e && e.code || 'unknown') }; r.statusCode = 502; r.end(); });
  rq.end();
}
const fsx = require('fs');
const zl = require('zlib');
const hmac = (m) => crypto.createHmac('sha256', ACCESS_CODE).update(m).digest('hex');
const mkCookie = () => { const exp = Date.now() + 12 * 3600 * 1000; return 'sid=' + exp + '.' + hmac('v1.' + exp) + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200'; };
const okCookie = (c) => { const m = /(?:^|;\s*)sid=(\d+)\.([0-9a-f]{64})/.exec(c || ''); return !!m && Number(m[1]) > Date.now() && eq(m[2], hmac('v1.' + m[1])); };

const CKEY = crypto.createHash('sha256').update('cred-v1|' + (process.env.CRED_KEY || '') + '|' + ACCESS_CODE).digest();
const PHU = '__saved_u__', PHP = '__saved_p__';
const getCookie = (c, n) => { const m = new RegExp('(?:^|;\\s*)' + n + '=([A-Za-z0-9_-]+)').exec(c || ''); return m ? m[1] : ''; };
function credEnc(o) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', CKEY, iv); c.setAAD(Buffer.from('cred-v1')); const ct = Buffer.concat([c.update(JSON.stringify(o), 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url'); }
function credDec(v) { try { const b = Buffer.from(v, 'base64url'); if (b.length < 30) return null; const d = crypto.createDecipheriv('aes-256-gcm', CKEY, b.subarray(0, 12)); d.setAAD(Buffer.from('cred-v1')); d.setAuthTag(b.subarray(12, 28)); const o = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')); return (o && typeof o.u === 'string' && typeof o.p === 'string' && o.exp > Date.now()) ? o : null; } catch (e) { return null; } }
const readCred = (q) => { const v = getCookie(q.headers.cookie, 'cred'); return v ? credDec(v) : null; };
const CRED_DAYS = 30;
const credCookie = (u, p) => 'cred=' + credEnc({ u: u, p: p, exp: Date.now() + CRED_DAYS * 86400000 }) + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=' + (CRED_DAYS * 86400);
const credClear = 'cred=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';
const hidePath = (pth, cr) => cr ? pth.split('/').map(sg => { let d = sg; try { d = decodeURIComponent(sg); } catch (e) {} return d === cr.u ? PHU : d === cr.p ? PHP : sg; }).join('/') : pth;
const showPath = (pth, cr) => pth.split('/').map(sg => sg === PHU ? (cr ? encodeURIComponent(cr.u) : sg) : sg === PHP ? (cr ? encodeURIComponent(cr.p) : sg) : sg).join('/');

const REMEMBER_SCRIPT = '<script>(function(){var tried=false,loggedOut=false;function setv(el,v){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,v);el.dispatchEvent(new Event("input",{bubbles:true}));}function auto(){if(tried)return;var u=document.querySelector("input[name=username]"),p=document.querySelector("input[name=password]");var b=[].slice.call(document.querySelectorAll("button")).filter(function(x){return x.textContent.trim()==="\\u062F\\u062E\\u0648\\u0644"})[0];if(!u||!p||!b)return;tried=true;fetch("/__me",{credentials:"same-origin"}).then(function(r){return r.json()}).then(function(j){if(j&&j.saved){setv(u,"__saved_u__");setv(p,"__saved_p__");setTimeout(function(){b.click()},150)}}).catch(function(){})}document.addEventListener("click",function(e){var t=e.target;while(t&&t.tagName!=="BUTTON")t=t.parentNode;if(t&&t.textContent.trim()==="\\u062E\\u0631\\u0648\\u062C"){fetch("/__logout",{method:"POST",headers:{"x-csrf":"1"},credentials:"same-origin"}).catch(function(){});tried=true}},true);new MutationObserver(auto).observe(document.documentElement,{childList:true,subtree:true});auto();})();</script>';
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
    .replace('نسخة تجريبية: سيرفر وهمي. مش اشتراكك. ماتكتبش بياناتك الحقيقية.', 'نسخة خاصة. بيانات الدخول بتعدّي على Render وبعدها للسيرفر بدون تشفير.')
    .replace('</script></body></html>', '</script>' + REMEMBER_SCRIPT + '</body></html>'), 'utf8');
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
const cp = require('child_process'), pathm = require('path'), os = require('os');
let FF = process.env.FFMPEG || ''; if (!FF) { try { FF = require('ffmpeg-static'); } catch (e) { FF = ''; } }
const HROOT = pathm.join(os.tmpdir(), 'hls'); try { fsx.rmSync(HROOT, { recursive: true, force: true }); fsx.mkdirSync(HROOT, { recursive: true }); } catch (e) {}
let HJOB = null;
function hlsStart(q, r, raw) {
  const u = new URL(raw, 'http://x'); const src = u.searchParams.get('src') || ''; const dur = parseInt(u.searchParams.get('dur') || '0', 10);
  if (!FF) { r.statusCode = 501; return r.end('no ffmpeg'); }
  if (!/^\/series\/[A-Za-z0-9_.\-\/]+$/.test(src) || src.includes('..') || src.includes('//')) { r.statusCode = 403; return r.end('bad src'); }
  if (HJOB && HJOB.running) { try { HJOB.p.kill('SIGKILL'); } catch (e) {} }
  const id = crypto.randomBytes(6).toString('hex'); const dir = pathm.join(HROOT, id); fsx.mkdirSync(dir, { recursive: true });
  const port = process.env.PORT || 10000;
  const args = ['-nostdin', '-loglevel', 'error', '-headers', 'Cookie: ' + (q.headers.cookie || '') + '\r\n', '-i', 'http://127.0.0.1:' + port + src];
  if (dur > 0) args.push('-t', String(Math.min(dur, 7200)));
  args.push('-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', pathm.join(dir, 's%05d.m4s'), pathm.join(dir, 'index.m3u8'));
  const t0 = Date.now(); const p = cp.spawn(FF, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const job = { id, p, running: true, t0, err: '', done: null }; HJOB = job;
  p.stderr.on('data', d => { if (job.err.length < 300) job.err += String(d).replace(/[?&=\/][^\s]*/g, '~').slice(0, 300); });
  p.on('close', (code) => { job.running = false; job.done = { code, secs: Math.round((Date.now() - t0) / 1000) }; });
  setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} setTimeout(() => { try { fsx.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }, 60000); }, 4 * 3600 * 1000);
  r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ id, playlist: '/__hls/' + id + '/index.m3u8' }));
}
function hlsRoute(q, r, raw, pathOnly) {
  if (pathOnly === '/__hls/start') return hlsStart(q, r, raw);
  if (pathOnly === '/__hls/status') { const j = HJOB; r.setHeader('content-type', 'application/json'); let files = 0, bytes = 0; if (j) { try { for (const f of fsx.readdirSync(pathm.join(HROOT, j.id))) { files++; bytes += fsx.statSync(pathm.join(HROOT, j.id, f)).size; } } catch (e) {} } return r.end(JSON.stringify(j ? { id: j.id, running: j.running, secs: Math.round((Date.now() - j.t0) / 1000), files, bytes, done: j.done, err: j.err } : {})); }
  const m = /^\/__hls\/([0-9a-f]{12})\/(index\.m3u8|init\.mp4|s\d{5}\.m4s)$/.exec(pathOnly);
  if (!m) { r.statusCode = 404; return r.end(); }
  const fp = pathm.join(HROOT, m[1], m[2]);
  fsx.readFile(fp, (e, b) => {
    if (e) { r.statusCode = 404; return r.end(); }
    r.setHeader('content-type', m[2].endsWith('m3u8') ? 'application/vnd.apple.mpegurl' : m[2].endsWith('mp4') ? 'video/mp4' : 'video/iso.segment');
    if (m[2].endsWith('m3u8') && HJOB && HJOB.id === m[1] && !HJOB.running && HJOB.done && HJOB.done.code === 0 && !/ENDLIST/.test(String(b))) b = Buffer.concat([b, Buffer.from('#EXT-X-ENDLIST\n')]);
    r.end(b);
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
  if (pathOnly === '/__logout' && q.method === 'POST') { if (q.headers['x-csrf'] !== '1') { r.statusCode = 403; return r.end(); } r.setHeader('set-cookie', credClear); r.statusCode = 204; return r.end(); }
  if (q.method !== 'GET' && q.method !== 'HEAD') { r.statusCode = 405; return r.end(); }
  if (pathOnly.startsWith('/__hls/')) return hlsRoute(q, r, raw, pathOnly);
  if (pathOnly === '/__me') { r.setHeader('content-type', 'application/json'); return r.end(JSON.stringify({ saved: !!readCred(q) })); }
  if (pathOnly === '/') { r.setHeader('content-type', 'text/html; charset=utf-8'); return r.end(ui()); }
  const rest = raw;
  if (rest === '/__diag') { r.setHeader('content-type', 'application/json'); return r.end(JSON.stringify(LAST)); }
  const u = new URL(rest, 'http://x');
  if (u.pathname.startsWith('/node/')) {
    const m = u.pathname.match(/^\/node\/(\d{1,5})(\/.*)$/);
    if (!m || !NODE_PORT) { r.statusCode = 403; return r.end('forbidden'); }
    const selfN = (q.headers['x-forwarded-proto'] || process.env.PUBLIC_PROTO || 'https') + '://' + q.headers.host + PREFIX;
    return nodeProxy(showPath(m[2], readCred(q)) + u.search, m[1], q, r, selfN);
  }
  if (rest.includes('..') || rest.includes('//') || !OK_PATH.test(u.pathname)) { r.statusCode = 403; return r.end('forbidden'); }
  if (active >= MAX) { r.statusCode = 429; return r.end(); }
  const CR = readCred(q);
  let upPath = u.pathname, upSearch = u.search, capture = null;
  const usp = u.searchParams;
  if (usp.get('username') === PHU || usp.get('password') === PHP || upPath.split('/').some(sg => sg === PHU || sg === PHP)) {
    if (!CR) { r.statusCode = 401; return r.end(); }
    if (usp.get('username') === PHU) usp.set('username', CR.u);
    if (usp.get('password') === PHP) usp.set('password', CR.p);
    upSearch = usp.toString() ? '?' + usp.toString() : '';
    upPath = showPath(upPath, CR);
  } else if (u.pathname === '/player_api.php' && usp.get('username') && usp.get('password') && (!usp.get('action') || usp.get('action') === 'get_live_categories') && usp.get('remember') !== '0') {
    capture = { u: usp.get('username'), p: usp.get('password') };
  }
  active++; r.on('close', () => { active--; });
  const self = (q.headers['x-forwarded-proto'] || process.env.PUBLIC_PROTO || 'https') + '://' + q.headers.host + PREFIX;
  const h = { host: UP.host, 'user-agent': q.headers['user-agent'] || 'Mozilla/5.0' };
  if (q.headers.range) h.range = q.headers.range;
  const req = (UP.protocol === 'https:' ? https : http).request({ host: UP.hostname, port: UP.port || (UP.protocol === 'https:' ? 443 : 80), path: upPath + upSearch, method: q.method, headers: h }, (ur) => {
    if (ur.statusCode >= 300 && ur.statusCode < 400 && /^\/series\//.test(u.pathname)) {
      ur.resume();
      let L3 = null; try { L3 = new URL(ur.headers.location, 'http://' + UP.host); } catch (e) {}
      if (!L3 || L3.protocol !== 'http:' || L3.hostname !== SERIES_HOST || L3.username || L3.password) { LAST = { at: new Date().toISOString(), kind: 'series-redirect-refused', location_host: L3 ? L3.hostname : 'unparsable' }; r.statusCode = 502; return r.end(); }
      return seriesProxy(L3, q, r, ((u.pathname.match(/\.([A-Za-z0-9]{1,5})$/) || [])[1] || ''));
    }
    if (ur.statusCode >= 300 && ur.statusCode < 400 && /^\/live\//.test(u.pathname)) {
      ur.resume();
      let L2 = null; try { L2 = new URL(ur.headers.location, 'http://' + UP.host); } catch (e) {}
      if (!L2 || L2.protocol !== 'http:' || L2.hostname !== NODE_HOST || L2.username || L2.password) { LAST = { at: new Date().toISOString(), kind: 'redirect-refused', location_host: L2 ? L2.hostname : 'unparsable' }; r.statusCode = 502; return r.end(); }
      if (NODE_PORT && NODE_PORT !== (L2.port || '80')) { LAST = { at: new Date().toISOString(), kind: 'redirect-port-changed', port: L2.port || '80' }; r.statusCode = 502; return r.end(); }
      NODE_PORT = L2.port || '80';
      LAST = { at: new Date().toISOString(), kind: 'followed-redirect', host: NODE_HOST, port: NODE_PORT };
      return nodeProxy(L2.pathname + L2.search, NODE_PORT, q, r, self);
    }
    if (capture && ur.statusCode === 200) {
      let bb = ''; ur.setEncoding('utf8'); ur.on('data', d => { if (bb.length < 1048576) bb += d; });
      return ur.on('end', () => { try { const j = JSON.parse(bb); if ((j && j.user_info && Number(j.user_info.auth) === 1) || (Array.isArray(j) && j.length > 0)) r.setHeader('set-cookie', credCookie(capture.u, capture.p)); } catch (e) {} r.setHeader('content-type', ur.headers['content-type'] || 'application/json'); r.statusCode = 200; r.end(bb); });
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
