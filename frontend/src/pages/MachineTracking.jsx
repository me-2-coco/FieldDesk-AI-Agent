import { useState } from "react"
import { getMachinesInHand } from "../shared/crmService.js"

function MachineTracking({ setPage }) {
  const [keyword, setKeyword] = useState("")
  const [machines, setMachines] = useState([])
  const [message, setMessage] = useState("")
  const [loading, setLoading] = useState(false)

  async function search(event) {
    event.preventDefault()
    try {
      setLoading(true)
      setMessage("")
      const data = await getMachinesInHand(keyword)
      setMachines(data)
      if (!data.length) setMessage("没有查到签收后仍在网点的机器")
    } catch (error) {
      setMachines([])
      setMessage(error.message)
    } finally {
      setLoading(false)
    }
  }

  const activeCount = machines.filter((machine) => !["COMPLETED", "CLOSED"].includes(machine.status)).length

  return <div className="page machine-tracking-page">
    <div className="top-bar backoffice-page-header"><button className="arrow-back" onClick={() => setPage("home")}>←</button><div><small>查询与档案</small><h1>机器去向</h1></div></div>
    <div className="card backoffice-intro-card">
      <div className="backoffice-intro-icon">机</div>
      <div><strong>查询网点在手机器</strong><p>通过联系电话或物流单号，快速确认机器当前负责人和处理状态。</p></div>
    </div>
    <div className="card compact-data-card">
      <div className="section-title-row"><div><small>快速查询</small><h2>定位机器</h2></div>{machines.length > 0 && <span>{machines.length} 台</span>}</div>
      <form onSubmit={search}>
        <label htmlFor="machine-keyword">电话或物流单号</label>
        <input id="machine-keyword" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入电话或完整物流单号" />
        <button className="primary-btn" type="submit" disabled={loading}>{loading ? "查询中..." : "查询机器"}</button>
      </form>
    </div>
    {machines.length > 0 && <div className="card compact-data-card">
      <div className="section-title-row"><div><small>查询结果</small><h2>机器列表</h2></div><span>{activeCount} 台处理中</span></div>
      <div className="compact-result-list machine-result-list">
        {machines.map((machine) => <details className="compact-record-card" key={machine.rmaNo}>
          <summary>
            <span><strong>{machine.rmaNo}</strong><small>{machine.productLine || "产品线未记录"} · {machine.sn || "SN 未记录"}</small></span>
            <em>{machine.technicianName || "未分配"}</em>
          </summary>
          <div className="compact-record-body">
            <div className="compact-key-value-grid">
              <span><small>当前状态</small><strong>{machine.status || "未记录"}</strong></span>
              <span><small>物流单号</small><strong>{machine.logisticsNo || "未记录"}</strong></span>
              <span><small>机器 SN</small><strong>{machine.sn || "未记录"}</strong></span>
              <span><small>签收时间</small><strong>{machine.receivedAt ? new Date(machine.receivedAt).toLocaleString() : "未记录"}</strong></span>
            </div>
          </div>
        </details>)}
      </div>
    </div>}
    {message && <p className="inline-notice-card" role="status">{message}</p>}
  </div>
}

export default MachineTracking
