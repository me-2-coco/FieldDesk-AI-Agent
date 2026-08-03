import { useEffect, useState } from "react"
import {
  confirmLocalPartReturn,
  getLocalInventory
} from "../shared/crmService.js"

function Warehouse() {
  const [inventory, setInventory] = useState(null)
  const [message, setMessage] = useState("")
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
  if (!inventory) return <div className="page"><p>正在读取本地库存...</p></div>
  return <div className="page">
    <h1>库房管理</h1>
    <div className="card"><h2>待确认退还</h2>
      {inventory.returnRequests.filter((item) => item.status === "PENDING_WAREHOUSE_CONFIRMATION").map((item) =>
        <div className="inventory-item" key={item.id}>
          <p>{item.partName} × {item.quantity}</p><p>师傅：{item.technicianName}</p><p>SN：{item.sn}</p><p>寄修单：{item.rmaNo}</p>
          <button onClick={() => confirm(item.id)}>确认退还入总库</button>
        </div>
      )}
    </div>
    <div className="card"><h2>总库</h2>{inventory.totalStock.map((part) => <p key={part.code}>{part.name}：{part.stock}</p>)}</div>
    <div className="card"><h2>全部师傅库存</h2>{Object.entries(inventory.technicianStock).map(([id, stock]) => <div key={id}><h3>{stock.technicianName}</h3>{stock.parts.map((part) => <p key={part.code}>{part.name}：{part.stock}</p>)}</div>)}</div>
    <div className="card"><h2>库存流水</h2>{inventory.transactions.slice().reverse().map((item) => <p key={item.id}>{item.type}｜{item.partName} × {item.quantity}｜{item.technicianName}｜{item.createdAt}</p>)}</div>
    {message && <p>{message}</p>}
  </div>
}
export default Warehouse
