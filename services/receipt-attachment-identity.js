const crypto = require('node:crypto');
const path = require('node:path');

function receiptUploadFiles(rmaNo, attachments) {
  if (!rmaNo || !Array.isArray(attachments) || !attachments.length) throw new Error('缺少工单或附件');
  const seen = new Set();
  return attachments.flatMap(file => {
    if (!file.id || !Buffer.isBuffer(file.buffer) || !file.buffer.length) throw new Error('附件缺少编号或内容');
    const digest = crypto.createHash('sha256').update(JSON.stringify([rmaNo, 'receipt', file.id])).update('\0').update(file.buffer).digest('hex');
    const ext = path.extname(String(file.name || '')).toLowerCase();
    if (!/^\.[a-z0-9]{1,10}$/.test(ext)) throw new Error('附件扩展名无法安全保留');
    const name = `fd-r-${digest}${ext}`;
    // Repeated local references are not another remote attachment. Only merge
    // an identical ID/content/extension; distinct content keeps its own marker.
    if (seen.has(name)) return [];
    seen.add(name);
    return [{ ...file, originalName: file.name, name, size: file.buffer.length }];
  });
}

function receiptAttachmentsMatch(rmaNo, files, snapshot) {
  return Boolean(files.length && snapshot?.readBackVerified === true && snapshot.rmaNo === rmaNo && Array.isArray(snapshot.attachments)
    && files.every(file => snapshot.attachments.filter(item => item.name === file.name).length === 1));
}
module.exports = { receiptUploadFiles, receiptAttachmentsMatch };
