import path from 'node:path';
import { ImageStore } from './db.js';
import { toErrorPayload } from './errors.js';
import { defaultDataDir } from './server.js';

const USAGE = `用法: node dist/src/cli.js <命令> [参数]

命令:
  import <文件路径>        导入 FITS 文件（幂等，按 SHA-256 去重）
  list                     列出已导入图像
  cards <id>               列出头卡（原文、类型、卡号）
  pixel <id> <x> <y>       查询像素：偏移、原值、缩放、缺测、物理值
  matrix <id>              导出数值矩阵与缺测掩码（JSON）
  stats <id>               查看统计（仅有效物理值）
  serve [端口]             启动 HTTP API（默认自动选择空闲端口）

环境变量:
  FITS_DATA_DIR   数据目录（默认 ./data）
  PORT            服务端口（默认 0 = 空闲端口）
`;

function intArg(value: string | undefined, name: string): number {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n)) {
    throw Object.assign(new Error(`参数 ${name} 必须为整数，实际为 ${value}`), { code: 'VALIDATION' });
  }
  return n;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(USAGE);
    return;
  }
  if (cmd === 'serve') {
    process.env.PORT = args[0] ?? process.env.PORT;
    await import('./server.js');
    return;
  }
  const store = new ImageStore(defaultDataDir());
  try {
    switch (cmd) {
      case 'import': {
        if (!args[0]) throw Object.assign(new Error('缺少文件路径参数'), { code: 'VALIDATION' });
        console.log(JSON.stringify(store.importFile(path.resolve(args[0])), null, 2));
        break;
      }
      case 'list':
        console.log(JSON.stringify(store.list(), null, 2));
        break;
      case 'cards':
        console.log(JSON.stringify(store.cards(intArg(args[0], 'id')), null, 2));
        break;
      case 'pixel':
        console.log(JSON.stringify(store.pixel(intArg(args[0], 'id'), intArg(args[1], 'x'), intArg(args[2], 'y')), null, 2));
        break;
      case 'matrix':
        console.log(JSON.stringify(store.matrix(intArg(args[0], 'id')), null, 2));
        break;
      case 'stats':
        console.log(JSON.stringify(store.stats(intArg(args[0], 'id')), null, 2));
        break;
      default:
        console.error(`未知命令: ${cmd}\n${USAGE}`);
        process.exitCode = 2;
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: toErrorPayload(err) }, null, 2));
  process.exitCode = 1;
});
