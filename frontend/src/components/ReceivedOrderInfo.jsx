import "./received-order-info.css"

export default function ReceivedOrderInfo({ order }) {
  return <section className="received-order-info" aria-label="已签收工单信息">
    <dl>
      <div><dt>用户姓名</dt><dd>{order.customer || "未提供"}</dd></div>
      <div><dt>产品线</dt><dd>{order.product || "未提供"}</dd></div>
      <div><dt>联系电话</dt><dd>{order.phone || "未提供"}</dd></div>
      <div><dt>寄修单号</dt><dd>{order.crmOrderNo || "未提供"}</dd></div>
      {order.address && <div className="received-order-wide"><dt>用户地址</dt><dd>{order.address}</dd></div>}
    </dl>
    <div className="received-order-fault"><span>用户报修的故障描述</span><p>{order.originalFault || "未提供"}</p></div>
  </section>
}
