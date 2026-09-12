const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const formats = require('../shared/media-formats.json');
const { LocalRepairAttachmentStore } = require('../database/repair-attachment-store');
const { parseRepairAttachmentPanelText } = require('../connectors/recloud-repair-attachments-reader');
test('remote attachment readback recognizes every declared extension', () => {
  for (const [mimeType, extensions] of Object.entries(formats.types)) for (const ext of extensions) {
    assert.deepEqual(parseRepairAttachmentPanelText(`test.${ext}\n1K |`), [{ fileName:`test.${ext}`, size:1024, mimeType }]);
  }
});
test('all declared image/video formats store and read back with empty or generic MIME', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fielddesk-media-formats-'));
  t.after(() => fs.rm(dir, { recursive:true, force:true }));
  const allowedMimeTypes = Object.keys(formats.types).filter(x => /^(image|video)\//.test(x));
  const store = new LocalRepairAttachmentStore(dir, { allowedMimeTypes });
  const data = Buffer.from('synthetic bytes for metadata acceptance, not decoder verification');
  for (const type of allowedMimeTypes) for (const ext of formats.types[type]) {
    for (const mimeType of ['', 'application/octet-stream', type]) {
      const saved = await store.save({rmaNo:'LAB-MEDIA', name:`test.${ext.toUpperCase()}`, mimeType, data:data.toString('base64')});
      assert.equal(saved.mimeType, type);
      const read = await store.read('LAB-MEDIA', saved);
      assert.deepEqual(read, data);
    }
  }
  for (const [name, mimeType] of [['test.exe','image/jpeg'], ['test.svg','image/svg+xml'], ['test.jpg','video/mp4'], ['test.html',''], ['test.pdf','application/pdf']]) {
    await assert.rejects(store.save({rmaNo:'LAB-MEDIA',name,mimeType,data:data.toString('base64')}));
  }
});
test('MIME aliases normalize without disabling extension validation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fielddesk-media-alias-'));
  t.after(() => fs.rm(dir, {recursive:true,force:true}));
  const store = new LocalRepairAttachmentStore(dir);
  for (const [alias, canonical] of Object.entries(formats.aliases)) {
    const saved = await store.save({rmaNo:'LAB-ALIAS',name:`test.${formats.types[canonical][0]}`,mimeType:alias,data:'dGVzdA=='});
    assert.equal(saved.mimeType,canonical);
  }
});
