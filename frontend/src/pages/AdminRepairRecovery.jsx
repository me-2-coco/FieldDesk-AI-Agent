import { useEffect, useMemo, useState } from "react"
import { deleteLocalRepairOrder, getLocalRepairOrders, reopenRepairTreatment } from "../shared/crmService.js"
import { getCurrentRepairOrder, removeDeletedRepairOrder, REPAIR_STATUS } from "../shared/repairOrderStore.js"
import { getCurrentUser, USER_ROLES } from "../shared/userStore.js"

const MODE_LABELS = {
  REPAIR: "维修",
  ABANDONED: "弃修",
  INSPECTION_ONLY: "只检测不维修",
  DEBUGGING: "调试",
  TRANSFER_HQ: "转寄总部",
}

const LOCKED_STATUSES = new Set(["SHIPPED_PENDING_COMPLETION", "COMPLETED"])
const DELETE_LOCKED_STATUSES = new Set(["REPAIR_COMPLETED_PENDING_SHIPMENT", "SHIPPED_PENDING_COMPLETION", "COMPLETED"])
const STATUS_LABELS = {
  INSPECTION_COMPLETED_PENDING_REPAIR: "待维修处理",
  REPAIR_COMPLETED_PENDING_SHIPMENT: "维修完成待发货",
  SHIPPED_PENDING_COMPLETION: "已发货待完结",
  COMPLETED: "已完结"
}

function technicianName(order) {
  return order.technicianName || order.operatorName || "未记录"
}

function canReopen(order) {
  return Boolean(
    order.receiptCompletedAt
    && (order.treatmentMode || order.repairCompletion)
    && !LOCKED_STATUSES.has(order.status)
    && !order.returnShipment?.shippedAt
  )
}

function canDelete(order) {
  return Boolean(order.receiptCompletedAt && !DELETE_LOCKED_STATUSES.has(order.status) && !order.returnShipment?.shippedAt)
}

