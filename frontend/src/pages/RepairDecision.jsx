import { useState } from "react"
import SupervisionNoticeCard from "../components/SupervisionNoticeCard.jsx"
import { saveTreatmentDecision, transferToHeadquarters } from "../shared/crmService.js"
import { getCurrentRepairOrder, REPAIR_STATUS, updateRepairOrder } from "../shared/repairOrderStore.js"

const OPTIONS = [
  { value: "REPAIR", title: "维修", badge: "需配件", description: "需要更换配件，下一步申请配件。", next: "申请配件" },
  { value: "ABANDONED", title: "弃修", badge: "免配件", description: "用户不维修，下一步登记故障分类并完成检测。", next: "填写检测" },
  { value: "INSPECTION_ONLY", title: "只检测不维修", badge: "检测报告", description: "不申请配件，下一步登记故障分类并完成检测。", next: "填写检测" },
  { value: "DEBUGGING", title: "调试", badge: "免配件", description: "无硬件故障，下一步登记故障分类并完成检测。", next: "填写检测" },
  { value: "TRANSFER_TO_HEADQUARTERS", title: "转寄总部", badge: "转总部", description: "网点不继续处理，登记后转寄总部。", next: "结束网点流程" },
]

function RepairDecision({ setPage }) {
  const [repairOrder, setRepairOrder] = useState(() => getCurrentRepairOrder())
  const [selected, setSelected] = useState(repairOrder.treatmentMode || "")
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState("")

  async function continueFlow() {
    if (!selected) return setErrorMessage("请选择这台机器接下来如何处理")
    try {
      setBusy(true)
      setErrorMessage("")
      const result = selected === "TRANSFER_TO_HEADQUARTERS"
        ? await transferToHeadquarters(repairOrder.crmOrderNo)
        : await saveTreatmentDecision(repairOrder.crmOrderNo, selected)
      const updated = updateRepairOrder({
        treatmentMode: result.treatmentMode || selected,
        treatmentLabel: result.treatmentLabel || OPTIONS.find((item) => item.value === selected)?.title,
        inspectionResult: result.detectionResult,
        warrantyType: result.technicianWarranty || repairOrder.warrantyType,
        status: REPAIR_STATUS.WAIT_INSPECTION,
      })
      setRepairOrder(updated)
      setPage(selected === "TRANSFER_TO_HEADQUARTERS" ? "home" : result.nextStep)
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setBusy(false)
    }
  }

  return <div className="page repair-decision-page">
    <div className="repair-decision-header">
      <button className="arrow-back" onClick={() => setPage("repairWarranty")}>←</button>
      <div>
        <span>工单处理</span>
        <h1>维修处理</h1>
      </div>
    </div>
    <SupervisionNoticeCard rmaNo={repairOrder.crmOrderNo} />
    <section className="card treatment-order-card">
      <span className="treatment-order-icon">单</span>
      <div className="treatment-order-copy">
        <span>当前工单</span>
        <h2>{repairOrder.crmOrderNo || "当前工单"}</h2>
        <p><strong>{repairOrder.product || "品类待确认"}</strong><i>SN {repairOrder.sn || "未录入"}</i></p>
      </div>
      <small>已签收</small>
    </section>
    <section className="card treatment-choice-card">
      <div className="treatment-choice-heading">
        <div><span>处理方案</span><h2>请选择本单处理方式</h2></div>
        <strong>5 选 1</strong>
      </div>
      <p className="treatment-choice-tip">选择后，系统会自动进入对应的下一步。</p>
      <div className="treatment-option-list">
        {OPTIONS.map((option) => <button key={option.value} type="button" className={`treatment-option ${selected === option.value ? "is-selected" : ""}`} onClick={() => { setSelected(option.value); setErrorMessage("") }} aria-pressed={selected === option.value}>
          <span className="treatment-option-icon">{selected === option.value ? "✓" : ""}</span>
          <span className="treatment-option-copy">
            <span><strong>{option.title}</strong><small>{option.badge}</small></span>
            <p>{option.description}</p>
            <em>{option.next} →</em>
          </span>
        </button>)}
      </div>
      {errorMessage && <p className="error-message">{errorMessage}</p>}
      <button className="primary-btn" onClick={continueFlow} disabled={busy || !selected}>
        {busy ? "正在保存处理方式..." : selected ? `确认${OPTIONS.find((item) => item.value === selected)?.title}并继续` : "请先选择处理方式"}
      </button>
    </section>
  </div>
}

export default RepairDecision
