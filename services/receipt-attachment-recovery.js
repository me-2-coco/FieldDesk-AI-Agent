const COOLDOWN_MS = 5 * 60 * 1000;
function canRecoverAttachments(order, now = Date.now()) {
  if (order?.recloudReceiptAttachmentSyncStatus !== 'RESULT_UNKNOWN'
    || !order.recloudReceiptConfirmedAt || !order.recloudProjectVerificationConfirmedAt
    || order.recloudReceiptAttachmentConfirmedAt
    || !order.receiptAttachments?.length
    || Number(order.recloudReceiptAttachmentRecoveryAttempts || 0) >= 2) return false;
  const at = Date.parse(order.recloudReceiptAttachmentLastError?.at || order.recloudReceiptAttachmentAttemptedAt || '');
  return Number.isFinite(at) && now - at >= COOLDOWN_MS;
}
function verifyRecoverySnapshots(rmaNo, files, first, second) {
  const names = files.map(f => f.name);
  const valid = snapshot => snapshot?.readBackVerified === true && snapshot.rmaNo === rmaNo
    && Array.isArray(snapshot.attachments)
    && snapshot.attachments.every(a => names.includes(a.name))
    && new Set(snapshot.attachments.map(a => a.name)).size === snapshot.attachments.length;
  const signature = snapshot => JSON.stringify(snapshot.attachments.map(a => a.name).sort());
  if (!names.length || new Set(names).size !== names.length || !valid(first) || !valid(second)
    || signature(first) !== signature(second)) {
    throw Object.assign(new Error('附件列表未稳定或存在无法核对的文件，未补传，请管理员核对'), {
      code:'RECLOUD_RMA_ATTACHMENT_RESULT_UNKNOWN', resultUnknown:true, retryable:false,
    });
  }
  return files.filter(f => !second.attachments.some(a => a.name === f.name));
}
module.exports = { canRecoverAttachments, verifyRecoverySnapshots };
