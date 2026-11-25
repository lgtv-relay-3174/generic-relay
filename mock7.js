// Mock IPTV provider and demo page for testing only. Account test/test. Streams a public Apple sample HLS clip.
const http = require('http');
const https = require('https');
const BASE = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/gear1/';
const get = (path, cb) => https.get(BASE + path, cb).on('error', () => cb(null));
const fs = require('fs');
const UI = require('zlib').gunzipSync(Buffer.from(fs.readdirSync(__dirname).filter(f => /^uib_\d+\.txt$/.test(f)).sort().map(f => fs.readFileSync(__dirname + '/' + f, 'utf8')).join(''), 'base64'));
const UI_FIXED = Buffer.from(UI.toString('utf8').replace('new MutationObserver(fill)', 'fill();setInterval(fill,300);new MutationObserver(fill)').replace('position:fixed;top:0;left:0;right:0;z-index:99','position:relative;width:100%;box-sizing:border-box').replace('document.body.appendChild(n)','document.body.insertBefore(n,document.body.firstChild)'), 'utf8');
const UI_PRIV = Buffer.from(UI_FIXED.toString('utf8').replace('set(s,R);set(u,"test");set(p,"test");', '').replace('نسخة تجريبية: سيرفر وهمي. مش اشتراكك. ماتكتبش بياناتك الحقيقية.', 'نسخة اختبار خاصة. البيانات بتفضل في الصفحة دي بس.'), 'utf8');
const PAGE = '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Video test</title>'
 + '<body style="margin:0;background:#111;color:#fff;font:18px sans-serif;text-align:center">'
 + '<p>اختبار فيديو تجريبي عام. ده مش اشتراكك.</p>'
 + '<video id="v" controls playsinline autoplay muted style="width:100%;max-height:65vh;background:#000"></video>'
 + '<p><button id="f" style="font-size:22px;padding:12px 28px">ملء الشاشة</button></p><p id="s">...</p>'
 + '<script>var src="/live/test/test/1.m3u8",v=document.getElementById("v"),s=document.getElementById("s");'
 + 'if(v.canPlayType("application/vnd.apple.mpegurl")){v.src=src;}else{var sc=document.createElement("script");sc.src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js";'
 + 'sc.onload=function(){if(window.Hls&&Hls.isSupported()){var h=new Hls();h.loadSource(src);h.attachMedia(v);}else{s.textContent="المتصفح ده مش بيدعم HLS";}};'
 + 'sc.onerror=function(){s.textContent="تعذر تحميل مكتبة التشغيل";};document.head.appendChild(sc);}'
 + 'document.getElementById("f").onclick=function(){var d=document;if(d.fullscreenElement||d.webkitFullscreenElement){(d.exitFullscreen||d.webkitExitFullscreen).call(d);return;}'
 + 'var r=v.requestFullscreen||v.webkitRequestFullscreen;if(r){r.call(v);}else if(v.webkitEnterFullscreen){v.webkitEnterFullscreen();}else{s.textContent="الجهاز ده مش بيدعم ملء الشاشة من هنا";}};'
 + 'setInterval(function(){if(v.error){s.textContent="خطأ تشغيل "+v.error.code;}else{s.textContent=(v.muted?"الصوت مقفول. ":"")+"وقت التشغيل: "+v.currentTime.toFixed(1)+" ثانية";}},1000);</script></body></html>';
http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  const p = u.pathname;
  if (p === '/private') { r.setHeader('content-type', 'text/html; charset=utf-8'); r.setHeader('cache-control', 'no-store'); return r.end(UI_PRIV); }
  if (p === '/' || p === '/app') { r.setHeader('content-type', 'text/html; charset=utf-8'); return r.end(UI_FIXED); }
  if (p === '/video' || p === '/demo') { r.setHeader('content-type', 'text/html; charset=utf-8'); return r.end(PAGE); }
  if (p === '/player_api.php') {
    r.setHeader('content-type', 'application/json');
    if (u.searchParams.get('username') !== 'test' || u.searchParams.get('password') !== 'test') return r.end(JSON.stringify({ user_info: { auth: 0 } }));
    const a = u.searchParams.get('action');
    if (a === 'get_live_streams') return r.end(JSON.stringify([{ stream_id: 1, name: 'Mock Channel 1', category_id: '1' }]));
    if (a === 'get_live_categories') return r.end(JSON.stringify([{ category_id: '1', category_name: 'Test' }]));
    if (a) return r.end('[]');
    return r.end(JSON.stringify({ user_info: { auth: 1, status: 'Active', username: 'test' }, server_info: {} }));
  }
  if (p === '/live/test/test/1.m3u8') {
    const self = (q.headers['x-forwarded-proto'] || 'https') + '://' + q.headers.host;
    return get('prog_index.m3u8', (ur) => {
      if (!ur) { r.statusCode = 502; return r.end(); }
      let b = ''; ur.setEncoding('utf8'); ur.on('data', d => b += d);
      ur.on('end', () => {
        r.setHeader('content-type', 'application/vnd.apple.mpegurl');
        r.end(b.replace(/^(fileSequence\d+\.ts)$/mg, self + '/seg/$1'));
      });
    });
  }
  const m = p.match(/^\/seg\/(fileSequence\d+\.ts)$/);
  if (m) return get(m[1], (ur) => {
    if (!ur) { r.statusCode = 502; return r.end(); }
    r.setHeader('content-type', 'video/mp2t'); ur.pipe(r);
  });
  r.statusCode = 404; r.end('nf');
}).listen(process.env.PORT || 10000);
