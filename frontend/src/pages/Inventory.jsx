import { useEffect, useState } from "react"
import {
  getCurrentFieldDeskUser,
  getLocalInventory,
  recordLocalPartUse,
  requestLocalPartReturn,
} from "../shared/crmService.js"
import { getCurrentRepairOrder } from "../shared/repairOrderStore.js"

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
      setMessage(result.message)
      await refresh()
    } catch (error) { setMessage(error.message) }
  }

  if (!inventory || !user) return <div className="page"><p>正在读取本地库存...</p></div>
  const personalEntries = Object.entries(inventory.technicianStock || {})

  return <div className="page">
    <h1>{user.role === "TECHNICIAN" ? "我的库存" : "库存总览"}</h1>
    <div className="card">
      <h2>总库库存（只读）</h2>
      {inventory.totalStock.map((part) => <p key={part.code}>{part.name}（{part.code}）：{part.stock}</p>)}
    </div>
    <div className="card">
      <h2>{user.role === "TECHNICIAN" ? "个人库存" : "全部师傅库存"}</h2>
      {personalEntries.map(([technicianId, stock]) => <div className="inventory-item" key={technicianId}>
        <h3>{stock.technicianName}</h3>
        {stock.parts.length === 0 ? <p>暂无库存</p> : stock.parts.map((part) => <div key={part.code}>
          <p>{part.name}（{part.code}）：{part.stock}</p>
          {user.role === "TECHNICIAN" && <div>
            <input type="number" min="1" value={quantities[part.code] || 1} onChange={(event) => setQuantities({ ...quantities, [part.code]: event.target.value })} />
            <button onClick={() => act("use", part.code)}>使用</button>
            <button onClick={() => act("return", part.code)}>申请退还</button>
          </div>}
        </div>)}
      </div>)}
    </div>
    <div className="card">
      <h2>库存流水</h2>
      {inventory.transactions.length === 0 ? <p>暂无流水</p> : inventory.transactions.slice().reverse().map((item) =>
        <p key={item.id}>{item.type}｜{item.partName} × {item.quantity}｜SN：{item.sn}｜寄修单：{item.rmaNo}｜师傅：{item.technicianName}｜{item.createdAt}</p>
      )}
    </div>
    {message && <div className="card"><p>{message}</p></div>}
    {user.role === "TECHNICIAN" && order.crmOrderNo && (
      <button className="primary-btn" onClick={() => setPage("repairCompletion")}>返回当前工单并进入维修完工</button>
    )}
  </div>
}

export default Inventory
