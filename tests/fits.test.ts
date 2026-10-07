import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFits, pixelAt, toMatrix, computeStats, FitsError, BLOCK_LEN,
} from "../src/fits";

// ---- 手写卡片工具（独立于 fixtures 写入器，用于交叉核对） ----
function card(s: string): string {
  assert.ok(s.length <= 80, `卡片超长: ${s}`);
  return s.padEnd(80, " ");
}
function val(kw: string, v: string): string {
  return card(`${kw.padEnd(8)}= ${v}`);
}
function makeFile(cards: string[], data: Buffer): Buffer {
  const text = cards.map(card).join("");
  const hLen = Math.ceil(text.length / BLOCK_LEN) * BLOCK_LEN;
  const header = Buffer.alloc(hLen, 0x20);
  header.write(text, 0, "ascii");
  const dLen = Math.ceil(data.length / BLOCK_LEN) * BLOCK_LEN;
  const d = Buffer.alloc(dLen, 0);
  data.copy(d);
  return Buffer.concat([header, d]);
}
function i16be(values: number[]): Buffer {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => { b[i * 2] = (v >> 8) & 0xff; b[i * 2 + 1] = v & 0xff; });
  return b;
}

test("3x1 BITPIX=16 手写卡：物理值 [6,null,16]，均值 11，偏移核对", () => {
  const buf = makeFile([
    val("SIMPLE", "T"), val("BITPIX", "16"), val("NAXIS", "2"),
    val("NAXIS1", "3"), val("NAXIS2", "1"),
    val("BSCALE", "2"), val("BZERO", "10"), val("BLANK", "0"),
    card("END"),
  ], i16be([-2, 0, 3]));
  const img = parseFits(buf);
  assert.equal(img.width, 3);
  assert.equal(img.height, 1);
  assert.equal(img.dataOffset, 2880);
  const m = toMatrix(img);
  assert.deepEqual(m.values, [[6, null, 16]]);
  assert.deepEqual(m.mask, [[false, true, false]]);
  const s = computeStats(img);
  assert.deepEqual({ valid: s.valid, min: s.min, max: s.max, mean: s.mean },
    { valid: 2, min: 6, max: 16, mean: 11 });
  const p0 = pixelAt(img, 0, 0);
  assert.equal(p0.offset, 2880);
  assert.equal(p0.raw, -2);
  assert.equal(p0.physical, 6);
  const p2 = pixelAt(img, 2, 0);
  assert.equal(p2.offset, 2884);
  assert.equal(p2.raw, 3);
  assert.equal(p2.physical, 16);
  const p1 = pixelAt(img, 1, 0);
  assert.equal(p1.isBlank, true);
  assert.equal(p1.physical, null);
});

test("BITPIX=16 大端：0x8000 是 -32768 而非 32768", () => {
  const buf = makeFile([
    val("SIMPLE", "T"), val("BITPIX", "16"), val("NAXIS", "2"),
    val("NAXIS1", "2"), val("NAXIS2", "1"), card("END"),
  ], Buffer.from([0x80, 0x00, 0x7f, 0xff]));
  const img = parseFits(buf);
  assert.equal(img.raw[0], -32768);
  assert.equal(img.raw[1], 32767);
});

test("END 在第二块时数据从下一块边界开始", () => {
  const cards = [
    val("SIMPLE", "T"), val("BITPIX", "16"), val("NAXIS", "2"),
    val("NAXIS1", "1"), val("NAXIS2", "1"),
  ];
  for (let i = 0; i < 40; i++) cards.push(card(`COMMENT filler ${i}`));
  cards.push(card("END"));
  const buf = makeFile(cards, i16be([42]));
  const img = parseFits(buf);
  assert.equal(img.dataOffset, 5760); // 两个头块
  assert.equal(pixelAt(img, 0, 0).offset, 5760);
  assert.equal(pixelAt(img, 0, 0).raw, 42);
});

