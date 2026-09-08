import { useEffect, useMemo, useState } from "react"
import ScannerModal from "../components/ScannerModal.jsx"
import SupervisionNoticeCard from "../components/SupervisionNoticeCard.jsx"
import { ScanIcon } from "../components/AppIcons.jsx"
import { applyLocalPart, chooseRecloudPart, confirmRepairParts, getRepairParts, saveRepairResumeStep, searchPartsCatalog, updateRepairPart } from "../shared/crmService.js"
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
  const [searchedKeyword, setSearchedKeyword] = useState("")
  const [selectedParts, setSelectedParts] = useState([])
  const [scannerOpen, setScannerOpen] = useState(false)
  const [partsShortage, setPartsShortage] = useState(null)
  const [partInteractionReady, setPartInteractionReady] = useState(false)
  const [partVerificationComplete, setPartVerificationComplete] = useState(false)
  const [syncStage, setSyncStage] = useState({ detection: "NOT_STARTED", serviceOrder: "NOT_STARTED", preparation: "NOT_STARTED" })
  const [noParts, setNoParts] = useState(false)
  const [noPartsReason, setNoPartsReason] = useState("")
  const [replacementFor, setReplacementFor] = useState("")
  const quoteOnly = repairOrder.treatmentMode === "ABANDONED"
  const diagnosticOnly = repairOrder.treatmentMode === "INSPECTION_ONLY" && repairOrder.inspectionFaultOutcome === "FAULT_REPRODUCED"
  const recordOnly = quoteOnly || diagnosticOnly
  // The repair path unwinds one page at a time:
  // completion -> inspection -> parts -> treatment decision.
  const backPage = recordOnly ? "repairDecision" : "repairProcess"

  useEffect(() => {
    let active = true
    let timer
    const refresh = () => getRepairParts(repairOrder.crmOrderNo)
      .then((result) => {
        if (!active) return
        setSelectedParts(result.items || [])
        setPartsShortage(result.partsShortage || null)
        setPartInteractionReady(result.recloudPartInteractionReady === true)
        setPartVerificationComplete(result.recloudPartVerificationComplete === true)
        setSyncStage({
          detection: result.recloudDetectionSyncStatus || "NOT_STARTED",
          serviceOrder: result.recloudServiceOrderSyncStatus || "NOT_STARTED",
          preparation: result.recloudRepairPreparationStatus || "NOT_STARTED",
        })
        setNoParts(Boolean(result.noPartsDeclaredAt))
        setNoPartsReason(result.noPartsReason || "")
        if (diagnosticOnly && result.diagnosticPartsConfirmedAt) {
          const updated = updateRepairOrder({
            status: REPAIR_STATUS.WAIT_INSPECTION,
            resumeStep: "repairProcess",
            diagnosticPartsConfirmedAt: result.diagnosticPartsConfirmedAt,
          })
          setRepairOrder(updated)
          setPage("repairProcess")
          return
        }
        if (!recordOnly && (result.recloudPartInteractionReady !== true || result.recloudPartVerificationComplete !== true)) timer = window.setTimeout(refresh, 1000)
      })
      .catch((error) => {
        if (!active) return
        setErrorMessage(error.message)
        if (!recordOnly) timer = window.setTimeout(refresh, 2000)
      })
    refresh()
    return () => { active = false; if (timer) window.clearTimeout(timer) }
  }, [diagnosticOnly, recordOnly, repairOrder.crmOrderNo, setPage])

  useEffect(() => {
    let active = true
    if (!keyword.trim() || keyword.trim().length < 2) {
      return () => { active = false }
    }
    const timer = setTimeout(async () => {
      try {
        setIsSearching(true)
        const result = await searchPartsCatalog({ rmaNo: repairOrder.crmOrderNo, keyword })
        if (active) {
          setParts(result.items || [])
          setSearchedKeyword(keyword.trim())
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
    setSearchedKeyword("")
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
    const query = String(selectedPart?.code || keyword || "").trim()
    if (!selectedPart) {
      setErrorMessage("请先从飞书备件表搜索结果中选择准确配件")
      return
    }
    if (query.length < 2) {
      setErrorMessage("请至少输入 2 个字符")
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
        partCode: selectedPart?.code || "",
        partQuery: query,
        partName: selectedPart?.name || query,
        partSource: selectedPart?.source || "",
        searchKeyword: keyword.trim(),
        confirmRecloudAdd: !recordOnly,
        replacesShortagePartCode: replacementFor,
        quantity: Number(quantity)
      })
      const application = result.application
      setPartsShortage(result.order?.partsShortage?.status === "PENDING_INFORMATION" ? result.order.partsShortage : null)
      if (!application) {
        setMessage(result.message || "瑞云确认库存不足，缺件记录已锁定")
        setSelectedCode("")
        return
      }
      setSelectedParts((current) => {
        const exists = current.some((item) => item.id === application.id)
        return exists ? current.map((item) => item.id === application.id ? application : item) : [...current, application]
      })
      setKeyword("")
      setSelectedCode("")
      setParts([])
      setSearchedKeyword("")
      setPartVerificationComplete(false)
      setReplacementFor("")
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
            status: recordOnly ? "已记录" : "瑞云核实中"
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

  async function chooseVerificationOption(application, option) {
    try {
      setIsSaving(true)
      setErrorMessage("")
      const result = await chooseRecloudPart({
        rmaNo: repairOrder.crmOrderNo,
        applicationId: application.id,
        partCode: option.code,
        partName: option.name,
      })
      setSelectedParts(result.order?.partApplications || selectedParts)
      setPartVerificationComplete(false)
      setMessage(result.message || "已选择配件，正在瑞云核实")
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
    if (!recordOnly && (!partInteractionReady || !partVerificationComplete)) return
    if (!selectedParts.length && !partsShortage && !noParts) return
    if (noParts && !noPartsReason.trim()) {
      setErrorMessage("选择无需配件时必须填写原因")
      return
    }
    try {
      setIsSaving(true)
      setErrorMessage("")
      const result = await confirmRepairParts(repairOrder.crmOrderNo, {
        noParts,
        noPartsReason: noPartsReason.trim(),
      })
      const updated = updateRepairOrder({
        status: result.nextStep === "repairCompletion" ? REPAIR_STATUS.REPAIRING : REPAIR_STATUS.WAIT_INSPECTION,
        diagnosticPartsConfirmedAt: result.order?.diagnosticPartsConfirmedAt || repairOrder.diagnosticPartsConfirmedAt || null,
      })
      setRepairOrder(updated)
      setPage(result.nextStep === "repairCompletion" ? "repairCompletion" : "repairProcess")
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
        <h1>{quoteOnly ? "弃修配件核价" : diagnosticOnly ? "确认故障配件" : "瑞云配件"}</h1>
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
        <div className="parts-order-fault"><span>报修描述</span><p>{repairOrder.originalFault || "未提供"}</p></div>
      </section>

      <section className="card selected-parts-card compact-selected-parts-card">
        <div className="selected-parts-heading"><div><span>{quoteOnly ? "报价配件" : diagnosticOnly ? "故障记录" : "已选配件"}</span><h2>{quoteOnly ? "导致弃修的故障配件" : diagnosticOnly ? "检测确认的故障配件" : "本工单配件"}</h2></div><strong>{selectedPartsCount} 件</strong></div>
        {!selectedParts.length && <p>{recordOnly ? "尚未登记故障配件" : "尚未添加瑞云配件"}</p>}
        {selectedParts.map((part) => (
          <div className="selected-part-row" key={part.id}>
            <div>
              <strong>{part.partName}</strong>
              <p>{part.partCode} · {part.repairLevel || "费用信息后台补充"} · {priceText(part.retailPrice)}{part.catalogMatchScope === "ALL_CATALOG" && <i>全表匹配</i>}{part.recloudVerificationStatus === "PENDING" && <i>排队待核实</i>}{part.recloudVerificationStatus === "VERIFYING" && <i>瑞云核实中</i>}{part.recloudVerificationStatus === "AVAILABLE" && <i>瑞云可用</i>}{part.recloudVerificationStatus === "OUT_OF_STOCK" && <i>瑞云缺件</i>}{part.recloudVerificationStatus === "FAILED" && <i>异常，自动重试中</i>}{part.recloudVerificationStatus === "NEEDS_SELECTION" && <i>请选择准确物料</i>}{part.recloudConfirmedAt && <i>瑞云已真实添加</i>}{part.isReplacementPart && <i>替代料</i>}{part.returnRequired && <strong className="part-return-required">旧件需返厂</strong>}</p>
              {part.recloudVerificationError?.message && <small>{part.recloudVerificationError.message}</small>}
              {part.recloudVerificationStatus === "NEEDS_SELECTION" && <div className="part-verification-options">
                {(part.recloudVerificationOptions || []).map((option) => <button type="button" className="secondary-btn" key={option.code} onClick={() => chooseVerificationOption(part, option)} disabled={isSaving}>{option.name} · {option.code}</button>)}
              </div>}
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
              disabled={isSaving || Boolean(part.recloudConfirmedAt) || part.recloudVerificationStatus === "OUT_OF_STOCK"}
            />
            <button type="button" className="secondary-btn" onClick={() => changeApplication(part, part.quantity, true)} disabled={isSaving || Boolean(part.recloudConfirmedAt) || part.recloudVerificationStatus === "OUT_OF_STOCK"}>{part.recloudConfirmedAt || part.recloudVerificationStatus === "OUT_OF_STOCK" ? "已锁定" : "删除"}</button>
          </div>
        ))}
        {partsShortage && <div className="parts-shortage-locked" role="status">
          <strong>瑞云缺件（不可删除）</strong>
          {(partsShortage.parts || []).map((part) => <p key={part.partCode}>{part.partName || part.partCode} · {part.partCode} × {part.quantity}<small>{part.reason}</small></p>)}
          <span>可继续搜索并添加瑞云认可的替代料；成功后系统自动解除对应缺件。否则完工时只点“完工”，不点“提交”，并通知信息员。</span>
        </div>}
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
          {!recordOnly && !partInteractionReady && <p>配件可先从飞书备件表选择；瑞云正在完成检测和创建服务单，建单后会自动真实添加并核实。当前进度：检测 {syncStage.detection} · 建单 {syncStage.serviceOrder}</p>}
          {isSearching && <p>正在查询飞书备件表...</p>}
          {!isSearching && keyword.trim().length >= 2 && searchedKeyword !== keyword.trim() && <p>正在准备飞书配件结果...</p>}
          {!isSearching && searchedKeyword === keyword.trim() && keyword.trim().length >= 2 && matches.length === 0 && <p>飞书备件表没有找到匹配配件，请更换编码或名称搜索</p>}
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
                <span className="part-result-meta">{alreadyApplied && <i>已添加</i>}<i>{part.catalogMatchLabel || "本机型匹配"}</i>{part.isReplacementPart && <i>替代料</i>}<em>{part.repairLevel}</em><b>零售价 {priceText(part.retailPrice)}</b>{part.returnRequired && <strong className="part-return-required">旧件需返厂</strong>}</span>
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
          {partsShortage && <label htmlFor="replacement-for">替代缺件
            <select id="replacement-for" value={replacementFor} onChange={(event) => setReplacementFor(event.target.value)} disabled={isSaving || !partInteractionReady}>
              <option value="">只是新增，不解除缺件</option>
              {(partsShortage.parts || []).map((part) => <option key={part.partCode} value={part.partCode}>替代 {part.partName || part.partCode}（{part.partCode}）</option>)}
            </select>
          </label>}
          <button
            className="primary-btn"
            onClick={submitApplication}
            disabled={isSaving || !selectedPart || selectedPartAlreadyApplied}
          >
            {isSaving ? "正在添加并核实..." : selectedPartAlreadyApplied ? "该配件已添加" : recordOnly ? "添加到本工单" : "添加并在瑞云核实"}
          </button>
        </div>

        {errorMessage && <p className="error-message">{errorMessage}</p>}
        {message && <p role="status">{message}</p>}

        <p className="dry-run-notice">
          {quoteOnly ? "弃修配件只用于核价和免运费申请，不占库存、不写入瑞云更换件" : diagnosticOnly ? "故障配件只用于说明检测结果，不占库存、不写入瑞云更换件" : "优先匹配当前机型；无结果时自动搜索飞书全表。全表结果只是候选，能否使用最终以瑞云真实添加和回读结果为准。"}
        </p>
        {!recordOnly && partInteractionReady && !partsShortage && selectedParts.length === 0 && <div className="no-parts-declaration">
          <label><input type="checkbox" checked={noParts} onChange={(event) => setNoParts(event.target.checked)} /> 本单确认无需更换配件</label>
          {noParts && <textarea value={noPartsReason} onChange={(event) => setNoPartsReason(event.target.value)} placeholder="必填：说明无需配件的原因，系统将记录操作人和时间" maxLength={500} />}
        </div>}
        <button className="primary-btn" onClick={continueToCompletion} disabled={isSaving || (!recordOnly && (!partInteractionReady || !partVerificationComplete)) || (!selectedParts.length && !partsShortage && !noParts) || (noParts && !noPartsReason.trim())}>
          {selectedParts.length || partsShortage || noParts ? (quoteOnly ? "弃修报价确认，下一步故障分类" : diagnosticOnly ? "故障配件确认，下一步填写检测" : "确认配件状态，进入维修完工") : (recordOnly ? "请先添加故障配件" : "请添加配件或说明无需配件")}
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
