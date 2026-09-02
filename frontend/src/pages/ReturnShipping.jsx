import { useEffect, useState } from "react"
import { getShippingContext, getShippingOrders } from "../shared/crmService.js"

function ReturnShipping({ setPage }) {
  const [orders, setOrders] = useState([])
  const [selectedRmaNo, setSelectedRmaNo] = useState("")
  const [context, setContext] = useState(null)
  const [errorMessage, setErrorMessage] = useState("")

  useEffect(() => {
    let active = true
    getShippingOrders().then((rows) => {
      if (!active) return
      setOrders(rows)
      setSelectedRmaNo(rows[0]?.rmaNo || "")
    }).catch((error) => active && setErrorMessage(error.message))
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      if (!active) return
      if (!selectedRmaNo) { setContext(null); return }
      setErrorMessage("")
      getShippingContext(selectedRmaNo)
        .then((data) => active && setContext(data))
        .catch((error) => active && setErrorMessage(error.message))
    }, 0)
    return () => { active = false; window.clearTimeout(timer) }
  }, [selectedRmaNo])

  const order = context?.order
  const partsText = context?.usedParts?.length
    ? context.usedParts.map((part) => `${part.partName}×${part.quantity}`).join("、")
    : "无实际使用配件"
  const pendingCount = orders.filter((item) => item.status !== "SHIPPED_PENDING_COMPLETION").length
  const shippedCount = orders.length - pendingCount

  return <div className="page return-shipping-page">
    <div className="top-bar backoffice-page-header">
      <button className="arrow-back" onClick={() => setPage("home")}>←</button>
      <div><small>发货与异常</small><h1>后台发货进度</h1></div>
    </div>
    <div className="backoffice-metric-grid shipping-metrics">
      <div><small>待发货</small><strong>{pendingCount}</strong></div>
      <div><small>已发货待完结</small><strong>{shippedCount}</strong></div>
      <div><small>当前队列</small><strong>{orders.length}</strong></div>
    </div>
    <div className="card compact-data-card">
      <div className="section-title-row"><div><small>工单队列</small><h2>选择工单</h2></div><span>{orders.length} 单</span></div>
      <label htmlFor="shipping-order">待发货与待完结工单</label>
      <select id="shipping-order" value={selectedRmaNo} onChange={(event) => setSelectedRmaNo(event.target.value)}>
        <option value="">请选择工单</option>
        {orders.map((item) => <option key={item.rmaNo} value={item.rmaNo}>{item.rmaNo}｜{item.status === "SHIPPED_PENDING_COMPLETION" ? "已发货/待完结" : "维修完成/后台待发货"}</option>)}
      </select>
      {!orders.length && <p className="empty-compact-state">当前没有后台待发货或待完结工单</p>}
    </div>
    {order && <>
      <div className="card shipping-status-hero">
        <span>{order.status === "SHIPPED_PENDING_COMPLETION" ? "已发货 · 待后台完结" : "维修完成 · 待后台发货"}</span>
        <h2>{order.rmaNo}</h2>
        <p>{order.productLine || "产品线未记录"} · SN {order.sn || "未提供"}</p>
      </div>
      <div className="card compact-data-card">
        <div className="section-title-row"><div><small>收件信息</small><h2>返件资料</h2></div><span>只读</span></div>
        <div className="compact-key-value-grid">
          <span><small>用户姓名</small><strong>{order.customerName || "未提供"}</strong></span>
          <span><small>联系电话</small><strong>{order.phoneMasked || "未提供"}</strong></span>
          <span className="wide"><small>收件地址</small><strong>{order.regionAddress || "未提供"}</strong></span>
          <span className="wide"><small>维修结果</small><strong>{order.repairCompletion?.repairMeasure || "未提供"}</strong></span>
          <span className="wide"><small>已使用配件</small><strong>{partsText}</strong></span>
        </div>
      </div>
      <div className="card compact-data-card shipping-progress-card">
        <div className="section-title-row"><div><small>后台状态</small><h2>发货进度</h2></div></div>
        <p className="shipping-progress-message">{order.status === "SHIPPED_PENDING_COMPLETION" ? `后台已完成发货${order.returnShipment?.trackingNo ? `，物流单号：${order.returnShipment.trackingNo}` : ""}` : "师傅维修已结束，后台正在处理返件发货"}</p>
        <p className="field-hint">仅供信息员和管理员查询；物流与发货凭证由后台自动同步。</p>
        <details className="compact-details timeline-details"><summary><span><small>处理记录</small><strong>查看工单时间线</strong></span><b>{(order.timeline || []).length} 条</b></summary>
          <ol className="compact-timeline compact-scroll-list">{(order.timeline || []).map((item) => <li key={item.id}><strong>{item.label}</strong><small>{new Date(item.at).toLocaleString()}</small></li>)}</ol>
        </details>
      </div>
    </>}
    {errorMessage && <p className="error-message" role="alert">{errorMessage}</p>}
  </div>
}

export default ReturnShipping
