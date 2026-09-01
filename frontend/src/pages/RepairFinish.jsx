import { useState } from "react"
import {
  getCurrentRepairOrder,
  updateStatusByAction
} from "../shared/repairOrderStore.js"
import WarrantyBadge from "../components/WarrantyBadge.jsx"


// 把完成的工单也写进 Records.jsx 读取的 repairRecords 列表，
// 这样"维修记录"页面才能看到已完成的维修
function appendToRepairRecords(order) {

  let storedRecords

  try {
    storedRecords = JSON.parse(
      localStorage.getItem("repairRecords") || "[]"
    )
  } catch {
    storedRecords = []
  }
  const records = Array.isArray(storedRecords) ? storedRecords : []

  const record = {
    id: order.id,
    orderId: order.id,
    product: order.product,
    customer: order.customer,
    phone: order.phone,
    sn: order.sn,
    technician: order.technician || "张师傅",
    completedAt: new Date().toLocaleString(),
    parts: order.parts || []
  }

  const withoutOldEntry = records.filter(
    (item) => item.id !== record.id
  )

  localStorage.setItem(
    "repairRecords",
    JSON.stringify([...withoutOldEntry, record])
  )
}


function RepairFinish({ setPage }) {

  const [repairOrder] = useState(() =>
    getCurrentRepairOrder()
  )
  const completedDetail = ["REPAIR_COMPLETED_PENDING_SHIPMENT", "SHIPPED_PENDING_COMPLETION", "COMPLETED"].includes(repairOrder?.status)


  function submitRepair() {

    const updated = updateStatusByAction("CONFIRM_COMPLETION")

    appendToRepairRecords(updated)

    setPage("home")
  }


  return (
    <div className="page repair-finish-page">

      <div className="top-bar">
        <button className="arrow-back" onClick={() => setPage(completedDetail ? "home" : "repairWork")}>
          ←
        </button>
        <h1>{completedDetail ? "维修完成详情" : "提交确认"}</h1>
      </div>

      <div className="card report-card machine-info-card">

        <div className="machine-card-header">
          <h2>📦机器信息</h2>
          <span className="repair-status-badge status-working">维修完成</span>
        </div>

        <div className="machine-info-list">
          <p>客户： {repairOrder.customer || "王先生"}</p>
          <p>电话： {repairOrder.phone || "13688886666"}</p>
          <p>产品： {repairOrder.product || "扫地机器人X2"}</p>
          <p>序列号： {repairOrder.sn || "-"}</p>
          <p>物流单号：{repairOrder.logisticsNo || "-"}</p>
          <p>CRM编号：{repairOrder.crmOrderNo || "-"}</p>
        </div>

      </div>

      <div className="card report-card">
        <h2>🔧 故障描述</h2>
        <p>{repairOrder.originalFault || "机器运行时异响"}</p>
      </div>

      <div className="card report-card">
        <h2>🧩 故障分类</h2>
        <p>{repairOrder.level3Fault || "未选择"}</p>
      </div>

      <div className="card report-card">
        <h2>🛠维修措施</h2>
        <p>{repairOrder.solution || "暂无"}</p>
      </div>

      <div className="card report-card">
        <h2>📦 本次使用配件</h2>
        {repairOrder.parts && repairOrder.parts.length > 0 ? (
          repairOrder.parts.map((item, index) => (
            <p key={index}>{item.name} × {item.quantity}</p>
          ))
        ) : (
          <p>暂无配件</p>
        )}
      </div>

      <div className="card report-card">
        <h2>📷照片/视频</h2>
        <p>
          {repairOrder.photos && repairOrder.photos.length > 0
            ? `已上传 ${repairOrder.photos.length} 个文件`
            : "暂无"}
        </p>
      </div>

      <div className="card report-card">
        <h2>🛡保内保外</h2>
        <p><WarrantyBadge value={repairOrder.warrantyType} fallback="未判断" /></p>
      </div>

      {completedDetail ? (
        <button className="secondary-btn" onClick={() => setPage("home")}>返回首页</button>
      ) : (
        <button className="primary-btn" onClick={submitRepair}>确认提交维修</button>
      )}

    </div>
  )
}

export default RepairFinish