test("字符串卡：斜杠不是注释，'' 是字面单引号", () => {
  const buf = makeFile([
    val("SIMPLE", "T"), val("BITPIX", "8"), val("NAXIS", "2"),
    val("NAXIS1", "1"), val("NAXIS2", "1"),
    val("OBJECT", "'M31/Spitzer''s field'  / target name"),
    card("END"),
  ], Buffer.from([7]));
  const img = parseFits(buf);
  const obj = img.cards.find((c) => c.keyword === "OBJECT")!;
  assert.equal(obj.value, "M31/Spitzer's field");
  assert.equal(obj.comment, "target name");
});

test("BITPIX=8 无符号与行序 rows[y][x] 不翻转", () => {
  const buf = makeFile([
    val("SIMPLE", "T"), val("BITPIX", "8"), val("NAXIS", "2"),
    val("NAXIS1", "2"), val("NAXIS2", "2"), card("END"),
  ], Buffer.from([1, 2, 3, 4]));
  const img = parseFits(buf);
  const m = toMatrix(img);
  assert.deepEqual(m.values, [[1, 2], [3, 4]]); // 第一行 = 轴二第一个索引
});

test("全缺测：valid=0，min/max/mean 为 null", () => {
  const buf = makeFile([
    val("SIMPLE", "T"), val("BITPIX", "16"), val("NAXIS", "2"),
    val("NAXIS1", "2"), val("NAXIS2", "2"), val("BLANK", "-32768"), card("END"),
  ], i16be([-32768, -32768, -32768, -32768]));
  const s = computeStats(parseFits(buf));
  assert.equal(s.valid, 0);
  assert.equal(s.blank, 4);
  assert.equal(s.min, null);
  assert.equal(s.max, null);
  assert.equal(s.mean, null);
});

test("D 指数与负 BSCALE", () => {
  const buf = makeFile([
    val("SIMPLE", "T"), val("BITPIX", "16"), val("NAXIS", "2"),
    val("NAXIS1", "2"), val("NAXIS2", "1"),
    val("BSCALE", "-2.5D+00"), val("BZERO", "1.0E+01"), card("END"),
  ], i16be([4, 8]));
  const m = toMatrix(parseFits(buf));
  assert.deepEqual(m.values, [[0, -10]]);
});

test("COMMENT/HISTORY 可重复且保序", () => {
  const buf = makeFile([
    val("SIMPLE", "T"), val("BITPIX", "8"), val("NAXIS", "2"),
    val("NAXIS1", "1"), val("NAXIS2", "1"),
    card("COMMENT first"), card("HISTORY h1"), card("COMMENT second"), card("END"),
  ], Buffer.from([0]));
  const img = parseFits(buf);
  const comments = img.cards.filter((c) => c.kind === "comment").map((c) => c.comment);
  assert.deepEqual(comments, ["first", "h1", "second"]);
});

test("重复结构关键字拒绝", () => {
  const buf = makeFile([
    val("SIMPLE", "T"), val("BITPIX", "16"), val("BITPIX", "16"),
    val("NAXIS", "2"), val("NAXIS1", "1"), val("NAXIS2", "1"), card("END"),
  ], i16be([1]));
  assert.throws(() => parseFits(buf), (e: FitsError) => e.code === "FITS_DUPLICATE_KEYWORD" && e.cardIndex === 2);
});

test("无 END 拒绝", () => {
  const cards = [val("SIMPLE", "T"), val("BITPIX", "16"), val("NAXIS", "2"),
    val("NAXIS1", "1"), val("NAXIS2", "1")];
  while (cards.length < 36) cards.push(card(`COMMENT ${cards.length}`));
  const buf = Buffer.from(cards.map(card).join(""), "ascii");
  assert.throws(() => parseFits(buf), (e: FitsError) => e.code === "FITS_BAD_HEADER");
});

test("坏宽高拒绝（NAXIS1=0）", () => {
  const buf = makeFile([
    val("SIMPLE", "T"), val("BITPIX", "16"), val("NAXIS", "2"),
    val("NAXIS1", "0"), val("NAXIS2", "1"), card("END"),
  ], Buffer.alloc(0));
  assert.throws(() => parseFits(buf), (e: FitsError) => e.code === "FITS_BAD_VALUE");
});

