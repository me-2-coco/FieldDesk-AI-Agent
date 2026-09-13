import { useCallback, useEffect, useMemo, useState } from "react"
import { getInformationExceptions, resolveInformationPartsShortage } from "../shared/crmService.js"
import categories from '../../../shared/todo-categories.json'
import './information-inbox.css'

const TYPE_NAMES = {
  MATERIAL_HOLD_PENDING: "缺件待料",
  UNASSIGNED_TECHNICIAN: "未分配师傅",
  WORKFLOW_STALLED: "流程停滞",
  REPORT_INCOMPLETE: "报告缺项",
  COMPLETION_MEDIA_MISSING: "缺少完工照片/视频",
  PARTS_MISMATCH: "配件记录不一致",
  ATTACHMENT_FILE_MISSING: "附件文件异常",
  SHIPPED_NOT_COMPLETED: "已发货未完结",
  RECLOUD_RECEIPT_RESULT_UNKNOWN: "签收结果待核对",
  SYNC_ATTENTION_REQUIRED: "同步待处理",
  PARTS_SHORTAGE_PENDING: "瑞云缺件待补录",
  INSPECTION_ONLY_ADDRESS_AND_SUBMIT_PENDING: "只检测待改址提交",
  RECLOUD_COMPLETED_SUBMIT_PENDING: "瑞云已完工待提交"
}

function InformationExceptionCenter({ setPage, onOpenReport }) {
  const [items, setItems] = useState([])
  const [keyword, setKeyword] = useState("")
  const [severity, setSeverity] = useState("ALL")
  const [category, setCategory] = useState('ALL')
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
      .filter(item => category === 'ALL' || (categories.types[item.type] || 'exceptions') === category)
      .filter((item) => !query || String(item.rmaNo || "").toUpperCase().includes(query)
        || String(item.logisticsNo || "").toUpperCase().includes(query)
        || String(item.technicianName || "").toUpperCase().includes(query))
  }, [items, keyword, severity, category])
  const highCount = items.filter((item) => item.severity === "HIGH").length
  const mediumCount = items.filter((item) => item.severity === "MEDIUM").length

  const resolveShortage = async (rmaNo) => {
    try {
      await resolveInformationPartsShortage(rmaNo)
      setMessage("已标记为瑞云补件并提交完成")
      await refresh()
    } catch (error) { setMessage(error.message) }
  }

  return <div className="page information-exception-page">
    <div className="top-bar"><button className="arrow-back" aria-label="返回" onClick={() => setPage("appBack")}>←</button><div><small>审核与业务跟进</small><h1>消息与待办</h1></div></div>
    <div className="backoffice-metric-grid exception-metric-grid"><div><span>全部待办</span><strong>{items.length}</strong></div><div><span>尽快处理</span><strong>{highCount}</strong></div><div><span>需要跟进</span><strong>{mediumCount}</strong></div></div>
    <div className="card compact-search-card exception-filter-card">
      <div className="inbox-search-row"><input id="exception-search" aria-label="搜索工单、物流单或师傅" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索工单号、物流单号或师傅" /><button type="button" className="mini-refresh-button" onClick={refresh} disabled={loading}>{loading ? "更新中" : "刷新"}</button></div>
      <div className="inbox-category-tabs" aria-label="消息分类">
        <button type="button" aria-pressed={category==='ALL'} onClick={()=>setCategory('ALL')}>全部消息 <span>{items.length}</span></button>
        {categories.groups.filter(g=>g.id!=='warranty').map(g=>{
          const count=items.filter(i=>(categories.types[i.type] || 'exceptions')===g.id).length
          return count>0 && <button type="button" key={g.id} aria-pressed={category===g.id} onClick={()=>setCategory(g.id)}>{g.label} <span>{count}</span></button>
        })}
      </div>
      <div className="segmented-control" aria-label="严重程度"><button type="button" className={severity === "ALL" ? "active" : ""} onClick={() => setSeverity("ALL")}>全部</button><button type="button" className={severity === "HIGH" ? "active" : ""} onClick={() => setSeverity("HIGH")}>紧急</button><button type="button" className={severity === "MEDIUM" ? "active" : ""} onClick={() => setSeverity("MEDIUM")}>跟进</button></div>
      <p className="compact-result-count">{filtered.length} 条待办 · 点击卡片展开详情{lastRefreshedAt ? ` · ${lastRefreshedAt} 更新` : ""}</p>
    </div>
    {!loading && !filtered.length && <p>当前没有符合条件的消息</p>}
    <div className="compact-result-list exception-list">{filtered.map((item) => <details className={`card compact-record-card exception-record severity-${String(item.severity).toLowerCase()}`} key={item.id}>
      <summary><span className="compact-record-main"><small>{TYPE_NAMES[item.type] || item.type}</small><strong>{item.rmaNo || "未关联寄修单"}</strong><em>{item.message}</em></span><span className="record-status">{item.severity === "HIGH" ? "尽快处理" : "需要跟进"}</span><b>⌄</b></summary>
      <div className="compact-record-detail"><div><small>物流单号</small><strong>{item.logisticsNo || "未记录"}</strong></div><div><small>负责师傅</small><strong>{item.technicianName || "未分配"}</strong></div><div><small>当前状态</small><strong>{item.status || "未记录"}</strong></div></div>
      {item.type === "SYNC_ATTENTION_REQUIRED" && <p><strong>处理方式：通知管理员进入同步任务页面处理，信息员不能修改或重试同步。</strong></p>}
      {item.type === "INSPECTION_ONLY_ADDRESS_AND_SUBMIT_PENDING" && <p><strong>处理方式：信息员开检测报告并上传到瑞云“附件（检测报告）”，再修改返件地址，确认无误后点击提交。</strong></p>}
      {item.type === "RECLOUD_COMPLETED_SUBMIT_PENDING" && <p><strong>处理方式：信息员核对瑞云维修资料，确认无误后点击提交。</strong></p>}
      {item.type === "PARTS_SHORTAGE_PENDING" && <>
        <p><strong>缺件：{(item.missingParts || []).map((part) => `${part.partName || part.partCode}（${part.partCode}）×${part.quantity}`).join("、")}</strong></p>
        <p>请在瑞云到货后补加以上配件并点击提交，再回来标记完成。</p>
        <button type="button" className="primary-btn" onClick={() => resolveShortage(item.rmaNo)}>已在瑞云补件并提交</button>
      </>}
      {item.type !== "SYNC_ATTENTION_REQUIRED" && item.rmaNo && typeof onOpenReport === "function" && <button type="button" className="primary-btn" onClick={() => onOpenReport(item.rmaNo)}>查看完整报告和附件</button>}
    </details>)}</div>
    {message && <p className="inline-status" role="status">{message}</p>}
  </div>
}

export default InformationExceptionCenter
