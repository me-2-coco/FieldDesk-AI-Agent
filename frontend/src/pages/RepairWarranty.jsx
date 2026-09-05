import { useEffect, useState } from "react"
import SupervisionNoticeCard from "../components/SupervisionNoticeCard.jsx"
import { checkInspectionWarranty, confirmInspectionWarranty } from "../shared/crmService.js"
import { getCurrentRepairOrder, REPAIR_STATUS, updateRepairOrder } from "../shared/repairOrderStore.js"

function RepairWarranty({ setPage }) {
  const [repairOrder, setRepairOrder] = useState(() => getCurrentRepairOrder())
  const [decision, setDecision] = useState(repairOrder.warrantyDecision || null)
  const [selectedWarranty, setSelectedWarranty] = useState(repairOrder.warrantyType || "")
  const [conversionRequested, setConversionRequested] = useState(
    repairOrder.manufacturerWarrantyConversion?.requested === true
  )
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState("")

  useEffect(() => {
    let active = true
    checkInspectionWarranty({ rmaNo: repairOrder.crmOrderNo, sn: repairOrder.sn })
      .then((result) => {
        if (!active) return
        setDecision(result)
        setSelectedWarranty((current) => current || result.warrantyStatus || "")
      })
      .catch((error) => active && setErrorMessage(error.message))
    return () => { active = false }
  }, [repairOrder.crmOrderNo, repairOrder.sn])

  async function confirmWarranty() {
    if (decision?.status !== "DETERMINED") {
      setErrorMessage(decision?.reason || "保修状态尚未明确")
      return
    }
    try {
      setBusy(true)
      setErrorMessage("")
      if (!["保内", "保外"].includes(selectedWarranty)) throw new Error("请确认最终保修状态")
      const result = await confirmInspectionWarranty(repairOrder.crmOrderNo, selectedWarranty, conversionRequested)
      const updated = updateRepairOrder({
        warrantyType: result.technicianWarranty,
        warrantyDecision: result.warrantyDecision,
        manufacturerWarrantyConversion: result.manufacturerWarrantyConversion,
        status: REPAIR_STATUS.WAIT_DECISION,
        resumeStep: "repairDecision",
      })
      setRepairOrder(updated)
      setPage("repairDecision")
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setBusy(false)
    }
  }

  const determined = decision?.status === "DETERMINED"
  return <div className="page repair-warranty-page">
    <div className="top-bar">
      <button className="arrow-back" onClick={() => setPage("repair")}>←</button>
      <h1>确认保修状态</h1>
    </div>
    <SupervisionNoticeCard rmaNo={repairOrder.crmOrderNo} />
    <section className="card warranty-confirm-card">
      <div className="mobile-record-hero">
        <span>机器 SN</span>
        <strong>{repairOrder.sn || "-"}</strong>
        <small>{repairOrder.product || "待确认品类"}</small>
      </div>
      <div className={`warranty-decision-panel ${determined && selectedWarranty === "保外" ? "is-out" : "is-in"}`}>
        <small>{determined && selectedWarranty !== decision.warrantyStatus ? "师傅已调整" : "系统判断"}</small>
        <strong>{determined ? selectedWarranty : "等待确认"}</strong>
        <p>{determined
          ? selectedWarranty !== decision.warrantyStatus
            ? `系统原判断：${decision.warrantyStatus}`
            : decision.source === "PURCHASE_DATE" ? "依据购买日期判断" : "依据 SN 生产日期并加 3 个月判断"
          : decision?.reason || "正在计算保修状态…"}</p>
      </div>
      {determined && <div className="warranty-choice-section">
        <div className="receipt-upload-heading"><div><strong>判断不对时再调整</strong><span>无需修改可直接进入下一步</span></div></div>
        <div className="warranty-option-grid" role="radiogroup" aria-label="最终保修状态">
          {["保内", "保外"].map((item) => <button key={item} type="button" className={selectedWarranty === item ? "active" : ""} onClick={() => {
            setSelectedWarranty(item)
            if (item === "保内") setConversionRequested(false)
          }}><span>{selectedWarranty === item ? "✓" : ""}</span><strong>{item}</strong>{decision.warrantyStatus === item && <small>系统建议</small>}</button>)}
        </div>
        {selectedWarranty === "保外" && <div className="warranty-conversion-choice">
          <div className="receipt-upload-heading"><div><strong>特殊处理</strong><span>需要申请时勾选，不申请可直接下一步</span></div></div>
          <div className="warranty-option-grid warranty-conversion-option">
            <button type="button" className={conversionRequested ? "active" : ""} aria-pressed={conversionRequested} onClick={() => setConversionRequested((current) => !current)}>
              <span>{conversionRequested ? "✓" : ""}</span>
              <strong>保外转保内</strong>
              <small>{conversionRequested ? "已选择，将通知信息员申请" : "点击勾选"}</small>
            </button>
          </div>
        </div>}
      </div>}
      {errorMessage && <p className="error-message">{errorMessage}</p>}
      <button className="primary-btn" onClick={confirmWarranty} disabled={busy || !determined || !selectedWarranty}>
        {busy ? "正在确认…" : determined ? `确认${selectedWarranty || "保修状态"}，选择处理方式` : "保修状态尚未明确"}
      </button>
      <p className="form-hint">先确认保内或保外，再决定维修、弃修、只检测或调试。</p>
    </section>
  </div>
}

export default RepairWarranty