test("文件长度不是 2880 整数倍拒绝", () => {
  assert.throws(() => parseFits(Buffer.alloc(100)), (e: FitsError) => e.code === "FITS_TRUNCATED");
});

test("数据截断拒绝", () => {
  const header = makeFile([
    val("SIMPLE", "T"), val("BITPIX", "16"), val("NAXIS", "2"),
    val("NAXIS1", "2"), val("NAXIS2", "2"), card("END"),
  ], Buffer.alloc(0));
  const buf = Buffer.concat([header, i16be([1, 2])]); // 声明 8 字节，实际 4
  assert.throws(() => parseFits(buf), (e: FitsError) => e.code === "FITS_TRUNCATED");
});

test("多余完整数据报未支持", () => {
  const good = makeFile([
    val("SIMPLE", "T"), val("BITPIX", "16"), val("NAXIS", "2"),
    val("NAXIS1", "1"), val("NAXIS2", "1"), card("END"),
  ], i16be([1]));
  const buf = Buffer.concat([good, Buffer.alloc(BLOCK_LEN, 0)]);
  assert.throws(() => parseFits(buf), (e: FitsError) => e.code === "FITS_EXTRA_DATA");
});

test("缩放溢出报 FITS_OVERFLOW", () => {
  const buf = makeFile([
    val("SIMPLE", "T"), val("BITPIX", "16"), val("NAXIS", "2"),
    val("NAXIS1", "1"), val("NAXIS2", "1"),
    val("BSCALE", "1.0E+308"), val("BZERO", "1.0E+308"), card("END"),
  ], i16be([1000]));
  const img = parseFits(buf);
  assert.throws(() => computeStats(img), (e: FitsError) => e.code === "FITS_OVERFLOW");
  assert.throws(() => pixelAt(img, 0, 0), (e: FitsError) => e.code === "FITS_OVERFLOW");
});

test("不支持项：BITPIX=-32 / NAXIS=3 / SIMPLE=F", () => {
  const base = [val("SIMPLE", "T"), val("BITPIX", "-32"), val("NAXIS", "2"),
    val("NAXIS1", "1"), val("NAXIS2", "1"), card("END")];
  assert.throws(() => parseFits(makeFile(base, Buffer.alloc(4))),
    (e: FitsError) => e.code === "FITS_UNSUPPORTED");
  const n3 = [val("SIMPLE", "T"), val("BITPIX", "16"), val("NAXIS", "3"),
    val("NAXIS1", "1"), val("NAXIS2", "1"), val("NAXIS3", "1"), card("END")];
  assert.throws(() => parseFits(makeFile(n3, i16be([1]))),
    (e: FitsError) => e.code === "FITS_UNSUPPORTED");
  const f = [val("SIMPLE", "F"), val("BITPIX", "16"), val("NAXIS", "2"),
    val("NAXIS1", "1"), val("NAXIS2", "1"), card("END")];
  assert.throws(() => parseFits(makeFile(f, i16be([1]))),
    (e: FitsError) => e.code === "FITS_NOT_FITS");
});

test("BLANK 超出像素类型范围拒绝", () => {
  const buf = makeFile([
    val("SIMPLE", "T"), val("BITPIX", "8"), val("NAXIS", "2"),
    val("NAXIS1", "1"), val("NAXIS2", "1"), val("BLANK", "300"), card("END"),
  ], Buffer.from([0]));
  assert.throws(() => parseFits(buf), (e: FitsError) => e.code === "FITS_BAD_VALUE" && e.cardIndex === 5);
});

test("未知普通卡原样保留不影响解析", () => {
  const buf = makeFile([
    val("SIMPLE", "T"), val("BITPIX", "8"), val("NAXIS", "2"),
    val("NAXIS1", "1"), val("NAXIS2", "1"),
    card("INVENTED  some random text"),
    card("END"),
  ], Buffer.from([9]));
  const img = parseFits(buf);
  const c = img.cards.find((k) => k.keyword === "INVENTED")!;
  assert.equal(c.kind, "raw");
  assert.equal(pixelAt(img, 0, 0).raw, 9);
});

