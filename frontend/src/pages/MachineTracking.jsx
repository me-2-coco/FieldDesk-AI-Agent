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

  return <div className="page machine-tracking-page">
    <div className="top-bar"><button className="arrow-back" onClick={() => setPage("home")}>←</button><h1>机器去向</h1></div>
    <div className="card">
      <p>信息员和管理员可通过电话或物流单号查询签收后的机器当前在哪位师傅手里。</p>
      <form onSubmit={search}>
        <label htmlFor="machine-keyword">电话或物流单号</label>
        <input id="machine-keyword" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入电话或完整物流单号" />
        <button className="primary-btn" type="submit" disabled={loading}>{loading ? "查询中..." : "查询机器"}</button>
      </form>
    </div>
    {machines.map((machine) => <article className="card" key={machine.rmaNo}>
      <h2>{machine.rmaNo}</h2>
      <p>当前师傅：<strong>{machine.technicianName}</strong></p>
      <p>当前状态：{machine.status}</p>
      <p>物流单号：{machine.logisticsNo}</p>
      <p>SN：{machine.sn || "未记录"}</p>
      <p>产品线：{machine.productLine || "未记录"}</p>
      <p>签收时间：{machine.receivedAt ? new Date(machine.receivedAt).toLocaleString() : "未记录"}</p>
    </article>)}
    {message && <p role="status">{message}</p>}
  </div>
}

export default MachineTracking
