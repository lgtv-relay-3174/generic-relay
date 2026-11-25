// Mock IPTV provider for relay testing only. Account test/test. Streams a public Apple sample HLS clip.
const http = require('http');
const https = require('https');
const BASE = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/gear1/';
const get = (path, cb) => https.get(BASE + path, cb).on('error', () => cb(null));
http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  const p = u.pathname;
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
