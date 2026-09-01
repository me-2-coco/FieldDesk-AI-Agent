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

  return <div className="page return-shipping-page">
    <div className="top-bar">
      <button className="arrow-back" onClick={() => setPage("home")}>←</button>
      <h1>后台发货进度</h1>
    </div>
    <div className="card">
      <label htmlFor="shipping-order">待发货与待完结工单</label>
      <select id="shipping-order" value={selectedRmaNo} onChange={(event) => setSelectedRmaNo(event.target.value)}>
        <option value="">请选择工单</option>
        {orders.map((item) => <option key={item.rmaNo} value={item.rmaNo}>{item.rmaNo}｜{item.status === "SHIPPED_PENDING_COMPLETION" ? "已发货/待完结" : "维修完成/后台待发货"}</option>)}
      </select>
      {!orders.length && <p>当前没有后台待发货或待完结工单</p>}
    </div>
    {order && <>
      <div className="card">
        <h2>返件资料</h2>
        <p>寄修单号：{order.rmaNo}</p><p>SN：{order.sn || "未提供"}</p>
        <p>用户姓名：{order.customerName || "未提供"}</p><p>联系电话：{order.phoneMasked || "未提供"}</p>
        <p>收件地址：{order.regionAddress || "未提供"}</p><p>产品线：{order.productLine || "未提供"}</p>
        <p>维修结果：{order.repairCompletion?.repairMeasure || "未提供"}</p><p>已使用配件：{partsText}</p>
      </div>
      <div className="card">
        <h2>后台处理状态</h2>
        <p>{order.status === "SHIPPED_PENDING_COMPLETION" ? `后台已完成发货${order.returnShipment?.trackingNo ? `，物流单号：${order.returnShipment.trackingNo}` : ""}` : "师傅维修已结束，后台正在处理返件发货"}</p>
        <p className="field-hint">仅供信息员和管理员查询；物流与发货凭证由后台自动同步。</p>
      </div>
      <div className="card"><h2>工单时间线</h2><ol>{(order.timeline || []).map((item) => <li key={item.id}>{item.label}｜{new Date(item.at).toLocaleString()}</li>)}</ol></div>
    </>}
    {errorMessage && <p className="error-message" role="alert">{errorMessage}</p>}
  </div>
}

export default ReturnShipping
