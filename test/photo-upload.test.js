const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture({ size = 400000, width = 4000, height = 3000, fail = false } = {}) {
  let revoked = 0; let created = 0;
  const canvas = { width: 0, height: 0,
    getContext: () => ({ drawImage() {} }),
    toBlob(callback, type, quality) {
      assert.equal(this.width, width); assert.equal(this.height, height);
      assert.equal(quality, 0.85); callback({ size, type });
    } };
  const context = { File: class { constructor(blobs, name, props) { Object.assign(this, props, {name, size: blobs[0].size}); } },
    Image: class { constructor() { this.naturalWidth = width; this.naturalHeight = height; }
      set src(value) { if (fail) this.onerror(); else this.onload(); } },
    URL: { createObjectURL() { created++; return 'blob:test'; }, revokeObjectURL() { revoked++; } },
    document: { createElement: () => canvas } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('frontend/src/shared/photoUpload.js', 'utf8').replace('export async function', 'async function'), context);
  return { run: context.optimizeUploadPhoto, counts: () => ({created, revoked}), canvas };
}
const file = {name: 'evidence.jpg', type: 'image/jpeg', size: 2000000, lastModified: 123};
test('large JPEG retains pixel dimensions/name/date and releases bitmap/URL', async () => {
  const f = fixture(); const result = await f.run(file);
  assert.equal(result.size, 400000); assert.equal(result.name, file.name);
  assert.equal(result.lastModified, 123);
  assert.deepEqual(f.counts(), {created: 1, revoked: 1}); assert.equal(f.canvas.width, 0);
});
test('small, non-JPEG, oversized, failed, or poorly compressible images keep originals', async () => {
  for (const options of [{size: 1950000}, {size: 0}, {fail: true}, {width: 8001}]) {
    const f = fixture(options); assert.equal(await f.run(file), file); assert.equal(f.counts().revoked, 1);
  }
  for (const original of [{...file, size: 500}, {...file, type: 'video/mp4'}, {...file, type: 'image/png'}]) {
    const f = fixture(); assert.equal(await f.run(original), original); assert.equal(f.counts().created, 0);
  }
});
