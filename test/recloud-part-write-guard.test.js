const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { RecloudPartWriteGuard, existingPartMatches, blocksPartRetry } = require('../services/recloud-part-write-guard');
test('part save intent survives restart and prevents concurrent duplicate saves', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'part-guard-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const guard = new RecloudPartWriteGuard(dir);
  await guard.assertUnattempted('LAB','P1');
  const results = await Promise.allSettled([guard.claim('LAB','P1'),guard.claim('LAB','P1')]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  await assert.rejects(new RecloudPartWriteGuard(dir).assertUnattempted('LAB','P1'),{code:'RECLOUD_PART_WRITE_UNCERTAIN'});
  await guard.assertUnattempted('LAB','P2');
  await guard.assertUnattempted('OTHER','P1');
});
test('remote exact row is reused; duplicates and quantity conflicts cannot add',()=>{
  const part={partCode:'P1',quantity:1};
  assert.equal(existingPartMatches([part],part),true);
  assert.equal(existingPartMatches([],part),false);
  for(const rows of [[part,part],[{...part,quantity:2}]]) assert.throws(()=>existingPartMatches(rows,part),{code:'RECLOUD_PART_REMOTE_CONFLICT'});
});
test('post-save verification failure is not eligible for automatic part retries',()=>{
  assert.equal(blocksPartRetry('RECLOUD_REPAIR_PART_POSTVERIFY_FAILED'),true);
  assert.equal(blocksPartRetry('RECLOUD_PART_WRITE_UNCERTAIN'),true);
  const { shouldAutoResumeServiceOrder } = require('../server');
  assert.equal(shouldAutoResumeServiceOrder({recloudRepairPreparation:{lastError:{code:'RECLOUD_REPAIR_PART_POSTVERIFY_FAILED'}}}),false);
});
