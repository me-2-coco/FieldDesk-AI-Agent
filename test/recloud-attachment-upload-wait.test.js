const test = require('node:test');
const assert = require('node:assert/strict');
const { attachmentUploadTimeout, waitForAttachmentDialog } = require('../services/recloud-attachment-upload-wait');

test('upload budget handles videos and stays bounded', () => {
  assert.equal(attachmentUploadTimeout([]), 120000);
  assert.ok(attachmentUploadTimeout([{size: 94 * 1024 * 1024}]) > 700000);
  assert.equal(attachmentUploadTimeout([{size: 10 ** 12}]), 900000);
});
test('dialog is awaited before uniqueness is checked', async () => {
  let ready = false;
  const dialog = { waitFor: async () => { ready = true; } };
  const dialogs = { first: () => dialog, count: async () => ready ? 1 : 0 };
  assert.equal(await waitForAttachmentDialog(dialogs), dialog);
});
test('multiple dialogs still fail closed', async () => {
  await assert.rejects(waitForAttachmentDialog({ first: () => ({waitFor: async () => {}}), count: async () => 2 }), {code: 'RECLOUD_REPAIR_ATTACHMENT_DIALOG_AMBIGUOUS'});
});

test('verified attachments on an already submitted order finalize locally, not resume writes', async () => {
  const { createRecloudCommandExecutor } = require('../services/recloud-command-executor');
  const { repairCompletionFingerprint } = require('../services/recloud-repair-completion-orchestrator');
  const fileName = `fd-m-${'a'.repeat(64)}.jpg`;
  const task = {nodeType:'REPAIR_COMPLETED', rmaNo:'SYNTHETIC', payload:{attachments:[{fileName:'photo.jpg',size:10}]}};
  const executor = createRecloudCommandExecutor({
    checkpointStore:{load:async()=>({status:'ATTACHMENTS_UPLOADING',fingerprint:repairCompletionFingerprint(task.rmaNo,task.payload),attachmentManifest:[fileName]})},
    repairAdapterProvider:{open:async()=>({readRemoteState:async()=>({completed:true,attachments:[{fileName}]}),prepareAttachmentIdentities:async()=>[{fileName}]})},
  });
  assert.equal((await executor.reconcileTask(task)).status, 'SUCCESS');
});
