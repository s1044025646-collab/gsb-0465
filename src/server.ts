import http from 'node:http';
import path from 'node:path';
import { ImageStore } from './db.js';
import { toErrorPayload } from './errors.js';

export function createServer(store: ImageStore): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/health') {
        return send(200, { ok: true });
      }
      if (method === 'POST' && url.pathname === '/images') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const parsed = body ? JSON.parse(body) : {};
        if (typeof parsed.path !== 'string' || parsed.path.length === 0) {
          return send(400, { error: { code: 'VALIDATION', message: '请求体需包含 path 字段' } });
        }
        return send(201, store.importFile(parsed.path));
      }
      if (method === 'GET' && url.pathname === '/images') {
        return send(200, { images: store.list() });
      }
      if (segments[0] === 'images' && segments.length >= 2) {
        const id = Number(segments[1]);
        if (!Number.isInteger(id) || id <= 0) {
          return send(400, { error: { code: 'VALIDATION', message: 'id 必须为正整数' } });
        }
        const sub = segments[2];
        if (method === 'GET' && sub === 'cards') return send(200, store.cards(id));
        if (method === 'GET' && sub === 'stats') return send(200, store.stats(id));
        if (method === 'GET' && sub === 'matrix') return send(200, store.matrix(id));
        if (method === 'GET' && sub === 'pixel') {
          const x = Number(url.searchParams.get('x'));
          const y = Number(url.searchParams.get('y'));
          return send(200, store.pixel(id, x, y));
        }
      }
      return send(404, { error: { code: 'NOT_FOUND', message: `未知路由：${method} ${url.pathname}` } });
    } catch (err) {
      const payload = toErrorPayload(err);
      const status = payload.code === 'NOT_FOUND' ? 404 : payload.code === 'INTERNAL' ? 500 : 400;
      return send(status, { error: payload });
    }
  });
}

export function defaultDataDir(): string {
  return process.env.FITS_DATA_DIR ?? path.join(process.cwd(), 'data');
}

if (require.main === module) {
  const store = new ImageStore(defaultDataDir());
  const server = createServer(store);
  const portEnv = process.env.PORT;
  const port = portEnv ? Number(portEnv) : 0;
  server.listen(port, () => {
    const addr = server.address();
    const actual = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`FITS 服务已启动: http://127.0.0.1:${actual}  数据目录: ${store.dataDir}`);
  });
  process.on('SIGINT', () => {
    server.close();
    store.close();
    process.exit(0);
  });
}
