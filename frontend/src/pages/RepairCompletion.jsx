import { useEffect, useMemo, useState } from "react"
import {
  getFaultCatalog,
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

const SPEECH_TEMPLATES = [
  "经检测确认故障，已完成维修并测试正常",
  "已更换故障部件，整机功能测试正常",
  "已完成清洁维护及故障排除，机器运行正常"
]
const RESPONSIBILITY_TYPES = ["保内质保", "保外维修", "客户责任", "非质量问题"]

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
  const [catalog, setCatalog] = useState([])
  const [usedParts, setUsedParts] = useState([])
  const [faultLevel1, setFaultLevel1] = useState("")
  const [faultLevel2, setFaultLevel2] = useState("")
  const [faultLevel3, setFaultLevel3] = useState("")
  const [faultKeyword, setFaultKeyword] = useState("")
  const [responsibilityType, setResponsibilityType] = useState("")
  const [speechTemplate, setSpeechTemplate] = useState(SPEECH_TEMPLATES[0])
  const [attachments, setAttachments] = useState([])
  const [message, setMessage] = useState("")
  const [errorMessage, setErrorMessage] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    Promise.all([
      getRepairCompletionContext(repairOrder.crmOrderNo),
      getFaultCatalog()
    ]).then(([context, faultData]) => {
      if (!active) return
      setUsedParts(context.usedParts || [])
      setCatalog(faultData.items || [])
      const draft = context.order?.repairCompletion
      if (draft) {
        setFaultLevel1(draft.faultLevel1 || "")
        setFaultLevel2(draft.faultLevel2 || "")
        setFaultLevel3(draft.faultLevel3 || "")
        setResponsibilityType(draft.responsibilityType || "")
        setSpeechTemplate(draft.speechTemplate || SPEECH_TEMPLATES[0])
        setAttachments(draft.attachments || [])
      }
    }).catch((error) => active && setErrorMessage(error.message))
    return () => { active = false }
  }, [repairOrder.crmOrderNo])

  const level1Options = useMemo(() => {
    const keyword = faultKeyword.trim().toLowerCase()
    if (!keyword) return catalog
    return catalog.filter((level1) =>
      [level1.name, ...level1.children.flatMap((level2) => [level2.name, ...level2.children])]
        .some((text) => text.toLowerCase().includes(keyword))
    )
  }, [catalog, faultKeyword])
  const selectedLevel1 = catalog.find((item) => item.name === faultLevel1)
  const selectedLevel2 = selectedLevel1?.children.find((item) => item.name === faultLevel2)
  const partsText = usedParts.length
    ? usedParts.map((part) => `${part.partName}×${part.quantity}`).join("、")
    : "无实际更换配件"
  const repairMeasure = speechTemplate ? `${speechTemplate}；实际更换配件：${partsText}` : ""

  const payload = () => ({
    rmaNo: repairOrder.crmOrderNo,
    faultLevel1, faultLevel2, faultLevel3,
    responsibilityType, speechTemplate, repairMeasure, attachments
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
      </div>

      <div className="card">
        <h2>三级故障</h2>
        <input value={faultKeyword} onChange={(event) => setFaultKeyword(event.target.value)} placeholder="模糊搜索故障名称" />
        <select value={faultLevel1} onChange={(event) => { setFaultLevel1(event.target.value); setFaultLevel2(""); setFaultLevel3("") }}>
          <option value="">请选择一级故障</option>
          {level1Options.map((item) => <option key={item.name}>{item.name}</option>)}
        </select>
        <select value={faultLevel2} onChange={(event) => { setFaultLevel2(event.target.value); setFaultLevel3("") }} disabled={!selectedLevel1}>
          <option value="">请选择二级故障</option>
          {selectedLevel1?.children.map((item) => <option key={item.name}>{item.name}</option>)}
        </select>
        <select value={faultLevel3} onChange={(event) => setFaultLevel3(event.target.value)} disabled={!selectedLevel2}>
          <option value="">请选择三级故障</option>
          {selectedLevel2?.children.map((item) => <option key={item}>{item}</option>)}
        </select>
        <p className="dry-run-notice">当前使用本地模拟故障分类，已预留瑞云同步来源。</p>

        <label htmlFor="responsibility-type">责任判定/质保类型</label>
        <select id="responsibility-type" value={responsibilityType} onChange={(event) => setResponsibilityType(event.target.value)}>
          <option value="">请选择责任判定</option>
          {RESPONSIBILITY_TYPES.map((item) => <option key={item}>{item}</option>)}
        </select>

        <label htmlFor="speech-template">维修话术</label>
        <select id="speech-template" value={speechTemplate} onChange={(event) => setSpeechTemplate(event.target.value)}>
          {SPEECH_TEMPLATES.map((item) => <option key={item}>{item}</option>)}
        </select>
        <label htmlFor="repair-measure">维修措施（自动生成）</label>
        <textarea id="repair-measure" value={repairMeasure} readOnly rows="3" />

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
