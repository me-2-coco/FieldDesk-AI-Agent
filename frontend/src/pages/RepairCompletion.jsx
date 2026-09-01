import { useEffect, useState } from "react"
import SupervisionNoticeCard from "../components/SupervisionNoticeCard.jsx"
import PhotoCaptureModal from "../components/PhotoCaptureModal.jsx"
import { CameraIcon } from "../components/AppIcons.jsx"
import {
  getRepairCompletionContext,
  getRepairSyncOrderStatus,
  saveRepairCompletionDraft,
  submitRepairCompletion,
  uploadRepairAttachment
} from "../shared/crmService.js"
import {
  getCurrentRepairOrder,
  REPAIR_STATUS,
  updateRepairOrder
} from "../shared/repairOrderStore.js"
import { buildRepairMeasure } from "../shared/repairMeasure.js"

const SPEECH_TEMPLATES = {
  "保内质保": [
    "机器无法使用，客诉故障复现，检测不良，更换，清理，测试OK寄回",
    "机器正常使用，客诉故障未复现，清理，测试OK寄回",
    "机器无法使用，客诉故障复现，检测不良，客户弃修，清理，寄回"
  ],
  "保外维修": [
    "机器无法使用，客诉故障复现，检测不良，更换，清理，测试OK寄回",
    "机器正常使用，客诉故障未复现，清理，测试OK寄回",
    "机器无法使用，客诉故障复现，检测不良，客户弃修，清理，寄回"
  ]
}

const TREATMENT_PRESETS = {
  ABANDONED: {
    label: "弃修",
    detectionResult: "弃修",
    speechTemplate: "客诉故障复现，检测故障部件不良，客户弃修，清理，寄回",
  },
  INSPECTION_ONLY: {
    label: "只检测不维修",
    detectionResult: "只检测不维修",
    speechTemplate: "客诉故障复现，检测故障部件不良，客户机无法使用，只检测不维修，清理，寄回",
    badgeLabel: "保内检测",
  },
  DEBUGGING: {
    label: "调试",
    detectionResult: "维修",
    speechTemplate: "机器正常使用，客诉故障未复现，清理，测试ok寄回",
  },
}

const LOGISTICS_MODES = [
  { value: "ROUND_TRIP", label: "收取往返运费", multiplier: 2 },
  { value: "ONE_WAY", label: "只收单边运费", multiplier: 1 },
  { value: "WAIVED", label: "运费全免", multiplier: 0 }
]

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error("附件读取失败"))
    reader.readAsDataURL(file)
  })
}

