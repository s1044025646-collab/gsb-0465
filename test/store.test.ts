import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ImageStore } from '../src/db.js';
import { buildFits } from '../src/fits/writer.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fits-test-'));
}

test('导入幂等、失败不登记、重启后结果一致', () => {
  const dir = tmpDir();
  const fitsPath = path.join(dir, 'a.fits');
  fs.writeFileSync(fitsPath, buildFits({ width: 3, height: 1, bitpix: 16, raw: [-2, 0, 3], bscale: 2, bzero: 10, blank: 0 }));

  const store = new ImageStore(path.join(dir, 'data'));
  const first = store.importFile(fitsPath);
  assert.equal(first.duplicate, false);
  const second = store.importFile(fitsPath);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);
  assert.equal(store.list().length, 1);

  const badPath = path.join(dir, 'bad.fits');
  fs.writeFileSync(badPath, Buffer.from('not a fits file'));
  assert.throws(() => store.importFile(badPath));
  assert.equal(store.list().length, 1);

  const statsBefore = store.stats(first.id);
  const pixelBefore = store.pixel(first.id, 2, 0);
  store.close();

  const reopened = new ImageStore(path.join(dir, 'data'));
  assert.deepEqual(reopened.stats(first.id), statsBefore);
  assert.deepEqual(reopened.pixel(first.id, 2, 0), pixelBefore);
  assert.deepEqual(reopened.matrix(first.id).physical, [[6, null, 16]]);
  reopened.close();
});

test('像素查询返回绝对偏移与缩放参数', () => {
  const dir = tmpDir();
  const fitsPath = path.join(dir, 'b.fits');
  fs.writeFileSync(fitsPath, buildFits({ width: 2, height: 2, bitpix: 16, raw: [1, 2, 3, 4], bscale: 2, bzero: 10 }));
  const store = new ImageStore(path.join(dir, 'data'));
  const { id } = store.importFile(fitsPath);
  const p = store.pixel(id, 1, 1);
  assert.equal(p.offset, 2880 + 3 * 2);
  assert.equal(p.raw, 4);
  assert.equal(p.physical, 18);
  assert.equal(p.masked, false);
  assert.throws(() => store.pixel(id, 5, 0), /越界/);
  store.close();
});
