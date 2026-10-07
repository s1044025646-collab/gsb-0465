import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFits, pixelAt, BLOCK_SIZE, CARD_SIZE } from '../src/fits/parser.js';
import { buildFits, formatCard } from '../src/fits/writer.js';
import { FitsError } from '../src/errors.js';

function handBuild(cards: string[], dataBytes: Buffer): Buffer {
  const headerBlocks = Math.ceil((cards.length * CARD_SIZE) / BLOCK_SIZE);
  const header = Buffer.alloc(headerBlocks * BLOCK_SIZE, 0x20);
  cards.forEach((c, i) => {
    assert.equal(c.length, CARD_SIZE, `卡 ${i} 长度必须为 80`);
    header.write(c, i * CARD_SIZE, 'ascii');
  });
  const data = Buffer.alloc(Math.ceil(dataBytes.length / BLOCK_SIZE) * BLOCK_SIZE, 0);
  dataBytes.copy(data);
  return Buffer.concat([header, data]);
}

test('合成 3x1 BITPIX=16：[-2,0,3] BSCALE=2 BZERO=10 BLANK=0 → [6,null,16]，均值 11', () => {
  const buf = buildFits({ width: 3, height: 1, bitpix: 16, raw: [-2, 0, 3], bscale: 2, bzero: 10, blank: 0 });
  const parsed = parseFits(buf);
  assert.deepEqual(parsed.rawRows, [[-2, 0, 3]]);
  assert.deepEqual(parsed.physicalRows, [[6, null, 16]]);
  assert.deepEqual(parsed.maskRows, [[false, true, false]]);
  assert.deepEqual(parsed.stats, { validCount: 2, blankCount: 1, min: 6, max: 16, mean: 11 });
});

test('手写卡片 + 手写大端字节独立核对像素偏移', () => {
  const cards = [
    formatCard('SIMPLE', 'T'),
    formatCard('BITPIX', '16'),
    formatCard('NAXIS', '2'),
    formatCard('NAXIS1', '2'),
    formatCard('NAXIS2', '2'),
    formatCard('END'),
  ];
  const data = Buffer.alloc(8);
  data.writeInt16BE(-5, 0);
  data.writeInt16BE(100, 2);
  data.writeInt16BE(7, 4);
  data.writeInt16BE(-32768, 6);
  const buf = handBuild(cards, data);
  const parsed = parseFits(buf);
  assert.equal(parsed.dataStart, BLOCK_SIZE);
  assert.deepEqual(parsed.rawRows, [[-5, 100], [7, -32768]]);
  const p = pixelAt(parsed, 1, 1);
  assert.equal(p.offset, BLOCK_SIZE + 3 * 2);
  assert.equal(p.raw, -32768);
  assert.equal(p.physical, -32768);
  assert.equal(buf.readInt16BE(p.offset), -32768);
});

test('头跨两个块时像素区从第二块之后开始', () => {
  const commentCards = Array.from({ length: 40 }, (_, i) => ('COMMENT   filler ' + String(i)).padEnd(CARD_SIZE, ' ').slice(0, CARD_SIZE));
  const cards = [
    formatCard('SIMPLE', 'T'),
    formatCard('BITPIX', '8'),
    formatCard('NAXIS', '2'),
    formatCard('NAXIS1', '1'),
    formatCard('NAXIS2', '1'),
    ...commentCards,
    formatCard('END'),
  ];
  assert.ok(cards.length * CARD_SIZE > BLOCK_SIZE, '头应超过一个块');
  const buf = handBuild(cards, Buffer.from([42]));
  const parsed = parseFits(buf);
  assert.equal(parsed.headerBlocks, 2);
  assert.equal(parsed.dataStart, 2 * BLOCK_SIZE);
  assert.equal(parsed.rawRows[0][0], 42);
  assert.equal(pixelAt(parsed, 0, 0).offset, 2 * BLOCK_SIZE);
});

test('字符串中的斜杠不是注释，双单引号表示一个字面单引号', () => {
  const buf = buildFits({
    width: 1, height: 1, bitpix: 8, raw: [1],
    extraCards: [formatCard('OBJECT', "'O''BRIEN / STAR'", 'trailing comment')],
  });
  const parsed = parseFits(buf);
  const obj = parsed.cards.find((c) => c.keyword === 'OBJECT');
  assert.ok(obj);
  assert.equal(obj.value, "O'BRIEN / STAR");
  assert.equal(obj.valueType, 'string');
  assert.equal(obj.comment, 'trailing comment');
});

test('COMMENT/HISTORY 可重复并保留顺序', () => {
  const buf = buildFits({
    width: 1, height: 1, bitpix: 8, raw: [1],
    extraCards: [
      ('COMMENT   first note').padEnd(CARD_SIZE, ' '),
      ('HISTORY   history one').padEnd(CARD_SIZE, ' '),
      ('COMMENT   second note').padEnd(CARD_SIZE, ' '),
    ],
  });
  const parsed = parseFits(buf);
  const texts = parsed.cards.filter((c) => c.keyword === 'COMMENT' || c.keyword === 'HISTORY').map((c) => c.comment);
  assert.deepEqual(texts, ['first note', 'history one', 'second note']);
});

