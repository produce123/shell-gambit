/**
 * Shell Gambit — 本地静态服务器（仅开发/测试用，不参与线上部署）
 *
 * 因为整个项目就是一堆静态文件，GitHub Pages 上不需要它。
 * 本地用它只是为了能用 http:// 打开页面（ES Module 在 file:// 下会被 CORS 拦掉）。
 *
 * 用法：node tools/serve.mjs [端口]
 */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export function createStaticServer(root = ROOT) {
  return createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let filePath = join(root, normalize(urlPath).replace(/^([/\\])+/, ''));
    // 防止 ../ 穿越
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      if (statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    try {
      const stat = statSync(filePath);
      res.writeHead(200, {
        'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': 'no-store',
      });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
    }
  });
}

/** 启动服务器并返回 { port, url, close } */
export function startServer(port = 0, root = ROOT) {
  return new Promise((resolvePromise) => {
    const server = createStaticServer(root);
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolvePromise({
        port: actual,
        url: `http://127.0.0.1:${actual}/`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// 直接运行时才起服务
if (process.argv[1] && process.argv[1].endsWith('serve.mjs')) {
  const port = Number(process.argv[2]) || 8080;
  const s = await startServer(port);
  console.log(`Shell Gambit 本地预览：${s.url}`);
}