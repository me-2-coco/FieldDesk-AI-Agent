const test = require('node:test');
const assert = require('node:assert/strict');
const { repairAttachmentIdentity, verifiedRepairManifest } = require('../services/repair-attachment-identity');
const { buildRecloudRepairAttachmentsPlan } = require('../services/recloud-repair-attachments-plan');
test('repair content identity is stable and distinguishes same-name content and orders', () => {
  const file = { fileName: 'camera.mov', size: 100 };
  const a = repairAttachmentIdentity('LAB', file, Buffer.from('movie-a'));
  assert.equal(a.fileName, repairAttachmentIdentity('LAB', file, Buffer.from('movie-a')).fileName);
  assert.notEqual(a.fileName, repairAttachmentIdentity('LAB', file, Buffer.from('movie-b')).fileName);
  assert.notEqual(a.fileName, repairAttachmentIdentity('OTHER', file, Buffer.from('movie-a')).fileName);
  assert.equal(a.originalFileName, file.fileName);
  assert.equal(verifiedRepairManifest([a], [a], [a.fileName]), true);
  for (const remote of [[], [file], [a, a]]) assert.equal(verifiedRepairManifest([a], remote, [a.fileName]), false);
  assert.equal(verifiedRepairManifest([a], [a], []), false);
  assert.equal(buildRecloudRepairAttachmentsPlan([a], [file]).readyToUpload, false);
  assert.equal(buildRecloudRepairAttachmentsPlan([a], []).additions[0].originalFileName, file.fileName);
});
test('verified attachments requeue remaining repair work, never locally finalize the whole order', async () => {
  const { RecloudSyncService } = require('../services/recloud-sync-service');
  let record = { id: 'LAB', nodeType: 'REPAIR_COMPLETED', status: 'MANUAL_REVIEW', reconciliationRequired: true };
  const scheduled = [];
  const context = {
    taskFilter: () => true,
    adapter: { reconcileTask: async () => ({ status: 'READY_TO_RESUME', step: 'ATTACHMENTS_VERIFIED' }) },
    outbox: {
      get: async () => record,
      update: async (_, patch) => (record = { ...record, ...patch }),
      transition: async (_, status, patch) => (record = { ...record, ...patch, status }),
    },
    scheduleTask: id => scheduled.push(id),
  };
  const result = await RecloudSyncService.prototype.reconcileTask.call(context, 'LAB');
  assert.equal(result.status, 'PENDING');
  assert.equal(result.localRecoveryResult, null);
  assert.equal(result.reconciliationRequired, false);
  assert.deepEqual(scheduled, ['LAB']);
});
