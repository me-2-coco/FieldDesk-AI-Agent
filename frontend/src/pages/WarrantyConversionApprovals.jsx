import { useCallback, useEffect, useMemo, useState } from "react"
import AttachmentPreviewList from "../components/AttachmentPreviewList.jsx"
import { downloadRepairAttachment, getWarrantyConversionRequests, uploadWarrantyConversionProof } from "../shared/crmService.js"

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error("凭证读取失败"))
    reader.readAsDataURL(file)
  })
}

function WarrantyConversionApprovals({ setPage }) {
  const [items, setItems] = useState([])
  const [filter, setFilter] = useState("PENDING_APPROVAL")
  const [busyRmaNo, setBusyRmaNo] = useState("")
  const [message, setMessage] = useState("")

  const refresh = useCallback(async () => {
    try { setItems(await getWarrantyConversionRequests()); setMessage("") }
    catch (error) { setMessage(error.message) }
  }, [])

  useEffect(() => {
    let active = true
    getWarrantyConversionRequests()
      .then((rows) => {
        if (!active) return
        setItems(rows)
        setMessage("")
      })
      .catch((error) => active && setMessage(error.message))
    return () => { active = false }
  }, [])
  const visible = useMemo(() => filter === "ALL" ? items : items.filter((item) => item.status === filter), [items, filter])

  async function uploadProof(item, file) {
    if (!file) return
    if (!file.type.startsWith("image/")) { setMessage("申请凭证仅支持照片"); return }
    try {
      setBusyRmaNo(item.rmaNo); setMessage("")
      await uploadWarrantyConversionProof({ rmaNo: item.rmaNo, name: file.name, mimeType: file.type, data: await fileToDataUrl(file) })
      await refresh()
      setMessage(`${item.rmaNo} 的申请凭证已上传，师傅维修页会自动显示`)
    } catch (error) { setMessage(error.message) }
    finally { setBusyRmaNo("") }
  }

  return <div className="page warranty-approval-page">
    <div className="top-bar"><button className="arrow-back" onClick={() => setPage("home")}>←</button><div><small>信息员待办</small><h1>保外转保内申请</h1></div></div>
    <div className="card compact-search-card">
      <div className="section-title-row"><div><small>师傅提交后自动到这里</small><h2>申请凭证</h2></div><span>{items.filter((item) => item.status === "PENDING_APPROVAL").length} 待处理</span></div>
      <div className="segmented-control"><button className={filter === "PENDING_APPROVAL" ? "active" : ""} onClick={() => setFilter("PENDING_APPROVAL")}>待申请</button><button className={filter === "APPROVED" ? "active" : ""} onClick={() => setFilter("APPROVED")}>已上传</button><button className={filter === "ALL" ? "active" : ""} onClick={() => setFilter("ALL")}>全部</button></div>
    </div>
    <div className="compact-result-list">{visible.map((item) => <article className="card warranty-approval-record" key={item.rmaNo}>
      <div className="section-title-row"><div><small>{item.productLine || "产品线待确认"}</small><h2>{item.rmaNo}</h2></div><span className={item.status === "APPROVED" ? "status-success" : "status-warning"}>{item.status === "APPROVED" ? "凭证已上传" : "等待申请"}</span></div>
      <div className="compact-record-detail"><div><small>机器 SN</small><strong>{item.sn || "未记录"}</strong></div><div><small>维修师傅</small><strong>{item.technicianName || "未分配"}</strong></div></div>
      {item.proofAttachments?.length > 0 && <AttachmentPreviewList attachments={item.proofAttachments} loadAttachment={(attachment) => downloadRepairAttachment(item.rmaNo, "warranty", attachment)} />}
      <label className="primary-btn warranty-proof-upload">{busyRmaNo === item.rmaNo ? "正在上传…" : item.status === "APPROVED" ? "补充凭证照片" : "上传总部申请凭证"}<input type="file" accept="image/*" disabled={Boolean(busyRmaNo)} onChange={(event) => { uploadProof(item, event.target.files?.[0]); event.target.value = "" }} /></label>
    </article>)}</div>
    {!visible.length && <div className="card empty-state-card">当前没有{filter === "PENDING_APPROVAL" ? "待处理" : "符合条件的"}申请</div>}
    {message && <p className="inline-status" role="status">{message}</p>}
  </div>
}

export default WarrantyConversionApprovals
