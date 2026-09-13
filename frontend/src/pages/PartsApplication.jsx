import { useEffect, useMemo, useState } from "react"
import ScannerModal from "../components/ScannerModal.jsx"
import SupervisionNoticeCard from "../components/SupervisionNoticeCard.jsx"
import { ScanIcon } from "../components/AppIcons.jsx"
import { applyLocalPart, confirmRepairParts, getRepairParts, saveRepairResumeStep, searchPartsCatalog, updateRepairPart } from "../shared/crmService.js"
import {
  getCurrentRepairOrder,
  REPAIR_STATUS,
  updateRepairOrder
} from "../shared/repairOrderStore.js"


function PartsApplication({ setPage }) {
  const [repairOrder, setRepairOrder] = useState(() =>
    getCurrentRepairOrder()
  )
  const [keyword, setKeyword] = useState("")
  const [selectedCode, setSelectedCode] = useState("")
  const [quantity, setQuantity] = useState(1)
  const [message, setMessage] = useState("")
  const [errorMessage, setErrorMessage] = useState("")
  const [isSaving, setIsSaving] = useState(false)
  const [parts, setParts] = useState([])
  const [isSearching, setIsSearching] = useState(false)
  const [selectedParts, setSelectedParts] = useState([])
  const [scannerOpen, setScannerOpen] = useState(false)
  const quoteOnly = repairOrder.treatmentMode === "ABANDONED"
  const diagnosticOnly = repairOrder.treatmentMode === "INSPECTION_ONLY" && repairOrder.inspectionFaultOutcome === "FAULT_REPRODUCED"
  const recordOnly = quoteOnly || diagnosticOnly
  // The repair path unwinds one page at a time:
  // completion -> inspection -> parts -> treatment decision.
  const backPage = "repairDecision"

  useEffect(() => {
    let active = true
    getRepairParts(repairOrder.crmOrderNo)
      .then((result) => {
        if (!active) return
        setSelectedParts(result.items || [])
        if (result.reportedFault) setRepairOrder(updateRepairOrder({ originalFault: result.reportedFault }))
        if (diagnosticOnly && result.diagnosticPartsConfirmedAt) {
          const updated = updateRepairOrder({
            status: REPAIR_STATUS.WAIT_INSPECTION,
            resumeStep: "repairProcess",
            diagnosticPartsConfirmedAt: result.diagnosticPartsConfirmedAt,
          })
          setRepairOrder(updated)
          setPage("repairProcess")
        }
      })
      .catch((error) => active && setErrorMessage(error.message))
    return () => { active = false }
  }, [diagnosticOnly, repairOrder.crmOrderNo, setPage])

  useEffect(() => {
    let active = true
    if (!keyword.trim()) {
      return () => { active = false }
    }
    const timer = setTimeout(async () => {
      try {
        setIsSearching(true)
        const result = await searchPartsCatalog({ rmaNo: repairOrder.crmOrderNo, keyword })
        if (active) {
          setParts(result.items || [])
          setErrorMessage("")
        }
      } catch (error) {
        if (active) setErrorMessage(error.message)
      } finally {
        if (active) setIsSearching(false)
      }
    }, 180)
    return () => { active = false; clearTimeout(timer) }
  }, [keyword, repairOrder.crmOrderNo])

  const matches = useMemo(() => parts, [parts])

  function updateKeyword(value) {
    const nextKeyword = String(value || "").trimStart()
    setKeyword(nextKeyword)
    setSelectedCode("")
    if (!nextKeyword.trim()) {
      setParts([])
      setIsSearching(false)
    }
  }

  function handlePartScan(value) {
    const scannedCode = String(value || "").trim()
    setScannerOpen(false)
    if (!scannedCode) return
    updateKeyword(scannedCode)
    setMessage(`已识别条码 ${scannedCode}，正在显示匹配结果`)
    setErrorMessage("")
  }

  const selectedPart = parts.find(
    (part) => part.code === selectedCode
  )
  const selectedPartAlreadyApplied = selectedParts.some((part) => part.partCode === selectedCode)
  const selectedPartsHaveKnownPrice = selectedParts.every((part) =>
    part.retailPrice !== null && part.retailPrice !== undefined && part.retailPrice !== "" &&
    Number.isFinite(Number(part.retailPrice)) && Number(part.retailPrice) >= 0
  )
  const selectedPartsTotal = selectedPartsHaveKnownPrice
    ? selectedParts.reduce((sum, part) => sum + Number(part.retailPrice) * Number(part.quantity || 0), 0)
    : null
  const selectedPartsCount = selectedParts.reduce((sum, part) => sum + Number(part.quantity || 0), 0)
  const priceText = (value) => Number.isFinite(Number(value)) && value !== null && value !== ""
    ? `¥${Number(value).toFixed(2)}`
    : "暂无价格"

  async function submitApplication() {
    if (!selectedPart) {
      setErrorMessage("请选择配件")
      return
    }
    if (selectedPartAlreadyApplied) {
      setErrorMessage("该配件已添加，请直接修改上方数量")
      return
    }
    try {
      setIsSaving(true)
      setErrorMessage("")
      const result = await applyLocalPart({
        rmaNo: repairOrder.crmOrderNo,
        partCode: selectedPart.code,
        quantity: Number(quantity)
      })
      const application = result.application
      setSelectedParts((current) => {
        const exists = current.some((item) => item.id === application.id)
        return exists ? current.map((item) => item.id === application.id ? application : item) : [...current, application]
      })
      const updated = updateRepairOrder({
        status: REPAIR_STATUS.WAIT_PARTS,
        parts: [
          ...(repairOrder.parts || []),
          {
            id: application.id,
            code: application.partCode,
            name: application.partName,
            quantity: application.quantity,
            sn: application.sn,
            retailPrice: application.retailPrice,
            repairLevel: application.repairLevel,
            returnRequired: application.returnRequired,
            isReplacementPart: application.isReplacementPart,
            sourcePartCode: application.sourcePartCode,
            catalogMatchScope: application.catalogMatchScope,
            catalogMatchLabel: application.catalogMatchLabel,
            status: "已记录"
          }
        ]
      })
      setRepairOrder(updated)
      setMessage(result.message || (quoteOnly ? "弃修报价配件已保存" : diagnosticOnly ? "故障配件已保存到 FieldDesk" : "配件申请已保存到 FieldDesk"))
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setIsSaving(false)
    }
  }

  async function changeApplication(application, nextQuantity, remove = false, rollbackQuantity = null) {
    try {
      setIsSaving(true)
      setErrorMessage("")
      const result = await updateRepairPart({
        rmaNo: repairOrder.crmOrderNo,
        applicationId: application.id,
        quantity: Number(nextQuantity),
        remove
      })
      setSelectedParts(result.order?.partApplications || [])
      setMessage(result.message)
    } catch (error) {
      setErrorMessage(error.message)
      if (rollbackQuantity !== null) {
        setSelectedParts((current) => current.map((item) =>
          item.id === application.id ? { ...item, quantity: rollbackQuantity } : item
        ))
      }
    } finally {
      setIsSaving(false)
    }
  }

  async function continueToCompletion() {
    if (!selectedParts.length) return
    try {
      setIsSaving(true)
      setErrorMessage("")
      const result = await confirmRepairParts(repairOrder.crmOrderNo)
      const updated = updateRepairOrder({
        status: result.nextStep === "repairCompletion" ? REPAIR_STATUS.REPAIRING : REPAIR_STATUS.WAIT_INSPECTION,
        diagnosticPartsConfirmedAt: result.order?.diagnosticPartsConfirmedAt || repairOrder.diagnosticPartsConfirmedAt || null,
      })
      setRepairOrder(updated)
      setPage("repairProcess")
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setIsSaving(false)
    }
  }

  async function returnToPreviousStep() {
    try {
      setIsSaving(true)
      setErrorMessage("")
      await saveRepairResumeStep(repairOrder.crmOrderNo, backPage)
      setPage(backPage)
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="page parts-application-page">
      <div className="top-bar">
        <button className="arrow-back" onClick={returnToPreviousStep} disabled={isSaving}>
          ←
        </button>
        <h1>{quoteOnly ? "弃修配件核价" : diagnosticOnly ? "确认故障配件" : "申请配件"}</h1>
      </div>

      <SupervisionNoticeCard rmaNo={repairOrder.crmOrderNo} />

      <section className="card parts-order-card">
        <div className="parts-order-hero"><span>机器 SN</span><strong>{repairOrder.sn || "-"}</strong><small>{repairOrder.product || "待确认品类"}</small></div>
        <dl className="parts-order-grid">
          <div><dt>寄修单号</dt><dd>{repairOrder.crmOrderNo || "-"}</dd></div>
          <div><dt>物流单号</dt><dd>{repairOrder.logisticsNo || "送修（无物流单号）"}</dd></div>
          <div><dt>用户姓名</dt><dd>{repairOrder.customer || "未提供"}</dd></div>
          <div><dt>维修品类</dt><dd>{repairOrder.specialty || repairOrder.product || "未提供"}</dd></div>
        </dl>
        <div className="parts-order-fault"><span>报修描述</span><p>{repairOrder.originalFault || "报修描述尚未同步，请重新进入页面读取"}</p></div>
      </section>

      <section className="card selected-parts-card compact-selected-parts-card">
        <div className="selected-parts-heading"><div><span>{quoteOnly ? "报价配件" : diagnosticOnly ? "故障记录" : "已选配件"}</span><h2>{quoteOnly ? "导致弃修的故障配件" : diagnosticOnly ? "检测确认的故障配件" : "本工单配件"}</h2></div><strong>{selectedPartsCount} 件</strong></div>
        {!selectedParts.length && <p>{recordOnly ? "尚未登记故障配件" : "尚未选择配件"}</p>}
        <div className="selected-parts-scroll" role="region" aria-label="本工单已选配件，可上下滚动" tabIndex={selectedParts.length > 3 ? 0 : undefined}>
        {selectedParts.map((part) => (
          <div className="selected-part-row" key={part.id}>
            <div>
              <strong>{part.partName}</strong>
              <p>{part.partCode} · {part.repairLevel} · {priceText(part.retailPrice)}{part.catalogMatchScope === "ALL_CATALOG" && <i>{part.catalogMatchLabel || "全表匹配·需瑞云确认"}</i>}{part.isReplacementPart && <i>替代料</i>}{part.returnRequired && <strong className="part-return-required">旧件需返厂</strong>}</p>
            </div>
            <input
              aria-label={`${part.partName}数量`}
              type="number"
              min="1"
              value={part.quantity}
              onFocus={(event) => { event.currentTarget.dataset.previousQuantity = String(part.quantity) }}
              onChange={(event) => {
                const nextQuantity = event.target.value
                setSelectedParts((current) => current.map((item) =>
                  item.id === part.id ? { ...item, quantity: nextQuantity } : item
                ))
              }}
              onBlur={(event) => {
                const previousQuantity = Number(event.currentTarget.dataset.previousQuantity || part.quantity)
                const nextQuantity = Number(event.target.value)
                if (nextQuantity !== previousQuantity) changeApplication(part, nextQuantity, false, previousQuantity)
              }}
              disabled={isSaving}
            />
            <button type="button" className="secondary-btn" onClick={() => changeApplication(part, part.quantity, true)} disabled={isSaving}>删除</button>
          </div>
        ))}
        </div>
        {!!selectedParts.length && <div className="selected-parts-total"><span>{quoteOnly ? "预计配件费" : diagnosticOnly ? "故障配件数量" : "配件小计"}</span><strong>{diagnosticOnly ? `${selectedPartsCount} 件` : selectedPartsTotal === null ? "待核价" : `¥${selectedPartsTotal.toFixed(2)}`}</strong><small>{quoteOnly ? "仅用于弃修费用明细，不会添加到瑞云更换件" : diagnosticOnly ? "仅用于确认故障，不申请库存、不写入瑞云更换件" : "完整费用在维修完工页核对"}</small></div>}
      </section>

      <section className="card parts-search-card">
        <div className="parts-search-heading">
          <div><span>飞书备件表</span><h2>搜索配件</h2></div>
          <small>机型优先 · 全表兜底</small>
        </div>
        <div className="parts-search-kinds" aria-label="支持的搜索方式">
          <span>条码完整/模糊</span><span>名称完整/模糊</span>
        </div>
        <div className="parts-search-input-row">
          <input
            id="part-search"
            value={keyword}
            onChange={(event) => updateKeyword(event.target.value)}
            placeholder="输入或扫描物料条码 / 物料名称"
            autoComplete="off"
          />
          <button type="button" className="parts-scan-button" aria-label="扫描物料条码" onClick={() => setScannerOpen(true)}>
            <ScanIcon size={20} /><span>扫码</span>
          </button>
        </div>

        <div className="part-search-result" tabIndex={matches.length > 8 ? 0 : undefined} aria-label="配件搜索结果，超过八条时可上下滑动">
          {isSearching && <p>正在查询飞书备件表...</p>}
          {!isSearching && keyword.trim() && matches.length === 0 && <p>本机型及飞书全表均未找到匹配配件</p>}
          {matches.map((part) => {
            const alreadyApplied = selectedParts.some((item) => item.partCode === part.code)
            return (
            <label className={`part-search-item ${alreadyApplied ? "is-applied" : ""}`} key={part.code}>
              <input
                type="radio"
                name="part"
                value={part.code}
                checked={selectedCode === part.code}
                onChange={() => setSelectedCode(part.code)}
                disabled={alreadyApplied}
              />
              <span className="part-search-copy">
                <strong>{part.name}</strong>
                <small>{part.code}</small>
                <span className="part-result-meta">{alreadyApplied && <i>已添加</i>}{part.catalogMatchScope === "ALL_CATALOG" && <i>{part.catalogMatchLabel || "全表匹配·需瑞云确认"}</i>}{part.isReplacementPart && <i>替代料</i>}<em>{part.repairLevel}</em><b>零售价 {priceText(part.retailPrice)}</b>{part.returnRequired && <strong className="part-return-required">旧件需返厂</strong>}</span>
              </span>
            </label>
          )})}
        </div>

        <div className="part-apply-controls">
          <label htmlFor="part-quantity">申请数量
            <input
              id="part-quantity"
              type="number"
              min="1"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </label>
          <button
            className="primary-btn"
            onClick={submitApplication}
            disabled={isSaving || !selectedPart || selectedPartAlreadyApplied}
          >
            {isSaving ? "正在保存..." : selectedPartAlreadyApplied ? "该配件已添加，请在上方改数量" : "添加到本工单"}
          </button>
        </div>

        {errorMessage && <p className="error-message">{errorMessage}</p>}
        {message && <p role="status">{message}</p>}

        <p className="dry-run-notice">
          {quoteOnly ? "弃修配件只用于核价和免运费申请，不占库存、不写入瑞云更换件" : diagnosticOnly ? "故障配件只用于说明检测结果，不占库存、不写入瑞云更换件" : "优先匹配当前机型；无结果时自动搜索飞书全表并标注。选择后先记录到 FieldDesk，进入维修时按完整编码添加到瑞云，能否使用以瑞云结果为准。"}
        </p>
        <button className="primary-btn" onClick={continueToCompletion} disabled={isSaving || selectedParts.length === 0}>
          {selectedParts.length ? (quoteOnly ? "弃修报价确认，下一步故障分类" : diagnosticOnly ? "故障配件确认，下一步填写检测" : "配件确认完成，下一步故障分类") : (recordOnly ? "请先添加故障配件" : "请先添加维修配件")}
        </button>
      </section>
      <ScannerModal
        open={scannerOpen}
        mode="part"
        title="扫描物料条码"
        onScan={handlePartScan}
        onClose={() => setScannerOpen(false)}
      />
    </div>
  )
}

export default PartsApplication
