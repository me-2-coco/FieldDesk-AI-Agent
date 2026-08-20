import { useEffect, useRef, useState } from "react"
import { checkInspectionWarranty, getSupervisionOrders, saveInspection, searchRecloudFaultCategories } from "../shared/crmService.js"
import { getPreferredFaultKeyword, rankFaultOptions } from "../shared/faultSearch.js"
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
    repairOrder.level3Fault || getPreferredFaultKeyword(repairOrder.parts, repairOrder.originalFault)
  )
  const [technicianWarranty, setTechnicianWarranty] = useState(repairOrder.warrantyType || "")
  const [warrantyDecision, setWarrantyDecision] = useState(null)
  const [faultOptions, setFaultOptions] = useState([])
  const [faultCategoryConfirmed, setFaultCategoryConfirmed] = useState(Boolean(repairOrder.level3Fault))
  const [faultDropdownOpen, setFaultDropdownOpen] = useState(false)
  const [isSearchingFault, setIsSearchingFault] = useState(false)
  const faultSearchSequence = useRef(0)
  const [message, setMessage] = useState("")
  const [errorMessage, setErrorMessage] = useState("")
  const [isSaving, setIsSaving] = useState(false)
  const [supervisionOrders, setSupervisionOrders] = useState([])

  useEffect(() => {
    let active = true
    getSupervisionOrders(repairOrder.crmOrderNo)
      .then((items) => active && setSupervisionOrders(items || []))
      .catch(() => {})
    return () => { active = false }
  }, [repairOrder.crmOrderNo])

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
    }, 450)
    return () => window.clearTimeout(timer)
  }, [faultCategory, faultCategoryConfirmed, repairOrder.logisticsNo, repairOrder.originalFault, repairOrder.parts])


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
      setErrorMessage("请选择师傅判断的保修状态")
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
      setMessage(result.message || "检测信息已保存到 FieldDesk")
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setIsSaving(false)
    }
  }

  async function checkWarranty() {
    try {
      setErrorMessage("")
      const result = await checkInspectionWarranty({
        rmaNo: repairOrder.crmOrderNo,
        sn: repairOrder.sn
      })
      setWarrantyDecision(result)
    } catch (error) {
      setErrorMessage(error.message)
    }
  }

  return (
    <div className="page repair-process-page">

      <div className="top-bar">
        <button className="arrow-back" onClick={() => setPage("repairWork")}>
          ←
        </button>
        <h1>检测登记</h1>
      </div>

      <div className="card machine-info-card">
        <div className="machine-card-header">
          <h2>工单信息</h2>
          <span className="repair-status-badge status-working">
            {repairOrder.status === REPAIR_STATUS.INSPECTION_COMPLETE
              ? REPAIR_STATUS.INSPECTION_COMPLETE
              : "维修完成/待检测登记"}
          </span>
        </div>

        <p>工单号：{repairOrder.crmOrderNo || "-"}</p>
        <p>物流单号：{repairOrder.logisticsNo || "-"}</p>
        <p>SN：{repairOrder.sn || "-"}</p>
        <p>产品线：{repairOrder.product || "-"}</p>
        <p>报修描述：{repairOrder.originalFault || "未提供"}</p>
        <p>维修师傅：{repairOrder.technician || "本地测试用户"}</p>
        <p>签收备注：{repairOrder.receiptRemark || "-"}</p>
      </div>

      {supervisionOrders.length > 0 && (
        <div className="card">
          <h2>客服督办单</h2>
          <p className="field-hint">以下为客服下发原文。师傅仅查看并执行相关事项，瑞云督办单统一由信息员回复。</p>
          {supervisionOrders.map((item) => (
            <div key={item.id} className="message-card">
              <p><strong>{item.originalContent}</strong></p>
              <p>识别类型：{(item.analysis?.intents || []).map((intent) => intent.label).join("、") || "待人工分类"}</p>
              <p>师傅需处理：</p>
              <ul>{(item.analysis?.technicianActions || ["请联系信息员确认具体处理要求"]).map((action) => <li key={action}>{action}</li>)}</ul>
              <p>回复责任：信息员（师傅端不能回复瑞云督办单）</p>
              {item.analysis?.requiresManualReview && <p className="error-message">需要人工确认</p>}
            </div>
          ))}
        </div>
      )}

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
          {isSearchingFault && <span className="fault-searching">正在查询瑞云…</span>}
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

        <label htmlFor="technician-warranty">保修状态</label>
        <select id="technician-warranty" value={technicianWarranty} onChange={(event) => {
          const selected = event.target.value
          setTechnicianWarranty(selected)
          setWarrantyDecision(null)
          if (selected) checkWarranty()
        }}>
          <option value="">请选择</option>
          <option value="保内">保内</option>
          <option value="保外">保外</option>
        </select>
        {warrantyDecision?.status === "DETERMINED" && (
          <p className={warrantyDecision.warrantyStatus === technicianWarranty ? "success-text" : "error-message"}>
            系统判断：{warrantyDecision.warrantyStatus}（{warrantyDecision.source === "PURCHASE_DATE" ? "按购买日期" : "按SN生产日期并加3个月"}）
            {warrantyDecision.warrantyStatus !== technicianWarranty ? "；与师傅填写不一致，需人工确认" : "；核对一致"}
          </p>
        )}
        {warrantyDecision?.status === "MANUAL_CONFIRMATION_REQUIRED" && <p className="error-message">{warrantyDecision.reason}</p>}

        {errorMessage && <p className="error-message">{errorMessage}</p>}
        {message && <p role="status">{message}</p>}

        <button
          className="primary-btn"
          onClick={saveDetection}
          disabled={isSaving}
        >
          {isSaving ? "正在保存..." : "保存检测信息"}
        </button>

        <p className="dry-run-notice">
          当前仅保存到 FieldDesk，本阶段不会操作瑞云
        </p>

        {repairOrder.status === REPAIR_STATUS.INSPECTION_COMPLETE && (
          <button className="primary-btn" onClick={() => setPage("repairCompletion")}>
            进入维修完工确认
          </button>
        )}
        {repairOrder.status === REPAIR_STATUS.REPAIR_COMPLETED_PENDING_SHIPMENT && (
          <button className="primary-btn" onClick={() => setPage("returnShipping")}>
            进入返件发货
          </button>
        )}
      </div>

    </div>
  )
}

export default RepairProcess
