import { FitsError } from '../errors.js';

export const CARD_SIZE = 80;
export const BLOCK_SIZE = 2880;
export const PARSER_VERSION = 'fits-mini/1.0.0';

export interface Limits {
  maxFileBytes: number;
  maxPixels: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxFileBytes: 256 * 1024 * 1024,
  maxPixels: 64 * 1024 * 1024,
};

export type CardValueType = 'string' | 'integer' | 'float' | 'logical' | 'none';

export interface Card {
  index: number;
  keyword: string;
  raw: string;
  value: string | number | boolean | null;
  valueType: CardValueType;
  comment: string | null;
}

export interface ParsedFits {
  cards: Card[];
  headerBlocks: number;
  dataStart: number;
  width: number;
  height: number;
  bitpix: 8 | 16;
  bscale: number;
  bzero: number;
  blank: number | null;
  rawRows: number[][];
  physicalRows: (number | null)[][];
  maskRows: boolean[][];
  stats: { validCount: number; blankCount: number; min: number | null; max: number | null; mean: number | null };
}

const STRUCTURAL_KEYS = new Set(['SIMPLE', 'BITPIX', 'NAXIS', 'NAXIS1', 'NAXIS2', 'BSCALE', 'BZERO', 'BLANK']);
const REPEATABLE_KEYS = new Set(['COMMENT', 'HISTORY']);

const INT_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eEdD][+-]?\d+)?$/;

