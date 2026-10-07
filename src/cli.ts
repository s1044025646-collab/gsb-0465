import * as path from "node:path";
import { ImageStore } from "./store";
import { startServer } from "./server";
import { pixelAt, toMatrix, FitsError } from "./fits";
import { buildFixtures } from "./fixtures";

const DEFAULT_DATA = path.join(process.cwd(), "data");

function argValue(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function fail(e: unknown): never {
  if (e instanceof FitsError) {
    console.error(`错误 [${e.code}] ${e.message}${e.cardIndex !== undefined ? `（卡片 ${e.cardIndex + 1}）` : ""}`);
  } else {
    console.error(`错误: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const dataDir = argValue(args, "--data") ?? process.env.FITS_DATA_DIR ?? DEFAULT_DATA;

  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(`用法: fits <命令> [参数]

命令:
  serve [--port N] [--data DIR]   启动 HTTP API（默认端口 0 = 自动选空闲端口）
  make-fixtures [DIR]             生成合成 FITS 夹具（默认 data/fixtures）
  import <file> [--data DIR]      导入 FITS 文件（幂等）
  list [--data DIR]               列出已导入图像
  cards <id> [--data DIR]         列出头卡
  pixel <id> <x> <y> [--data DIR] 查询像素（偏移/原值/缩放/缺测/物理值）
  matrix <id> [--data DIR]        导出物理值矩阵与缺测掩码
  stats <id> [--data DIR]         查看统计
  demo [--data DIR]               生成夹具并演示 3x1 BITPIX=16 样例`);
    return;
  }

  if (cmd === "make-fixtures") {
    const dir = args[1] && !args[1].startsWith("--") ? args[1] : path.join(dataDir, "fixtures");
    const files = buildFixtures(dir);
    for (const f of files) console.log(`已生成 ${f}`);
    return;
  }

  if (cmd === "serve") {
    const portArg = argValue(args, "--port") ?? process.env.PORT ?? "0";
    const port = Number(portArg);
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail(new Error(`非法端口: ${portArg}`));
    const store = new ImageStore(dataDir);
    const { port: actual } = await startServer(store, port);
    console.log(`FITS API 已启动: http://127.0.0.1:${actual}  数据目录: ${dataDir}`);
    return;
  }

  const store = new ImageStore(dataDir);
  try {
    if (cmd === "import") {
      const file = args[1];
      if (!file) fail(new Error("用法: fits import <file>"));
      const { record, already } = store.import(file);
      console.log(JSON.stringify({ id: record.id, already, image: record }, null, 2));
    } else if (cmd === "list") {
      console.log(JSON.stringify(store.list(), null, 2));
    } else if (cmd === "cards") {
      const id = args[1];
      if (!id) fail(new Error("用法: fits cards <id>"));
      if (!store.get(id)) fail(new Error(`图像不存在: ${id}`));
      console.log(JSON.stringify(store.cards(id), null, 2));
    } else if (cmd === "pixel") {
      const [, id, xs, ys] = args;
      const x = Number(xs), y = Number(ys);
      if (!id || !Number.isInteger(x) || !Number.isInteger(y)) fail(new Error("用法: fits pixel <id> <x> <y>"));
      const img = store.loadImage(id);
      if (!img) fail(new Error(`图像不存在: ${id}`));
      console.log(JSON.stringify(pixelAt(img, x, y), null, 2));
    } else if (cmd === "matrix") {
      const id = args[1];
      if (!id) fail(new Error("用法: fits matrix <id>"));
      const img = store.loadImage(id);
      if (!img) fail(new Error(`图像不存在: ${id}`));
      console.log(JSON.stringify(toMatrix(img), null, 2));
    } else if (cmd === "stats") {
      const id = args[1];
      if (!id) fail(new Error("用法: fits stats <id>"));
      const rec = store.get(id);
      if (!rec) fail(new Error(`图像不存在: ${id}`));
      console.log(JSON.stringify(rec.stats, null, 2));
    } else if (cmd === "demo") {
      const dir = path.join(dataDir, "fixtures");
      buildFixtures(dir);
      const { record, already } = store.import(path.join(dir, "demo16.fits"));
      console.log(`导入 demo16.fits id=${record.id} already=${already}`);
      const img = store.loadImage(record.id)!;
      const m = toMatrix(img);
      console.log(`物理值: ${JSON.stringify(m.values[0])}`);
      console.log(`掩码:   ${JSON.stringify(m.mask[0])}`);
      console.log(`统计:   ${JSON.stringify(record.stats)}`);
      const p = pixelAt(img, 0, 0);
      console.log(`像素(0,0): 偏移=${p.offset} 原值=${p.raw} 物理值=${p.physical}`);
    } else {
      fail(new Error(`未知命令: ${cmd}，用 fits help 查看用法`));
    }
  } catch (e) {
    fail(e);
  } finally {
    store.close();
  }
}

main();
