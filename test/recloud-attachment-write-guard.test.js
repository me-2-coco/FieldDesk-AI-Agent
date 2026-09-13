const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { RecloudAttachmentWriteGuard } = require('../services/recloud-attachment-write-guard');
const a = {fileName:`fd-m-${'a'.repeat(64)}.jpg`,originalFileName:'photo.jpg',size:1024};
const b = {fileName:`fd-m-${'b'.repeat(64)}.mp4`,originalFileName:'video.mp4',size:2048};
test('restart reuses verified files and never repeats an uncertain upload', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'attachment-guard-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const guard = new RecloudAttachmentWriteGuard(dir);
  assert.deepEqual((await guard.pending('LAB',[a,b],[a])).map(x=>x.fileName),[b.fileName]);
  await guard.claim('LAB',[b]);
  const restarted = new RecloudAttachmentWriteGuard(dir);
  await assert.rejects(restarted.pending('LAB',[a,b],[a]),{resultUnknown:true});
  assert.deepEqual(await restarted.pending('LAB',[a,b],[a,b]),[]);
});
test('concurrent upload claims allow only one writer', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'attachment-race-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const results = await Promise.allSettled([new RecloudAttachmentWriteGuard(dir).claim('LAB',[a]),new RecloudAttachmentWriteGuard(dir).claim('LAB',[a])]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
});
test('original-name attachments, duplicates, unknown reads and size conflicts block upload', async () => {
  const guard = new RecloudAttachmentWriteGuard('/unused-synthetic');
  for (const remote of [null,[a,a],[{...a,size:999999}],[{fileName:'photo.jpg',size:1024}]]) {
    await assert.rejects(guard.pending('LAB',[a],remote),{resultUnknown:true});
  }
});
