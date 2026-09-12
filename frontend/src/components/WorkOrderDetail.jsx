import { workOrderStage, workOrderHolder } from "../shared/workOrderDetail.js"

export default function WorkOrderDetail({ order, onBack, showSyncDetails = false }) {
  return <div className="page machine-tracking-page">
    <div className="top-bar"><button className="arrow-back" onClick={onBack} aria-label="返回工单列表">←</button><h1>工单详情</h1><span>只读</span></div>
    <section className="card">
      <h2>{order.rmaNo}</h2>
      <div className="compact-key-value-grid">
        <span><small>当前进度</small><strong>{workOrderStage(order)}</strong></span>
        <span><small>机器在谁手上</small><strong>{workOrderHolder(order)}</strong></span>
        <span><small>维修师傅</small><strong>{order.technicianName || order.operatorName || "未分配"}</strong></span>
        <span><small>物流单号</small><strong>{order.logisticsNo || "未记录"}</strong></span>
        <span><small>机器 SN</small><strong>{order.sn || "未记录"}</strong></span>
        <span><small>产品线</small><strong>{order.productLine || order.specialty || "未记录"}</strong></span>
        <span><small>联系电话</small><strong>{order.phoneMasked || "未记录"}</strong></span>
        <span><small>签收时间</small><strong>{order.receiptCompletedAt ? new Date(order.receiptCompletedAt).toLocaleString() : "未签收"}</strong></span>
      </div>
      {order.hold && <section><h3>暂存记录</h3><p>{order.hold.category} / {order.hold.reason}</p><p>{order.hold.remark}</p>{showSyncDetails && <p>瑞云同步：{({ CONFIRMED: "已同步", FAILED: "失败待重试", PENDING: "待同步", SUBMITTING: "同步中", RESULT_UNKNOWN: "结果待核对" })[order.hold.status] || "待核对"}</p>}</section>}
      {order.repairCompletion?.repairMeasure && <section><h3>维修措施</h3><p>{order.repairCompletion.repairMeasure}</p></section>}
      <h3>最近操作记录</h3>
      {order.recentTimeline?.length ? <ol className="machine-progress-timeline">{[...order.recentTimeline].reverse().map((event, index) => <li key={event.id || index}><span>{event.label}</span><small>{event.operatorName || "系统"} · {event.at ? new Date(event.at).toLocaleString() : ""}</small></li>)}</ol> : <p>暂无操作记录</p>}
    </section>
  </div>
}
