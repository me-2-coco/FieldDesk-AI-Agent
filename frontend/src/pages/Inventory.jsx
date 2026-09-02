import { useEffect, useState } from "react"
import {
  getCurrentFieldDeskUser,
  getLocalInventory,
  recordLocalPartUse,
  requestLocalPartReturn,
} from "../shared/crmService.js"
import { getCurrentRepairOrder, REPAIR_STATUS, updateRepairOrder } from "../shared/repairOrderStore.js"

function Inventory({ setPage }) {
  const [user, setUser] = useState(null)
  const [inventory, setInventory] = useState(null)
  const [quantities, setQuantities] = useState({})
  const [message, setMessage] = useState("")
  const order = getCurrentRepairOrder()

  async function refresh() {
    const [currentUser, data] = await Promise.all([
      getCurrentFieldDeskUser(), getLocalInventory()
    ])
    setUser(currentUser)
    setInventory(data)
  }
  useEffect(() => {
    Promise.all([getCurrentFieldDeskUser(), getLocalInventory()])
      .then(([currentUser, data]) => {
        setUser(currentUser)
        setInventory(data)
      })
      .catch((error) => setMessage(error.message))
  }, [])

  async function act(action, partCode) {
    try {
      const payload = { rmaNo: order.crmOrderNo, partCode, quantity: Number(quantities[partCode] || 1) }
      const result = action === "use"
        ? await recordLocalPartUse(payload)
        : await requestLocalPartReturn(payload)
      if (action === "use") updateRepairOrder({ status: REPAIR_STATUS.REPAIRING })
      setMessage(result.message)
      await refresh()
    } catch (error) { setMessage(error.message) }
  }

  if (!inventory || !user) return <div className="page"><p>正在读取本地库存...</p></div>
  const personalEntries = Object.entries(inventory.technicianStock || {})
  const isTechnicianRole = String(user.role || "").toUpperCase() === "TECHNICIAN"

  return <div className="page inventory-page compact-backoffice-page">
    <div className="top-bar"><button className="arrow-back" onClick={() => setPage("home")}>←</button><div><small>库存管理</small><h1>{isTechnicianRole ? "我的库存" : "库存总览"}</h1></div></div>
    <div className="card compact-data-card">
      <div className="section-title-row"><div><small>实时库存</small><h2>总库库存（只读）</h2></div><span>只读</span></div>
      <div className="compact-stock-list">{inventory.totalStock.map((part) => <div key={part.code}><span><strong>{part.name}</strong><small>{part.code}</small></span><b>{part.stock}</b></div>)}</div>
    </div>
    <div className="card compact-data-card">
      <div className="section-title-row"><div><small>人员库存</small><h2>{isTechnicianRole ? "个人库存" : "全部师傅库存"}</h2></div><span>{personalEntries.length} 人</span></div>
      <div className="compact-scroll-list">
      {personalEntries.map(([technicianId, stock]) => <div className="inventory-item" key={technicianId}>
        <h3>{stock.technicianName}</h3>
        {stock.parts.length === 0 ? <p>暂无库存</p> : stock.parts.map((part) => <div key={part.code}>
          <p>{part.name}（{part.code}）：{part.stock}</p>
          {isTechnicianRole && <div>
            <input type="number" min="1" value={quantities[part.code] || 1} onChange={(event) => setQuantities({ ...quantities, [part.code]: event.target.value })} />
            <button onClick={() => act("use", part.code)}>使用</button>
            <button onClick={() => act("return", part.code)}>申请退还</button>
          </div>}
        </div>)}
      </div>)}</div>
    </div>
    <details className="card compact-data-card compact-details"><summary><span><small>库存记录</small><strong>库存流水</strong></span><b>{inventory.transactions.length} 条</b></summary><div className="compact-scroll-list transaction-list">
      {inventory.transactions.length === 0 ? <p>暂无流水</p> : inventory.transactions.slice().reverse().map((item) => <p key={item.id}><strong>{item.type} · {item.partName} × {item.quantity}</strong><small>SN {item.sn || "--"} · {item.technicianName || "--"} · {item.createdAt}</small></p>)}
    </div></details>
    {message && <div className="card"><p>{message}</p></div>}
    {isTechnicianRole && order.crmOrderNo && [REPAIR_STATUS.INSPECTION_COMPLETE, REPAIR_STATUS.WAIT_PARTS, REPAIR_STATUS.REPAIRING].includes(order.status) && (
      <button className="primary-btn" onClick={() => setPage("repairWork")}>配件领用完成，进入维修</button>
    )}
  </div>
}

export default Inventory
