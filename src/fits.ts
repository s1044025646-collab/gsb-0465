export const CARD_LEN = 80;
export const BLOCK_LEN = 2880;
export const CARDS_PER_BLOCK = 36;
export const PARSE_VERSION = "fits-mini/1.0.0";

export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_PIXELS = 64 * 1024 * 1024;

export type FitsErrorCode =
  | "FITS_NOT_FITS"
  | "FITS_UNSUPPORTED"
  | "FITS_BAD_HEADER"
  | "FITS_DUPLICATE_KEYWORD"
  | "FITS_BAD_VALUE"
  | "FITS_TRUNCATED"
  | "FITS_EXTRA_DATA"
  | "FITS_OVERFLOW"
  | "LIMIT_EXCEEDED";

export class FitsError extends Error {
  constructor(
    public code: FitsErrorCode,
    message: string,
    public cardIndex?: number
  ) {
    super(message);
    this.name = "FitsError";
  }
}

export type CardKind = "logical" | "integer" | "float" | "string" | "comment" | "end" | "blank" | "raw";

export interface HeaderCard {
  index: number; // 卡片号，从 0 开始
  raw: string; // 80 字符原文
  keyword: string; // 前 8 列去尾空格
  kind: CardKind;
  value: boolean | number | string | null;
  comment: string | null;
}

export interface FitsImage {
  cards: HeaderCard[];
  width: number;
  height: number;
  bitpix: 8 | 16;
  bscale: number;
  bzero: number;
  blank: number | null;
  headerBytes: number; // 头占用（含补齐）字节数
  dataOffset: number; // 像素区绝对起始偏移
  totalBytes: number; // 声明的完整文件大小
  raw: Int32Array; // 原始像素值，行优先 rows[y][x]
}

const STRUCTURAL_KEYS = new Set([
  "SIMPLE", "BITPIX", "NAXIS", "NAXIS1", "NAXIS2",
  "BSCALE", "BZERO", "BLANK", "END",
]);

const INT_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([EDed][+-]?\d+)?$/;

function parseValueField(field: string): { value: boolean | number | string | null; kind: CardKind; comment: string | null } {
  const s = field; // 第 11-80 列
  let i = 0;
  while (i < s.length && s[i] === " ") i++;
  if (i >= s.length) return { value: null, kind: "raw", comment: null };
  if (s[i] === "/") return { value: null, kind: "raw", comment: s.slice(i + 1).trimEnd() };
  if (s[i] === "'") {
    // 字符串：'' 表示一个字面单引号；串内 / 不是注释
    let out = "";
    let j = i + 1;
    for (;;) {
      if (j >= s.length) throw new FitsError("FITS_BAD_VALUE", "字符串缺少结束单引号");
      const c = s[j];
      if (c === "'") {
        if (s[j + 1] === "'") { out += "'"; j += 2; continue; }
        j++;
        break;
      }
      out += c;
      j++;
    }
    const rest = s.slice(j);
    const slash = rest.indexOf("/");
    const comment = slash >= 0 ? rest.slice(slash + 1).trim() : null;
    return { value: out, kind: "string", comment };
  }
  // 数值或逻辑：到 / 或空白为止
  let end = i;
  while (end < s.length && s[end] !== "/" && s[end] !== " ") end++;
  const token = s.slice(i, end);
  const rest = s.slice(end);
  const slash = rest.indexOf("/");
  const comment = slash >= 0 ? rest.slice(slash + 1).trim() : null;
  if (token === "T") return { value: true, kind: "logical", comment };
  if (token === "F") return { value: false, kind: "logical", comment };
  if (INT_RE.test(token)) {
    const n = Number(token);
    if (!Number.isSafeInteger(n)) throw new FitsError("FITS_BAD_VALUE", `整数超出安全范围: ${token}`);
    return { value: n, kind: "integer", comment };
  }
  if (FLOAT_RE.test(token)) {
    const n = Number(token.replace(/[Dd]/, "E"));
    if (!Number.isFinite(n)) throw new FitsError("FITS_BAD_VALUE", `浮点数不可解析或非有限: ${token}`);
    return { value: n, kind: "float", comment };
  }
  throw new FitsError("FITS_BAD_VALUE", `无法解析的值: ${token}`);
}

export function parseHeaderCard(raw: string, index: number): HeaderCard {
  const keyword = raw.slice(0, 8).trimEnd();
  try {
    if (keyword === "END" && raw.slice(8).trim() === "") {
      return { index, raw, keyword: "END", kind: "end", value: null, comment: null };
    }
    if (keyword === "COMMENT" || keyword === "HISTORY" || keyword === "") {
      return { index, raw, keyword, kind: "comment", value: null, comment: raw.slice(8).trimEnd() };
    }
    if (raw[8] === "=" && raw[9] === " ") {
      const { value, kind, comment } = parseValueField(raw.slice(10));
      return { index, raw, keyword, kind, value, comment };
    }
    // 无值标记的普通卡：原样保留
    return { index, raw, keyword, kind: "raw", value: null, comment: raw.slice(8).trim() || null };
  } catch (e) {
    if (e instanceof FitsError) { e.cardIndex = index; throw e; }
    throw e;
  }
}

