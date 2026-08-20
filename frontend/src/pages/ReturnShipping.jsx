import { useEffect, useMemo, useState } from "react"
import ScannerModal from "../components/ScannerModal.jsx"
import {
  confirmLocalOrderCompletion,
  getShippingContext,
  getShippingOrders,
  submitReturnShipment,
  uploadShippingProof
} from "../shared/crmService.js"
import {
  getCurrentRepairOrder,
  REPAIR_STATUS,
  updateRepairOrder
} from "../shared/repairOrderStore.js"
import { getCurrentUser, USER_ROLES } from "../shared/userStore.js"

const LOGISTICS_COMPANIES = ["顺丰速运", "京东物流", "中通快递", "圆通速递", "申通快递", "韵达快递", "其他"]

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error("发货凭证读取失败"))
    reader.readAsDataURL(file)
  })
}

function ReturnShipping({ setPage }) {
  const currentOrder = useMemo(() => getCurrentRepairOrder(), [])
  const currentUser = useMemo(() => getCurrentUser(), [])
  const [orders, setOrders] = useState([])
  const [selectedRmaNo, setSelectedRmaNo] = useState("")
  const [context, setContext] = useState(null)
  const [logisticsCompany, setLogisticsCompany] = useState("")
  const [trackingNo, setTrackingNo] = useState("")
  const [attachments, setAttachments] = useState([])
  const [scannerOpen, setScannerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [errorMessage, setErrorMessage] = useState("")

  async function refreshOrders(preferredRmaNo = selectedRmaNo) {
    const rows = await getShippingOrders()
    setOrders(rows)
    const preferred = rows.find((item) => item.rmaNo === preferredRmaNo)
      || rows.find((item) => item.rmaNo === currentOrder.crmOrderNo)
      || rows[0]
    setSelectedRmaNo(preferred?.rmaNo || "")
    return preferred
  }

  useEffect(() => {
    let active = true
    getShippingOrders().then((rows) => {
      if (!active) return
      setOrders(rows)
      const preferred = rows.find((item) => item.rmaNo === currentOrder.crmOrderNo) || rows[0]
      setSelectedRmaNo(preferred?.rmaNo || "")
    }).catch((error) => active && setErrorMessage(error.message))
    return () => { active = false }
  }, [currentOrder.crmOrderNo])

  useEffect(() => {
    if (!selectedRmaNo) return undefined
    let active = true
    getShippingContext(selectedRmaNo).then((data) => {
      if (!active) return
      setContext(data)
      setLogisticsCompany(data.order.returnShipment?.logisticsCompany || "")
      setTrackingNo(data.order.returnShipment?.trackingNo || "")
      setAttachments(data.order.returnShipment?.attachments || [])
    }).catch((error) => active && setErrorMessage(error.message))
    return () => { active = false }
  }, [selectedRmaNo])

  async function uploadProofs(event) {
    const files = [...event.target.files]
    try {
      setBusy(true)
      const saved = []
      for (const file of files) {
        if (!file.type.startsWith("image/")) throw new Error("发货凭证仅支持照片")
        saved.push(await uploadShippingProof({
          rmaNo: selectedRmaNo, name: file.name, mimeType: file.type,
          data: await fileToDataUrl(file)
        }))
      }
      setAttachments((current) => [...current, ...saved])
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setBusy(false)
      event.target.value = ""
    }
  }

  async function submitShipping() {
    if (!trackingNo.trim()) { setErrorMessage("请输入或扫描返件物流单号"); return }
    if (!logisticsCompany) { setErrorMessage("请选择物流公司"); return }
    try {
      setBusy(true); setErrorMessage("")
      const result = await submitReturnShipment({
        rmaNo: selectedRmaNo,
        logisticsCompany,
        trackingNo: trackingNo.trim().toUpperCase(),
        attachments
      })
      if (currentOrder.crmOrderNo === selectedRmaNo) {
        updateRepairOrder({
          status: REPAIR_STATUS.SHIPPED_PENDING_COMPLETION,
          returnShipment: result.returnShipment
        })
      }
      setMessage(result.message)
      await refreshOrders(selectedRmaNo)
      setContext(await getShippingContext(selectedRmaNo))
    } catch (error) {
      setErrorMessage(error.message)
    } finally { setBusy(false) }
  }

  async function completeOrder() {
    try {
      setBusy(true); setErrorMessage("")
      const result = await confirmLocalOrderCompletion(selectedRmaNo)
      if (currentOrder.crmOrderNo === selectedRmaNo) updateRepairOrder({ status: REPAIR_STATUS.COMPLETED })
      setMessage(result.message)
      const nextOrder = await refreshOrders("")
      if (!nextOrder) setContext(null)
    } catch (error) {
      setErrorMessage(error.message)
    } finally { setBusy(false) }
  }

  const order = context?.order
  const partsText = context?.usedParts?.length
    ? context.usedParts.map((part) => `${part.partName}×${part.quantity}`).join("、")
    : "无实际使用配件"

  return <div className="page return-shipping-page">
    <div className="top-bar">
      <button className="arrow-back" onClick={() => setPage("home")}>←</button>
      <h1>返件发货与工单完结</h1>
    </div>

    <div className="card">
      <label htmlFor="shipping-order">待处理工单</label>
      <select id="shipping-order" value={selectedRmaNo} onChange={(event) => setSelectedRmaNo(event.target.value)}>
        <option value="">请选择待发货/待完结工单</option>
        {orders.map((item) => <option key={item.rmaNo} value={item.rmaNo}>{item.rmaNo}｜{item.status === "SHIPPED_PENDING_COMPLETION" ? "已发货/待完结" : "维修完成/待发货"}</option>)}
      </select>
      {!orders.length && <p>当前没有可处理的本地工单</p>}
    </div>

    {order && <>
      <div className="card">
        <h2>返件资料</h2>
        <p>寄修单号：{order.rmaNo}</p>
        <p>SN：{order.sn || "未提供"}</p>
        <p>用户姓名：{order.customerName || "未提供"}</p>
        <p>联系电话：{order.phoneMasked || "未提供"}</p>
        <p>收件地址：{order.regionAddress || "未提供"}</p>
        <p>产品线：{order.productLine || "未提供"}</p>
        <p>维修结果：{order.repairCompletion?.repairMeasure || "未提供"}</p>
        <p>已使用配件：{partsText}</p>
        <p>状态：{order.status === "SHIPPED_PENDING_COMPLETION" ? "已发货/待完结" : "维修完成/待发货"}</p>
      </div>

      {order.status === "REPAIR_COMPLETED_PENDING_SHIPMENT" && <div className="card">
        <h2>发货登记</h2>
        <label htmlFor="logistics-company">物流公司</label>
        <select id="logistics-company" value={logisticsCompany} onChange={(event) => setLogisticsCompany(event.target.value)}>
          <option value="">请选择物流公司</option>
          {LOGISTICS_COMPANIES.map((item) => <option key={item}>{item}</option>)}
        </select>
        <label htmlFor="return-tracking-no">返件物流单号</label>
        <div className="scan-input-row">
          <input id="return-tracking-no" value={trackingNo} onChange={(event) => setTrackingNo(event.target.value.toUpperCase())} placeholder="扫码或手工输入物流单号" />
          <button type="button" onClick={() => setScannerOpen(true)}>📷 扫码</button>
          <button type="button" onClick={() => setTrackingNo("")}>清空</button>
        </div>
        <label htmlFor="shipping-proof">发货凭证照片</label>
        <input id="shipping-proof" type="file" accept="image/*" multiple onChange={uploadProofs} disabled={busy} />
        <ul>{attachments.map((item) => <li key={item.id}>{item.name}（本地）</li>)}</ul>
        <button className="primary-btn" disabled={busy} onClick={submitShipping}>提交本地发货</button>
      </div>}

      <div className="card">
        <h2>工单时间线</h2>
        <ol>{(order.timeline || []).map((item) => <li key={item.id}>{item.label}｜{new Date(item.at).toLocaleString()}</li>)}</ol>
      </div>

      {order.status === "SHIPPED_PENDING_COMPLETION" && currentUser.role === USER_ROLES.ADMIN && (
        <button className="primary-btn" disabled={busy} onClick={completeOrder}>管理员确认完结</button>
      )}
    </>}

    {errorMessage && <p className="error-message" role="alert">{errorMessage}</p>}
    {message && <p role="status">{message}</p>}
    <p className="dry-run-notice">仅保存 FieldDesk 本地数据，不执行真实发货、完结或瑞云同步。</p>
    <ScannerModal open={scannerOpen} mode="logistics" title="扫描返件物流单号" onScan={(value) => setTrackingNo(String(value || "").trim().toUpperCase())} onClose={() => setScannerOpen(false)} />
  </div>
}

export default ReturnShipping
