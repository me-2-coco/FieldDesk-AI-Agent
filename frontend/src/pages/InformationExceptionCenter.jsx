import { useCallback, useEffect, useMemo, useState } from "react"
import { getInformationExceptions } from "../shared/crmService.js"

const TYPE_NAMES = {
  UNASSIGNED_TECHNICIAN: "未分配师傅",
  WORKFLOW_STALLED: "流程停滞",
  REPORT_INCOMPLETE: "报告缺项",
  COMPLETION_MEDIA_MISSING: "缺少完工照片/视频",
  PARTS_MISMATCH: "配件记录不一致",
  ATTACHMENT_FILE_MISSING: "附件文件异常",
  SHIPPED_NOT_COMPLETED: "已发货未完结",
  RECLOUD_RECEIPT_RESULT_UNKNOWN: "签收结果待核对",
  SYNC_ATTENTION_REQUIRED: "同步待处理"
}

function InformationExceptionCenter({ setPage, onOpenReport }) {
  const [items, setItems] = useState([])
  const [keyword, setKeyword] = useState("")
  const [severity, setSeverity] = useState("ALL")
  const [message, setMessage] = useState("")
  const [loading, setLoading] = useState(true)
  const [lastRefreshedAt, setLastRefreshedAt] = useState("")

  const refresh = useCallback(async () => {
    try {
      const data = await getInformationExceptions()
      setItems(data); setMessage(""); setLastRefreshedAt(new Date().toLocaleTimeString())
    } catch (error) { setMessage(error.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    const initialTimer = window.setTimeout(refresh, 0)
    const timer = window.setInterval(refresh, 30000)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(timer)
    }
  }, [refresh])

  const filtered = useMemo(() => {
    const query = keyword.trim().toUpperCase()
    return items.filter((item) => severity === "ALL" || item.severity === severity)
      .filter((item) => !query || String(item.rmaNo || "").toUpperCase().includes(query)
        || String(item.logisticsNo || "").toUpperCase().includes(query)
        || String(item.technicianName || "").toUpperCase().includes(query))
  }, [items, keyword, severity])
  const highCount = items.filter((item) => item.severity === "HIGH").length
  const mediumCount = items.filter((item) => item.severity === "MEDIUM").length

  return <div className="page information-exception-page">
    <div className="top-bar"><button className="arrow-back" onClick={() => setPage("home")}>←</button><div><small>发货与异常</small><h1>问题工单</h1></div></div>
    <div className="backoffice-metric-grid exception-metric-grid"><div><span>全部异常</span><strong>{items.length}</strong></div><div><span>尽快处理</span><strong>{highCount}</strong></div><div><span>需要跟进</span><strong>{mediumCount}</strong></div></div>
    <div className="card compact-search-card exception-filter-card">
      <div className="section-title-row"><div><small>本页只读汇总</small><h2>筛选异常</h2></div><button type="button" className="mini-refresh-button" onClick={refresh} disabled={loading}>{loading ? "检查中" : "刷新"}</button></div>
      <input id="exception-search" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入关键词" />
      <div className="segmented-control" aria-label="严重程度"><button type="button" className={severity === "ALL" ? "active" : ""} onClick={() => setSeverity("ALL")}>全部</button><button type="button" className={severity === "HIGH" ? "active" : ""} onClick={() => setSeverity("HIGH")}>紧急</button><button type="button" className={severity === "MEDIUM" ? "active" : ""} onClick={() => setSeverity("MEDIUM")}>跟进</button></div>
      <p className="compact-result-count">显示 {filtered.length} 个{lastRefreshedAt ? ` · ${lastRefreshedAt} 更新` : ""}</p>
    </div>
    {!loading && !filtered.length && <p>当前没有符合条件的异常</p>}
    <div className="compact-result-list exception-list">{filtered.map((item) => <details className={`card compact-record-card exception-record severity-${String(item.severity).toLowerCase()}`} key={item.id}>
      <summary><span className="compact-record-main"><small>{TYPE_NAMES[item.type] || item.type}</small><strong>{item.rmaNo || "未关联寄修单"}</strong><em>{item.message}</em></span><span className="record-status">{item.severity === "HIGH" ? "尽快处理" : "需要跟进"}</span><b>⌄</b></summary>
      <div className="compact-record-detail"><div><small>物流单号</small><strong>{item.logisticsNo || "未记录"}</strong></div><div><small>负责师傅</small><strong>{item.technicianName || "未分配"}</strong></div><div><small>当前状态</small><strong>{item.status || "未记录"}</strong></div></div>
      {item.type === "SYNC_ATTENTION_REQUIRED" && <p><strong>处理方式：通知管理员进入同步任务页面处理，信息员不能修改或重试同步。</strong></p>}
      {item.type !== "SYNC_ATTENTION_REQUIRED" && item.rmaNo && typeof onOpenReport === "function" && <button type="button" className="primary-btn" onClick={() => onOpenReport(item.rmaNo)}>查看完整报告和附件</button>}
    </details>)}</div>
    {message && <p className="inline-status" role="status">{message}</p>}
  </div>
}

export default InformationExceptionCenter