function requireCard(cards: HeaderCard[], pos: number, keyword: string, kind: CardKind): HeaderCard {
  const c = cards[pos];
  if (!c || c.keyword !== keyword) {
    throw new FitsError("FITS_BAD_HEADER", `第 ${pos + 1} 张卡必须是 ${keyword}`, pos);
  }
  if (kind === "logical" && c.kind !== "logical") throw new FitsError("FITS_BAD_VALUE", `${keyword} 必须是逻辑值`, pos);
  if ((kind === "integer" || kind === "float") && c.kind !== "integer" && c.kind !== "float") {
    throw new FitsError("FITS_BAD_VALUE", `${keyword} 必须是数值`, pos);
  }
  return c;
}

export function parseFits(buf: Buffer): FitsImage {
  if (buf.length > MAX_FILE_BYTES) throw new FitsError("LIMIT_EXCEEDED", `文件超过 ${MAX_FILE_BYTES} 字节上限`);
  if (buf.length < BLOCK_LEN) throw new FitsError("FITS_TRUNCATED", "文件不足一个头块（2880 字节）");
  if (buf.length % BLOCK_LEN !== 0) throw new FitsError("FITS_TRUNCATED", `文件长度 ${buf.length} 不是 2880 的整数倍`);

  const cards: HeaderCard[] = [];
  let endIndex = -1;
  const totalCards = buf.length / CARD_LEN;
  for (let i = 0; i < totalCards; i++) {
    const raw = buf.toString("ascii", i * CARD_LEN, (i + 1) * CARD_LEN);
    const card = parseHeaderCard(raw, i);
    cards.push(card);
    if (card.kind === "end") { endIndex = i; break; }
  }
  if (endIndex < 0) throw new FitsError("FITS_BAD_HEADER", "未找到 END 卡");

  // 重复关键字检查：结构/缩放关键字不允许重复；COMMENT/HISTORY 可重复
  const seen = new Map<string, number>();
  for (const c of cards) {
    if (!STRUCTURAL_KEYS.has(c.keyword)) continue;
    const prev = seen.get(c.keyword);
    if (prev !== undefined) {
      throw new FitsError("FITS_DUPLICATE_KEYWORD", `关键字 ${c.keyword} 重复（首次在第 ${prev + 1} 张卡）`, c.index);
    }
    seen.set(c.keyword, c.index);
  }

  // 前五张卡顺序固定
  const simple = requireCard(cards, 0, "SIMPLE", "logical");
  if (simple.value !== true) throw new FitsError("FITS_NOT_FITS", "SIMPLE 必须为 T", 0);
  const bitpixCard = requireCard(cards, 1, "BITPIX", "integer");
  const bitpix = bitpixCard.value as number;
  if (bitpix !== 8 && bitpix !== 16) {
    throw new FitsError("FITS_UNSUPPORTED", `仅支持 BITPIX=8 或 16，得到 ${bitpix}`, 1);
  }
  const naxisCard = requireCard(cards, 2, "NAXIS", "integer");
  if (naxisCard.value !== 2) {
    throw new FitsError("FITS_UNSUPPORTED", `仅支持 NAXIS=2，得到 ${naxisCard.value}`, 2);
  }
  const n1 = requireCard(cards, 3, "NAXIS1", "integer").value as number;
  const n2 = requireCard(cards, 4, "NAXIS2", "integer").value as number;
  if (!Number.isSafeInteger(n1) || !Number.isSafeInteger(n2) || n1 <= 0 || n2 <= 0) {
    throw new FitsError("FITS_BAD_VALUE", `NAXIS1/NAXIS2 必须为正安全整数，得到 ${n1} x ${n2}`, 3);
  }
  const pixels = n1 * n2;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_PIXELS) {
    throw new FitsError("LIMIT_EXCEEDED", `像素总数 ${n1}x${n2} 超过上限 ${MAX_PIXELS}`);
  }

  // 可选缩放/缺测
  let bscale = 1, bzero = 0, blank: number | null = null;
  for (const c of cards) {
    if (c.kind === "end") break;
    if (c.keyword === "BSCALE" || c.keyword === "BZERO") {
      if (c.kind !== "integer" && c.kind !== "float") throw new FitsError("FITS_BAD_VALUE", `${c.keyword} 必须是数值`, c.index);
      const v = c.value as number;
      if (!Number.isFinite(v)) throw new FitsError("FITS_BAD_VALUE", `${c.keyword} 非有限`, c.index);
      if (c.keyword === "BSCALE") bscale = v; else bzero = v;
    } else if (c.keyword === "BLANK") {
      if (c.kind !== "integer") throw new FitsError("FITS_BAD_VALUE", "BLANK 必须是整数", c.index);
      const v = c.value as number;
      const ok = bitpix === 8 ? v >= 0 && v <= 255 : v >= -32768 && v <= 32767;
      if (!ok) throw new FitsError("FITS_BAD_VALUE", `BLANK=${v} 超出 BITPIX=${bitpix} 可表示范围`, c.index);
      blank = v;
    }
  }

  // 数据区从 END 所在头块的下一块边界开始
  const headerBytes = (Math.floor(endIndex / CARDS_PER_BLOCK) + 1) * BLOCK_LEN;
  const bpp = bitpix / 8;
  const dataBytes = pixels * bpp;
  const dataPadded = Math.ceil(dataBytes / BLOCK_LEN) * BLOCK_LEN;
  const totalBytes = headerBytes + dataPadded;
  if (buf.length < totalBytes) {
    throw new FitsError("FITS_TRUNCATED", `声明大小 ${totalBytes} 字节，实际仅 ${buf.length} 字节`);
  }
  if (buf.length > totalBytes) {
    throw new FitsError("FITS_EXTRA_DATA", `主 HDU 声明 ${totalBytes} 字节，但文件有 ${buf.length} 字节；扩展 HDU 或多余数据不支持`);
  }

  const raw = new Int32Array(pixels);
  for (let p = 0; p < pixels; p++) {
    const off = headerBytes + p * bpp;
    raw[p] = bitpix === 8 ? buf.readUInt8(off) : buf.readInt16BE(off);
  }

  return {
    cards: cards.slice(0, endIndex + 1),
    width: n1, height: n2, bitpix: bitpix as 8 | 16,
    bscale, bzero, blank,
    headerBytes, dataOffset: headerBytes, totalBytes, raw,
  };
}

