function orderQuery(order = {}) {
  const raw = String(order.logisticsNo || "").trim();
  const logisticsNo = /^(?:[-—–]+|无|暂无|未提供|null|undefined)$/i.test(raw) ? "" : raw;
  const rmaNo = String(order.rmaNo || "").trim();
  return {
    logisticsNo,
    identifier: logisticsNo || rmaNo,
    options: { expectedRmaNo: rmaNo, requirePickupLogisticsNo: Boolean(logisticsNo) },
  };
}
module.exports = { orderQuery };
