// 零依赖静态服务器。刻意用 CommonJS：package.json 里是 "type": "module"，
// 这样 `node --check` 会把 js/ 下的浏览器源码当 ES 模块解析，而本文件仍然能被
// Electron 和 tools/verify.sh require。
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function createServer(root = __dirname) {
  return http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    if (urlPath === '/') urlPath = '/index.html';
    const file = path.join(root, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        // 不缓存：harness 会在两个 scenario 之间重载页面，一次 304 就能把刚改的字节
        // 伪装成「没发出去」；玩家手改本地 css/ 时看到的也是同一份假象。
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
  });
}

// 5272：本仓在 z-biz-game 端口表里占的号。挑一个每仓专属的固定号，是为了不让一个忘关的
// 别的仓的服务器被当成本仓的盘面来测——fallback 和 package.json 的 dev 脚本必须是同一个数。
// 隔壁 5271 是海战推演的，只差一个字符，所以 verify.sh 在开打前还要看 served 字节里写的是数方。
function startServer({ port = 5272, root = path.join(__dirname) } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer(root);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { createServer, startServer };

if (require.main === module) {
  const port = Number(process.argv[2]) || Number(process.env.PORT) || 5272;
  startServer({ port })
    .then((server) => {
      console.log(`数方 Suguru served at http://127.0.0.1:${port}/  (ctrl+c to stop)`);
      process.on('SIGINT', () => server.close(() => process.exit(0)));
    })
    .catch((err) => {
      console.error('failed to start:', err.message);
      process.exit(1);
    });
}
