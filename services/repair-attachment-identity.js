const crypto = require('node:crypto');
const path = require('node:path');
function repairAttachmentIdentity(rmaNo, file, buffer) {
  const originalFileName = path.basename(String(file.fileName || file.name || ''));
  const ext = path.extname(originalFileName).toLowerCase();
  if (!rmaNo || !originalFileName || !/^\.[a-z0-9]{1,10}$/.test(ext) || !Buffer.isBuffer(buffer) || !buffer.length) throw new Error('维修附件身份资料不完整');
  const digest = crypto.createHash('sha256').update(JSON.stringify([rmaNo, 'repair', originalFileName])).update('\0').update(buffer).digest('hex');
  return { ...file, originalFileName, fileName: `fd-m-${digest}${ext}`, size: buffer.length };
}
function verifiedRepairManifest(files, remote, manifest) {
  const names = files.map(file => file.fileName);
  return Boolean(names.length && new Set(names).size === names.length && Array.isArray(manifest) && names.length === manifest.length
    && names.every(name => /^fd-m-[a-f0-9]{64}\.[a-z0-9]{1,10}$/.test(name) && manifest.includes(name)
      && (remote || []).filter(file => (file.fileName || file.name) === name).length === 1));
}
module.exports = { repairAttachmentIdentity, verifiedRepairManifest };
