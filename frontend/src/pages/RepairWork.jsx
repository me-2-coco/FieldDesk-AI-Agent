import { useState } from "react"
import SupervisionNoticeCard from "../components/SupervisionNoticeCard.jsx"
import {
  getCurrentRepairOrder,
  updateRepairOrder,
  updateStatusByAction
} from "../shared/repairOrderStore.js"


// 实际维修阶段：配件、维修经过、维修完成
function RepairWork({ setPage }) {

  const [repairOrder, setRepairOrder] = useState(() =>
    getCurrentRepairOrder()
  )

  const [solution, setSolution] = useState(
    repairOrder.repairWorkNote || ""
  )


  function finishRepair() {

    const updated = updateRepairOrder({ repairWorkNote: solution.trim() })

    updateStatusByAction("FINISH_REPAIR")

    setRepairOrder(updated)
    setPage("repairProcess")
  }


  return (
    <div className="page repair-work-page">

      <div className="top-bar">
        <button className="arrow-back" onClick={() => setPage("partsApplication")}>
          ←
        </button>
        <h1>维修</h1>
      </div>

      <SupervisionNoticeCard rmaNo={repairOrder.crmOrderNo} />

      <div className="card machine-info-card">

        <div className="machine-card-header">
          <h2>📦机器信息</h2>
          <span className="repair-status-badge status-working">维修中</span>
        </div>

        <p>工单号：{repairOrder.crmOrderNo || "-"}</p>
        <p>产品：{repairOrder.product || "-"}</p>
        <p>SN：{repairOrder.sn || "-"}</p>
        <p>用户故障描述：{repairOrder.originalFault || "未提供"}</p>
        <p>维修师傅：{repairOrder.technician || "本地测试师傅"}</p>

      </div>

      <div className="card">
        <h2>本次维修配件</h2>
        {repairOrder.parts && repairOrder.parts.length > 0 ? (
          repairOrder.parts.map((item, index) => (
            <p key={index}>{item.name} × {item.quantity}</p>
          ))
        ) : (
          <p>本单未登记更换配件</p>
        )}
      </div>

      <div className="card">
        <h2>实际维修记录</h2>
        <textarea
          value={solution}
          placeholder="可选：记录拆机、清洁、更换、调试等实际维修经过"
          onChange={e => setSolution(e.target.value)}
        />
        <p className="upload-tip">瑞云维修描述将在完工确认时根据保内/保外和配件自动生成。</p>
      </div>

      <button className="primary-btn" onClick={finishRepair}>
        维修完成，进入检测登记
      </button>

    </div>
  )
}

export default RepairWork
