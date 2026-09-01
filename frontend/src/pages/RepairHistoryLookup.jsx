import { useState } from "react"
import ScannerModal from "../components/ScannerModal.jsx"
import { ScanIcon } from "../components/AppIcons.jsx"
import { getRepairHistoryByPhone } from "../shared/crmService.js"

function displayTime(value) {
  if (!value) return "未记录"
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString("zh-CN", { hour12: false })
}

function RepairHistoryLookup() {
  const [keyword, setKeyword] = useState("")
  const [records, setRecords] = useState([])
  const [message, setMessage] = useState("")
  const [loading, setLoading] = useState(false)
  const [scannerOpen, setScannerOpen] = useState(false)

  async function runSearch(nextKeyword = keyword) {
    const value = String(nextKeyword || "").trim()
    if (!/^1[3-9]\d{9}$/.test(value) && !/^[A-Z0-9-]{8,}$/i.test(value)) {
      setRecords([])
      setMessage("请输入完整联系电话或机器 SN")
      return
    }
    try {
      setLoading(true)
      setMessage("")
      const data = await getRepairHistoryByPhone(value)
      setRecords(data)
      if (!data.length) setMessage("没有查询到历史维修记录")
    } catch (error) {
      setRecords([])
      setMessage(error.message)
    } finally {
      setLoading(false)
    }
  }

  function search(event) {
    event.preventDefault()
    runSearch()
  }

  function handleScan(value) {
    const scanned = String(value || "").trim()
    setKeyword(scanned)
    runSearch(scanned)
  }

  return <div className="page repair-history-page">
    <header className="history-page-header">
      <span>维修档案</span>
      <h1>历史工单</h1>
      <p>查询客户全部历史维修记录</p>
    </header>
    <section className="history-query-hero">
      <span className="history-query-hero-icon">历</span>
      <div><small>维修记录快速追溯</small><strong>电话与机器 SN 均可查询</strong></div>
      <b>只读</b>
    </section>
    <section className="card history-search-card">
      <div className="history-card-heading">
        <div><span>历史检索</span><h2>查询维修记录</h2></div>
        <small>支持扫码</small>
      </div>
      <div className="history-query-types"><span>完整电话</span><span>机器 SN</span></div>
      <form onSubmit={search}>
        <div className="scan-input-row">
          <input aria-label="联系电话或机器 SN" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入完整电话或机器 SN" autoCapitalize="characters" />
          <button className="scan-btn" type="button" aria-label="扫描机器 SN" onClick={() => setScannerOpen(true)}><ScanIcon /></button>
        </div>
        <button className="primary-btn history-query-submit" type="submit" disabled={loading}>{loading ? "正在查询..." : "查询历史记录"}</button>
      </form>
      <div className="history-readonly-tip"><span>✓</span><p><strong>安全只读模式</strong>本页面只读，不能修改历史工单</p></div>
    </section>
    {records.length > 0 && <section className="card history-results-card">
      <div className="history-results-heading">
        <div><span>查询结果</span><h2>历史维修记录</h2></div>
        <strong>{records.length} 条</strong>
      </div>
      <p className="history-results-tip">按维修完成时间从新到旧排列</p>
      <div className="history-order-list">
        {records.map((record) => <article className="history-order-card" key={`${record.rmaNo}-${record.completedAt}`}>
          <div className="history-order-top">
            <div><small>寄修单号</small><h3>{record.rmaNo || "未记录"}</h3></div>
            <span>已完成</span>
          </div>
          <div className="history-order-grid">
            <div><small>用户姓名</small><strong>{record.customerName || "未记录"}</strong></div>
            <div><small>完整电话</small><strong>{record.phone || "未记录"}</strong></div>
            <div><small>用户信息</small><strong>{record.customerAddress || "未记录"}</strong></div>
            <div className="history-technician"><small>原维修师傅</small><strong>{record.technicianName || "未记录"}</strong></div>
            <div><small>产品线</small><strong>{record.productLine || "未记录"}</strong></div>
            <div><small>机器 SN</small><strong>{record.sn || "未记录"}</strong></div>
          </div>
          <div className="history-order-note"><small>用户报修描述</small><p>{record.reportedFault || "未记录"}</p></div>
          <div className="history-order-note"><small>更换的配件</small><p>{record.replacedParts?.length ? record.replacedParts.map((part) => `${part.name} × ${part.quantity}`).join("、") : "未更换配件"}</p></div>
          <footer><span>维修完成时间</span><strong>{displayTime(record.completedAt)}</strong></footer>
        </article>)}
      </div>
    </section>}
    {message && <section className="card history-message-card" role="status"><span>!</span><div><strong>查询结果</strong><p>{message}</p></div></section>}
    <ScannerModal open={scannerOpen} mode="sn" title="扫描机器 SN" onScan={handleScan} onClose={() => setScannerOpen(false)} />
  </div>
}

export default RepairHistoryLookup
