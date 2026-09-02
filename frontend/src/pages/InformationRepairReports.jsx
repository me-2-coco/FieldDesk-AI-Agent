import { useEffect, useState } from "react"
import {
  downloadInformationAttachment,
  getInformationRepairReport,
  getInformationRepairReports
} from "../shared/crmService.js"
import WarrantyBadge from "../components/WarrantyBadge.jsx"

const CATEGORY_NAMES = { receipt: "签收照片", repair: "维修照片/视频", shipping: "返件凭证" }

function saveDownload(download) {
  const url = URL.createObjectURL(download.blob)
  const link = document.createElement("a")
  link.href = url
  link.download = download.name
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function value(data) { return data || "未记录" }

function InformationRepairReports({ setPage, initialRmaNo = "" }) {
  const [keyword, setKeyword] = useState("")
  const [reports, setReports] = useState([])
  const [report, setReport] = useState(null)
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState("")
  const [preview, setPreview] = useState(null)

  useEffect(() => () => {
    if (preview?.url) URL.revokeObjectURL(preview.url)
  }, [preview])

  useEffect(() => {
    if (!initialRmaNo) return undefined
    let active = true
    const timer = window.setTimeout(() => {
      if (!active) return
      setBusy(true)
      getInformationRepairReport(initialRmaNo)
        .then((data) => active && setReport(data))
        .catch((error) => active && setMessage(error.message))
        .finally(() => active && setBusy(false))
    }, 0)
    return () => { active = false; window.clearTimeout(timer) }
  }, [initialRmaNo])

  async function search(event) {
    event.preventDefault()
    try {
      setBusy(true); setMessage(""); setReport(null)
      const data = await getInformationRepairReports(keyword)
      setReports(data)
      if (!data.length) setMessage("没有查询到本地维修工单")
    } catch (error) { setReports([]); setMessage(error.message) }
    finally { setBusy(false) }
  }

  async function openReport(rmaNo) {
    try { setBusy(true); setMessage(""); setReport(await getInformationRepairReport(rmaNo)) }
    catch (error) { setMessage(error.message) }
    finally { setBusy(false) }
  }

  async function downloadOne(attachment) {
    try { setBusy(true); setDownloadProgress(`正在下载：${attachment.name}`); saveDownload(await downloadInformationAttachment(report.rmaNo, attachment)); setMessage(`已调用浏览器下载：${attachment.name}`) }
    catch (error) { setMessage(error.message) }
    finally { setBusy(false); setDownloadProgress("") }
  }

  async function previewOne(attachment) {
    try {
      setBusy(true); setMessage("")
      const download = await downloadInformationAttachment(report.rmaNo, attachment)
      setPreview({
        url: URL.createObjectURL(download.blob),
        name: download.name,
        mimeType: attachment.mimeType,
        attachment
      })
    } catch (error) { setMessage(error.message) }
    finally { setBusy(false) }
  }

  function closePreview() { setPreview(null) }

  async function downloadAll() {
    try {
      setBusy(true); setMessage("")
      const failed = []
      let succeeded = 0
      for (let index = 0; index < report.attachments.length; index += 1) {
        const attachment = report.attachments[index]
        setDownloadProgress(`正在逐个下载 ${index + 1}/${report.attachments.length}：${attachment.name}`)
        try {
          saveDownload(await downloadInformationAttachment(report.rmaNo, attachment))
          succeeded += 1
        } catch {
          failed.push(attachment.name)
        }
        await new Promise((resolve) => window.setTimeout(resolve, 120))
      }
      setMessage(failed.length
        ? `已下载 ${succeeded} 个，失败 ${failed.length} 个：${failed.join("、")}。可使用对应文件旁的“单个下载”补下。`
        : `已调用浏览器逐个下载 ${succeeded} 个文件；保存位置由浏览器下载设置决定`)
    }
    catch (error) { setMessage(error.message) }
    finally { setBusy(false); setDownloadProgress("") }
  }

  const pricing = report?.repairCompletion?.pricing

  return <div className="page information-report-page">
    <div className="top-bar backoffice-page-header"><button className="arrow-back" onClick={() => report ? setReport(null) : setPage("home")}>←</button><div><small>查询与档案</small><h1>维修档案</h1></div></div>
    {!report && <>
      <div className="card backoffice-intro-card"><div className="backoffice-intro-icon">档</div><div><strong>完整维修档案</strong><p>信息员只读查看本地维修报告，不能修改师傅填写的内容。</p></div></div>
      <div className="card compact-data-card">
        <div className="section-title-row"><div><small>档案查询</small><h2>查找维修报告</h2></div>{reports.length > 0 && <span>{reports.length} 份</span>}</div>
        <form onSubmit={search}>
          <label htmlFor="report-keyword">电话、物流单号或寄修单号</label>
          <input id="report-keyword" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入至少4位" />
          <button className="primary-btn" type="submit" disabled={busy}>{busy ? "查询中..." : "查询报告"}</button>
        </form>
      </div>
      {reports.length > 0 && <div className="card compact-data-card"><div className="compact-result-list report-result-list">
        {reports.map((item) => <article className="compact-report-row" key={item.rmaNo}>
          <div><strong>{item.rmaNo}</strong><small>{value(item.productLine)} · SN {value(item.sn)}</small><small>{value(item.technicianName)} · {item.attachmentCount} 个附件</small></div>
          <button type="button" className="mini-action-button" onClick={() => openReport(item.rmaNo)}>查看完整报告</button>
        </article>)}
      </div></div>}
    </>}
    {report && <>
      <div className="card report-status-hero"><span>维修档案 · {value(report.status)}</span><h2>{report.rmaNo}</h2><p>{value(report.productLine)} · SN {value(report.sn)}</p><strong>{value(report.technicianName)}</strong></div>
      <div className="card compact-data-card">
        <div className="section-title-row"><div><small>基础资料</small><h2>工单信息</h2></div><span>只读</span></div>
        <div className="compact-key-value-grid"><span><small>物流单号</small><strong>{value(report.logisticsNo)}</strong></span><span><small>当前状态</small><strong>{value(report.status)}</strong></span><span><small>产品线</small><strong>{value(report.productLine)}</strong></span><span><small>维修师傅</small><strong>{value(report.technicianName)}</strong></span></div>
      </div>
      <div className="card compact-data-card">
        <div className="section-title-row"><div><small>检测阶段</small><h2>检测报告</h2></div><WarrantyBadge value={report.inspection.warranty} fallback="未记录" /></div>
        <div className="compact-key-value-grid"><span><small>检测结果</small><strong>{value(report.inspection.result)}</strong></span><span><small>故障分类</small><strong>{value(report.inspection.faultCategory)}</strong></span><span className="wide"><small>检测备注</small><strong>{value(report.inspection.remark)}</strong></span></div>
      </div>
      <div className="card compact-data-card">
        <div className="section-title-row"><div><small>完工阶段</small><h2>维修完工报告</h2></div><WarrantyBadge value={report.repairCompletion.responsibilityType} fallback="未记录" /></div>
        <div className="compact-key-value-grid"><span><small>故障分类</small><strong>{value(report.repairCompletion.faultClassification)}</strong></span><span><small>完工检测</small><strong>{value(report.repairCompletion.detectionResult)}</strong></span><span className="wide emphasized"><small>维修措施</small><strong>{value(report.repairCompletion.repairMeasure)}</strong></span><span className="wide"><small>维修备注</small><strong>{value(report.repairCompletion.primaryRemark)}</strong></span><span className="wide"><small>提交师傅</small><strong>{value(report.repairCompletion.operatorName)}</strong></span></div>
      </div>
      <div className="card compact-data-card"><div className="section-title-row"><div><small>物料使用</small><h2>更换配件</h2></div><span>{report.usedParts.length} 种</span></div>
        {!report.usedParts.length && <p className="empty-compact-state">未记录更换配件</p>}
        <div className="compact-part-list">{report.usedParts.map((part, index) => <div key={`${part.partCode}-${index}`}><span><strong>{value(part.partName)}</strong><small>{value(part.partCode)} · {value(part.repairLevel)}{part.returnRequired ? " · 需返旧件" : ""}</small></span><b>×{part.quantity}</b></div>)}</div>
      </div>
      {pricing && <div className="card compact-data-card report-pricing-card"><div className="section-title-row"><div><small>收费核对</small><h2>费用记录</h2></div><span>合计 ¥{Number(pricing.totalFee || 0).toFixed(2)}</span></div>
        <div className="report-fee-grid"><span><small>配件费</small><strong>¥{Number(pricing.partsFee || 0).toFixed(2)}</strong></span><span><small>维修费</small><strong>¥{Number(pricing.fee || 0).toFixed(2)}</strong></span><span><small>物流费</small><strong>¥{Number(pricing.logisticsFee || 0).toFixed(2)}</strong></span></div>
        <p className="report-note"><small>费用备注</small>{value(report.repairCompletion.secondaryRemark || report.repairCompletion.primaryRemark)}</p>
      </div>}
      <div className="card compact-data-card"><div className="section-title-row"><div><small>过程凭证</small><h2>照片和视频</h2></div><span>{report.attachments.length} 个</span></div>
        {report.attachments.length > 0 && <>
          <button type="button" className="secondary-btn report-download-all" onClick={downloadAll} disabled={busy}>{busy && downloadProgress ? downloadProgress : "一键逐个下载全部"}</button>
          <p className="attachment-storage-hint">每个照片或视频保持独立文件，保存位置由电脑浏览器的下载设置决定。</p>
        </>}
        {!report.attachments.length && <p className="empty-compact-state">没有上传照片或视频</p>}
        <div className="report-attachment-grid">{report.attachments.map((attachment) => <article key={`${attachment.category}-${attachment.id}`}>
          <button type="button" className="attachment-preview-tile" onClick={() => previewOne(attachment)} disabled={busy}><span>{attachment.mimeType.startsWith("video/") ? "▶" : "图"}</span><strong>{CATEGORY_NAMES[attachment.category] || attachment.category}</strong><small>{attachment.name}</small></button>
          <button type="button" className="attachment-download-link" onClick={() => downloadOne(attachment)} disabled={busy}>单个下载 · {Math.ceil(attachment.size / 1024)}KB</button>
        </article>)}</div>
      </div>
      {preview && <div className="card attachment-preview" role="dialog" aria-label={`预览 ${preview.name}`}>
        <div className="top-bar"><h2>{preview.name}</h2><button type="button" onClick={closePreview}>关闭预览</button></div>
        {preview.mimeType.startsWith("image/") && <img src={preview.url} alt={preview.name} />}
        {preview.mimeType.startsWith("video/") && <video src={preview.url} controls preload="metadata">浏览器不支持播放该视频</video>}
        <button type="button" className="primary-btn" onClick={() => downloadOne(preview.attachment)} disabled={busy}>下载这个文件</button>
      </div>}
      {report.returnShipment && <div className="card compact-data-card"><div className="section-title-row"><div><small>返件物流</small><h2>返件信息</h2></div></div>
        <div className="compact-key-value-grid"><span><small>承运商</small><strong>{value(report.returnShipment.logisticsCompany)}</strong></span><span><small>返件单号</small><strong>{value(report.returnShipment.trackingNo)}</strong></span><span className="wide"><small>操作人</small><strong>{value(report.returnShipment.operatorName)}</strong></span></div>
      </div>}
      <details className="card compact-details report-timeline-details"><summary><span><small>过程追踪</small><strong>工单过程</strong></span><b>{report.timeline.length} 条</b></summary>
        {!report.timeline.length && <p className="empty-compact-state">暂无过程记录</p>}
        <ol className="compact-timeline compact-scroll-list">{report.timeline.map((item, index) => <li key={`${item.type}-${index}`}><strong>{value(item.label || item.type)}</strong><small>{value(item.operatorName)} · {item.createdAt ? new Date(item.createdAt).toLocaleString() : "时间未记录"}</small></li>)}</ol>
      </details>
    </>}
    {message && <p className="inline-notice-card" role="status">{message}</p>}
  </div>
}

export default InformationRepairReports