function AdminRepairRecovery({ setPage }) {
  const [orders, setOrders] = useState([])
  const [keyword, setKeyword] = useState("")
  const [message, setMessage] = useState("")
  const [loading, setLoading] = useState(true)
  const [workingRmaNo, setWorkingRmaNo] = useState("")

  useEffect(() => {
    let active = true
    getLocalRepairOrders()
      .then((data) => {
        if (!active || !Array.isArray(data)) return
        setOrders(data)
        // This administrator-only view receives the complete local order list.
        // Heal stale browser state left by deletion in another tab/session.
        const current = getCurrentRepairOrder()
        if (getCurrentUser()?.role === USER_ROLES.ADMIN
          && current?.crmOrderNo && current.status !== REPAIR_STATUS.WAIT_RECEIPT
          && !data.some(order => order.rmaNo === current.crmOrderNo)) {
          removeDeletedRepairOrder(current.crmOrderNo)
        }
      })
      .catch((error) => { if (active) setMessage(error.message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const results = useMemo(() => {
    const normalized = keyword.trim().toUpperCase()
    return [...orders]
      .filter((order) => order.receiptCompletedAt)
      .filter((order) => !normalized || [
        order.rmaNo,
        order.logisticsNo,
        order.sn,
        order.phone,
        order.phoneMasked,
        order.customerName,
      ].some((value) => String(value || "").toUpperCase().includes(normalized)))
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
  }, [orders, keyword])
  const recoverableCount = results.filter(canReopen).length

  async function reopen(order) {
    const mode = MODE_LABELS[order.treatmentMode] || order.treatmentLabel || "已完成处理"
    const confirmed = window.confirm(
      `确定恢复工单 ${order.rmaNo} 吗？\n\n当前处理方式：${mode}\n原维修师傅：${technicianName(order)}\n\n恢复后会撤回当前处理结果，工单回到“选择处理方式”；签收资料、SN、原师傅和已申请配件会保留。`
    )
    if (!confirmed) return
    try {
      setWorkingRmaNo(order.rmaNo)
      setMessage("")
      const updated = await reopenRepairTreatment(order.rmaNo)
      setOrders((current) => current.map((item) => item.rmaNo === order.rmaNo ? updated : item))
      setMessage(`${order.rmaNo} 已恢复，${technicianName(order)} 再次进入工单时会从“选择处理方式”继续。`)
    } catch (error) {
      setMessage(error.message)
    } finally {
      setWorkingRmaNo("")
    }
  }

  async function removeMistakenOrder(order) {
    const confirmed = window.confirm(
      `确定从 FieldDesk 删除误操作工单 ${order.rmaNo} 吗？\n\nSN：${order.sn || "未录入"}\n维修师傅：${technicianName(order)}\n\n该操作会停止后续自动同步；已完工、已发货或已完结工单不能删除。`
    )
    if (!confirmed) return
    try {
      setWorkingRmaNo(order.rmaNo)
      setMessage("")
      await deleteLocalRepairOrder(order.rmaNo)
      removeDeletedRepairOrder(order.rmaNo)
      setOrders((current) => current.filter((item) => item.rmaNo !== order.rmaNo))
      setMessage(`${order.rmaNo} 已从 FieldDesk 删除，后续自动同步已停止。`)
    } catch (error) {
      setMessage(error.message)
    } finally {
      setWorkingRmaNo("")
    }
  }

  return <div className="page admin-recovery-page">
    <div className="top-bar">
      <button type="button" className="arrow-back" aria-label="退出应用" onClick={() => setPage("appBack")}>←</button>
      <div><small>管理员 / 负责人权限</small><h1>工单恢复</h1></div>
    </div>

    <div className="card admin-recovery-intro backoffice-intro-card">
      <span className="backoffice-intro-icon">↶</span>
      <div><strong>恢复或清理异常工单</strong><p>可恢复到“选择处理方式”，也可删除误操作工单并停止后续自动同步；已完工、已发货或已完结工单不可删除。</p></div>
    </div>

    <div className="card admin-recovery-search compact-search-card">
      <div className="section-title-row"><div><small>快速定位</small><h2>查找工单</h2></div><span>{results.length} 条</span></div>
      <input
        id="recovery-keyword"
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
        placeholder="寄修单号 / 物流单号 / SN / 电话 / 用户姓名"
      />
    </div>

    {message && <p className="admin-recovery-message" role="status">{message}</p>}
    {!loading && <div className="result-summary-bar"><span>可恢复 <strong>{recoverableCount}</strong></span><span>不可恢复 <strong>{results.length - recoverableCount}</strong></span></div>}
    {loading ? <div className="card compact-loading-state"><p>正在读取工单…</p></div> : <div className="admin-recovery-list compact-result-list">
      {results.map((order) => {
        const reopenAvailable = canReopen(order)
        const deleteAvailable = canDelete(order)
        const mode = MODE_LABELS[order.treatmentMode] || order.treatmentLabel || "未选择处理方式"
        return <details className="card admin-recovery-order compact-record-card" key={order.rmaNo}>
          <summary>
            <span className="compact-record-main"><small>寄修单号</small><strong>{order.rmaNo}</strong><em>{order.productLine || order.specialty || "品类未记录"} · SN {order.sn || "未录入"}</em></span>
            <span className={deleteAvailable ? "record-status recoverable" : "record-status locked"}>{deleteAvailable ? mode : "不可操作"}</span><b>⌄</b>
          </summary>
          <div className="compact-record-detail">
            <div><small>原维修师傅</small><strong>{technicianName(order)}</strong></div>
            <div><small>当前处理</small><strong>{mode}</strong></div>
            <div><small>当前状态</small><strong>{STATUS_LABELS[order.status] || order.status || "未记录"}</strong></div>
          </div>
          <button type="button" disabled={!reopenAvailable || workingRmaNo === order.rmaNo} onClick={() => reopen(order)}>
            {workingRmaNo === order.rmaNo ? "正在处理…" : reopenAvailable ? "恢复到选择处理方式" : "当前已在处理方式选择前"}
          </button>
          <button type="button" className="danger-outline-button" disabled={!deleteAvailable || workingRmaNo === order.rmaNo} onClick={() => removeMistakenOrder(order)}>
            {workingRmaNo === order.rmaNo ? "正在处理…" : deleteAvailable ? "删除误操作工单" : "已完工、已发货或已完结，不能删除"}
          </button>
        </details>
      })}
      {!results.length && <div className="card admin-recovery-empty"><p>没有找到已签收工单</p></div>}
    </div>}
  </div>
}

export default AdminRepairRecovery
