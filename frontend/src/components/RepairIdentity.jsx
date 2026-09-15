// Inspection and completion share fixed identifier/contact positions.
export default function RepairIdentity({ order, children }) {
  return <>
    <div className="parts-order-hero"><span>机器 SN</span><strong>{order.sn || "未记录"}</strong><small>{order.product || "待确认品类"}</small></div>
    <dl className="parts-order-grid">
      <div><dt>寄修单号</dt><dd>{order.crmOrderNo || "未记录"}</dd></div>
      <div><dt>物流单号</dt><dd>{order.logisticsNo || "送修（无物流单号）"}</dd></div>
      <div><dt>客户姓名</dt><dd>{order.customer || "未记录"}</dd></div>
      <div><dt>客户电话</dt><dd>{order.phone || "未记录"}</dd></div>
      <div><dt>产品线</dt><dd>{order.product || "未记录"}</dd></div>
      <div><dt>维修师傅</dt><dd>{order.technician || "未记录"}</dd></div>
      {children}
    </dl>
  </>
}