test('BITPIX=8 无符号读取', () => {
  const buf = buildFits({ width: 2, height: 1, bitpix: 8, raw: [0, 255] });
  const parsed = parseFits(buf);
  assert.deepEqual(parsed.rawRows, [[0, 255]]);
});

test('全缺测图：统计均为 null，不出现 NaN', () => {
  const buf = buildFits({ width: 2, height: 2, bitpix: 16, raw: [7, 7, 7, 7], blank: 7 });
  const parsed = parseFits(buf);
  assert.deepEqual(parsed.stats, { validCount: 0, blankCount: 4, min: null, max: null, mean: null });
  assert.ok(!JSON.stringify(parsed.stats).includes('NaN'));
});

test('科学计数与 D 指数', () => {
  const buf = buildFits({ width: 1, height: 1, bitpix: 16, raw: [2], bscale: 1.5, extraCards: [formatCard('BZERO', '1.0D1')] });
  const parsed = parseFits(buf);
  assert.equal(parsed.bzero, 10);
  assert.equal(parsed.physicalRows[0][0], 13);
});

test('拒绝重复结构关键字', () => {
  const buf = buildFits({ width: 1, height: 1, bitpix: 8, raw: [1], extraCards: [formatCard('BSCALE', '2'), formatCard('BSCALE', '3')] });
  assert.throws(() => parseFits(buf), (e) => e instanceof FitsError && e.code === 'FITS_DUPLICATE_KEYWORD');
});

test('拒绝无 END', () => {
  const buf = Buffer.alloc(BLOCK_SIZE, 0x20);
  buf.write(formatCard('SIMPLE', 'T'), 0, 'ascii');
  assert.throws(() => parseFits(buf), (e) => e instanceof FitsError && e.code === 'FITS_NO_END');
});

test('拒绝错误块长度', () => {
  const buf = buildFits({ width: 1, height: 1, bitpix: 8, raw: [1] });
  assert.throws(() => parseFits(buf.subarray(0, buf.length - 10)), (e) => e instanceof FitsError && e.code === 'FITS_TRUNCATED');
});

test('拒绝坏宽高', () => {
  const buf = buildFits({ width: 1, height: 1, bitpix: 8, raw: [1] });
  buf.write(formatCard('NAXIS1', '-3'), 3 * CARD_SIZE, 'ascii');
  assert.throws(() => parseFits(buf), (e) => e instanceof FitsError && e.code === 'FITS_BAD_VALUE' && e.cardIndex === 3);
});

test('拒绝不支持的 BITPIX 与 NAXIS', () => {
  const b1 = buildFits({ width: 1, height: 1, bitpix: 8, raw: [1] });
  b1.write(formatCard('BITPIX', '-32'), CARD_SIZE, 'ascii');
  assert.throws(() => parseFits(b1), (e) => e instanceof FitsError && e.code === 'FITS_UNSUPPORTED');
  const b2 = buildFits({ width: 1, height: 1, bitpix: 8, raw: [1] });
  b2.write(formatCard('NAXIS', '3'), 2 * CARD_SIZE, 'ascii');
  assert.throws(() => parseFits(b2), (e) => e instanceof FitsError && e.code === 'FITS_UNSUPPORTED');
});

test('拒绝截断的像素区与多余数据', () => {
  const good = buildFits({ width: 3, height: 1, bitpix: 16, raw: [1, 2, 3] });
  assert.throws(() => parseFits(good.subarray(0, BLOCK_SIZE)), (e) => e instanceof FitsError && e.code === 'FITS_TRUNCATED');
  const extra = Buffer.concat([good, Buffer.alloc(BLOCK_SIZE)]);
  assert.throws(() => parseFits(extra), (e) => e instanceof FitsError && e.code === 'FITS_EXTRA_DATA');
});

test('缩放溢出报 FITS_OVERFLOW 而非裁剪', () => {
  const buf = buildFits({ width: 1, height: 1, bitpix: 16, raw: [32767], extraCards: [formatCard('BSCALE', '1.0E308')] });
  assert.throws(() => parseFits(buf), (e) => e instanceof FitsError && e.code === 'FITS_OVERFLOW');
});

test('BLANK 必须可表示', () => {
  const buf = buildFits({ width: 1, height: 1, bitpix: 8, raw: [1], blank: 300 });
  assert.throws(() => parseFits(buf), (e) => e instanceof FitsError && e.code === 'FITS_BAD_VALUE');
});

test('未知头卡原样保留且不影响像素解释', () => {
  const buf = buildFits({ width: 1, height: 1, bitpix: 8, raw: [9], extraCards: [formatCard('FOO', '123'), formatCard('BARXYZ', undefined)] });
  const parsed = parseFits(buf);
  assert.equal(parsed.cards.find((c) => c.keyword === 'FOO')?.value, 123);
  assert.equal(parsed.rawRows[0][0], 9);
});

test('行不翻转：rows[y][x]，y 为轴二索引', () => {
  const buf = buildFits({ width: 2, height: 2, bitpix: 8, raw: [1, 2, 3, 4] });
  const parsed = parseFits(buf);
  assert.deepEqual(parsed.rawRows, [[1, 2], [3, 4]]);
});
