async function resolveLatestServiceOrderNo(task, receiptStore) {
  const normalize = value => String(value || '').trim().toUpperCase();
  const rmaNo = normalize(task.rmaNo);
  if (!rmaNo) throw new Error('Missing repair RMA');
  const matches = (await receiptStore.readAll()).filter(order => normalize(order.rmaNo) === rmaNo);
  const snapshot = normalize(task.payload?.serviceOrderNo);
  const latest = normalize(matches[0]?.recloudServiceOrderNo);
  if (matches.length > 1 || (latest && snapshot && latest !== snapshot)) {
    const error = new Error('维修服务单号存在冲突，停止自动操作');
    error.code = 'RECLOUD_REPAIR_ORDER_MISMATCH';
    error.permanent = true;
    throw error;
  }
  // Absence keeps the existing authoritative RMA lookup; do not guess a number.
  return latest || snapshot;
}
module.exports = { resolveLatestServiceOrderNo };
