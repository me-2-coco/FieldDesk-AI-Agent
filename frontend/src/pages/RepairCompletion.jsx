import { useCallback, useEffect, useRef, useState } from "react"
import { canViewRecloudSyncDetails } from "../shared/accountAccessPolicy.js"
import { MEDIA_ACCEPT, mediaType } from "../shared/mediaFormats.js"
import SupervisionNoticeCard from "../components/SupervisionNoticeCard.jsx"
import PhotoCaptureModal from "../components/PhotoCaptureModal.jsx"
import { CameraIcon } from "../components/AppIcons.jsx"
import AttachmentPreviewList from "../components/AttachmentPreviewList.jsx"
import {
  downloadRepairAttachment,
  getRepairCompletionContext,
  getRepairPreparationStatus,
  getRepairSyncOrderStatus,
  retryRepairPreparation,
  saveRepairCompletionDraft,
  saveRepairResumeStep,
  submitRepairCompletion,
  uploadRepairAttachment
} from "../shared/crmService.js"
import {
  getCurrentRepairOrder,
  REPAIR_STATUS,
  updateRepairOrder
} from "../shared/repairOrderStore.js"
import { buildRepairMeasure } from "../shared/repairMeasure.js"
import {
  MAX_VIDEO_UPLOAD_BYTES,
  compressVideoFile,
  needsVideoCompression
} from "../shared/videoCompression.js"

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
  { value: "WAIVED", label: "运费全免", multiplier: 0 },
  { value: "WALK_IN", label: "送修", multiplier: 0 }
]

const DISCOUNT_SCOPES = [
  { value: "ORDER_TOTAL", label: "整体打折", description: "配件费、维修费和运费一起打折" },
  { value: "SERVICE_ONLY", label: "配件＋维修费打折", description: "配件费和维修费打折，运费保持原价" }
]

function formatFileMb(bytes) {
  return `${(Number(bytes || 0) / 1024 / 1024).toFixed(1)}MB`
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error("附件读取失败"))
    reader.readAsDataURL(file)
  })
}

function persistedAttachment(attachment) {
  const copy = { ...attachment }
  delete copy.localPreviewFile
  delete copy.file
  return copy
}

