import { useEffect, useState } from "react"
import {
  getRepairCompletionContext,
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
  const [usedParts, setUsedParts] = useState([])
  const [pricing, setPricing] = useState(null)
  const [oneWayLogisticsFee, setOneWayLogisticsFee] = useState("")
  const [logisticsChargeMode, setLogisticsChargeMode] = useState("ROUND_TRIP")
  const [faultLevel1, setFaultLevel1] = useState("")
  const [faultLevel2, setFaultLevel2] = useState("")
  const [faultLevel3, setFaultLevel3] = useState("")
  const [responsibilityType, setResponsibilityType] = useState("")
  const [detectionResult, setDetectionResult] = useState("")
  const [speechTemplate, setSpeechTemplate] = useState("")
  const [repairMeasure, setRepairMeasure] = useState("")
  const [attachments, setAttachments] = useState([])
  const [message, setMessage] = useState("")
  const [errorMessage, setErrorMessage] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    getRepairCompletionContext(repairOrder.crmOrderNo).then((context) => {
      if (!active) return
      const contextParts = context.usedParts || []
      const contextPricing = context.pricing || null
      const autoResponsibilityType = context.order?.technicianWarranty === "保外" ? "保外维修" : "保内质保"
      const templates = SPEECH_TEMPLATES[autoResponsibilityType]
      setUsedParts(contextParts)
      setPricing(contextPricing)
      setResponsibilityType(autoResponsibilityType)
      const confirmedFault = String(context.order?.faultCategory || "").split("/").map((item) => item.trim()).filter(Boolean)
      if (confirmedFault.length >= 3) {
        setFaultLevel1(confirmedFault[0])
        setFaultLevel2(confirmedFault[1])
        setFaultLevel3(confirmedFault.slice(2).join(" / "))
      }
      const draft = context.order?.repairCompletion
      if (draft) {
        if (confirmedFault.length < 3) {
          setFaultLevel1(draft.faultLevel1 || "")
          setFaultLevel2(draft.faultLevel2 || "")
          setFaultLevel3(draft.faultLevel3 || "")
        }
        setDetectionResult(draft.detectionResult || "")
        const selectedTemplate = templates.includes(draft.speechTemplate) ? draft.speechTemplate : templates[0]
        const draftLogisticsFee = draft.oneWayLogisticsFee === undefined ? "" : String(draft.oneWayLogisticsFee)
        setSpeechTemplate(selectedTemplate)
        setRepairMeasure(draft.repairMeasure || buildRepairMeasure(selectedTemplate, contextParts, repairOrder.originalFault))
        setAttachments(draft.attachments || [])
        setOneWayLogisticsFee(draftLogisticsFee)
        setLogisticsChargeMode(draft.logisticsChargeMode || draft.pricing?.logisticsChargeMode || "ROUND_TRIP")
      }
      if (!draft) {
        setSpeechTemplate(templates[0])
        setRepairMeasure(buildRepairMeasure(templates[0], contextParts, repairOrder.originalFault))
      }
    }).catch((error) => active && setErrorMessage(error.message))
    return () => { active = false }
  }, [repairOrder.crmOrderNo, repairOrder.originalFault])

  const partsText = usedParts.length
    ? usedParts.map((part) => `${part.partName}×${part.quantity}（${part.repairLevel || "等级待确认"}）`).join("、")
    : "无实际更换配件"
  const availableTemplates = SPEECH_TEMPLATES[responsibilityType] || []
  const logisticsMode = LOGISTICS_MODES.find((item) => item.value === logisticsChargeMode) || LOGISTICS_MODES[0]
  const displayedLogisticsFee = Number(oneWayLogisticsFee || 0) * logisticsMode.multiplier
  const primaryRemark = logisticsChargeMode === "ROUND_TRIP" ? "无减免" : "申请运费减免"
  const secondaryRemark = logisticsChargeMode === "WAIVED"
    ? `配件费${Number(pricing?.partsFee || 0)}元，维修费${Number(pricing?.fee || 0)}元，运费全免，合计：${Number(pricing?.subtotal || 0).toFixed(2)}元`
    : `配件费${Number(pricing?.partsFee || 0)}元，维修费${Number(pricing?.fee || 0)}元，${logisticsChargeMode === "ONE_WAY" ? "单边" : "来回"}运费${displayedLogisticsFee.toFixed(2)}元，合计：${(Number(pricing?.subtotal || 0) + displayedLogisticsFee).toFixed(2)}元`

  function applySpeechTemplate(template = speechTemplate) {
    setSpeechTemplate(template)
    setRepairMeasure(buildRepairMeasure(template, usedParts, repairOrder.originalFault))
  }

  const payload = () => ({
    rmaNo: repairOrder.crmOrderNo,
    faultLevel1, faultLevel2, faultLevel3,
    responsibilityType, detectionResult, speechTemplate, repairMeasure, attachments,
    oneWayLogisticsFee, logisticsChargeMode
  })

  async function save(submit) {
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
        if (!/^(image|video)\//.test(file.type)) throw new Error("仅支持维修照片和视频")
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

  return (
    <div className="page repair-completion-page">
      <div className="top-bar">
        <button className="arrow-back" onClick={() => setPage("repairProcess")}>←</button>
        <h1>维修完工</h1>
      </div>

      <div className="card">
        <h2>工单摘要</h2>
        <p>寄修单号：{repairOrder.crmOrderNo || "-"}</p>
        <p>SN：{repairOrder.sn || "-"}</p>
        <p>产品线：{repairOrder.product || "未提供"}</p>
        <p>报修描述：{repairOrder.originalFault || "未提供"}</p>
        <p>本单已使用配件：{partsText}</p>
        {repairOrder.warrantyType === "保外" || responsibilityType === "保外维修" ? (
          pricing?.canPrice ? (
            <div className="pricing-summary">
              <p>最高维修等级：{pricing.highestLevel}</p>
              <p>配件金额：¥{pricing.partsFee}</p>
              <p>维修费：¥{pricing.fee}</p>
              <label htmlFor="one-way-logistics-fee">单程物流费（可修改）</label>
              <input id="one-way-logistics-fee" type="number" min="0" step="0.01" value={oneWayLogisticsFee} onChange={(event) => setOneWayLogisticsFee(event.target.value)} placeholder="请输入或修改单程快递费" />
              <fieldset>
                <legend>向客户收取的运费</legend>
                {LOGISTICS_MODES.map((item) => (
                  <label key={item.value}>
                    <input type="radio" name="logistics-charge-mode" value={item.value} checked={logisticsChargeMode === item.value} onChange={(event) => setLogisticsChargeMode(event.target.value)} />
                    {item.label}
                  </label>
                ))}
              </fieldset>
              <p>{logisticsMode.label}：¥{displayedLogisticsFee.toFixed(2)}{logisticsMode.multiplier > 0 ? `（单程 × ${logisticsMode.multiplier}）` : ""}</p>
              <p><strong>保外合计：¥{(Number(pricing.subtotal || 0) + displayedLogisticsFee).toFixed(2)}</strong></p>
              <p>一级备注：{primaryRemark}</p>
              <p>二级备注：{secondaryRemark}</p>
              <p className="field-hint">物流接口只返回单程费用；师傅可按实际政策选择往返、单边或全免，后台会重新核算。</p>
            </div>
          ) : <p className="error-message">保外价格暂时无法自动核对，请转人工确认</p>
        ) : <p className="success-text">保内工单：不向客户收取配件费和维修费</p>}
      </div>

      <div className="card">
        <h2>检测阶段已确认的三级故障</h2>
        <p>{[faultLevel1, faultLevel2, faultLevel3].filter(Boolean).join(" / ") || "尚未选择三级故障"}</p>

        <label>质保类型</label>
        <p><strong>{responsibilityType || "检测阶段尚未确认"}</strong></p>
        <p className="field-hint">根据师傅在检测阶段选择的保内/保外自动带入，维修完工时不能重复修改。</p>

        <label htmlFor="completion-detection-result">检测结果</label>
        <textarea
          id="completion-detection-result"
          value={detectionResult}
          onChange={(event) => setDetectionResult(event.target.value)}
          placeholder="维修完成后填写最终检测结果"
          rows="3"
        />

        <label htmlFor="speech-template">维修话术</label>
        <select id="speech-template" value={speechTemplate} onChange={(event) => applySpeechTemplate(event.target.value)}>
          {availableTemplates.map((item) => <option key={item}>{item}</option>)}
        </select>
        <button type="button" className="secondary-btn" onClick={() => applySpeechTemplate()}>按当前故障和配件重新生成</button>
        <label htmlFor="repair-measure">维修措施（自动生成后可修改）</label>
        <textarea id="repair-measure" value={repairMeasure} onChange={(event) => setRepairMeasure(event.target.value)} rows="4" />

        <label htmlFor="repair-attachments">维修照片/视频</label>
        <input id="repair-attachments" type="file" accept="image/*,video/*" multiple onChange={uploadFiles} disabled={busy} />
        <ul>{attachments.map((item) => <li key={item.id}>{item.name}（本地）</li>)}</ul>

        {errorMessage && <p className="error-message">{errorMessage}</p>}
        {message && <p role="status">{message}</p>}
        <button className="secondary-btn" disabled={busy} onClick={() => save(false)}>保存草稿</button>
        <button className="primary-btn" disabled={busy} onClick={() => save(true)}>提交完工</button>
        {repairOrder.status === REPAIR_STATUS.REPAIR_COMPLETED_PENDING_SHIPMENT && (
          <button className="primary-btn" onClick={() => setPage("returnShipping")}>进入返件发货</button>
        )}
        <p className="dry-run-notice">仅保存 FieldDesk 本地数据，不连接或修改瑞云。</p>
      </div>
    </div>
  )
}

export default RepairCompletion
