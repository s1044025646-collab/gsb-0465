import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseFits, pixelAt, PARSER_VERSION, type ParsedFits } from './fits/parser.js';
import { FitsError } from './errors.js';

export interface ImageRow {
  id: number;
  name: string;
  sha256: string;
  file_size: number;
  stored_path: string;
  width: number;
  height: number;
  bitpix: number;
  bscale: number;
  bzero: number;
  blank: number | null;
  parser_version: string;
  imported_at: string;
  stats: string;
  cards: string;
}

export class ImageStore {
  private db: DatabaseSync;
  readonly filesDir: string;

  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.filesDir = path.join(dataDir, 'files');
    fs.mkdirSync(this.filesDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'fits.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        sha256 TEXT NOT NULL UNIQUE,
        file_size INTEGER NOT NULL,
        stored_path TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        bitpix INTEGER NOT NULL,
        bscale REAL NOT NULL,
        bzero REAL NOT NULL,
        blank INTEGER,
        parser_version TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        stats TEXT NOT NULL,
        cards TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  importFile(filePath: string): { id: number; duplicate: boolean; name: string; sha256: string } {
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) {
      throw new FitsError('NOT_FOUND', `文件不存在：${abs}`);
    }
    const buf = fs.readFileSync(abs);
    const parsed = parseFits(buf);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const existing = this.db.prepare('SELECT id, name, sha256 FROM images WHERE sha256 = ?').get(sha256) as
      | { id: number; name: string; sha256: string }
      | undefined;
    if (existing) {
      return { id: existing.id, duplicate: true, name: existing.name, sha256 };
    }
    const storedPath = path.join(this.filesDir, `${sha256}.fits`);
    if (!fs.existsSync(storedPath)) {
      fs.writeFileSync(storedPath, buf);
    }
    const stmt = this.db.prepare(`
      INSERT INTO images (name, sha256, file_size, stored_path, width, height, bitpix, bscale, bzero, blank,
        parser_version, imported_at, stats, cards)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      path.basename(abs),
      sha256,
      buf.length,
      storedPath,
      parsed.width,
      parsed.height,
      parsed.bitpix,
      parsed.bscale,
      parsed.bzero,
      parsed.blank,
      PARSER_VERSION,
      new Date().toISOString(),
      JSON.stringify(parsed.stats),
      JSON.stringify(parsed.cards),
    );
    return { id: Number(result.lastInsertRowid), duplicate: false, name: path.basename(abs), sha256 };
  }

  list(): Array<Pick<ImageRow, 'id' | 'name' | 'sha256' | 'width' | 'height' | 'bitpix' | 'parser_version' | 'imported_at'>> {
    return this.db
      .prepare('SELECT id, name, sha256, width, height, bitpix, parser_version, imported_at FROM images ORDER BY id')
      .all() as never;
  }

  get(id: number): ImageRow {
    const row = this.db.prepare('SELECT * FROM images WHERE id = ?').get(id) as ImageRow | undefined;
    if (!row) throw new FitsError('NOT_FOUND', `图像 id=${id} 不存在`);
    return row;
  }

  cards(id: number) {
    const row = this.get(id);
    return { id: row.id, name: row.name, parserVersion: row.parser_version, cards: JSON.parse(row.cards) };
  }

  stats(id: number) {
    const row = this.get(id);
    return {
      id: row.id,
      name: row.name,
      width: row.width,
      height: row.height,
      bitpix: row.bitpix,
      bscale: row.bscale,
      bzero: row.bzero,
      blank: row.blank,
      stats: JSON.parse(row.stats),
    };
  }

  private reparse(id: number): ParsedFits {
    const row = this.get(id);
    const buf = fs.readFileSync(row.stored_path);
    const digest = createHash('sha256').update(buf).digest('hex');
    if (digest !== row.sha256) {
      throw new FitsError('INTERNAL', `固定副本摘要校验失败：${row.stored_path}`);
    }
    return parseFits(buf);
  }

  matrix(id: number) {
    const row = this.get(id);
    const parsed = this.reparse(id);
    return {
      id: row.id,
      width: parsed.width,
      height: parsed.height,
      raw: parsed.rawRows,
      physical: parsed.physicalRows,
      mask: parsed.maskRows,
    };
  }

  pixel(id: number, x: number, y: number) {
    const parsed = this.reparse(id);
    return { id, ...pixelAt(parsed, x, y) };
  }
}