function parseValueField(field: string): { value: Card['value']; valueType: CardValueType; comment: string | null } {
  const trimmedStart = field.replace(/^ +/, '');
  if (trimmedStart.startsWith("'")) {
    let out = '';
    let i = 1;
    let closed = false;
    while (i < trimmedStart.length) {
      const ch = trimmedStart[i];
      if (ch === "'") {
        if (trimmedStart[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        closed = true;
        i += 1;
        break;
      }
      out += ch;
      i += 1;
    }
    if (!closed) {
      return { value: null, valueType: 'none', comment: null };
    }
    const rest = trimmedStart.slice(i).trimStart();
    const comment = rest.startsWith('/') ? rest.slice(1).trim() : null;
    return { value: out, valueType: 'string', comment };
  }
  const slash = trimmedStart.indexOf('/');
  const token = (slash === -1 ? trimmedStart : trimmedStart.slice(0, slash)).trim();
  const comment = slash === -1 ? null : trimmedStart.slice(slash + 1).trim();
  if (token === 'T') return { value: true, valueType: 'logical', comment };
  if (token === 'F') return { value: false, valueType: 'logical', comment };
  if (INT_RE.test(token)) return { value: Number(token), valueType: 'integer', comment };
  if (FLOAT_RE.test(token)) {
    const num = Number(token.replace(/[dD]/, 'e'));
    if (Number.isFinite(num)) return { value: num, valueType: 'float', comment };
  }
  if (token === '') return { value: null, valueType: 'none', comment };
  return { value: null, valueType: 'none', comment };
}

export function parseCard(buf: Buffer, index: number): Card {
  const raw = buf.toString('ascii', index * CARD_SIZE, (index + 1) * CARD_SIZE);
  const keyword = raw.slice(0, 8).trim();
  if (keyword === 'END' || keyword === 'COMMENT' || keyword === 'HISTORY' || raw.slice(8, 10) !== '= ') {
    const comment = keyword === 'COMMENT' || keyword === 'HISTORY' ? raw.slice(8).trim() : null;
    return { index, keyword, raw, value: null, valueType: 'none', comment };
  }
  const { value, valueType, comment } = parseValueField(raw.slice(10));
  return { index, keyword, raw, value, valueType, comment };
}

function requiredNumber(cards: Card[], keyword: string, index: number): number {
  const card = cards[index];
  if (card.keyword !== keyword) {
    throw new FitsError('FITS_BAD_HEADER', `第 ${index} 张卡应为 ${keyword}，实际为 ${card.keyword || '(空)'}`, index);
  }
  if (typeof card.value !== 'number' || !Number.isFinite(card.value)) {
    throw new FitsError('FITS_BAD_VALUE', `${keyword} 缺失或不是有限数值`, index);
  }
  return card.value;
}

export function parseFits(buf: Buffer, limits: Limits = DEFAULT_LIMITS): ParsedFits {
  if (buf.length > limits.maxFileBytes) {
    throw new FitsError('LIMIT_EXCEEDED', `文件大小 ${buf.length} 超过限制 ${limits.maxFileBytes}`);
  }
  if (buf.length < BLOCK_SIZE) {
    throw new FitsError('FITS_TRUNCATED', `文件不足一个头块（${BLOCK_SIZE} 字节）`);
  }
  if (buf.length % BLOCK_SIZE !== 0) {
    throw new FitsError('FITS_TRUNCATED', `文件长度 ${buf.length} 不是 ${BLOCK_SIZE} 的整数倍`);
  }

  const cards: Card[] = [];
  const seen = new Set<string>();
  let endIndex = -1;
  const totalCards = buf.length / CARD_SIZE;
  for (let i = 0; i < totalCards; i++) {
    const card = parseCard(buf, i);
    cards.push(card);
    if (card.keyword === 'END') {
      endIndex = i;
      break;
    }
    if (REPEATABLE_KEYS.has(card.keyword) || card.keyword === '') continue;
    if (seen.has(card.keyword)) {
      if (STRUCTURAL_KEYS.has(card.keyword)) {
        throw new FitsError('FITS_DUPLICATE_KEYWORD', `结构/缩放关键字 ${card.keyword} 重复`, i);
      }
    } else {
      seen.add(card.keyword);
    }
  }
  if (endIndex === -1) {
    throw new FitsError('FITS_NO_END', '头中未找到 END 卡');
  }

  if (cards.length < 5) {
    throw new FitsError('FITS_BAD_HEADER', '头卡数量不足 5 张');
  }
  const simple = cards[0];
  if (simple.keyword !== 'SIMPLE' || simple.value !== true) {
    throw new FitsError('FITS_UNSUPPORTED', '仅支持 SIMPLE = T 的标准 FITS 文件', 0);
  }
  const bitpix = requiredNumber(cards, 'BITPIX', 1);
  if (bitpix !== 8 && bitpix !== 16) {
    throw new FitsError('FITS_UNSUPPORTED', `仅支持 BITPIX 8 或 16，实际为 ${bitpix}`, 1);
  }
  const naxis = requiredNumber(cards, 'NAXIS', 2);
  if (naxis !== 2) {
    throw new FitsError('FITS_UNSUPPORTED', `仅支持 NAXIS = 2 的二维主图像，实际为 ${naxis}`, 2);
  }
  const width = requiredNumber(cards, 'NAXIS1', 3);
  const height = requiredNumber(cards, 'NAXIS2', 4);
  for (const [name, v, idx] of [['NAXIS1', width, 3], ['NAXIS2', height, 4]] as const) {
    if (!Number.isSafeInteger(v) || v <= 0) {
      throw new FitsError('FITS_BAD_VALUE', `${name} 必须为正安全整数，实际为 ${v}`, idx);
    }
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > limits.maxPixels) {
    throw new FitsError('LIMIT_EXCEEDED', `像素总数 ${width}x${height} 超过限制 ${limits.maxPixels}`);
  }

  const findKey = (key: string): Card | undefined => cards.find((c) => c.keyword === key);
  const numberOrDefault = (key: string, def: number): number => {
    const card = findKey(key);
    if (!card) return def;
    if (typeof card.value !== 'number' || !Number.isFinite(card.value)) {
      throw new FitsError('FITS_BAD_VALUE', `${key} 不是有限数值`, card.index);
    }
    return card.value;
  };
  const bscale = numberOrDefault('BSCALE', 1);
  const bzero = numberOrDefault('BZERO', 0);

  let blank: number | null = null;
  const blankCard = findKey('BLANK');
  if (blankCard) {
    const v = blankCard.value;
    const [lo, hi] = bitpix === 8 ? [0, 255] : [-32768, 32767];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
      throw new FitsError('FITS_BAD_VALUE', `BLANK 必须是 BITPIX=${bitpix} 可表示的整数，实际为 ${String(v)}`, blankCard.index);
    }
    blank = v;
  }

  const bytesPerPixel = bitpix / 8;
  const dataBytes = pixels * bytesPerPixel;
  const headerBlocks = Math.floor((endIndex + 1) * CARD_SIZE / BLOCK_SIZE) + 1;
  const dataStart = headerBlocks * BLOCK_SIZE;
  const dataPadded = Math.ceil(dataBytes / BLOCK_SIZE) * BLOCK_SIZE;
  const expectedTotal = dataStart + dataPadded;
  if (buf.length < expectedTotal) {
    throw new FitsError('FITS_TRUNCATED', `文件截断：期望至少 ${expectedTotal} 字节，实际 ${buf.length}`);
  }
  if (buf.length > expectedTotal) {
    throw new FitsError('FITS_EXTRA_DATA', `主 HDU 之后存在 ${buf.length - expectedTotal} 字节额外数据（扩展 HDU 不受支持）`);
  }

  const rawRows: number[][] = [];
  const physicalRows: (number | null)[][] = [];
  const maskRows: boolean[][] = [];
  let validCount = 0;
  let blankCount = 0;
  let min: number | null = null;
  let max: number | null = null;
  let sum = 0;

  for (let y = 0; y < height; y++) {
    const rawRow: number[] = [];
    const physRow: (number | null)[] = [];
    const maskRow: boolean[] = [];
    for (let x = 0; x < width; x++) {
      const offset = dataStart + (y * width + x) * bytesPerPixel;
      const raw = bitpix === 8 ? buf.readUInt8(offset) : buf.readInt16BE(offset);
      rawRow.push(raw);
      const masked = blank !== null && raw === blank;
      maskRow.push(masked);
      if (masked) {
        blankCount += 1;
        physRow.push(null);
      } else {
        const physical = raw * bscale + bzero;
        if (!Number.isFinite(physical)) {
          throw new FitsError('FITS_OVERFLOW', `像素 (x=${x}, y=${y}) 物理值非有限：${raw}*${bscale}+${bzero}`);
        }
        physRow.push(physical);
        validCount += 1;
        sum += physical;
        min = min === null || physical < min ? physical : min;
        max = max === null || physical > max ? physical : max;
      }
    }
    rawRows.push(rawRow);
    physicalRows.push(physRow);
    maskRows.push(maskRow);
  }

  return {
    cards,
    headerBlocks,
    dataStart,
    width,
    height,
    bitpix,
    bscale,
    bzero,
    blank,
    rawRows,
    physicalRows,
    maskRows,
    stats: {
      validCount,
      blankCount,
      min,
      max,
      mean: validCount > 0 ? sum / validCount : null,
    },
  };
}

export function pixelAt(parsed: ParsedFits, x: number, y: number) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= parsed.width || y >= parsed.height) {
    throw new FitsError('VALIDATION', `像素坐标越界：x=${x}, y=${y}（宽 ${parsed.width}，高 ${parsed.height}）`);
  }
  const bytesPerPixel = parsed.bitpix / 8;
  const offset = parsed.dataStart + (y * parsed.width + x) * bytesPerPixel;
  const raw = parsed.rawRows[y][x];
  const masked = parsed.maskRows[y][x];
  return {
    x,
    y,
    offset,
    raw,
    bscale: parsed.bscale,
    bzero: parsed.bzero,
    blank: parsed.blank,
    masked,
    physical: parsed.physicalRows[y][x],
  };
}