export interface PixelInfo {
  x: number; y: number;
  offset: number; // 文件内绝对字节偏移
  raw: number;
  bscale: number; bzero: number;
  blank: number | null;
  isBlank: boolean;
  physical: number | null;
}

export function pixelAt(img: FitsImage, x: number, y: number): PixelInfo {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= img.width || y >= img.height) {
    throw new FitsError("FITS_BAD_VALUE", `像素坐标越界: (${x}, ${y})，图像 ${img.width}x${img.height}`);
  }
  const idx = y * img.width + x;
  const rawVal = img.raw[idx];
  const isBlank = img.blank !== null && rawVal === img.blank;
  let physical: number | null = null;
  if (!isBlank) {
    physical = rawVal * img.bscale + img.bzero;
    if (!Number.isFinite(physical)) {
      throw new FitsError("FITS_OVERFLOW", `像素 (${x}, ${y}) 物理值非有限: ${rawVal}*${img.bscale}+${img.bzero}`);
    }
  }
  return {
    x, y,
    offset: img.dataOffset + idx * (img.bitpix / 8),
    raw: rawVal, bscale: img.bscale, bzero: img.bzero, blank: img.blank,
    isBlank, physical,
  };
}

export interface Matrix {
  width: number; height: number;
  values: (number | null)[][]; // rows[y][x]，y=0 为轴二第一个索引
  mask: boolean[][]; // true = 缺测
}

export function toMatrix(img: FitsImage): Matrix {
  const values: (number | null)[][] = [];
  const mask: boolean[][] = [];
  for (let y = 0; y < img.height; y++) {
    const vrow: (number | null)[] = [];
    const mrow: boolean[] = [];
    for (let x = 0; x < img.width; x++) {
      const p = pixelAt(img, x, y);
      vrow.push(p.physical);
      mrow.push(p.isBlank);
    }
    values.push(vrow);
    mask.push(mrow);
  }
  return { width: img.width, height: img.height, values, mask };
}

export interface Stats {
  total: number;
  valid: number;
  blank: number;
  min: number | null;
  max: number | null;
  mean: number | null;
}

export function computeStats(img: FitsImage): Stats {
  let valid = 0, blankCount = 0;
  let min = Infinity, max = -Infinity, sum = 0;
  for (let i = 0; i < img.raw.length; i++) {
    const r = img.raw[i];
    if (img.blank !== null && r === img.blank) { blankCount++; continue; }
    const v = r * img.bscale + img.bzero;
    if (!Number.isFinite(v)) {
      throw new FitsError("FITS_OVERFLOW", `物理值非有限: raw=${r}, BSCALE=${img.bscale}, BZERO=${img.bzero}`);
    }
    valid++;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return {
    total: img.raw.length,
    valid,
    blank: blankCount,
    min: valid > 0 ? min : null,
    max: valid > 0 ? max : null,
    mean: valid > 0 ? sum / valid : null,
  };
}

