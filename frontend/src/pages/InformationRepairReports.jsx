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

  return <div className="page information-report-page">
    <div className="top-bar"><button className="arrow-back" onClick={() => report ? setReport(null) : setPage("home")}>←</button><h1>维修档案</h1></div>
    {!report && <>
      <div className="card">
        <p>信息员只读查看本地维修报告，不能修改师傅填写的内容。</p>
        <form onSubmit={search}>
          <label htmlFor="report-keyword">电话、物流单号或寄修单号</label>
          <input id="report-keyword" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入至少4位" />
          <button className="primary-btn" type="submit" disabled={busy}>{busy ? "查询中..." : "查询报告"}</button>
        </form>
      </div>
      {reports.map((item) => <article className="card" key={item.rmaNo}>
        <h2>{item.rmaNo}</h2>
        <p>物流单号：{value(item.logisticsNo)}</p><p>SN：{value(item.sn)}</p>
        <p>当前师傅：{value(item.technicianName)}</p><p>当前状态：{value(item.status)}</p>
        <p>照片/视频：{item.attachmentCount} 个</p>
        <button type="button" className="primary-btn" onClick={() => openReport(item.rmaNo)}>查看完整报告</button>
      </article>)}
    </>}
    {report && <>
      <div className="card"><h2>{report.rmaNo}</h2>
        <p>物流单号：{value(report.logisticsNo)}</p><p>SN：{value(report.sn)}</p><p>产品线：{value(report.productLine)}</p>
        <p>当前状态：{value(report.status)}</p><p>维修师傅：<strong>{value(report.technicianName)}</strong></p>
      </div>
      <div className="card"><h2>检测报告</h2>
        <p>检测结果：{value(report.inspection.result)}</p><p>故障分类：{value(report.inspection.faultCategory)}</p>
        <p>质保判断：<WarrantyBadge value={report.inspection.warranty} fallback="未记录" /></p><p>检测备注：{value(report.inspection.remark)}</p>
      </div>
      <div className="card"><h2>维修完工报告</h2>
        <p>故障分类：{value(report.repairCompletion.faultClassification)}</p>
        <p>责任类型：<WarrantyBadge value={report.repairCompletion.responsibilityType} fallback="未记录" /></p>
        <p>维修措施：{value(report.repairCompletion.repairMeasure)}</p>
        <p>完工检测：{value(report.repairCompletion.detectionResult)}</p>
        <p>维修备注：{value(report.repairCompletion.primaryRemark)}</p>
        <p>提交师傅：{value(report.repairCompletion.operatorName)}</p>
      </div>
      <div className="card"><h2>更换配件</h2>
        {!report.usedParts.length && <p>未记录更换配件</p>}
        {report.usedParts.map((part, index) => <p key={`${part.partCode}-${index}`}>{value(part.partName)} · {value(part.partCode)} · 数量 {part.quantity} · {value(part.repairLevel)}{part.returnRequired ? " · 需返旧件" : ""}</p>)}
      </div>
      {report.repairCompletion.pricing && <div className="card"><h2>费用记录</h2>
        <p>配件费：{Number(report.repairCompletion.pricing.partsFee || 0).toFixed(2)}元</p>
        <p>维修费：{Number(report.repairCompletion.pricing.fee || 0).toFixed(2)}元</p>
        <p>物流费：{Number(report.repairCompletion.pricing.logisticsFee || 0).toFixed(2)}元</p>
        <p>合计：{Number(report.repairCompletion.pricing.totalFee || 0).toFixed(2)}元</p>
        <p>费用备注：{value(report.repairCompletion.secondaryRemark || report.repairCompletion.primaryRemark)}</p>
      </div>}
      <div className="card"><h2>照片和视频</h2>
        {report.attachments.length > 0 && <>
          <button type="button" className="primary-btn" onClick={downloadAll} disabled={busy}>{busy && downloadProgress ? downloadProgress : "一键逐个下载全部"}</button>
          <p>每个照片或视频保持独立文件，保存位置由电脑浏览器的下载设置决定。</p>
        </>}
        {!report.attachments.length && <p>没有上传照片或视频</p>}
        <ul>{report.attachments.map((attachment) => <li key={`${attachment.category}-${attachment.id}`}>
          <span>{CATEGORY_NAMES[attachment.category] || attachment.category}：{attachment.name}（{Math.ceil(attachment.size / 1024)}KB）</span>
          <button type="button" className="secondary-btn" onClick={() => previewOne(attachment)} disabled={busy}>预览</button>
          <button type="button" className="secondary-btn" onClick={() => downloadOne(attachment)} disabled={busy}>单个下载</button>
        </li>)}</ul>
      </div>
      {preview && <div className="card attachment-preview" role="dialog" aria-label={`预览 ${preview.name}`}>
        <div className="top-bar"><h2>{preview.name}</h2><button type="button" onClick={closePreview}>关闭预览</button></div>
        {preview.mimeType.startsWith("image/") && <img src={preview.url} alt={preview.name} />}
        {preview.mimeType.startsWith("video/") && <video src={preview.url} controls preload="metadata">浏览器不支持播放该视频</video>}
        <button type="button" className="primary-btn" onClick={() => downloadOne(preview.attachment)} disabled={busy}>下载这个文件</button>
      </div>}
      {report.returnShipment && <div className="card"><h2>返件信息</h2>
        <p>承运商：{value(report.returnShipment.logisticsCompany)}</p><p>返件单号：{value(report.returnShipment.trackingNo)}</p>
        <p>操作人：{value(report.returnShipment.operatorName)}</p>
      </div>}
      <div className="card"><h2>工单过程</h2>
        {!report.timeline.length && <p>暂无过程记录</p>}
        {report.timeline.map((item, index) => <p key={`${item.type}-${index}`}>{value(item.label || item.type)} · {value(item.operatorName)} · {item.createdAt ? new Date(item.createdAt).toLocaleString() : "时间未记录"}</p>)}
      </div>
    </>}
    {message && <p role="status">{message}</p>}
  </div>
}

export default InformationRepairReports
