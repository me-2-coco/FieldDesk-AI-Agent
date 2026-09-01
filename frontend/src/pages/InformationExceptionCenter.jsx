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

  return <div className="page information-exception-page">
    <div className="top-bar"><button className="arrow-back" onClick={() => setPage("home")}>←</button><h1>问题工单</h1></div>
    <div className="card">
      <p>本页只读汇总需要补救的本地工单。信息员联系负责师傅补充，涉及同步和最终确认的问题交管理员处理。</p>
      <button type="button" onClick={refresh} disabled={loading}>{loading ? "检查中..." : "立即检查"}</button>
      {lastRefreshedAt && <p>最近检查：{lastRefreshedAt}，每30秒自动刷新</p>}
      <label htmlFor="exception-search">筛选工单、物流单号或师傅</label>
      <input id="exception-search" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入关键词" />
      <label htmlFor="exception-severity">严重程度</label>
      <select id="exception-severity" value={severity} onChange={(event) => setSeverity(event.target.value)}>
        <option value="ALL">全部</option><option value="HIGH">需要尽快处理</option><option value="MEDIUM">需要跟进</option>
      </select>
      <p>共 {filtered.length} 个异常，其中需要尽快处理 {filtered.filter((item) => item.severity === "HIGH").length} 个。</p>
    </div>
    {!loading && !filtered.length && <p>当前没有符合条件的异常</p>}
    {filtered.map((item) => <article className="card" key={item.id}>
      <h2>{TYPE_NAMES[item.type] || item.type} · {item.severity === "HIGH" ? "需要尽快处理" : "需要跟进"}</h2>
      <p>寄修单号：{item.rmaNo || "未记录"}</p>
      {item.type !== "SYNC_ATTENTION_REQUIRED" && <><p>物流单号：{item.logisticsNo || "未记录"}</p><p>负责师傅：{item.technicianName || "未分配"}</p></>}
      <p>当前状态：{item.status || "未记录"}</p>
      <p>{item.message}</p>
      {item.type === "SYNC_ATTENTION_REQUIRED" && <p><strong>处理方式：通知管理员进入同步任务页面处理，信息员不能修改或重试同步。</strong></p>}
      {item.type !== "SYNC_ATTENTION_REQUIRED" && item.rmaNo && typeof onOpenReport === "function" && <button type="button" className="primary-btn" onClick={() => onOpenReport(item.rmaNo)}>查看完整报告和附件</button>}
    </article>)}
    {message && <p role="status">{message}</p>}
  </div>
}

export default InformationExceptionCenter
