import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  FitsImage, HeaderCard, Stats, PARSE_VERSION,
  parseFits, computeStats,
} from "./fits";

export interface ImageRecord {
  id: string;
  name: string;
  size: number;
  width: number;
  height: number;
  bitpix: number;
  bscale: number;
  bzero: number;
  blank: number | null;
  storedPath: string;
  parseVersion: string;
  stats: Stats;
  createdAt: string;
}

export class ImageStore {
  private db: DatabaseSync;
  readonly filesDir: string;

  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.filesDir = path.join(dataDir, "files");
    fs.mkdirSync(this.filesDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "fits.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        bitpix INTEGER NOT NULL,
        bscale REAL NOT NULL,
        bzero REAL NOT NULL,
        blank INTEGER,
        stored_path TEXT NOT NULL,
        parse_version TEXT NOT NULL,
        stats_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cards (
        image_id TEXT NOT NULL REFERENCES images(id),
        card_index INTEGER NOT NULL,
        raw TEXT NOT NULL,
        keyword TEXT NOT NULL,
        kind TEXT NOT NULL,
        value_json TEXT,
        comment TEXT,
        PRIMARY KEY (image_id, card_index)
      );
    `);
  }

  close(): void { this.db.close(); }

  /** 幂等导入：按内容哈希去重。解析失败抛错且不写入任何记录。 */
  import(filePath: string): { record: ImageRecord; already: boolean; image: FitsImage } {
    const buf = fs.readFileSync(filePath);
    const id = createHash("sha256").update(buf).digest("hex").slice(0, 32);
    const existing = this.get(id);
    if (existing) {
      return { record: existing, already: true, image: parseFits(fs.readFileSync(existing.storedPath)) };
    }
    // 先完整解析并计算统计（含溢出检查），失败则什么都不登记
    const image = parseFits(buf);
    const stats = computeStats(image);
    const storedPath = path.join(this.filesDir, `${id}.fits`);
    fs.writeFileSync(storedPath, buf); // 固定副本
    const record: ImageRecord = {
      id,
      name: path.basename(filePath),
      size: buf.length,
      width: image.width, height: image.height, bitpix: image.bitpix,
      bscale: image.bscale, bzero: image.bzero, blank: image.blank,
      storedPath, parseVersion: PARSE_VERSION, stats,
      createdAt: new Date().toISOString(),
    };
    this.db.prepare(
      `INSERT INTO images (id,name,size,width,height,bitpix,bscale,bzero,blank,stored_path,parse_version,stats_json,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, record.name, record.size, record.width, record.height, record.bitpix,
      record.bscale, record.bzero, record.blank, storedPath, PARSE_VERSION,
      JSON.stringify(stats), record.createdAt);
    const ins = this.db.prepare(
      `INSERT INTO cards (image_id,card_index,raw,keyword,kind,value_json,comment) VALUES (?,?,?,?,?,?,?)`
    );
    for (const c of image.cards) {
      ins.run(id, c.index, c.raw, c.keyword, c.kind,
        c.value === null ? null : JSON.stringify(c.value), c.comment);
    }
    return { record, already: false, image };
  }

  get(id: string): ImageRecord | null {
    const r = this.db.prepare(`SELECT * FROM images WHERE id = ?`).get(id) as any;
    return r ? this.rowToRecord(r) : null;
  }

  list(): ImageRecord[] {
    const rows = this.db.prepare(`SELECT * FROM images ORDER BY created_at, id`).all() as any[];
    return rows.map((r) => this.rowToRecord(r));
  }

  cards(id: string): HeaderCard[] {
    const rows = this.db.prepare(
      `SELECT card_index, raw, keyword, kind, value_json, comment FROM cards WHERE image_id = ? ORDER BY card_index`
    ).all(id) as any[];
    return rows.map((r) => ({
      index: r.card_index, raw: r.raw, keyword: r.keyword, kind: r.kind,
      value: r.value_json === null ? null : JSON.parse(r.value_json),
      comment: r.comment,
    }));
  }

  /** 从固定副本重新解析（确定性），保证重启后结果一致。 */
  loadImage(id: string): FitsImage | null {
    const rec = this.get(id);
    if (!rec) return null;
    return parseFits(fs.readFileSync(rec.storedPath));
  }

  private rowToRecord(r: any): ImageRecord {
    return {
      id: r.id, name: r.name, size: r.size, width: r.width, height: r.height,
      bitpix: r.bitpix, bscale: r.bscale, bzero: r.bzero,
      blank: r.blank === null ? null : r.blank,
      storedPath: r.stored_path, parseVersion: r.parse_version,
      stats: JSON.parse(r.stats_json), createdAt: r.created_at,
    };
  }
}
