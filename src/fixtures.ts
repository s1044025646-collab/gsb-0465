import * as fs from "node:fs";
import * as path from "node:path";
import { CARD_LEN, BLOCK_LEN } from "./fits";

export function padCard(s: string): string {
  if (s.length > CARD_LEN) throw new Error(`卡片超过 80 字符: ${s}`);
  return s.padEnd(CARD_LEN, " ");
}

export function valueCard(keyword: string, value: string, comment?: string): string {
  const kw = keyword.padEnd(8, " ");
  let v = value;
  if (comment) v = v.padEnd(20, " ") + " / " + comment;
  return padCard(`${kw}= ${v}`);
}

export function buildFits(cards: string[], data: Buffer): Buffer {
  const headerText = cards.map(padCard).join("");
  const headerPadded = Math.ceil(headerText.length / BLOCK_LEN) * BLOCK_LEN;
  const header = Buffer.alloc(headerPadded, 0x20);
  header.write(headerText, 0, "ascii");
  const dataPadded = Math.ceil(data.length / BLOCK_LEN) * BLOCK_LEN;
  const dataBuf = Buffer.alloc(dataPadded, 0);
  data.copy(dataBuf);
  return Buffer.concat([header, dataBuf]);
}

export function int16Data(values: number[]): Buffer {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => b.writeInt16BE(v, i * 2));
  return b;
}

export function uint8Data(values: number[]): Buffer {
  return Buffer.from(values);
}

const END = padCard("END");

