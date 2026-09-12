function receiptEvidenceMatches(order, snapshot) {
  if (!order?.rmaNo || !order.sn || snapshot?.readBackVerified !== true || snapshot.rmaNo !== order.rmaNo) return false;
  if (!Array.isArray(snapshot.rows) || snapshot.rows.length !== 1) return false;
  const row = snapshot.rows[0];
  if (String(row.sn || '').trim().toUpperCase() !== String(order.sn).trim().toUpperCase()) return false;
  const status = String(row.systemReceiptStatus || '').trim();
  if (status && status !== '已签收') return false;
  const time = String(row.systemSignedAt || '').trim();
  // Generic/logistics timestamps and downstream order status are NOT evidence.
  return status === '已签收' || /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(time) && Number.isFinite(Date.parse(time));
}
module.exports = { receiptEvidenceMatches };
