import fs from 'node:fs';
import path from 'node:path';
import { buildFits, formatCard } from '../src/fits/writer.js';
import { ImageStore } from '../src/db.js';
import { CARD_SIZE } from '../src/fits/parser.js';

const dataDir = process.env.FITS_DATA_DIR ?? path.join(process.cwd(), 'data');
const fixturesDir = path.join(dataDir, 'fixtures');
fs.mkdirSync(fixturesDir, { recursive: true });

const fixtures: Record<string, Buffer> = {
  'demo16.fits': buildFits({ width: 3, height: 1, bitpix: 16, raw: [-2, 0, 3], bscale: 2, bzero: 10, blank: 0 }),
  'demo8.fits': buildFits({ width: 4, height: 2, bitpix: 8, raw: [0, 64, 128, 255, 255, 128, 64, 0], bzero: -10 }),
  'demo-all-blank.fits': buildFits({ width: 2, height: 2, bitpix: 16, raw: [7, 7, 7, 7], blank: 7 }),
  'demo-long-header.fits': buildFits({
    width: 1,
    height: 1,
    bitpix: 8,
    raw: [42],
    extraCards: [
      formatCard('OBJECT', "'O''BRIEN / STAR'", 'string with slash and quote'),
      ...Array.from({ length: 40 }, (_, i) => ('COMMENT   filler note ' + String(i)).padEnd(CARD_SIZE, ' ').slice(0, CARD_SIZE)),
    ],
  }),
};

const store = new ImageStore(dataDir);
for (const [name, buf] of Object.entries(fixtures)) {
  const file = path.join(fixturesDir, name);
  fs.writeFileSync(file, buf);
  const info = store.importFile(file);
  console.log(`导入 ${name}: id=${info.id} duplicate=${info.duplicate}`);
  console.log('  统计:', JSON.stringify(store.stats(info.id).stats));
  console.log('  矩阵:', JSON.stringify(store.matrix(info.id).physical));
  console.log('  像素(0,0):', JSON.stringify(store.pixel(info.id, 0, 0)));
}
store.close();
console.log(`\n演示完成，数据目录: ${dataDir}`);
