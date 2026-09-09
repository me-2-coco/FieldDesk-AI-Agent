export function filterShippingOrders(orders, query) {
  const keyword = String(query || "").trim().toLocaleLowerCase()
  if (!keyword) return orders
  return orders.filter(order => [
    order.rmaNo, order.logisticsNo, order.returnShipment?.trackingNo,
    order.customerName, order.phone, order.phoneMasked, order.sn,
  ].some(value => String(value || "").toLocaleLowerCase().includes(keyword)))
}
