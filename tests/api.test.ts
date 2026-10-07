import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ImageStore } from "../src/store";
import { buildFixtures } from "../src/fixtures";
import { startServer } from "../src/server";

let dir: string;
let fixtures: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fits-test-"));
  fixtures = path.join(dir, "fixtures");
  buildFixtures(fixtures);
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("导入幂等且重启后结果一致；失败不登记", () => {
  const dbDir = path.join(dir, "db1");
  const store = new ImageStore(dbDir);
  const f = path.join(fixtures, "demo16.fits");
  const r1 = store.import(f);
  assert.equal(r1.already, false);
  const r2 = store.import(f);
  assert.equal(r2.already, true);
  assert.equal(r2.record.id, r1.record.id);
  assert.equal(store.list().length, 1);
  assert.equal(r1.record.stats.mean, 11);
  const statsBefore = JSON.stringify(r1.record.stats);
  const cardsBefore = JSON.stringify(store.cards(r1.record.id));
  store.close();

  // 模拟重启
  const store2 = new ImageStore(dbDir);
  const rec = store2.get(r1.record.id)!;
  assert.equal(JSON.stringify(rec.stats), statsBefore);
  assert.equal(JSON.stringify(store2.cards(rec.id)), cardsBefore);
  const img = store2.loadImage(rec.id)!;
  assert.equal(img.raw[0], -2);
  store2.close();

  // 失败导入不登记
  const store3 = new ImageStore(dbDir);
  assert.throws(() => store3.import(path.join(fixtures, "bad-dup.fits")));
  assert.equal(store3.list().length, 1);
  store3.close();
});

test("夹具：twoblock 跨块头、img8、allblank、dexp", () => {
  const store = new ImageStore(path.join(dir, "db2"));
  const two = store.import(path.join(fixtures, "twoblock.fits"));
  assert.equal(two.image.dataOffset, 5760);
  const obj = two.image.cards.find((c) => c.keyword === "OBJECT")!;
  assert.equal(obj.value, "M31/Spitzer's field");

  const img8 = store.import(path.join(fixtures, "img8.fits"));
  assert.equal(img8.record.stats.valid, 7);
  assert.equal(img8.record.stats.blank, 1);

  const ab = store.import(path.join(fixtures, "allblank.fits"));
  assert.equal(ab.record.stats.valid, 0);
  assert.equal(ab.record.stats.mean, null);

  const dx = store.import(path.join(fixtures, "dexp.fits"));
  assert.equal(dx.image.bscale, 2.5);
  assert.equal(dx.image.bzero, -10);
  store.close();
});

test("坏夹具全部以对应错误码拒绝", () => {
  const store = new ImageStore(path.join(dir, "db3"));
  const expect: Record<string, string> = {
    "bad-naxis3.fits": "FITS_UNSUPPORTED",
    "bad-dup.fits": "FITS_DUPLICATE_KEYWORD",
    "bad-noend.fits": "FITS_BAD_HEADER",
    "bad-truncated.fits": "FITS_TRUNCATED",
    "bad-overflow.fits": "FITS_OVERFLOW",
    "bad-extra.fits": "FITS_EXTRA_DATA",
    "bad-dims.fits": "FITS_BAD_VALUE",
    "bad-blocklen.fits": "FITS_TRUNCATED",
  };
  for (const [name, code] of Object.entries(expect)) {
    assert.throws(
      () => store.import(path.join(fixtures, name)),
      (e: any) => e.code === code,
      `${name} 应以 ${code} 拒绝`
    );
  }
  assert.equal(store.list().length, 0);
  store.close();
});

test("HTTP API 端到端", async () => {
  const store = new ImageStore(path.join(dir, "db4"));
  const { port, close } = await startServer(store, 0);
  assert.ok(port > 0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const imp = await fetch(`${base}/images/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path.join(fixtures, "demo16.fits") }),
    });
    assert.equal(imp.status, 201);
    const { id } = (await imp.json()) as any;
    assert.ok(id);

    const imp2 = await fetch(`${base}/images/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path.join(fixtures, "demo16.fits") }),
    });
    assert.equal(imp2.status, 200);
    assert.equal(((await imp2.json()) as any).already, true);

    const pixel = await fetch(`${base}/images/${id}/pixel?x=0&y=0`);
    const pj = (await pixel.json()) as any;
    assert.equal(pj.pixel.offset, 2880);
    assert.equal(pj.pixel.raw, -2);
    assert.equal(pj.pixel.physical, 6);

    const matrix = await fetch(`${base}/images/${id}/matrix`);
    const mj = (await matrix.json()) as any;
    assert.deepEqual(mj.matrix.values, [[6, null, 16]]);
    assert.deepEqual(mj.matrix.mask, [[false, true, false]]);

    const stats = await fetch(`${base}/images/${id}/stats`);
    assert.equal(((await stats.json()) as any).stats.mean, 11);

    const cards = await fetch(`${base}/images/${id}/cards`);
    const cj = (await cards.json()) as any;
    assert.equal(cj.cards[0].keyword, "SIMPLE");
    assert.equal(cj.cards[0].raw.length, 80);

    const bad = await fetch(`${base}/images/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path.join(fixtures, "bad-overflow.fits") }),
    });
    assert.equal(bad.status, 422);
    assert.equal(((await bad.json()) as any).error.code, "FITS_OVERFLOW");

    const nf = await fetch(`${base}/images/doesnotexist/stats`);
    assert.equal(nf.status, 404);

    const badq = await fetch(`${base}/images/${id}/pixel?x=a&y=0`);
    assert.equal(badq.status, 400);
  } finally {
    close();
    store.close();
  }
});
