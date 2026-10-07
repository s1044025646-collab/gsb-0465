import { BLOCK_SIZE, CARD_SIZE } from './parser.js';

export interface FixtureSpec {
  width: number;
  height: number;
  bitpix: 8 | 16;
  raw: number[];
  bscale?: number;
  bzero?: number;
  blank?: number;
  extraCards?: string[];
}

export function formatCard(keyword: string, value?: string, comment?: string): string {
  let body: string;
  if (value === undefined) {
    body = keyword.padEnd(8, ' ');
  } else {
    body = keyword.padEnd(8, ' ') + '= ' + value.padStart(20, ' ');
    if (comment) body += ' / ' + comment;
  }
  return body.padEnd(CARD_SIZE, ' ').slice(0, CARD_SIZE);
}

export function buildFits(spec: FixtureSpec): Buffer {
  const cards: string[] = [
    formatCard('SIMPLE', 'T', 'standard FITS'),
    formatCard('BITPIX', String(spec.bitpix)),
    formatCard('NAXIS', '2'),
    formatCard('NAXIS1', String(spec.width)),
    formatCard('NAXIS2', String(spec.height)),
  ];
  if (spec.bscale !== undefined) cards.push(formatCard('BSCALE', String(spec.bscale)));
  if (spec.bzero !== undefined) cards.push(formatCard('BZERO', String(spec.bzero)));
  if (spec.blank !== undefined) cards.push(formatCard('BLANK', String(spec.blank)));
  if (spec.extraCards) cards.push(...spec.extraCards);
  cards.push(formatCard('END'));

  const headerBytes = cards.length * CARD_SIZE;
  const headerBlocks = Math.ceil(headerBytes / BLOCK_SIZE);
  const header = Buffer.alloc(headerBlocks * BLOCK_SIZE, 0x20);
  for (let i = 0; i < cards.length; i++) {
    header.write(cards[i], i * CARD_SIZE, CARD_SIZE, 'ascii');
  }

  const bpp = spec.bitpix / 8;
  const dataBytes = spec.width * spec.height * bpp;
  const data = Buffer.alloc(Math.ceil(dataBytes / BLOCK_SIZE) * BLOCK_SIZE, 0);
  for (let i = 0; i < spec.raw.length; i++) {
    if (spec.bitpix === 8) data.writeUInt8(spec.raw[i], i);
    else data.writeInt16BE(spec.raw[i], i * 2);
  }
  return Buffer.concat([header, data]);
}