/** 生成全部合成夹具，返回文件路径列表。 */
export function buildFixtures(dir: string): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const out: Record<string, Buffer> = {};

  // 1) 3x1 BITPIX=16: raw [-2,0,3], BSCALE=2, BZERO=10, BLANK=0 -> [6,null,16], 均值 11
  out["demo16.fits"] = buildFits([
    valueCard("SIMPLE", "T", "conforms to FITS standard"),
    valueCard("BITPIX", "16"),
    valueCard("NAXIS", "2"),
    valueCard("NAXIS1", "3"),
    valueCard("NAXIS2", "1"),
    valueCard("BSCALE", "2"),
    valueCard("BZERO", "10"),
    valueCard("BLANK", "0"),
    END,
  ], int16Data([-2, 0, 3]));

  // 2) 头部跨两个块（大量 COMMENT 撑过 36 卡），字符串含斜杠与转义单引号
  const twoBlockCards: string[] = [
    valueCard("SIMPLE", "T"),
    valueCard("BITPIX", "16"),
    valueCard("NAXIS", "2"),
    valueCard("NAXIS1", "2"),
    valueCard("NAXIS2", "2"),
    valueCard("OBJECT", "'M31/Spitzer''s field'", "slash and quote"),
    valueCard("BSCALE", "1"),
    valueCard("BZERO", "0"),
  ];
  for (let i = 0; i < 40; i++) twoBlockCards.push(padCard(`COMMENT filler card number ${i}`));
  twoBlockCards.push(padCard("HISTORY created by fixture builder"));
  twoBlockCards.push(END);
  out["twoblock.fits"] = buildFits(twoBlockCards, int16Data([1, 2, 3, 4]));

  // 3) BITPIX=8 4x2
  out["img8.fits"] = buildFits([
    valueCard("SIMPLE", "T"),
    valueCard("BITPIX", "8"),
    valueCard("NAXIS", "2"),
    valueCard("NAXIS1", "4"),
    valueCard("NAXIS2", "2"),
    valueCard("BSCALE", "0.5"),
    valueCard("BZERO", "1"),
    valueCard("BLANK", "255"),
    END,
  ], uint8Data([0, 1, 2, 255, 10, 20, 30, 40]));

  // 4) 全缺测 2x2 BITPIX=16
  out["allblank.fits"] = buildFits([
    valueCard("SIMPLE", "T"),
    valueCard("BITPIX", "16"),
    valueCard("NAXIS", "2"),
    valueCard("NAXIS1", "2"),
    valueCard("NAXIS2", "2"),
    valueCard("BLANK", "-32768"),
    END,
  ], int16Data([-32768, -32768, -32768, -32768]));

  // 5) 科学计数法（D 指数）缩放
  out["dexp.fits"] = buildFits([
    valueCard("SIMPLE", "T"),
    valueCard("BITPIX", "16"),
    valueCard("NAXIS", "2"),
    valueCard("NAXIS1", "2"),
    valueCard("NAXIS2", "1"),
    valueCard("BSCALE", "2.5D+00"),
    valueCard("BZERO", "-1.0E+01"),
    END,
  ], int16Data([4, 8]));

  // ---- 坏文件 ----
  // 6) NAXIS=3 不支持
  out["bad-naxis3.fits"] = buildFits([
    valueCard("SIMPLE", "T"), valueCard("BITPIX", "16"), valueCard("NAXIS", "3"),
    valueCard("NAXIS1", "2"), valueCard("NAXIS2", "2"), valueCard("NAXIS3", "2"), END,
  ], int16Data(new Array(8).fill(0)));

  // 7) 重复 BITPIX
  out["bad-dup.fits"] = buildFits([
    valueCard("SIMPLE", "T"), valueCard("BITPIX", "16"), valueCard("BITPIX", "16"),
    valueCard("NAXIS", "2"), valueCard("NAXIS1", "2"), valueCard("NAXIS2", "1"), END,
  ], int16Data([1, 2]));

  // 8) 无 END（整个文件都是头卡）
  {
    const cards = [
      valueCard("SIMPLE", "T"), valueCard("BITPIX", "16"), valueCard("NAXIS", "2"),
      valueCard("NAXIS1", "2"), valueCard("NAXIS2", "1"),
    ];
    while (cards.length < 36) cards.push(padCard(`COMMENT ${cards.length}`));
    out["bad-noend.fits"] = Buffer.from(cards.map(padCard).join(""), "ascii");
  }

  // 9) 数据截断：声明 2x2 int16（8 字节）但数据区只有 4 字节且不足整块
  {
    const header = buildFits([
      valueCard("SIMPLE", "T"), valueCard("BITPIX", "16"), valueCard("NAXIS", "2"),
      valueCard("NAXIS1", "2"), valueCard("NAXIS2", "2"), END,
    ], Buffer.alloc(0));
    out["bad-truncated.fits"] = Buffer.concat([header, int16Data([1, 2])]);
  }

  // 10) 缩放溢出：BSCALE=1E300, BZERO=1E300
  out["bad-overflow.fits"] = buildFits([
    valueCard("SIMPLE", "T"), valueCard("BITPIX", "16"), valueCard("NAXIS", "2"),
    valueCard("NAXIS1", "2"), valueCard("NAXIS2", "1"),
    valueCard("BSCALE", "1.0E+308"), valueCard("BZERO", "1.0E+308"), END,
  ], int16Data([1000, 2000]));

  // 11) 多余数据：主 HDU 后追加一个完整块
  {
    const good = buildFits([
      valueCard("SIMPLE", "T"), valueCard("BITPIX", "16"), valueCard("NAXIS", "2"),
      valueCard("NAXIS1", "2"), valueCard("NAXIS2", "1"), END,
    ], int16Data([1, 2]));
    out["bad-extra.fits"] = Buffer.concat([good, Buffer.alloc(BLOCK_LEN, 0)]);
  }

  // 12) 坏宽高：NAXIS1 = 0
  out["bad-dims.fits"] = buildFits([
    valueCard("SIMPLE", "T"), valueCard("BITPIX", "16"), valueCard("NAXIS", "2"),
    valueCard("NAXIS1", "0"), valueCard("NAXIS2", "1"), END,
  ], Buffer.alloc(0));

  // 13) 错误块长度：文件不是 2880 的整数倍
  out["bad-blocklen.fits"] = Buffer.alloc(100, 0x20);

  const written: string[] = [];
  for (const [name, buf] of Object.entries(out)) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, buf);
    written.push(p);
  }
  return written;
}

