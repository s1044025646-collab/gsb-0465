import * as http from "node:http";
import { ImageStore } from "./store";
import { FitsError, pixelAt, toMatrix, computeStats } from "./fits";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function errBody(e: unknown): { status: number; body: unknown } {
  if (e instanceof FitsError) {
    const status = e.code === "LIMIT_EXCEEDED" ? 413 : 422;
    return { status, body: { error: { code: e.code, message: e.message, card: e.cardIndex ?? null } } };
  }
  if (e && typeof e === "object" && "code" in e && (e as any).code === "ENOENT") {
    return { status: 404, body: { error: { code: "FILE_NOT_FOUND", message: (e as unknown as Error).message } } };
  }
  return { status: 500, body: { error: { code: "INTERNAL", message: String(e) } } };
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new FitsError("FITS_BAD_VALUE", "请求体不是合法 JSON"); }
}

export function createServer(store: ImageStore): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      // POST /images/import  {path}
      if (req.method === "POST" && url.pathname === "/images/import") {
        const body = await readBody(req);
        if (typeof body.path !== "string" || !body.path) {
          return json(res, 400, { error: { code: "VALIDATION", message: "缺少参数 path（字符串）" } });
        }
        const { record, already } = store.import(body.path);
        return json(res, already ? 200 : 201, { id: record.id, already, image: record });
      }
      // GET /images
      if (req.method === "GET" && url.pathname === "/images") {
        return json(res, 200, { images: store.list() });
      }
      if (parts[0] === "images" && parts.length >= 2) {
        const id = parts[1];
        const rec = store.get(id);
        if (!rec) return json(res, 404, { error: { code: "NOT_FOUND", message: `图像不存在: ${id}` } });
        const sub = parts[2];
        if (req.method === "GET" && !sub) return json(res, 200, { image: rec });
        if (req.method === "GET" && sub === "cards") return json(res, 200, { cards: store.cards(id) });
        if (req.method === "GET" && sub === "stats") return json(res, 200, { stats: rec.stats });
        if (req.method === "GET" && sub === "pixel") {
          const x = Number(url.searchParams.get("x"));
          const y = Number(url.searchParams.get("y"));
          if (!Number.isInteger(x) || !Number.isInteger(y)) {
            return json(res, 400, { error: { code: "VALIDATION", message: "x、y 必须为整数查询参数" } });
          }
          const img = store.loadImage(id)!;
          return json(res, 200, { pixel: pixelAt(img, x, y) });
        }
        if (req.method === "GET" && sub === "matrix") {
          const img = store.loadImage(id)!;
          return json(res, 200, { matrix: toMatrix(img) });
        }
      }
      return json(res, 404, { error: { code: "NOT_FOUND", message: `未知路由: ${req.method} ${url.pathname}` } });
    } catch (e) {
      const { status, body } = errBody(e);
      return json(res, status, body);
    }
  });
}

export function startServer(store: ImageStore, port: number): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer(store);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({ port: actual, close: () => server.close() });
    });
  });
}
