const path = require('node:path');
const { RecloudPartWriteGuard } = require('./recloud-part-write-guard');
const { buildRecloudRepairAttachmentsPlan } = require('./recloud-repair-attachments-plan');

function blocked() {
  return Object.assign(new Error('附件写入必须先核对瑞云，禁止重复上传'), {
    code: 'RECLOUD_REPAIR_ATTACHMENT_UPLOAD_UNCERTAIN', phase: 'ATTACHMENTS',
    resultUnknown: true, permanent: true,
  });
}

// Use the same exclusive, fsynced intent primitive as parts, in a separate store.
// Markers are never cleared on restart, timeout or unsuccessful readback.
class RecloudAttachmentWriteGuard {
  constructor(directory = path.join(process.env.FIELDDESK_DATA_DIRECTORY || path.join(__dirname, '../database/data'), 'attachment-write-intents')) {
    this.store = new RecloudPartWriteGuard(directory);
  }
  async pending(rmaNo, files, remote) {
    if (!Array.isArray(remote)) throw blocked();
    const plan = buildRecloudRepairAttachmentsPlan(files, remote);
    if (!plan.readyToUpload) throw blocked();
    for (const file of plan.additions) {
      try { await this.store.assertUnattempted(rmaNo, file.fileName); }
      catch { throw blocked(); }
    }
    return plan.additions;
  }
  async claim(rmaNo, files) {
    for (const file of files) {
      try { await this.store.claim(rmaNo, file.fileName); }
      catch { throw blocked(); }
    }
  }
}
module.exports = { RecloudAttachmentWriteGuard, blocked };
