const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {prepareRecloudUploadPaths,MAX_FILE_BYTES} = require('../services/recloud-upload-file-paths');
test('individual files above 50MB and aggregate above 100MB use paths', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'upload-path-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const files = [{name:'one.mp4',buffer:Buffer.alloc(60_000_000,1)}, {name:'two.mp4',buffer:Buffer.alloc(60_000_000,2)}];
  const paths = await prepareRecloudUploadPaths(files,dir);
  assert.equal(paths.length,2);
  for (let i=0;i<paths.length;i++) {
    assert.equal(typeof paths[i],'string');
    assert.equal(path.basename(paths[i]),files[i].name);
    assert.equal((await fs.stat(paths[i])).size,60_000_000);
  }
  assert.deepEqual(await prepareRecloudUploadPaths(files,dir),paths);
});
test('reject a single file above 100MB before writing anything', async () => {
  await assert.rejects(prepareRecloudUploadPaths([{name:'too-big.mp4',buffer:Buffer.alloc(MAX_FILE_BYTES+1)}],'/unused-test'),{code:'RECLOUD_UPLOAD_SINGLE_FILE_SIZE_INVALID'});
});
