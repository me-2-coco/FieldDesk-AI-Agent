import { useState } from "react"
import {
  getCurrentRepairOrder,
  updateRepairOrder,
  updateStatusByAction
} from "../shared/repairOrderStore.js"


// 维修阶段：故障分类 + 维修措施 + 上传 + 维修完成
function RepairWork({ setPage }) {

  const [repairOrder, setRepairOrder] = useState(() =>
    getCurrentRepairOrder()
  )

  const [faultKeyword, setFaultKeyword] = useState(
    repairOrder.level3Fault || ""
  )
  const [selectedFault, setSelectedFault] = useState(null)
  const [solution, setSolution] = useState(
    repairOrder.solution || ""
  )


  const faultList = [
    { system: "电源系统", fault: "电池容量不足", solution: "更换电池", part: "电池包" },
    { system: "主机系统", fault: "运行异响", solution: "检查电机并更换异常部件", part: "主刷电机" },
    { system: "导航系统", fault: "无法定位", solution: "检查传感器", part: "雷达模块" }
  ]

  const resultList = faultList.filter(item =>
    item.fault.includes(faultKeyword) ||
    item.system.includes(faultKeyword)
  )


  function chooseFault(item) {
    setSelectedFault(item)
    setFaultKeyword(item.fault)
    if (!solution) {
      setSolution(item.solution)
    }
  }


  function finishRepair() {

    const updated = updateRepairOrder({
      faultSystem: selectedFault ? selectedFault.system : repairOrder.faultSystem,
      level3Fault: faultKeyword,
      solution
    })

    updateStatusByAction("FINISH_REPAIR")

    setRepairOrder(updated)
    setPage("repairFinish")
  }


  return (
    <div className="page repair-work-page">

      <div className="top-bar">
        <button className="arrow-back" onClick={() => setPage("repairProcess")}>
          ←
        </button>
        <h1>维修</h1>
      </div>

      <div className="card machine-info-card">

        <div className="machine-card-header">
          <h2>📦机器信息</h2>
          <span className="repair-status-badge status-working">维修中</span>
        </div>

        <p>客户：{repairOrder.customer || "王先生"}</p>
        <p>电话：{repairOrder.phone || "13688886666"}</p>
        <p>产品：{repairOrder.product || "扫地机器人X2"}</p>
        <p>SN：{repairOrder.sn || "暂无"}</p>
        <p>用户故障描述：{repairOrder.originalFault || "机器运行时异响"}</p>

      </div>

      <div className="card">

        <h2>🧩CRM故障分类</h2>

        <input
          value={faultKeyword}
          placeholder="搜索三级故障"
          onChange={e => setFaultKeyword(e.target.value)}
        />

        {faultKeyword && resultList.length > 0 && (
          <div>
            {resultList.map((item, index) => (
              <div key={index} className="fault-item" onClick={() => chooseFault(item)}>
                <div>系统：{item.system}</div>
                <div>故障：{item.fault}</div>
                <div>维修方案：{item.solution}</div>
                <div>配件：{item.part}</div>
              </div>
            ))}
          </div>
        )}

        {selectedFault && (
          <div className="selected-card">
            <h3>已选择故障</h3>
            <p>系统：{selectedFault.system}</p>
            <p>三级故障：{selectedFault.fault}</p>
            <p>维修方案：{selectedFault.solution}</p>
            <p>建议配件：{selectedFault.part}</p>
          </div>
        )}

      </div>

      <div className="card">
        <h2>🛠维修措施</h2>
        <textarea
          value={solution}
          placeholder="填写维修措施"
          onChange={e => setSolution(e.target.value)}
        />
      </div>

      <div className="card upload-card">
        <h2>📷 上传照片/视频</h2>
        <input type="file" accept="image/*,video/*" multiple />
        <p className="upload-tip">支持上传维修前后照片、维修视频</p>
      </div>

      <div className="card">
        <h2>📦本次申请配件</h2>
        {repairOrder.parts && repairOrder.parts.length > 0 ? (
          repairOrder.parts.map((item, index) => (
            <p key={index}>{item.name} × {item.quantity}</p>
          ))
        ) : (
          <p>暂无配件</p>
        )}
      </div>

      <button className="primary-btn" onClick={finishRepair}>
        维修完成
      </button>

    </div>
  )
}

export default RepairWork
