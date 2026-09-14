import { useEffect, useState, useRef } from "react"
import { getShippingContext, getShippingOrders, syncShipping, getShippingSyncStatus } from "../shared/crmService.js"
import { filterShippingOrders } from "../shared/shippingSearch.js"
import { AppIcon } from "../components/AppIcons.jsx"
import "./return-shipping.css"

const state = order => order.recloudShipping?.status || "UNKNOWN"
const shipped = order => ["SHIPPED", "SIGNED"].includes(state(order))
const statusLabel = order => ({UNKNOWN:"待同步 / 待核对",PENDING:"待发货",SHIPPED:"已发货",SIGNED:"已签收"}[state(order)] || "待核对")

function ReturnShipping({ setPage }) {
  const [orders, setOrders] = useState([])
  const [search, setSearch] = useState("")
  const [filter, setFilter] = useState("all")
  const [selectedRmaNo, setSelectedRmaNo] = useState("")
  const [context, setContext] = useState(null)
  const [listError, setListError] = useState("")
  const [detailError, setDetailError] = useState("")
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState("")
  const [job, setJob] = useState(null)
  const lastJobRunning = useRef(false)
  useEffect(() => {
    let active=true
    const check=async()=>{ try { const next=await getShippingSyncStatus(); if(active) { setJob(next); if(next.running || lastJobRunning.current) setRevision(v=>v+1); lastJobRunning.current=next.running; } } catch { /* List errors are displayed separately. */ } }
    check(); const timer=window.setInterval(check,5000)
    return ()=>{active=false;window.clearInterval(timer)}
  }, [])
  async function synchronize() {
    setSyncing(true);setSyncError("")
    try { const result=await syncShipping(selectedRmaNo); if(!selectedRmaNo) setJob(result); setRevision(v=>v+1) }
    catch(error) {setSyncError(error.message)}
    finally {setSyncing(false)}
  }

  useEffect(() => {
    let active = true
    getShippingOrders().then(rows => {
      if (!active) return
      setOrders(rows)
      setListError("")
      setSelectedRmaNo(current => rows.some(row => row.rmaNo === current) ? current : "")
    }).catch(error => { if (active) setListError(error.message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [revision])

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      if (!selectedRmaNo) { setContext(null); setDetailLoading(false); setDetailError(""); return }
      setDetailLoading(true); setDetailError(""); setContext(null)
      getShippingContext(selectedRmaNo).then(data => { if (active) setContext(data) })
        .catch(error => { if (active) setDetailError(error.message) })
        .finally(() => { if (active) setDetailLoading(false) })
    }, 0)
    return () => { active = false; window.clearTimeout(timer) }
  }, [selectedRmaNo, revision])

  function refresh() { setLoading(true); setRevision(value => value + 1) }
  const order = context?.order?.rmaNo === selectedRmaNo ? context.order : null
  const pendingCount = orders.filter(item => state(item) === "PENDING").length
  const filteredOrders = filterShippingOrders(orders, search).filter(item => filter === "all" || (filter === "shipped" ? shipped(item) : filter === "unknown" ? state(item) === "UNKNOWN" : state(item) === "PENDING"))
  const unavailable = loading || Boolean(listError)

  const refreshControl = <button className="fdship-refresh" disabled={loading} onClick={refresh}><AppIcon name="sync" size={16} />{loading ? "正在更新" : "刷新列表"}</button>

  return <div className="fdship-page">
    <header className="fdship-header">
      <div className="fdship-title"><button className="fdship-back" aria-label={selectedRmaNo ? "返回发货列表" : "退出发货进度"} onClick={() => selectedRmaNo ? setSelectedRmaNo("") : setPage("appBack")}>←</button><div><span className="fdship-eyebrow">发货管理</span><h1>{selectedRmaNo ? "工单详情" : "发货进度"}</h1></div></div>
    </header>
    {!selectedRmaNo && <section className="fdship-metrics" aria-label="发货统计">
      {[{ label: "待发货", value: pendingCount, icon: "inventory", tone: "amber", note: "维修已完成，等待寄出" }, { label: "已发货", value: orders.filter(shipped).length, icon: "shipping", tone: "blue", note: "返件已寄出，等待完结" }, { label: "当前队列", value: orders.length, icon: "records", tone: "slate", note: "全部待处理返件工单" }].map(metric => <div className="fdship-metric" key={metric.label}><div><span>{metric.label}</span><strong>{unavailable ? "—" : metric.value}<small>单</small></strong><p>{metric.note}</p></div><span className={`fdship-icon fdship-${metric.tone}`}><AppIcon name={metric.icon} size={23} /></span></div>)}
    </section>}
    <div className="fdship-sync-bar"><button className="fdship-refresh" onClick={synchronize} disabled={syncing || job?.running}>{syncing ? "正在同步…" : job?.running ? `同步中 ${job.done}/${job.total}` : selectedRmaNo ? "同步本单物流" : "同步瑞云物流"}</button><small>{job?.running ? "正在逐单核对，可继续查看已有结果" : job?.finishedAt ? `上次批量同步：${job.done - job.failed} 单成功，${job.failed} 单待重试${job.paused ? "，连续查询失败，已暂停" : ""}` : "未核对的工单不计入待发货"}</small></div>
    {syncError && <p className="fdship-alert" role="alert">{syncError}</p>}
    {listError && <div className="fdship-alert" role="alert"><AppIcon name="alert" size={21} /><div><strong>工单列表暂时无法加载</strong><p>{listError}</p><small>连接恢复后点击刷新，即可重新查看工单。</small></div><button onClick={refresh} disabled={loading}>重试</button></div>}
    <div className="fdship-workspace">
      {!selectedRmaNo && <section className="fdship-panel fdship-queue" aria-label="工单队列">
        <div className="fdship-panel-heading"><h2>工单队列</h2><span className="fdship-counter">{unavailable ? "待更新" : `${filteredOrders.length} 单`}</span>{refreshControl}</div>
        <label className="fdship-search" htmlFor="shipping-search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input id="shipping-search" aria-label="搜索工单" type="search" value={search} placeholder="搜索单号、姓名、电话或 SN" onChange={event => setSearch(event.target.value)} /></label>
        <div className="fdship-filters" role="group" aria-label="筛选发货状态">{[["all", "全部"], ["pending", "待发货"], ["shipped", "已发货"], ["unknown", "待同步"]].map(([value, label]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
        {loading ? <div className="fdship-empty" role="status"><span className="fdship-empty-icon"><AppIcon name="sync" size={28} /></span><h3>正在加载工单</h3><p>请稍候，正在更新发货进度。</p></div> : listError ? <div className="fdship-empty"><span className="fdship-empty-icon"><AppIcon name="alert" size={28} /></span><h3>等待连接恢复</h3><p>暂时无法确认工单数量。</p></div> : !filteredOrders.length ? <div className="fdship-empty"><span className="fdship-empty-icon"><AppIcon name="shipping" size={32} /></span><h3>{orders.length ? "没有找到匹配工单" : "暂无待处理的发货工单"}</h3><p>{orders.length ? "试试其他关键词，或切换发货状态。" : "维修完成后的返件工单会显示在这里。"}</p>{orders.length > 0 && <button onClick={() => { setSearch(""); setFilter("all") }}>清空筛选</button>}</div> : <div className="fdship-order-list">{filteredOrders.map(item => <button className={`fdship-order ${selectedRmaNo === item.rmaNo ? "is-selected" : ""}`} key={item.rmaNo} aria-pressed={selectedRmaNo === item.rmaNo} onClick={() => { setSelectedRmaNo(item.rmaNo); window.scrollTo({ top: 0, behavior: "auto" }) }}><div><strong>{item.rmaNo}</strong><span className={`fdship-badge ${shipped(item) ? "is-shipped" : ""}`}>{statusLabel(item)}</span></div><p>{item.customerName || "姓名未记录"}<span>·</span>{item.productLine || "机型未记录"}</p><small>SN {item.sn || "未记录"}</small></button>)}</div>}
      </section>}
      {selectedRmaNo && <section className="fdship-detail" aria-label="工单详情">
        {detailLoading || (!order && !detailError) ? <div className="fdship-panel fdship-empty" role="status"><h3>正在读取工单详情…</h3></div> : detailError ? <div className="fdship-panel fdship-empty" role="alert"><h3>暂时无法读取详情</h3><p>{detailError}</p><button disabled={loading} onClick={refresh}>重新加载</button></div> : order && <>
          <div className="fdship-panel fdship-order-heading">{refreshControl}<span className={`fdship-badge ${shipped(order) ? "is-shipped" : ""}`}>{statusLabel(order)}</span><h2>{order.rmaNo}</h2><p>{order.productLine || "机型未记录"}<span>·</span>SN {order.sn || "未提供"}</p></div>
          <div className="fdship-panel"><div className="fdship-panel-heading"><h2>返件资料</h2><span className="fdship-readonly">仅查看</span></div><dl className="fdship-fields"><div><dt>用户姓名</dt><dd>{order.customerName || "未提供"}</dd></div><div><dt>联系电话</dt><dd>{order.phoneMasked || "未提供"}</dd></div><div className="fdship-wide"><dt>收件地址</dt><dd>{order.regionAddress || "未提供"}</dd></div><div className="fdship-wide"><dt>维修结果</dt><dd>{order.repairCompletion?.repairMeasure || "未提供"}</dd></div><div className="fdship-wide"><dt>已使用配件</dt><dd>{context.usedParts?.length ? context.usedParts.map(part => `${part.partName} × ${part.quantity}`).join("、") : "无实际使用配件"}</dd></div></dl></div>
          <div className="fdship-panel"><div className="fdship-panel-heading"><h2>发货进度</h2><AppIcon name="shipping" size={20} /></div><div className="fdship-progress"><span className="fdship-progress-dot" /><div><strong>{statusLabel(order)}</strong><p>{order.recloudShipping?.rawStatus ? `瑞云状态：${order.recloudShipping.rawStatus}` : "尚未确认瑞云返件状态，请同步核对。"}</p></div></div><dl className="fdship-fields"><div><dt>快递公司</dt><dd>{order.recloudShipping?.logisticsCompany || "未提供"}</dd></div><div><dt>返件单号</dt><dd>{order.recloudShipping?.trackingNo || "未提供"}</dd></div><div><dt>发货时间</dt><dd>{order.recloudShipping?.shippedAt || "未提供"}</dd></div><div><dt>签收时间</dt><dd>{order.recloudShipping?.signedAt || "暂无确认记录"}</dd></div></dl>
          <details className="fdship-timeline" open><summary>物流轨迹<span>{order.recloudShipping?.traces?.length || 0} 条</span></summary>{order.recloudShipping?.traces?.length ? <ol>{order.recloudShipping.traces.map((trace,index)=><li key={index}><time>{trace.at}</time><p>{trace.description}</p></li>)}</ol> : <p>{order.recloudShipping?.traceStatus === "UNAVAILABLE" ? "本次未能取得物流轨迹，请重试。" : "点击“同步本单物流”读取瑞云最新轨迹。"}</p>}</details>
          {order.recloudShipping?.error && <p role="alert">{order.recloudShipping.error}，保留上次成功结果。</p>}
          <details className="fdship-timeline"><summary>查看处理记录<span>{(order.timeline || []).length} 条</span></summary>{order.timeline?.length ? <ol>{order.timeline.map((item, index) => <li key={item.id || index}><strong>{item.label}</strong><time>{new Date(item.at).toLocaleString()}</time></li>)}</ol> : <p>暂无处理记录。</p>}</details><p className="fdship-footnote">来自瑞云 · 最后成功同步：{order.recloudShipping?.syncedAt ? new Date(order.recloudShipping.syncedAt).toLocaleString() : "尚未同步"}</p></div>
        </>}
      </section>}
    </div>
  </div>
}
export default ReturnShipping
