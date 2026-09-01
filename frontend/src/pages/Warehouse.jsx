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
  return <div className="page">
    <h1>库房管理</h1>
    <div className="card"><h2>配件入库</h2><form onSubmit={stockIn}>
      <input aria-label="入库配件编码" value={stockForm.partCode} onChange={(event) => setStockForm({ ...stockForm, partCode: event.target.value })} placeholder="完整物料编码" required />
      <input aria-label="入库配件名称" value={stockForm.partName} onChange={(event) => setStockForm({ ...stockForm, partName: event.target.value })} placeholder="配件名称" required />
      <input aria-label="入库数量" type="number" min="1" value={stockForm.quantity} onChange={(event) => setStockForm({ ...stockForm, quantity: event.target.value })} />
      <button type="submit">登记入库</button>
    </form></div>
    <div className="card"><h2>发放给师傅</h2><form onSubmit={allocate}>
      <input aria-label="发放配件编码" value={allocateForm.partCode} onChange={(event) => setAllocateForm({ ...allocateForm, partCode: event.target.value })} placeholder="完整物料编码" required />
      <input aria-label="师傅账号" value={allocateForm.technicianId} onChange={(event) => setAllocateForm({ ...allocateForm, technicianId: event.target.value })} placeholder="师傅账号 ID" required />
      <input aria-label="师傅姓名" value={allocateForm.technicianName} onChange={(event) => setAllocateForm({ ...allocateForm, technicianName: event.target.value })} placeholder="师傅姓名" required />
      <input aria-label="发放数量" type="number" min="1" value={allocateForm.quantity} onChange={(event) => setAllocateForm({ ...allocateForm, quantity: event.target.value })} />
      <button type="submit">确认发放</button>
    </form></div>
    <div className="card"><h2>待确认退还</h2>
      {inventory.returnRequests.filter((item) => item.status === "PENDING_WAREHOUSE_CONFIRMATION").map((item) =>
        <div className="inventory-item" key={item.id}>
          <p>{item.partName} × {item.quantity}</p><p>师傅：{item.technicianName}</p><p>SN：{item.sn}</p><p>寄修单：{item.rmaNo}</p>
          <button onClick={() => confirm(item.id)}>确认退还入总库</button>
        </div>
      )}
    </div>
    <div className="card"><h2>总库</h2>{inventory.totalStock.map((part) => <p key={part.code}>{part.name}（{part.code}）：{part.stock}</p>)}</div>
    <div className="card"><h2>全部师傅库存</h2>{Object.entries(inventory.technicianStock).map(([id, stock]) => <div key={id}><h3>{stock.technicianName}</h3>{stock.parts.map((part) => <p key={part.code}>{part.name}：{part.stock}</p>)}</div>)}</div>
    <div className="card"><h2>库存流水</h2>{inventory.transactions.slice().reverse().map((item) => <p key={item.id}>{item.type}｜{item.partName} × {item.quantity}｜{item.technicianName}｜{item.createdAt}</p>)}</div>
    {message && <p role="status">{message}</p>}
  </div>
}
export default Warehouse