function RepairCompletion({ setPage }) {
  const [repairOrder, setRepairOrder] = useState(() => getCurrentRepairOrder())
  const treatmentMode = repairOrder?.treatmentMode || "REPAIR"
  const treatmentPreset = TREATMENT_PRESETS[treatmentMode] || null
  const isAbandoned = treatmentMode === "ABANDONED"
  const isInspectionOnly = treatmentMode === "INSPECTION_ONLY"
  const isDebugging = treatmentMode === "DEBUGGING"
  const skipsParts = treatmentMode !== "REPAIR"
  const completedDetail = [REPAIR_STATUS.REPAIR_COMPLETED_PENDING_SHIPMENT, REPAIR_STATUS.SHIPPED_PENDING_COMPLETION, REPAIR_STATUS.COMPLETED].includes(repairOrder?.status)
  const [usedParts, setUsedParts] = useState([])
  const [pricing, setPricing] = useState(null)
  const [oneWayLogisticsFee, setOneWayLogisticsFee] = useState("")
  const [logisticsChargeMode, setLogisticsChargeMode] = useState("ROUND_TRIP")
  const [faultLevel1, setFaultLevel1] = useState("")
  const [faultLevel2, setFaultLevel2] = useState("")
  const [faultLevel3, setFaultLevel3] = useState("")
  const [responsibilityType, setResponsibilityType] = useState("")
  const [detectionResult, setDetectionResult] = useState(repairOrder.inspectionResult || "维修")
  const [speechTemplate, setSpeechTemplate] = useState("")
  const [repairMeasure, setRepairMeasure] = useState("")
  const [attachments, setAttachments] = useState([])
  const [photoCameraOpen, setPhotoCameraOpen] = useState(false)
  const [message, setMessage] = useState("")
  const [errorMessage, setErrorMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [syncStatus, setSyncStatus] = useState(null)

  useEffect(() => {
    let active = true
    getRepairCompletionContext(repairOrder.crmOrderNo).then((context) => {
      if (!active) return
      const contextParts = context.usedParts || []
      const contextPricing = context.pricing || null
      const autoResponsibilityType = isAbandoned
        ? "保外维修"
        : isInspectionOnly ? "保内质保" : context.order?.technicianWarranty === "保外" ? "保外维修" : "保内质保"
      const templates = SPEECH_TEMPLATES[autoResponsibilityType]
      const presetTemplate = treatmentPreset?.speechTemplate || templates[0]
      setUsedParts(contextParts)
      setPricing(contextPricing)
      setResponsibilityType(autoResponsibilityType)
      const confirmedFault = String(context.order?.faultCategory || "").split(/[|/]/).map((item) => item.trim()).filter(Boolean)
      if (confirmedFault.length >= 3) {
        setFaultLevel1(confirmedFault[0])
        setFaultLevel2(confirmedFault[1])
        setFaultLevel3(confirmedFault.slice(2).join(" / "))
      }
      const draft = context.order?.repairCompletion
      setDetectionResult(draft?.detectionResult || treatmentPreset?.detectionResult || context.order?.inspectionResult || "维修")
      if (draft) {
        if (confirmedFault.length < 3) {
          setFaultLevel1(draft.faultLevel1 || "")
          setFaultLevel2(draft.faultLevel2 || "")
          setFaultLevel3(draft.faultLevel3 || "")
        }
        const selectedTemplate = treatmentPreset?.speechTemplate || (templates.includes(draft.speechTemplate) ? draft.speechTemplate : templates[0])
        const draftLogisticsFee = draft.oneWayLogisticsFee === undefined ? "" : String(draft.oneWayLogisticsFee)
        setSpeechTemplate(selectedTemplate)
        setRepairMeasure(treatmentPreset
          ? buildRepairMeasure(selectedTemplate, contextParts, repairOrder.originalFault, confirmedFault.at(-1))
          : draft.repairMeasure || buildRepairMeasure(selectedTemplate, contextParts, repairOrder.originalFault, confirmedFault.at(-1)))
        setAttachments(draft.attachments || [])
        setOneWayLogisticsFee(draftLogisticsFee)
        setLogisticsChargeMode(draft.logisticsChargeMode || draft.pricing?.logisticsChargeMode || "ROUND_TRIP")
      }
      if (!draft) {
        setSpeechTemplate(presetTemplate)
        setRepairMeasure(buildRepairMeasure(presetTemplate, contextParts, repairOrder.originalFault, confirmedFault.at(-1)))
      }
    }).catch((error) => active && setErrorMessage(error.message))
    return () => { active = false }
  }, [repairOrder.crmOrderNo, repairOrder.originalFault, treatmentMode])

  useEffect(() => {
    let active = true
    getRepairSyncOrderStatus(repairOrder.crmOrderNo)
      .then((status) => active && setSyncStatus(status))
      .catch(() => active && setSyncStatus(null))
    return () => { active = false }
  }, [repairOrder.crmOrderNo])

  const partsText = usedParts.length
    ? usedParts.map((part) => `${part.partName}×${part.quantity}（${part.repairLevel || "等级待确认"}）`).join("、")
    : "无实际更换配件"
  const logisticsMode = LOGISTICS_MODES.find((item) => item.value === logisticsChargeMode) || LOGISTICS_MODES[0]
  const isOutOfWarranty = !isInspectionOnly && !isAbandoned && responsibilityType === "保外维修"
  const requiresOutOfWarrantyFee = isOutOfWarranty && !isDebugging
  const responsibilityBadgeLabel = isInspectionOnly
    ? treatmentPreset?.badgeLabel
    : isAbandoned
      ? "保外弃修"
      : isDebugging
        ? responsibilityType === "保外维修" ? "保外调试" : responsibilityType === "保内质保" ? "保内调试" : "待确认调试"
        : responsibilityType
  const logisticsFeeNumber = Number(oneWayLogisticsFee)
  const hasValidOutOfWarrantyFee = oneWayLogisticsFee !== "" && Number.isFinite(logisticsFeeNumber) && logisticsFeeNumber >= 0
  const hasValidOptionalOutOfWarrantyFee = oneWayLogisticsFee === "" || hasValidOutOfWarrantyFee
  const hasInspectionReport = attachments.some((item) => item.mimeType === "application/pdf")
  const hasInspectionMedia = attachments.some((item) => /^(image|video)\//.test(item.mimeType || ""))
  const hasRequiredAttachment = isInspectionOnly ? hasInspectionReport && hasInspectionMedia : attachments.length > 0
  const canSubmitCompletion = hasRequiredAttachment && (
    !isOutOfWarranty
    || (pricing?.canPrice && (requiresOutOfWarrantyFee ? hasValidOutOfWarrantyFee : hasValidOptionalOutOfWarrantyFee))
  )
  const submitButtonLabel = !hasRequiredAttachment
    ? isInspectionOnly
      ? !hasInspectionReport ? "请先上传 PDF 检测报告" : "请先上传照片/视频"
      : "请先上传维修照片/视频"
    : isOutOfWarranty && !pricing?.canPrice
      ? "保外费用待核对"
      : requiresOutOfWarrantyFee && !hasValidOutOfWarrantyFee
        ? "请填写单程物流费"
        : isOutOfWarranty && !hasValidOptionalOutOfWarrantyFee
          ? "单程物流费格式不正确"
        : "提交完工"
  const displayedLogisticsFee = Number(oneWayLogisticsFee || 0) * logisticsMode.multiplier
  const primaryRemark = logisticsChargeMode === "ROUND_TRIP" ? "无减免" : "申请运费减免"
  const secondaryRemark = logisticsChargeMode === "WAIVED"
    ? `配件费${Number(pricing?.partsFee || 0)}元，维修费${Number(pricing?.fee || 0)}元，运费全免，合计：${Number(pricing?.subtotal || 0).toFixed(2)}元`
    : `配件费${Number(pricing?.partsFee || 0)}元，维修费${Number(pricing?.fee || 0)}元，${logisticsChargeMode === "ONE_WAY" ? "单边" : "来回"}运费${displayedLogisticsFee.toFixed(2)}元，合计：${(Number(pricing?.subtotal || 0) + displayedLogisticsFee).toFixed(2)}元`

  const payload = () => ({
    rmaNo: repairOrder.crmOrderNo,
    faultLevel1, faultLevel2, faultLevel3,
    responsibilityType, detectionResult, speechTemplate, repairMeasure, attachments,
    oneWayLogisticsFee, logisticsChargeMode
  })

  async function save(submit) {
    if (submit && !canSubmitCompletion) return
    try {
      setBusy(true)
      setErrorMessage("")
      const result = submit
        ? await submitRepairCompletion(payload())
        : await saveRepairCompletionDraft(payload())
      const updated = updateRepairOrder({
        repairCompletion: result.repairCompletion,
        status: submit
          ? REPAIR_STATUS.REPAIR_COMPLETED_PENDING_SHIPMENT
          : repairOrder.status
      })
      setRepairOrder(updated)
      setMessage(result.message)
      if (submit) setPage("home")
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function uploadFiles(event) {
    const files = [...event.target.files]
    if (!files.length) return
    try {
      setBusy(true)
      setErrorMessage("")
      const saved = []
      for (const file of files) {
        const supportedMedia = /^(image|video)\//.test(file.type)
        const supportedReport = isInspectionOnly && file.type === "application/pdf"
        if (!supportedMedia && !supportedReport) {
          throw new Error(isInspectionOnly ? "仅支持照片、视频和 PDF 检测报告" : "仅支持维修照片和视频")
        }
        saved.push(await uploadRepairAttachment({
          rmaNo: repairOrder.crmOrderNo,
          name: file.name,
          mimeType: file.type,
          data: await fileToDataUrl(file)
        }))
      }
      setAttachments((current) => [...current, ...saved])
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setBusy(false)
      event.target.value = ""
    }
  }

  async function uploadCapturedPhoto(file) {
    await uploadFiles({ target: { files: [file], value: "" } })
  }

  function removeAttachment(attachmentId) {
    setAttachments((current) => current.filter((item) => item.id !== attachmentId))
    setMessage("已移除附件，保存草稿或提交完工后生效")
  }

  return (
    <div className="page repair-completion-page">
      <div className="top-bar">
        <button className="arrow-back" onClick={() => setPage(completedDetail ? "home" : skipsParts ? "repairDecision" : "repairProcess")}>←</button>
        <h1>{completedDetail ? "维修完成详情" : "维修完工"}</h1>
      </div>

      <SupervisionNoticeCard rmaNo={repairOrder.crmOrderNo} />

      {syncStatus && <div className="card repair-sync-status-card">
        <h2>瑞云同步状态</h2>
        <p>{({
          NOT_CREATED: "尚未创建维修完工同步任务",
          PENDING: "等待执行",
          PROCESSING: "正在执行",
          READY_DRY_RUN: "演练检查通过，尚未写入瑞云",
          AWAITING_FINAL_CONFIRM: "已点击完工，正在等待瑞云进入可提交状态",
          MANUAL_REVIEW: "存在冲突，需要人工复核",
          FAILED: "同步失败，等待管理员处理",
          SUCCESS: "瑞云同步已完成"
        })[syncStatus.status] || syncStatus.status}</p>
        {syncStatus.completedSteps?.length > 0 && <p>
          已核对：{syncStatus.completedSteps.map((step) => ({
            PARTS_VERIFIED: "配件",
            FIELDS_VERIFIED: "维修字段",
            ATTACHMENTS_VERIFIED: "完工附件",
            COMPLETE_CLICKED: "已点击完工",
            SUBMIT_READY: "瑞云已可提交",
            SUBMIT_VERIFIED: "已提交并确认锁定"
          })[step] || step).join("、")}
        </p>}
        {syncStatus.reviewSteps?.length > 0 && <p className="error-message">
          需复核：{syncStatus.reviewSteps.map((step) => ({ FORM: "维修字段", PARTS: "配件", ATTACHMENTS: "完工附件" })[step] || step).join("、")}
        </p>}
        {syncStatus.status === "AWAITING_FINAL_CONFIRM" && <p className="field-hint">系统会在瑞云状态变化后自动提交；确认锁定后本次维修任务即完成。</p>}
      </div>}

      <section className="card parts-order-card completion-order-card">
        <div className="parts-order-hero"><span>机器 SN</span><strong>{repairOrder.sn || "-"}</strong><small>{repairOrder.product || "待确认品类"}</small></div>
        <dl className="parts-order-grid">
          <div><dt>寄修单号</dt><dd>{repairOrder.crmOrderNo || "-"}</dd></div>
          <div><dt>物流单号</dt><dd>{repairOrder.logisticsNo || "送修（无物流单号）"}</dd></div>
          <div><dt>维修师傅</dt><dd>{repairOrder.technician || "未记录"}</dd></div>
          <div><dt>{skipsParts ? "处理方式" : "已用配件"}</dt><dd>{skipsParts ? treatmentPreset?.label || repairOrder.treatmentLabel : partsText}</dd></div>
        </dl>
        <div className="parts-order-fault"><span>报修描述</span><p>{repairOrder.originalFault || "未提供"}</p></div>
        {isInspectionOnly ? (
          <p className="success-text">保内检测：不向客户收取配件费、维修费和运费，请上传检测报告及照片/视频</p>
        ) : isAbandoned ? (
          <p className="treatment-status-text treatment-status-out">
            保外弃修：不申请配件，上传照片/视频后按弃修流程寄回
          </p>
        ) : isOutOfWarranty ? (
          pricing?.canPrice ? (
            <div className={`pricing-summary compact-pricing-summary ${isDebugging ? "debugging-pricing-summary" : ""}`}>
              <div className="pricing-summary-head">
                <div><span>保外费用</span><strong>{isDebugging ? "调试费用（选填）" : "维修费用（必填）"}</strong></div>
                <b>合计 ¥{(Number(pricing.subtotal || 0) + displayedLogisticsFee).toFixed(2)}</b>
              </div>
              {!isDebugging && <div className="pricing-stat-grid">
                <div><span>维修等级</span><strong>{pricing.highestLevel}</strong></div>
                <div><span>配件费</span><strong>¥{pricing.partsFee}</strong></div>
                <div><span>维修费</span><strong>¥{pricing.fee}</strong></div>
              </div>}
              <div className="pricing-fee-field">
                <label htmlFor="one-way-logistics-fee"><span>单程物流费</span><em>{requiresOutOfWarrantyFee ? "必填" : "选填"}</em></label>
                <input id="one-way-logistics-fee" type="number" min="0" step="0.01" value={oneWayLogisticsFee} onChange={(event) => setOneWayLogisticsFee(event.target.value)} placeholder={requiresOutOfWarrantyFee ? "请填写单程快递费" : "可按实际情况填写，不填也能提交"} required={requiresOutOfWarrantyFee} disabled={completedDetail} />
              </div>
              <fieldset className="logistics-mode-options">
                <legend>向客户收取的运费</legend>
                {LOGISTICS_MODES.map((item) => (
                  <label key={item.value}>
                    <input type="radio" name="logistics-charge-mode" value={item.value} checked={logisticsChargeMode === item.value} onChange={(event) => setLogisticsChargeMode(event.target.value)} disabled={completedDetail} />
                    {item.label}
                  </label>
                ))}
              </fieldset>
              <div className="pricing-calculation-row">
                <span>{logisticsMode.label}<strong>¥{displayedLogisticsFee.toFixed(2)}</strong></span>
                <span>计费方式<strong>{logisticsMode.multiplier > 0 ? `单程 × ${logisticsMode.multiplier}` : "全免"}</strong></span>
              </div>
              <details className="pricing-remarks">
                <summary>查看费用备注</summary>
                <p>一级备注：{primaryRemark}</p>
                <p>二级备注：{secondaryRemark}</p>
              </details>
              <p className="field-hint">{isDebugging
                ? "保外调试费用选填，师傅可根据实际情况填写；不填也可直接提交。"
                : "正常保外维修必须填写单程物流费；可按实际政策选择往返、单边或全免，后台会重新核算。"}</p>
            </div>
          ) : <p className="error-message">保外价格暂时无法自动核对，请转人工确认</p>
        ) : <p className="success-text">保内工单：不向客户收取配件费和维修费</p>}
      </section>

      <div className="card repair-decision-card">
        <div className="repair-decision-heading">
          <div><span>检测结论</span><h2>维修方案</h2></div>
          <strong className={`repair-warranty-badge ${String(responsibilityBadgeLabel).includes("保外") ? "warranty-out" : String(responsibilityBadgeLabel).includes("保内") ? "warranty-in" : "warranty-pending"}`}>{responsibilityBadgeLabel || "待确认"}</strong>
        </div>

        <section className="confirmed-fault-card">
          <span className="repair-section-kicker">{skipsParts ? "已选择处理方式" : "已确认三级故障"}</span>
          <div className="fault-path-pills">
            {(skipsParts ? [treatmentPreset?.label || repairOrder.treatmentLabel] : [faultLevel1, faultLevel2, faultLevel3]).filter(Boolean).map((item, index) => (
              <span key={`${item}-${index}`}>{item}</span>
            ))}
            {!skipsParts && ![faultLevel1, faultLevel2, faultLevel3].some(Boolean) && <span>尚未选择</span>}
          </div>
        </section>

        <section className="repair-measure-card">
          <div className="repair-measure-heading"><span>维修措施</span><small>系统生成 · 只读</small></div>
          <p id="repair-measure">{repairMeasure || "暂未生成维修措施"}</p>
        </section>

        <section className="receipt-upload-section repair-upload-section">
          <div className="receipt-upload-heading"><div><strong>{isInspectionOnly ? "检测报告与照片/视频" : "维修照片/视频"}</strong><span>{isInspectionOnly ? "上传检测报告和现场照片/视频，无需填写保外费用" : "归属瑞云维修单，与签收附件分开"}</span></div><span className="repair-required-badge">必填</span></div>
          {!completedDetail && <input className="visually-hidden-file" id="repair-attachments" type="file" accept={isInspectionOnly ? "image/*,video/*,application/pdf" : "image/*,video/*"} multiple onChange={uploadFiles} disabled={busy} />}
          {!completedDetail && <div className="receipt-upload-actions">
            <button type="button" className="receipt-upload-button camera-button" onClick={() => setPhotoCameraOpen(true)} disabled={busy}><CameraIcon size={18} />拍照</button>
            <label className="receipt-upload-button" htmlFor="repair-attachments">▧ 从相册选择</label>
          </div>}
          {attachments.length > 0 ? <div className="receipt-upload-list">{attachments.map((item) => <div key={item.id}><span>{item.mimeType === "application/pdf" ? "报告" : item.mimeType?.startsWith("video/") ? "视频" : "照片"}</span><strong>{item.name}</strong>{!completedDetail && <button type="button" onClick={() => removeAttachment(item.id)} disabled={busy} aria-label={`移除${item.name}`}>移除</button>}</div>)}</div> : <p className="receipt-upload-empty">{isInspectionOnly ? "暂无检测报告或附件" : "暂无维修照片/视频"}</p>}
        </section>

        {errorMessage && !/^缺少必填字段/.test(errorMessage) && <p className="error-message">{errorMessage}</p>}
        {message && <p role="status">{message}</p>}
        {!completedDetail && <div className="completion-actions">
          <button className="secondary-btn" disabled={busy} onClick={() => save(false)}>保存草稿</button>
          <button className="primary-btn" disabled={busy || !canSubmitCompletion} onClick={() => save(true)}>{submitButtonLabel}</button>
        </div>}
        {completedDetail ? <button className="secondary-btn" onClick={() => setPage("home")}>返回首页</button> : <p className="dry-run-notice">仅保存 FieldDesk 本地数据，不连接或修改瑞云。</p>}
      </div>
      {!completedDetail && <PhotoCaptureModal open={photoCameraOpen} title="拍摄维修照片" filePrefix="维修照片" onCapture={uploadCapturedPhoto} onClose={() => setPhotoCameraOpen(false)} />}
    </div>
  )
}

export default RepairCompletion
