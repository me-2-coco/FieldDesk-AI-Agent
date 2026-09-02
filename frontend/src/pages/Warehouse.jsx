import { useEffect, useState } from "react"
import {
  allocateInventoryPart,
  confirmLocalPartReturn,
  getLocalInventory,
  receiveInventoryPart
} from "../shared/crmService.js"

function Warehouse({ setPage }) {
  const [inventory, setInventory] = useState(null)
  const [message, setMessage] = useState("")
  const [stockForm, setStockForm] = useState({ partCode: "", partName: "", quantity: 1 })
  const [allocateForm, setAllocateForm] = useState({ partCode: "", technicianId: "", technicianName: "", quantity: 1 })
  async function refresh() { setInventory(await getLocalInventory()) }
  useEffect(() => {
    getLocalInventory()
      .then(setInventory)
      .catch((error) => setMessage(error.message))
  }, [])
  async function confirm(requestId) {
    try {
      const result = await confirmLocalPartReturn(requestId)
      setMessage(result.message)
      await refresh()
    } catch (error) { setMessage(error.message) }
  }
  async function stockIn(event) {
    event.preventDefault()
    try { const result = await receiveInventoryPart(stockForm); setMessage(result.message); await refresh() }
    catch (error) { setMessage(error.message) }
  }
  async function allocate(event) {
    event.preventDefault()
    try { const result = await allocateInventoryPart(allocateForm); setMessage(result.message); await refresh() }
    catch (error) { setMessage(error.message) }
  }
  if (!inventory) return <div className="page"><p>正在读取本地库存...</p></div>
  const pendingReturns = inventory.returnRequests.filter((item) => item.status === "PENDING_WAREHOUSE_CONFIRMATION")
  return <div className="page warehouse-page compact-backoffice-page">
    <div className="top-bar"><button className="arrow-back" onClick={() => setPage("home")}>←</button><div><small>库存与库房</small><h1>库房作业</h1></div></div>
    <div className="card compact-data-card warehouse-pending-card"><div className="section-title-row"><div><small>优先处理</small><h2>待确认退还</h2></div><span>{pendingReturns.length} 单</span></div>
      {!pendingReturns.length && <p className="empty-compact-state">当前没有待确认退件</p>}
      <div className="compact-scroll-list">{pendingReturns.map((item) =>
        <div className="inventory-item return-request-row" key={item.id}>
          <div><strong>{item.partName} × {item.quantity}</strong><small>{item.technicianName} · SN {item.sn || "--"}<br />寄修单 {item.rmaNo || "--"}</small></div>
          <button onClick={() => confirm(item.id)}>确认退还入总库</button>
        </div>
      )}</div>
    </div>
    <div className="warehouse-operation-grid">
    <details className="card compact-data-card compact-details"><summary><span><small>库存操作</small><strong>配件入库</strong></span><b>展开</b></summary><form onSubmit={stockIn}>
      <input aria-label="入库配件编码" value={stockForm.partCode} onChange={(event) => setStockForm({ ...stockForm, partCode: event.target.value })} placeholder="完整物料编码" required />
      <input aria-label="入库配件名称" value={stockForm.partName} onChange={(event) => setStockForm({ ...stockForm, partName: event.target.value })} placeholder="配件名称" required />
      <input aria-label="入库数量" type="number" min="1" value={stockForm.quantity} onChange={(event) => setStockForm({ ...stockForm, quantity: event.target.value })} />
      <button type="submit">登记入库</button>
    </form></details>
    <details className="card compact-data-card compact-details"><summary><span><small>库存操作</small><strong>发放给师傅</strong></span><b>展开</b></summary><form onSubmit={allocate}>
      <input aria-label="发放配件编码" value={allocateForm.partCode} onChange={(event) => setAllocateForm({ ...allocateForm, partCode: event.target.value })} placeholder="完整物料编码" required />
      <input aria-label="师傅账号" value={allocateForm.technicianId} onChange={(event) => setAllocateForm({ ...allocateForm, technicianId: event.target.value })} placeholder="师傅账号 ID" required />
      <input aria-label="师傅姓名" value={allocateForm.technicianName} onChange={(event) => setAllocateForm({ ...allocateForm, technicianName: event.target.value })} placeholder="师傅姓名" required />
      <input aria-label="发放数量" type="number" min="1" value={allocateForm.quantity} onChange={(event) => setAllocateForm({ ...allocateForm, quantity: event.target.value })} />
      <button type="submit">确认发放</button>
    </form></details></div>
    <div className="card compact-data-card"><div className="section-title-row"><div><small>库存总览</small><h2>总库</h2></div><span>{inventory.totalStock.length} 种</span></div><div className="compact-stock-list">{inventory.totalStock.map((part) => <div key={part.code}><span><strong>{part.name}</strong><small>{part.code}</small></span><b>{part.stock}</b></div>)}</div></div>
    <details className="card compact-data-card compact-details"><summary><span><small>人员库存</small><strong>全部师傅库存</strong></span><b>{Object.keys(inventory.technicianStock).length} 人</b></summary><div className="compact-scroll-list">{Object.entries(inventory.technicianStock).map(([id, stock]) => <div className="inventory-item" key={id}><h3>{stock.technicianName}</h3>{stock.parts.length ? stock.parts.map((part) => <p key={part.code}>{part.name}：{part.stock}</p>) : <p>暂无库存</p>}</div>)}</div></details>
    <details className="card compact-data-card compact-details"><summary><span><small>库存记录</small><strong>库存流水</strong></span><b>{inventory.transactions.length} 条</b></summary><div className="compact-scroll-list transaction-list">{inventory.transactions.slice().reverse().map((item) => <p key={item.id}><strong>{item.type} · {item.partName} × {item.quantity}</strong><small>{item.technicianName || "--"} · {item.createdAt}</small></p>)}</div></details>
    {message && <p className="inline-status" role="status">{message}</p>}
  </div>
}
export default Warehouse
