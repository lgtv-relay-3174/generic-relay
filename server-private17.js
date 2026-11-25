process.on('uncaughtException', (e) => { try { console.log('uncaught', String(e && e.code || e).slice(0,60)); } catch (x) {} });
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
  r.on('error', () => {}); rq.on('error', (e) => { LAST = { at: new Date().toISOString(), kind: 'series-connect-error', code: String(e && e.code || 'unknown') }; if (!r.headersSent) { r.statusCode = 502; r.end(); } else { r.destroy(); } });
  rq.end();
}
const MOVIE_HOST = '103.205.17.234';
let MOVIE_PORT = null;
const RCACHE = new Map();
const rkey = (q, p) => crypto.createHash('sha256').update(String((/(?:^|;\s*)sid=([^;]+)/.exec(q.headers.cookie || '') || [])[1] || '') + '|' + p).digest('hex');
function movieProxy(L2, q, r, ext, onFail) {
  const port = L2.port || '80';
  const pq = L2.pathname + L2.search;
  if (!/^\d{1,5}$/.test(port) || pq.includes('..') || pq.includes('//') || !SAFE_NODE_PATH.test(pq)) { r.statusCode = 403; return r.end('forbidden'); }
  if (MOVIE_PORT && MOVIE_PORT !== port) { LAST = { at: new Date().toISOString(), kind: 'movie-port-changed' }; r.statusCode = 502; return r.end(); }
  MOVIE_PORT = port;
  const rg = /^bytes=\d*-\d*$/.test(String(q.headers.range || '')) ? q.headers.range : '';
  const ua = String(q.headers['user-agent'] || 'Mozilla/5.0').replace(/[^\x20-\x7e]/g, '').slice(0, 200);
  const net = require('net');
  const s = net.connect(parseInt(port, 10), MOVIE_HOST);
  let buf = Buffer.alloc(0), hd = false, need = Infinity, sent = 0, fin = false;
  const bail = () => { if (!onFail || fin || r.headersSent) return false; fin = true; s.destroy(); onFail(); return true; };
  const finish = () => { if (fin) return; fin = true; try { r.end(); } catch (e) {} s.destroy(); };
  r.on('error', () => {}); r.on('close', () => { fin = true; s.destroy(); });
  s.setTimeout(30000, () => s.destroy());
  s.on('connect', () => s.write('GET ' + pq + ' HTTP/1.1\r\nHost: ' + MOVIE_HOST + (port === '80' ? '' : ':' + port) + '\r\nUser-Agent: ' + ua + '\r\n' + (rg ? 'Range: ' + rg + '\r\n' : '') + 'Connection: close\r\n\r\n'));
  const out = (b) => { if (fin || !b.length) return; const part = b.subarray(0, Math.max(0, need - sent)); sent += part.length; if (part.length && !r.write(part)) { s.pause(); r.once('drain', () => s.resume()); } if (sent >= need) finish(); };
  s.on('data', (d) => {
    if (hd) return out(d);
    buf = Buffer.concat([buf, d]); const i2 = buf.indexOf('\r\n\r\n');
    if (i2 < 0) { if (buf.length > 16384) s.destroy(); return; }
    const head = buf.subarray(0, i2).toString('latin1').split('\r\n'); const rest = buf.subarray(i2 + 4); hd = true;
    const sm = /^HTTP\/1\.[01] (\d{3})/.exec(head[0] || ''); const st2 = sm ? parseInt(sm[1], 10) : 502; const H = {};
    let bad = false; for (const ln of head.slice(1)) { const k = ln.indexOf(':'); if (k > 0) { const nm = ln.slice(0, k).trim().toLowerCase(), vl = ln.slice(k + 1).trim(); if ((nm === 'content-length' || nm === 'content-range') && H[nm] !== undefined && H[nm] !== vl) bad = true; H[nm] = vl; } }
    LAST = { at: new Date().toISOString(), kind: 'movie-raw-response', ext: ext, status: st2, content_type: String(H['content-type'] || '').slice(0, 60), content_length: String(H['content-length'] || '').slice(0, 12), accept_ranges: String(H['accept-ranges'] || '').slice(0, 10), has_range: !!rg, extra_after_body: null };
    if (st2 >= 300 && st2 < 400) { if (bail()) return; r.statusCode = 502; return finish(); }
    { const cl = H['content-length'], cr = H['content-range'];
      const m = cr === undefined ? null : /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(cr);
      let ok = !bad && !H['transfer-encoding'] && (st2 === 200 || st2 === 206) && /^\d+$/.test(cl || '');
      if (ok && st2 === 206) ok = !!m && (parseInt(m[2], 10) - parseInt(m[1], 10) + 1 === parseInt(cl, 10));
      if (ok && st2 === 200) ok = cr === undefined;
      if (!ok) { LAST = { at: new Date().toISOString(), kind: 'movie-raw-refused', status: st2, te: !!H['transfer-encoding'], has_cl: !!cl, dup: bad }; if (bail()) return; r.statusCode = 502; return finish(); } }
    r.statusCode = st2;
    for (const k of ['content-type', 'content-range']) if (H[k]) r.setHeader(k, H[k]);
    r.setHeader('accept-ranges', 'bytes');
    if (/^\d+$/.test(H['content-length'] || '')) { need = parseInt(H['content-length'], 10); r.setHeader('content-length', String(need)); }
    out(rest);
    if (need === 0) finish();
  });
  s.on('error', (e) => { LAST = { at: new Date().toISOString(), kind: 'movie-connect-error', code: String(e && e.code || 'unknown') }; if (bail()) return; if (!r.headersSent && !fin) { r.statusCode = 502; } finish(); });
  s.on('close', () => { if (fin) return; if (hd && sent < need) { fin = true; LAST = { at: new Date().toISOString(), kind: 'movie-raw-truncated', sent: sent, need: need }; try { r.destroy(); } catch (e) {} return; } finish(); });
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
    .replace('</script></body></html>', '</script>' + REMEMBER_SCRIPT + HLS_SCRIPT + '</body></html>'), 'utf8');
  return UIBUF;
};
const HLS_SCRIPT = '<script>(function(){var P=HTMLMediaElement.prototype,d=Object.getOwnPropertyDescriptor(P,"src");if(!d||!d.set)return;var v0=document.createElement("video");if(!/forcehls/.test(location.search)&&(v0.canPlayType("video/x-matroska")||!v0.canPlayType("application/vnd.apple.mpegurl")))return;var RX=/^(?:https?:\\/\\/[^\\/]+)?(\\/(?:series|movie)\\/[A-Za-z0-9_.\\-]+\\/[A-Za-z0-9_.\\-]+\\/\\d+\\.mkv)(?:\\?.*)?$/;function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}Object.defineProperty(P,"src",{configurable:true,enumerable:d.enumerable,get:d.get,set:function(val){var el=this,m=RX.exec(String(val||""));if(!m||el.tagName!=="VIDEO")return d.set.call(el,val);var tok=(el.__hlsTok=(el.__hlsTok||0)+1);(async function(){try{var a=await fetch("/__hls/start?src="+encodeURIComponent(m[1]),{credentials:"same-origin"});if(!a.ok)throw new Error("start");var j=await a.json();for(var i=0;i<60;i++){if(el.__hlsTok!==tok)return;var r=await fetch(j.playlist,{credentials:"same-origin",cache:"no-store"});if(r.ok){var t=await r.text();if((t.match(/\\.ts/g)||[]).length>=3){d.set.call(el,j.playlist);try{el.play()}catch(e){}return}}await sleep(1500)}d.set.call(el,val)}catch(e){d.set.call(el,val)}})();}});})();</script>';
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
const HLSLOG = [];
function hlsStop() { const j = HJOB; if (!j) return; try { j.p.kill('SIGKILL'); } catch (e) {} if (j.timer) clearInterval(j.timer); const dd = pathm.join(HROOT, j.id); setTimeout(() => { try { fsx.rmSync(dd, { recursive: true, force: true }); } catch (e) {} }, 1500); HJOB = null; }
function hlsWatch(job, dir) {
  job.lastReq = Date.now(); job.idx = 0; job.stopped = false;
  job.timer = setInterval(() => {
    if (!job.running) { clearInterval(job.timer); if (Date.now() - job.lastReq > 600000 && HJOB === job) hlsStop(); return; }
    if (Date.now() - job.lastReq > parseInt(process.env.HLS_IDLE_MS || "120000", 10)) { LAST = { at: new Date().toISOString(), kind: 'hls-idle-stop' }; if (HJOB === job) hlsStop(); return; }
    let written = 0; try { written = fsx.readdirSync(dir).filter(f => /^s\d{5}\.ts$/.test(f)).length; } catch (e) {}
    const ahead = written - job.idx;
    try { if (ahead > 15 && !job.stopped) { job.p.kill('SIGSTOP'); job.stopped = true; } else if (ahead <= 10 && job.stopped) { job.p.kill('SIGCONT'); job.stopped = false; } } catch (e) {}
  }, 250);
}
function hlsStart(q, r, raw) {
  const u = new URL(raw, 'http://x'); const src = u.searchParams.get('src') || ''; const dur = parseInt(u.searchParams.get('dur') || '0', 10);
  if (!FF) { r.statusCode = 501; return r.end('no ffmpeg'); }
  if (!/^\/(series|movie)\/[A-Za-z0-9_.\-\/]+$/.test(src) || src.includes('..') || src.includes('//')) { r.statusCode = 403; return r.end('bad src'); }
  hlsStop();
  const id = crypto.randomBytes(16).toString('hex'); const dir = pathm.join(HROOT, id); fsx.mkdirSync(dir, { recursive: true });
  const port = process.env.PORT || 10000;
  const args = ['-nostdin', '-loglevel', 'error', '-headers', 'Cookie: ' + (q.headers.cookie || '') + '\r\n', '-i', 'http://127.0.0.1:' + port + src];
  if (!process.env.NO_READRATE) args.splice(args.indexOf('-i'), 0, '-readrate', '8');
  if (dur > 0) args.push('-t', String(Math.min(dur, 7200)));
  args.push('-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_segment_type', 'mpegts', '-hls_flags', 'independent_segments', '-hls_segment_filename', pathm.join(dir, 's%05d.ts'), pathm.join(dir, 'index.m3u8'));
  const t0 = Date.now(); const p = cp.spawn(FF, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const job = { id, p, running: true, t0, err: '', done: null }; HJOB = job; hlsWatch(job, dir);
  p.stderr.on('data', d => { if (job.err.length < 300) job.err += String(d).replace(/[?&=\/][^\s]*/g, '~').slice(0, 300); });
  p.on('close', (code) => { job.running = false; job.done = { code, secs: Math.round((Date.now() - t0) / 1000) }; });
  setTimeout(() => { if (HJOB === job) hlsStop(); }, 4 * 3600 * 1000);
  r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ id, playlist: '/__hls/' + id + '/index.m3u8' }));
}
function hlsRoute(q, r, raw, pathOnly) {
  if (pathOnly === '/__hls/start') return hlsStart(q, r, raw);
  if (pathOnly === '/__hls/selftest') {
    if (!FF) { r.statusCode = 501; return r.end('no ffmpeg'); }
    hlsStop();
    const id = crypto.randomBytes(16).toString('hex'); const dir = pathm.join(HROOT, id); fsx.mkdirSync(dir, { recursive: true });
    const samp = pathm.join(dir, 'sample.mkv'); const t0 = Date.now();
    const g = cp.spawn(FF, ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '30', '-c:v', 'libx264', '-profile:v', 'main', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', samp], { stdio: 'ignore' });
    const job = { id, p: g, running: true, t0, err: '', done: null }; HJOB = job; let genSecs = 0;
    g.on('close', (c1) => {
      genSecs = Math.round((Date.now() - t0) / 1000);
      const t1 = Date.now();
      const p = cp.spawn(FF, ['-nostdin', '-loglevel', 'error', '-i', samp, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_segment_type', 'mpegts', '-hls_flags', 'independent_segments', '-hls_segment_filename', pathm.join(dir, 's%05d.ts'), pathm.join(dir, 'index.m3u8')], { stdio: 'ignore' });
      job.p = p;
      p.on('close', (c2) => { job.running = false; job.done = { gen_code: c1, gen_secs: genSecs, remux_code: c2, remux_secs: Math.round((Date.now() - t1) / 1000), rss_mb: Math.round(process.memoryUsage().rss / 1048576), sample_bytes: (() => { try { return fsx.statSync(samp).size; } catch (e) { return -1; } })() }; });
    });
    r.setHeader('content-type', 'application/json'); return r.end(JSON.stringify({ id, playlist: '/__hls/' + id + '/index.m3u8' }));
  }
  if (pathOnly === '/__hls/status') { const j = HJOB; r.setHeader('content-type', 'application/json'); let files = 0, bytes = 0; if (j) { try { for (const f of fsx.readdirSync(pathm.join(HROOT, j.id))) { files++; bytes += fsx.statSync(pathm.join(HROOT, j.id, f)).size; } } catch (e) {} } return r.end(JSON.stringify(j ? { id: j.id, running: j.running, secs: Math.round((Date.now() - j.t0) / 1000), files, bytes, done: j.done, err: j.err } : {})); }
  const m = /^\/__hls\/([0-9a-f]{32})\/(index\.m3u8|s\d{5}\.ts)$/.exec(pathOnly);
  if (!m) { r.statusCode = 404; return r.end(); }
  if (HJOB && HJOB.id === m[1]) { HJOB.lastReq = Date.now(); const sn = /^s(\d{5})\.ts$/.exec(m[2]); if (sn) HJOB.idx = Math.max(HJOB.idx || 0, parseInt(sn[1], 10)); }
  const fp = pathm.join(HROOT, m[1], m[2]);
  fsx.readFile(fp, (e, b) => {
    if (e) { r.statusCode = 404; return r.end(); }
    r.setHeader('content-type', m[2].endsWith('m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
    if (m[2].endsWith('m3u8') && !/EXT-X-START/.test(String(b))) b = Buffer.from(String(b).replace('#EXTM3U\n', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n'));
    if (m[2].endsWith('m3u8') && HJOB && HJOB.id === m[1] && !HJOB.running && HJOB.done && HJOB.done.code === 0 && !/ENDLIST/.test(String(b))) b = Buffer.concat([b, Buffer.from('#EXT-X-ENDLIST\n')]);
    r.end(b);
  });
}
http.createServer((q, r) => {
  r.setHeader('cache-control', 'no-store'); r.setHeader('x-content-type-options', 'nosniff');
  const raw = q.url || '';
  const pathOnly = raw.split('?')[0];
  if (pathOnly.startsWith('/__hls/')) { const kd = /index\.m3u8$/.test(pathOnly) ? 'playlist' : /init\.mp4$/.test(pathOnly) ? 'init' : /\.ts$/.test(pathOnly) ? 'seg' : /start$/.test(pathOnly) ? 'start' : 'other'; const ua = /iPhone|iPad/.test(q.headers['user-agent'] || '') ? 'ios' : 'other'; const hc = /(?:^|;\s*)sid=/.test(q.headers.cookie || ''); const sn = (/\/s(\d{5})\.ts$/.exec(pathOnly) || [])[1]; r.on('finish', () => { HLSLOG.push({ t: new Date().toISOString().slice(11, 19), kind: kd, seg: sn ? parseInt(sn, 10) : undefined, status: r.statusCode, cookie: hc, ua: ua, range: !!q.headers.range }); if (HLSLOG.length > 40) HLSLOG.shift(); }); }
  if (pathOnly === '/login' && q.method === 'POST') return handleLogin(q, r);
  if (!okCookie(q.headers.cookie)) {
    if ((pathOnly === '/' || pathOnly === '/login') && (q.method === 'GET' || q.method === 'HEAD')) { r.setHeader('content-type', 'text/html; charset=utf-8'); return r.end(loginPage('')); }
    r.statusCode = 401; return r.end();
  }
  if (pathOnly === '/__logout' && q.method === 'POST') { if (q.headers['x-csrf'] !== '1') { r.statusCode = 403; return r.end(); } RCACHE.clear(); r.setHeader('set-cookie', credClear); r.statusCode = 204; return r.end(); }
  if (q.method !== 'GET' && q.method !== 'HEAD') { r.statusCode = 405; return r.end(); }
  if (pathOnly.startsWith('/__hls/')) return hlsRoute(q, r, raw, pathOnly);
  if (pathOnly === '/__me') { r.setHeader('content-type', 'application/json'); return r.end(JSON.stringify({ saved: !!readCred(q) })); }
  if (pathOnly === '/') { r.setHeader('content-type', 'text/html; charset=utf-8'); return r.end(ui()); }
  const rest = raw;
  if (rest === '/__diag') { r.setHeader('content-type', 'application/json'); return r.end(JSON.stringify(Object.assign({}, LAST, { hls: HLSLOG.slice(-30) }))); }
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
  const mext = ((u.pathname.match(/\.([A-Za-z0-9]{1,5})$/) || [])[1] || '');
  const ck = /^\/movie\//.test(u.pathname) ? rkey(q, upPath + upSearch) : null;
  const runUp = () => {
  const req = (UP.protocol === 'https:' ? https : http).request({ host: UP.hostname, port: UP.port || (UP.protocol === 'https:' ? 443 : 80), path: upPath + upSearch, method: q.method, headers: h }, (ur) => {
    if (ur.statusCode >= 300 && ur.statusCode < 400 && /^\/movie\//.test(u.pathname)) {
      ur.resume();
      let L4 = null; try { L4 = new URL(ur.headers.location, 'http://' + UP.host); } catch (e) {}
      if (!L4 || L4.protocol !== 'http:' || L4.hostname !== MOVIE_HOST || L4.username || L4.password) { LAST = { at: new Date().toISOString(), kind: 'movie-redirect-refused', location_host: L4 ? L4.hostname : 'unparsable' }; r.statusCode = 502; return r.end(); }
      if (ck) { if (RCACHE.size > 50) RCACHE.clear(); RCACHE.set(ck, { href: L4.href, exp: Date.now() + 120000 }); }
      return movieProxy(L4, q, r, mext);
    }
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
  };
  if (ck) { const hit = RCACHE.get(ck); if (hit) { let Lc = null; try { Lc = new URL(hit.href); } catch (e) {} if (hit.exp > Date.now() && Lc && Lc.protocol === 'http:' && Lc.hostname === MOVIE_HOST && !Lc.username && !Lc.password) return movieProxy(Lc, q, r, mext, () => { RCACHE.delete(ck); runUp(); }); RCACHE.delete(ck); } }
  runUp();
}).listen(process.env.PORT || 10000);