function RepairCompletion({ setPage, currentUser }) {
  const showSyncDetails = canViewRecloudSyncDetails(currentUser)
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
  const [discountEnabled, setDiscountEnabled] = useState(false)
  const [outOfWarrantyReliefEnabled, setOutOfWarrantyReliefEnabled] = useState(false)
  const [awaitingInformationReview, setAwaitingInformationReview] = useState(false)
  const [discountScope, setDiscountScope] = useState("ORDER_TOTAL")
  const [discountRate, setDiscountRate] = useState("")
  const [finalChargeAmount, setFinalChargeAmount] = useState(null)
  const [faultLevel1, setFaultLevel1] = useState("")
  const [faultLevel2, setFaultLevel2] = useState("")
  const [faultLevel3, setFaultLevel3] = useState("")
  const [responsibilityType, setResponsibilityType] = useState("")
  const [detectionResult, setDetectionResult] = useState(treatmentPreset?.detectionResult || repairOrder.inspectionResult || "维修")
  const [speechTemplate, setSpeechTemplate] = useState("")
  const [repairMeasure, setRepairMeasure] = useState("")
  const [attachments, setAttachments] = useState([])
  const [photoCameraOpen, setPhotoCameraOpen] = useState(false)
  const [message, setMessage] = useState("")
  const [errorMessage, setErrorMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [completionConfirmOpen, setCompletionConfirmOpen] = useState(false)
  const [contextLoading, setContextLoading] = useState(true)
  const [descriptionRetry, setDescriptionRetry] = useState(0)
  const [descriptionReady, setDescriptionReady] = useState(false)
  const [reportedFault, setReportedFault] = useState("")
  const [syncStatus, setSyncStatus] = useState(null)
  const [preparationStatus, setPreparationStatus] = useState(null)
  const [warrantyConversion, setWarrantyConversion] = useState(repairOrder.manufacturerWarrantyConversion || null)
  const pricingSummaryRef = useRef(null)

  useEffect(() => {
    let active = true
    setContextLoading(true)
    getRepairCompletionContext(repairOrder.crmOrderNo).then((context) => {
      if (!active) return
      setDescriptionReady(Boolean(context.order?.reportedFault?.trim()))
      setReportedFault(context.order?.reportedFault || "")
      if (context.order?.reportedFaultError) setErrorMessage(context.order.reportedFaultError)
      else setErrorMessage("")
      const contextParts = isAbandoned ? (context.abandonedQuoteParts || []) : (context.usedParts || [])
      if (descriptionRetry) {
        // A description retry must not reset unsaved photos, fees or draft fields.
        setRepairMeasure(buildRepairMeasure(speechTemplate, contextParts, context.order?.reportedFault, faultLevel3))
        return
      }
      const contextPricing = context.pricing || null
      const autoResponsibilityType = isAbandoned
        ? "保外维修"
        : isInspectionOnly ? "保内质保" : context.order?.technicianWarranty === "保外" ? "保外维修" : "保内质保"
      const templates = SPEECH_TEMPLATES[autoResponsibilityType]
      const presetTemplate = treatmentPreset?.speechTemplate || templates[0]
      setUsedParts(contextParts)
      setPricing(contextPricing)
      const conversion = context.order?.manufacturerWarrantyConversion || null
      const approvalAttachments = context.warrantyApprovalAttachments || []
      setWarrantyConversion(conversion)
      setResponsibilityType(autoResponsibilityType)
      const confirmedFault = String(context.order?.faultCategory || "").split(/[|/]/).map((item) => item.trim()).filter(Boolean)
      if (confirmedFault.length >= 3) {
        setFaultLevel1(confirmedFault[0])
        setFaultLevel2(confirmedFault[1])
        setFaultLevel3(confirmedFault.slice(2).join(" / "))
      }
      const draft = context.order?.repairCompletion
      setAwaitingInformationReview(context.order?.inspectionOnlyHandoff?.status === 'PENDING_INFORMATION')
      setDetectionResult(treatmentPreset?.detectionResult || draft?.detectionResult || context.order?.inspectionResult || "维修")
      if (draft) {
        if (confirmedFault.length < 3) {
          setFaultLevel1(draft.faultLevel1 || "")
          setFaultLevel2(draft.faultLevel2 || "")
          setFaultLevel3(draft.faultLevel3 || "")
        }
        const selectedTemplate = treatmentPreset?.speechTemplate || (templates.includes(draft.speechTemplate) ? draft.speechTemplate : templates[0])
        const savedLogisticsMode = draft.logisticsChargeMode || draft.pricing?.logisticsChargeMode || "ROUND_TRIP"
        const draftLogisticsMode = isAbandoned && savedLogisticsMode === "WAIVED" ? "ROUND_TRIP" : savedLogisticsMode
        const draftLogisticsFee = draft.oneWayLogisticsFee === undefined ? "" : String(draft.oneWayLogisticsFee)
        setSpeechTemplate(selectedTemplate)
        setRepairMeasure(completedDetail && draft.repairMeasure
          ? draft.repairMeasure
          : buildRepairMeasure(selectedTemplate, contextParts, context.order?.reportedFault, confirmedFault.at(-1)))
        const combined = [...(draft.attachments || [])]
        for (const approval of approvalAttachments) if (!combined.some((item) => item.id === approval.id)) combined.push(approval)
        if (!descriptionRetry) setAttachments(combined)
        setOneWayLogisticsFee(draftLogisticsMode === "WAIVED" && !isAbandoned ? "" : draftLogisticsFee)
        setLogisticsChargeMode(draftLogisticsMode)
        setDiscountEnabled(draft.discountEnabled === true || draft.pricing?.discountEnabled === true)
        setOutOfWarrantyReliefEnabled(draft.outOfWarrantyReliefEnabled === true)
        setDiscountScope(draft.discountScope || draft.pricing?.discountScope || "ORDER_TOTAL")
        setDiscountRate((draft.discountEnabled === true || draft.pricing?.discountEnabled === true)
          ? String(draft.discountRate || draft.pricing?.discountRate || "")
          : "")
        setFinalChargeAmount(draft.finalChargeAmount === null || draft.finalChargeAmount === undefined
          ? null
          : String(draft.finalChargeAmount))
      }
      if (!draft) {
        setOutOfWarrantyReliefEnabled(false)
        if (isAbandoned) setLogisticsChargeMode("ROUND_TRIP")
        setSpeechTemplate(presetTemplate)
        setRepairMeasure(buildRepairMeasure(presetTemplate, contextParts, context.order?.reportedFault, confirmedFault.at(-1)))
        if (!descriptionRetry) setAttachments(approvalAttachments)
      }
    }).catch((error) => active && setErrorMessage(error.message))
      .finally(() => active && setContextLoading(false))
    return () => { active = false }
  }, [descriptionRetry, completedDetail, isAbandoned, isInspectionOnly, repairOrder.crmOrderNo, repairOrder.originalFault, treatmentMode, treatmentPreset])

  useEffect(() => {
    let active = true
    getRepairSyncOrderStatus(repairOrder.crmOrderNo)
      .then((status) => active && setSyncStatus(status))
      .catch(() => active && setSyncStatus(null))
    getRepairPreparationStatus(repairOrder.crmOrderNo)
      .then((status) => active && setPreparationStatus(status))
      .catch(() => active && setPreparationStatus(null))
    return () => { active = false }
  }, [repairOrder.crmOrderNo])

  async function retryPreparation() {
    try {
      setBusy(true)
      setErrorMessage("")
      const result = await retryRepairPreparation(repairOrder.crmOrderNo)
      setMessage(result.message || "已开始恢复瑞云维修准备")
      setPreparationStatus((current) => current ? {
        ...current,
        recloudRepairPreparationStatus: "PENDING",
        recloudRepairPreparationLastError: null,
      } : current)
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setBusy(false)
    }
  }

  const partsText = usedParts.length
    ? usedParts.map((part) => `${part.partName}×${part.quantity}（${part.repairLevel || "等级待确认"}）`).join("、")
    : "无实际更换配件"
  const logisticsMode = LOGISTICS_MODES.find((item) => item.value === logisticsChargeMode) || LOGISTICS_MODES[0]
  const isOutOfWarranty = !isInspectionOnly && !isAbandoned && responsibilityType === "保外维修"
  const requiresOutOfWarrantyFee = isOutOfWarranty && !isDebugging
  const requiresLogisticsFee = requiresOutOfWarrantyFee && !["WAIVED", "WALK_IN"].includes(logisticsChargeMode)
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
  const discountRateNumber = Number(discountRate)
  const hasValidDiscount = !discountEnabled || (discountRate !== "" && Number.isFinite(discountRateNumber) && discountRateNumber > 0 && discountRateNumber < 10)
  const technicianAttachments = attachments.filter((item) => !["WARRANTY_CONVERSION_APPROVAL", "FREIGHT_WAIVER_APPLICATION"].includes(item.source))
  const hasInspectionMedia = technicianAttachments.some((item) => /^(image|video)\//.test(item.mimeType || ""))
  const hasRequiredAttachment = isInspectionOnly ? hasInspectionMedia : technicianAttachments.length > 0
  const conversionReady = warrantyConversion?.requested !== true || warrantyConversion?.status === "APPROVED"
  const canSubmitCompletionBase = hasRequiredAttachment && conversionReady && (
    isAbandoned
      ? pricing?.canPrice && (logisticsChargeMode === "WALK_IN" || hasValidOptionalOutOfWarrantyFee)
      : !isOutOfWarranty
        || (pricing?.canPrice && hasValidDiscount && (requiresLogisticsFee ? hasValidOutOfWarrantyFee : logisticsChargeMode === "WAIVED" || hasValidOptionalOutOfWarrantyFee))
  )
  const displayedLogisticsFee = Number(oneWayLogisticsFee || 0) * logisticsMode.multiplier
  const originalServiceFee = Number(pricing?.subtotal || 0)
  const originalTotalFee = originalServiceFee + displayedLogisticsFee
  const discountMultiplier = discountEnabled && hasValidDiscount ? discountRateNumber / 10 : 1
  const calculatedTotalFee = isAbandoned
    ? outOfWarrantyReliefEnabled ? 0 : displayedLogisticsFee
    : discountEnabled && hasValidDiscount
    ? discountScope === "ORDER_TOTAL"
      ? Number((originalTotalFee * discountMultiplier).toFixed(2))
      : Number((originalServiceFee * discountMultiplier + displayedLogisticsFee).toFixed(2))
    : Number(originalTotalFee.toFixed(2))
  const hasManualFinalCharge = finalChargeAmount !== null
  const manualFinalChargeNumber = Number(finalChargeAmount)
  const hasValidFinalCharge = !hasManualFinalCharge || (
    finalChargeAmount !== ""
    && Number.isFinite(manualFinalChargeNumber)
    && manualFinalChargeNumber >= 0
    && manualFinalChargeNumber <= originalTotalFee
  )
  const displayedTotalFee = hasManualFinalCharge && hasValidFinalCharge
    ? Number(manualFinalChargeNumber.toFixed(2))
    : calculatedTotalFee
  const canSubmitCompletion = descriptionReady && !contextLoading && canSubmitCompletionBase && (isAbandoned || hasValidFinalCharge)
  const submitButtonLabel = !conversionReady
    ? "等待信息员上传转保凭证"
    : !hasRequiredAttachment
    ? isInspectionOnly
      ? "请先上传照片/视频"
      : "请先上传维修照片/视频"
    : (isOutOfWarranty || isAbandoned) && !pricing?.canPrice
      ? "保外费用待核对"
      : isAbandoned && logisticsChargeMode !== "WALK_IN" && !hasValidOptionalOutOfWarrantyFee
        ? "运费格式不正确"
      : requiresLogisticsFee && !hasValidOutOfWarrantyFee
        ? "请填写单程物流费"
        : discountEnabled && !hasValidDiscount
          ? "请输入大于0且小于10的折数"
        : isOutOfWarranty && !hasValidOptionalOutOfWarrantyFee
          ? "单程物流费格式不正确"
        : !isAbandoned && !hasValidFinalCharge
          ? "最终应收金额格式不正确"
        : "提交完工"
  const displayedDiscountAmount = Number((originalTotalFee - displayedTotalFee).toFixed(2))
  const formatMoney = (value) => String(Number(Number(value || 0).toFixed(2)))
  const primaryRemark = isAbandoned
    ? outOfWarrantyReliefEnabled && logisticsChargeMode !== "WALK_IN" ? "申请运费减免" : "无减免"
    : discountEnabled && hasValidDiscount ? "申请折扣减免" : "无减免"
  const feeDetails = `配件费${formatMoney(pricing?.partsFee)}元，维修费${formatMoney(pricing?.fee)}元，运费${formatMoney(displayedLogisticsFee)}元，合计${formatMoney(originalTotalFee)}元`
  const secondaryRemark = isAbandoned
    ? `${feeDetails}，用户放弃维修${logisticsChargeMode === "WALK_IN" ? "" : outOfWarrantyReliefEnabled ? "，免运费寄回" : `，仅收运费${formatMoney(displayedLogisticsFee)}元`}`
    : discountEnabled && hasValidDiscount
      ? `${feeDetails}，${formatMoney(discountRateNumber)}折后费用合计${formatMoney(displayedTotalFee)}元`
      : feeDetails

  const payload = () => ({
    rmaNo: repairOrder.crmOrderNo,
    faultLevel1, faultLevel2, faultLevel3,
    responsibilityType, detectionResult, speechTemplate, repairMeasure,
    attachments: attachments.map(persistedAttachment),
    oneWayLogisticsFee: ["WAIVED", "WALK_IN"].includes(logisticsChargeMode) ? "" : oneWayLogisticsFee,
    logisticsChargeMode,
    discountEnabled,
    outOfWarrantyReliefEnabled: isAbandoned && outOfWarrantyReliefEnabled,
    discountScope,
    discountRate: discountEnabled ? discountRate : "",
    finalChargeAmount: isAbandoned ? null : finalChargeAmount
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
      if (submit) setPage("repair")
    } catch (error) {
      setMessage("")
      setErrorMessage(`${submit ? "完工未提交成功：" : "草稿保存失败："}${error.message}`)
    } finally {
      setBusy(false)
    }
  }

  function confirmAndSubmitCompletion() {
    setCompletionConfirmOpen(false)
    save(true)
  }

  useEffect(() => {
    if (!completionConfirmOpen) return undefined
    const closeOnEscape = (event) => event.key === "Escape" && setCompletionConfirmOpen(false)
    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [completionConfirmOpen])

  async function uploadFiles(event) {
    const files = [...event.target.files].map(file => {
      const type = mediaType(file)
      return type && file.type !== type ? new File([file], file.name, { type, lastModified: file.lastModified }) : file
    })
    if (!files.length) return
    try {
      setBusy(true)
      setErrorMessage("")
      for (const file of files) {
        const supportedMedia = mediaType(file)
        if (!supportedMedia) {
          throw new Error("仅支持维修照片和视频")
        }
        if (!String(file.type).startsWith("video/") && file.size > MAX_VIDEO_UPLOAD_BYTES) {
          throw new Error(`${file.name} 为 ${formatFileMb(file.size)}，超过单文件100MB限制`)
        }
      }
      for (const file of files) {
        let uploadFile = file
        if (needsVideoCompression(file)) {
          let lastProgress = -1
          setMessage(`视频 ${formatFileMb(file.size)}，正在自动压缩…`)
          uploadFile = await compressVideoFile(file, {
            onProgress(progress) {
              if (progress === lastProgress) return
              lastProgress = progress
              setMessage(`正在压缩视频 ${progress}%，请勿关闭页面`)
            }
          })
          setMessage(`视频已压缩为 ${formatFileMb(uploadFile.size)}，正在上传…`)
        }
        const attachment = await uploadRepairAttachment({
          rmaNo: repairOrder.crmOrderNo,
          name: uploadFile.name,
          mimeType: uploadFile.type,
          data: await fileToDataUrl(uploadFile)
        })
        setAttachments((current) => current.some(item => item.id === attachment.id)
          ? current
          : [...current, { ...attachment, localPreviewFile: uploadFile }])
      }
      setMessage(files.some(needsVideoCompression) ? "视频压缩并上传完成" : "附件上传完成")
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
    setAttachments((current) => current.filter((item) => item.id !== attachmentId || item.locked || item.source === "WARRANTY_CONVERSION_APPROVAL"))
    setMessage("已移除附件，保存草稿或提交完工后生效")
  }

  function showPricingSummary() {
    pricingSummaryRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
  }

  const loadSavedAttachment = useCallback(
    (attachment) => downloadRepairAttachment(repairOrder.crmOrderNo, attachment.source === "WARRANTY_CONVERSION_APPROVAL" ? "warranty" : "repair", attachment),
    [repairOrder.crmOrderNo]
  )

  async function leaveCompletion() {
    if (completedDetail) {
      setPage("repair", { withinApp: true })
      return
    }
    // Always return one page at a time. No-parts flows are:
    // completion -> inspection -> treatment decision.
    // Repair flows continue from inspection -> parts -> treatment decision.
    const nextPage = "repairProcess"
    try {
      setBusy(true)
      setErrorMessage("")
      await saveRepairResumeStep(repairOrder.crmOrderNo, nextPage)
      setPage(nextPage)
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setBusy(false)
    }
  }

  if (contextLoading) {
    return (
      <div className="page repair-completion-page">
        <div className="top-bar">
          <button className="arrow-back" onClick={() => setPage("repairProcess")}>←</button>
          <h1>维修完工</h1>
        </div>
        <div className="card completion-context-state" role="status">
          <h2>正在读取维修资料</h2>
          <p>正在加载已保存的三级故障、配件和维修方案…</p>
        </div>
      </div>
    )
  }

  if (!pricing && errorMessage) {
    return (
      <div className="page repair-completion-page">
        <div className="top-bar">
          <button className="arrow-back" onClick={() => setPage("repairProcess")}>←</button>
          <h1>维修完工</h1>
        </div>
        <div className="card completion-context-state" role="alert">
          <h2>维修资料读取失败</h2>
          <p>{errorMessage}</p>
          <button className="secondary-btn" onClick={() => setPage("repairProcess")}>返回检测记录</button>
        </div>
      </div>
    )
  }

  return (
    <div className="page repair-completion-page">
      <div className="top-bar">
        <button className="arrow-back" onClick={leaveCompletion} disabled={busy}>←</button>
        <h1>{completedDetail ? awaitingInformationReview ? "待信息员审核" : "维修完成详情" : "维修完工"}</h1>
      </div>

      <SupervisionNoticeCard rmaNo={repairOrder.crmOrderNo} />
      {awaitingInformationReview && <div className="card"><h2>待信息员审核</h2><p>资料已准备，瑞云尚未最终提交。请信息员核对后在瑞云手动提交，不要重复提交本工单。</p></div>}

      {preparationStatus?.recloudRepairPreparationStatus === "FAILED" && <div className="card repair-sync-status-card">
        <h2>瑞云维修准备未完成</h2>
        <p className="error-message">{preparationStatus.recloudRepairPreparationLastError?.message || "上次准备失败，可从已有维修单继续。"}</p>
        <button type="button" className="secondary-btn" disabled={busy} onClick={retryPreparation}>恢复瑞云维修准备</button>
      </div>}

      {showSyncDetails && syncStatus && <div className="card repair-sync-status-card">
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
        <div className="parts-order-fault"><span>报修描述</span><p>{reportedFault || "报修描述尚未同步，请重新读取；不是客户未提供"}</p></div>
        {isInspectionOnly ? (
          <p className="success-text">保内检测：不向客户收取配件费、维修费和运费；师傅上传现场照片/视频，检测报告由信息员制作并上传</p>
        ) : (isAbandoned || isOutOfWarranty) ? (
            <div ref={pricingSummaryRef} className={`pricing-summary compact-pricing-summary ${isDebugging ? "debugging-pricing-summary" : ""} ${!pricing?.canPrice ? "pricing-needs-review" : ""}`}>
              <div className="pricing-summary-head">
                <div><span>{isAbandoned ? "弃修报价明细" : "保外费用明细"}</span><strong>{isAbandoned ? outOfWarrantyReliefEnabled ? "用于免运费申请" : "不申请减免，仅核对运费" : isDebugging ? "调试费用（选填）" : "完工前请核对"}</strong></div>
                <b>{pricing?.canPrice ? `应收 ¥${displayedTotalFee.toFixed(2)}` : "合计待核价"}</b>
              </div>
              {!isDebugging && <div className="pricing-stat-grid fee-detail-grid">
                <div><span>维修等级</span><strong>{pricing?.highestLevel || "待确认"}</strong></div>
                <div><span>配件费</span><strong>{pricing?.partsFee === null || pricing?.partsFee === undefined ? "待核价" : `¥${pricing.partsFee}`}</strong></div>
                <div><span>维修费</span><strong>{pricing?.fee === null || pricing?.fee === undefined ? "待核价" : `¥${pricing.fee}`}</strong></div>
              </div>}
              {!pricing?.canPrice && <div className="pricing-review-alert" role="alert"><strong>价格资料不完整</strong><span>仍可先填写运费；配件零售价或机型维修费补齐后即可提交。</span></div>}
              {(isAbandoned || logisticsChargeMode !== "WAIVED") && <div className="pricing-fee-field">
                <label htmlFor="one-way-logistics-fee"><span>单程物流费</span><em>{requiresLogisticsFee ? "必填" : "选填"}</em></label>
                <input id="one-way-logistics-fee" type="number" min="0" step="0.01" value={oneWayLogisticsFee} onChange={(event) => setOneWayLogisticsFee(event.target.value)} placeholder={logisticsChargeMode === "WALK_IN" ? "送修无运费" : requiresLogisticsFee ? "请填写单程快递费" : "选填，无费用可留空"} required={requiresLogisticsFee} disabled={completedDetail || logisticsChargeMode === "WALK_IN"} />
              </div>}
              <fieldset className="logistics-mode-options">
                <legend>{isAbandoned ? "原应收运费方式" : "向客户收取的运费"}</legend>
                {LOGISTICS_MODES.filter((item) => !isAbandoned || item.value !== "WAIVED").map((item) => (
                  <label key={item.value}>
                    <input type="radio" name="logistics-charge-mode" value={item.value} checked={logisticsChargeMode === item.value} onChange={(event) => {
                      const nextMode = event.target.value
                      setLogisticsChargeMode(nextMode)
                      if (["WAIVED", "WALK_IN"].includes(nextMode)) setOneWayLogisticsFee("")
                    }} disabled={completedDetail} />
                    {item.label}
                  </label>
                ))}
              </fieldset>
              {isAbandoned && <section className={`discount-panel ${outOfWarrantyReliefEnabled ? "is-enabled" : ""}`}>
                <label><input type="checkbox" role="switch" checked={outOfWarrantyReliefEnabled} disabled={completedDetail} onChange={(event) => setOutOfWarrantyReliefEnabled(event.target.checked)} /> 保外折扣减免</label>
                <p>{outOfWarrantyReliefEnabled ? "提交时生成减免申请单，填写减免备注并同步瑞云。" : "默认关闭：不生成、不上传减免申请单，不申请减免。"}</p>
              </section>}
              {requiresOutOfWarrantyFee && <section className={`discount-panel ${discountEnabled ? "is-enabled" : ""}`}>
                <fieldset className="discount-toggle-options">
                  <legend>是否打折</legend>
                  <label>
                    <input type="radio" name="discount-enabled" checked={!discountEnabled} onChange={() => {
                      setDiscountEnabled(false)
                      setDiscountScope("ORDER_TOTAL")
                      setDiscountRate("")
                    }} disabled={completedDetail} />
                    不打折
                  </label>
                  <label>
                    <input type="radio" name="discount-enabled" checked={discountEnabled} onChange={() => {
                      setDiscountEnabled(true)
                      setDiscountScope("ORDER_TOTAL")
                    }} disabled={completedDetail} />
                    打折
                  </label>
                </fieldset>
                {discountEnabled && <div className="discount-details">
                  <fieldset className="discount-scope-options">
                    <legend>打折方案</legend>
                    {DISCOUNT_SCOPES.map((item) => <label key={item.value}>
                      <input type="radio" name="discount-scope" value={item.value} checked={discountScope === item.value} onChange={(event) => setDiscountScope(event.target.value)} disabled={completedDetail} />
                      <span><strong>{item.label}</strong><small>{item.description}</small></span>
                    </label>)}
                  </fieldset>
                  <div className="pricing-fee-field discount-rate-field">
                    <label htmlFor="discount-rate"><span>折扣</span><em>必填</em></label>
                    <div className="discount-rate-input">
                      <input id="discount-rate" type="number" min="0.1" max="9.9" step="0.1" value={discountRate} onChange={(event) => setDiscountRate(event.target.value)} placeholder="例如 5.5" required disabled={completedDetail} />
                      <span>折</span>
                    </div>
                    {!hasValidDiscount && <p className="discount-error">请输入大于 0 且小于 10 的折数</p>}
                  </div>
                </div>}
              </section>}
              <div className="pricing-calculation-row">
                <span>{logisticsMode.label}<strong>¥{displayedLogisticsFee.toFixed(2)}</strong></span>
                <span>{isAbandoned ? "原维修报价合计" : "费用原价"}<strong>¥{originalTotalFee.toFixed(2)}</strong></span>
                {!isAbandoned && discountEnabled && hasValidDiscount && <span>折扣优惠<strong>-¥{displayedDiscountAmount.toFixed(2)}</strong></span>}
                {isAbandoned
                  ? <span>弃修实收<strong>¥{displayedTotalFee.toFixed(2)}</strong></span>
                  : <span className="final-charge-cell">
                      <label htmlFor="final-charge-amount">最终应收</label>
                      <span className="final-charge-control"><b>¥</b><input id="final-charge-amount" aria-label="最终应收金额" type="number" min="0" max={originalTotalFee} step="0.01" value={finalChargeAmount === null ? calculatedTotalFee.toFixed(2) : finalChargeAmount} onChange={(event) => setFinalChargeAmount(event.target.value)} disabled={completedDetail} /></span>
                    </span>}
              </div>
              {pricing?.canPrice && <details className="pricing-remarks">
                <summary>查看费用备注</summary>
                <p>一级备注：{primaryRemark}</p>
                <p>二级备注：{secondaryRemark}</p>
              </details>}
              <p className="field-hint">{logisticsChargeMode === "WALK_IN"
                ? "送修不计运费，维修和弃修均适用。"
                : isAbandoned
                ? "故障配件仅用于核算原维修报价；瑞云不会添加配件。运费选填，无费用可留空；送修请选择送修。"
                : isDebugging
                ? "保外调试费用选填，师傅可根据实际情况填写；不填也可直接提交。"
                : "收取往返或单边运费时必须填写单程物流费；选择全免后无需填写，后台会重新核算。"}</p>
            </div>
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
          <div className="receipt-upload-heading"><div><strong>{isInspectionOnly ? "现场照片/视频" : "维修照片/视频"}</strong><span>{isInspectionOnly ? "师傅只需上传现场照片/视频；检测报告由信息员另行制作并上传" : "归属瑞云维修单，与签收附件分开"}</span></div><span className="repair-required-badge">必填</span></div>
          {!completedDetail && <input className="visually-hidden-file" id="repair-attachments" type="file" accept={MEDIA_ACCEPT} multiple onChange={uploadFiles} disabled={busy} />}
          {!completedDetail && <div className="receipt-upload-actions">
            <button type="button" className="receipt-upload-button camera-button" onClick={() => setPhotoCameraOpen(true)} disabled={busy}><CameraIcon size={18} />拍照</button>
            <label className="receipt-upload-button" htmlFor="repair-attachments">▧ 从相册选择</label>
          </div>}
          {warrantyConversion?.requested === true && <div className={`warranty-proof-status ${conversionReady ? "is-ready" : "is-pending"}`}>
            <strong>{conversionReady ? "保外转保内凭证已带入" : "保外转保内申请中"}</strong>
            <span>{conversionReady ? "信息员上传的凭证已锁定，提交完工时会自动上传瑞云附件。" : "已通知信息员；凭证上传后会自动显示，师傅不可删除。"}</span>
          </div>}
          {attachments.length > 0 ? <AttachmentPreviewList
            attachments={attachments}
            disabled={busy}
            loadAttachment={loadSavedAttachment}
            onRemove={completedDetail ? null : removeAttachment}
          /> : <p className="receipt-upload-empty">暂无维修照片/视频</p>}
        </section>

        {errorMessage && !/^缺少必填字段/.test(errorMessage) && <p className="error-message">{errorMessage}</p>}
        {message && <p role="status">{message}</p>}
        {!completedDetail && <div className="completion-actions">
          {!descriptionReady && <button className="secondary-btn" disabled={busy || contextLoading} onClick={() => setDescriptionRetry(value => value + 1)}>{contextLoading ? "正在读取报修描述…" : "重新读取描述"}</button>}
          <button className="secondary-btn" disabled={busy} onClick={() => save(false)}>保存草稿</button>
          {isOutOfWarranty && !pricing?.canPrice
            ? <button type="button" className="fee-review-jump" disabled={busy} onClick={showPricingSummary}>查看费用明细</button>
            : <button className="primary-btn" disabled={busy || !canSubmitCompletion} onClick={() => setCompletionConfirmOpen(true)}>{submitButtonLabel}</button>}
        </div>}
        {completedDetail
          ? <button className="secondary-btn" onClick={() => setPage("repair")}>返回工单</button>
          : <p className="dry-run-notice">提交后由系统继续同步瑞云，无需停留本页等待。</p>}
      </div>
      {completionConfirmOpen && <div className="completion-confirm-overlay" onClick={() => setCompletionConfirmOpen(false)}>
        <section className="completion-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="completion-confirm-title" onClick={(event) => event.stopPropagation()}>
          <div className="completion-confirm-icon" aria-hidden="true">✓</div>
          <h2 id="completion-confirm-title">确认提交完工？</h2>
          <p>{isInspectionOnly ? "请确认检测资料和现场附件均已核对无误。确认后系统只操作瑞云完工，不点击提交；信息员将开检测报告、上传报告、修改地址并提交。" : "请确认维修资料和附件均已核对无误。提交后，瑞云流程将由系统继续处理。"}</p>
          <div className="completion-confirm-actions">
            <button type="button" className="completion-confirm-cancel" onClick={() => setCompletionConfirmOpen(false)}>再检查一下</button>
            <button type="button" className="completion-confirm-submit" onClick={confirmAndSubmitCompletion}>确认完工</button>
          </div>
        </section>
      </div>}
      {!completedDetail && <PhotoCaptureModal open={photoCameraOpen} title="拍摄维修照片" filePrefix="维修照片" onCapture={uploadCapturedPhoto} onClose={() => setPhotoCameraOpen(false)} />}
    </div>
  )
}

export default RepairCompletion
