const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRecloudRepairPageAdapter } = require('../connectors/recloud-repair-page-adapter');
test('repair upload identity reads the configured server upload directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'repair-upload-path-'));
  const previous = process.env.FIELDDESK_UPLOAD_DIRECTORY;
  try {
    process.env.FIELDDESK_UPLOAD_DIRECTORY = root;
    const rmaNo = 'LAB-RMA';
    const dir = path.join(root,'repairs',crypto.createHash('sha256').update(rmaNo).digest('hex'));
    await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(path.join(dir,'test.jpg'),Buffer.from('synthetic-image'));
    const adapter = createRecloudRepairPageAdapter({}, {rmaNo});
    const result = await adapter.prepareAttachmentIdentities([{fileName:'test.jpg',mimeType:'image/jpeg'}]);
    assert.equal(result.length,1);
    assert.match(JSON.stringify(result),/fd-m-/);
  } finally {
    if(previous===undefined) delete process.env.FIELDDESK_UPLOAD_DIRECTORY; else process.env.FIELDDESK_UPLOAD_DIRECTORY=previous;
    await fs.rm(root,{recursive:true,force:true});
  }
});
