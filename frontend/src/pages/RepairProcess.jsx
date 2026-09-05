import { useEffect, useRef, useState } from "react"
import { saveInspection, saveRepairResumeStep, searchRecloudFaultCategories, startRepair } from "../shared/crmService.js"
import SupervisionNoticeCard from "../components/SupervisionNoticeCard.jsx"
import { rankFaultOptions } from "../shared/faultSearch.js"
import {
  getCurrentRepairOrder,
  REPAIR_STATUS,
  updateRepairOrder
} from "../shared/repairOrderStore.js"


function RepairProcess({ setPage }) {

  const [repairOrder, setRepairOrder] = useState(() =>
    getCurrentRepairOrder()
  )
  const [faultCategory, setFaultCategory] = useState(
    repairOrder.level3Fault || ""
  )
  const technicianWarranty = repairOrder.warrantyType || ""
  const [faultOptions, setFaultOptions] = useState([])
  const [faultCategoryConfirmed, setFaultCategoryConfirmed] = useState(Boolean(repairOrder.level3Fault))
  const [faultDropdownOpen, setFaultDropdownOpen] = useState(false)
  const [isSearchingFault, setIsSearchingFault] = useState(false)
  const faultSearchSequence = useRef(0)
  const [message, setMessage] = useState("")
  const [errorMessage, setErrorMessage] = useState("")
  const [isSaving, setIsSaving] = useState(false)
  const [recloudPrefillPlan, setRecloudPrefillPlan] = useState(null)
  const inspectionIsSaved = Boolean(repairOrder.level3Fault && repairOrder.warrantyType)
    || [REPAIR_STATUS.INSPECTION_COMPLETE, REPAIR_STATUS.REPAIRING].includes(repairOrder.status)

  useEffect(() => {
    const keyword = faultCategory.trim()
    if (!keyword || faultCategoryConfirmed) {
      return undefined
    }
    const sequence = ++faultSearchSequence.current
    const timer = window.setTimeout(async () => {
      try {
        setIsSearchingFault(true)
        setErrorMessage("")
        const result = await searchRecloudFaultCategories({
          rmaNo: repairOrder.crmOrderNo,
          logisticsNo: repairOrder.logisticsNo,
          faultKeyword: keyword
        })
        if (sequence !== faultSearchSequence.current) return
        const options = rankFaultOptions(result.items || [], {
          reportedFault: repairOrder.originalFault,
          parts: repairOrder.parts
        })
        setFaultOptions(options)
        setFaultDropdownOpen(true)
        if (!options.length) setErrorMessage(result.syncedAt ? "本地瑞云目录没有匹配项" : "瑞云三级故障目录尚未同步")
      } catch (error) {
        if (sequence === faultSearchSequence.current) setErrorMessage(error.message)
      } finally {
        if (sequence === faultSearchSequence.current) setIsSearchingFault(false)
      }
    }, 80)
    return () => window.clearTimeout(timer)
  }, [faultCategory, faultCategoryConfirmed, repairOrder.crmOrderNo, repairOrder.logisticsNo, repairOrder.originalFault, repairOrder.parts])


  async function saveDetection() {
    if (!faultCategory.trim()) {
      setErrorMessage("请选择三级故障分类")
      return
    }
    if (!faultCategoryConfirmed) {
      setErrorMessage("请从瑞云返回的三级故障选项中选择")
      return
    }
    if (!technicianWarranty) {
      setErrorMessage("请先返回确认保修状态")
      return
    }
    try {
      setIsSaving(true)
      setErrorMessage("")
      const result = await saveInspection({
        rmaNo: repairOrder.crmOrderNo,
        inspectionResult: "",
        inspectionRemark: "",
        faultCategory: faultCategory.trim(),
        faultCategoryConfirmed: true,
        technicianWarranty,
      })
      const updated = updateRepairOrder({
        inspectionResult: result.inspectionResult || "维修",
        level3Fault: faultCategory.trim(),
        warrantyType: technicianWarranty,
        status: REPAIR_STATUS.INSPECTION_COMPLETE
      })
      setRepairOrder(updated)
      setRecloudPrefillPlan(result.recloudPrefillPlan || null)
      setMessage(result.message || "检测信息已保存到 FieldDesk")
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setIsSaving(false)
    }
  }

  async function enterRepair() {
    try {
      setIsSaving(true)
      setErrorMessage("")
      const result = await startRepair(repairOrder.crmOrderNo)
      const updated = updateRepairOrder({
        status: REPAIR_STATUS.REPAIRING,
        resumeStep: "repairCompletion",
      })
      setRepairOrder(updated)
      setMessage(result.message || "已进入维修")
      setPage("repairCompletion")
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setIsSaving(false)
    }
  }

  async function navigateToSavedStep(nextPage) {
    try {
      setIsSaving(true)
      setErrorMessage("")
      await saveRepairResumeStep(repairOrder.crmOrderNo, nextPage)
      setPage(nextPage)
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setIsSaving(false)
    }
  }

  function returnToPreviousStep() {
    navigateToSavedStep(repairOrder.treatmentMode === "REPAIR" ? "partsApplication" : "repairDecision")
  }

  return (
    <div className="page repair-process-page">

      <div className="top-bar">
        <button className="arrow-back" onClick={returnToPreviousStep} disabled={isSaving}>
          ←
        </button>
        <h1>检测登记</h1>
      </div>

      <div className="card machine-info-card">
        <div className="machine-card-header">
          <h2>机器信息</h2>
          <span className="repair-status-badge status-working">
            {inspectionIsSaved
              ? "已检测"
              : "待检测"}
          </span>
        </div>
        <div className="mobile-record-hero">
          <span>寄修单号</span>
          <strong>{repairOrder.crmOrderNo || "-"}</strong>
          <small>{repairOrder.product || "待确认品类"}</small>
        </div>
        <dl className="mobile-record-grid">
          <div><dt>物流单号</dt><dd>{repairOrder.logisticsNo || "-"}</dd></div>
          <div><dt>机器 SN</dt><dd>{repairOrder.sn || "-"}</dd></div>
          <div><dt>产品线</dt><dd>{repairOrder.product || "-"}</dd></div>
          <div><dt>维修师傅</dt><dd>{repairOrder.technician || "本地测试用户"}</dd></div>
        </dl>
        <div className="mobile-record-description">
          <span>报修描述</span>
          <p>{repairOrder.originalFault || "未提供"}</p>
        </div>
      </div>

      <SupervisionNoticeCard rmaNo={repairOrder.crmOrderNo} />

      <div className="card">
        <h2>检测记录</h2>

        <label htmlFor="fault-category">故障三级分类（快速搜索）</label>
        <div className="fault-autocomplete">
          <input id="fault-category" value={faultCategory} autoComplete="off" onFocus={() => faultOptions.length && setFaultDropdownOpen(true)} onChange={(event) => {
            setFaultCategory(event.target.value)
            if (!event.target.value.trim()) setFaultOptions([])
            setFaultCategoryConfirmed(false)
            setFaultDropdownOpen(false)
          }} placeholder="优先按更换配件名称搜索，例如：上下水模组" />
          {isSearchingFault && <span className="fault-searching">正在搜索本地目录…</span>}
          {faultDropdownOpen && faultOptions.length > 0 && (
            <div className="fault-options" role="listbox" aria-label="瑞云三级故障分类">
              {faultOptions.map((item) => (
                <button key={item} type="button" role="option" onClick={() => {
                  setFaultCategory(item)
                  setFaultCategoryConfirmed(true)
                  setFaultDropdownOpen(false)
                  setErrorMessage("")
                }}>{item}</button>
              ))}
            </div>
          )}
        </div>
        {faultCategoryConfirmed && <p className="success-text">已选择瑞云三级故障分类</p>}

        <p className={`warranty-status-line ${technicianWarranty === "保外" ? "warranty-out" : "warranty-in"}`}><strong>保修状态</strong><span>{technicianWarranty || "未确认"}</span></p>

        {errorMessage && <p className="error-message">{errorMessage}</p>}
        {message && <p role="status">{message}</p>}

        {recloudPrefillPlan && (
          <div className="recloud-review-card" aria-label="瑞云检测预填复核清单">
            <h3>瑞云预填复核清单</h3>
            <p>以下内容已由 FieldDesk 生成，提交瑞云前必须由师傅逐项核对。</p>
            <dl>
              {recloudPrefillPlan.safeWrites
                .filter((item) => !/耗材名称|是否拆封/.test(item.target || ""))
                .map((item) => (
                <div key={item.key}>
                  <dt>{item.target}</dt>
                  <dd>{item.value || "保持空白"}</dd>
                </div>
              ))}
            </dl>
            <p className="dry-run-notice">责任判定保持空白；系统不会自动点击瑞云“确认”。</p>
          </div>
        )}

        <div className="inspection-actions">
          {inspectionIsSaved && repairOrder.treatmentMode === "REPAIR" ? (
            <button className="secondary-btn" onClick={() => navigateToSavedStep("partsApplication")} disabled={isSaving}>
              返回添加配件
            </button>
          ) : !inspectionIsSaved ? (
            <button
              className="primary-btn"
              onClick={saveDetection}
              disabled={isSaving}
            >
              {isSaving ? "正在检测..." : "检测"}
            </button>
          ) : null}
          {inspectionIsSaved && repairOrder.treatmentMode === "REPAIR" && (
            <button className="primary-btn" onClick={enterRepair} disabled={isSaving}>
              {isSaving ? "正在进入维修..." : "维修"}
            </button>
          )}
          {inspectionIsSaved && repairOrder.treatmentMode !== "REPAIR" && (
            <button className="primary-btn" onClick={() => navigateToSavedStep("repairCompletion")} disabled={isSaving}>
              进入处理结果
            </button>
          )}
        </div>

        <p className="dry-run-notice">
          “检测”只完成瑞云寄修单检测；“维修”才创建瑞云维修服务单
        </p>
      </div>

    </div>
  )
}

export default RepairProcess
