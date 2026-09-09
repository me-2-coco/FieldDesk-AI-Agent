import { useEffect, useState } from "react"
import { AppIcon } from "../components/AppIcons.jsx"
import { canAccessPage, getCurrentUser } from "../shared/userStore.js"
import Warehouse from "./Warehouse.jsx"
import "../home-desktop.css"
import {
  getCurrentFieldDeskUser,
  getLocalInventory,
  queryRecloudPartsInventory,
  recordLocalPartUse,
  requestLocalPartReturn,
} from "../shared/crmService.js"
import { getCurrentRepairOrder, REPAIR_STATUS, updateRepairOrder } from "../shared/repairOrderStore.js"

function InventoryContent({ setPage }) {
  const [user, setUser] = useState(null)
  const [inventory, setInventory] = useState(null)
  const [quantities, setQuantities] = useState({})
  const [message, setMessage] = useState("")
  const [recloudQuery, setRecloudQuery] = useState("")
  const [recloudResult, setRecloudResult] = useState(null)
  const [recloudLoading, setRecloudLoading] = useState(false)
  const [recloudError, setRecloudError] = useState("")
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

  async function searchRecloudInventory(event) {
    event.preventDefault()
    const query = recloudQuery.trim()
    if (!query || recloudLoading) return
    setRecloudLoading(true)
    setRecloudError("")
    try {
      setRecloudResult(await queryRecloudPartsInventory(query))
    } catch (error) {
      setRecloudResult(null)
      setRecloudError(error.message)
    } finally {
      setRecloudLoading(false)
    }
  }

  if (!inventory || !user) return <div className="page"><p>正在读取本地库存...</p></div>
  const personalEntries = Object.entries(inventory.technicianStock || {})
  const isTechnicianRole = String(user.role || "").toUpperCase() === "TECHNICIAN"
  const personalPartCount = personalEntries.reduce((total, [, stock]) => total + stock.parts.reduce((sum, part) => sum + Number(part.stock || 0), 0), 0)

  return <div className="page inventory-page compact-backoffice-page">
    <header className="inventory-app-hero">
      <button className="inventory-hero-back" onClick={() => recloudResult ? setRecloudResult(null) : setPage("appBack")} aria-label={recloudResult ? "返回库存查询" : "返回库存"}>←</button>
      <span className="inventory-hero-icon"><AppIcon name="inventory" size={24} /></span>
      <div className="inventory-hero-copy">
        <small>RECLOUD PARTS</small>
        <h1>库存查询</h1>
        <p>实时查询备件与个人领用记录</p>
      </div>
      <span className="inventory-live-badge"><i />实时</span>
    </header>

    <section className="card compact-data-card inventory-search-card">
      <div className="section-title-row inventory-section-title"><div><small>瑞云备件管理</small><h2>备件库存查询</h2></div><span><AppIcon name="sync" size={12} />只读实时</span></div>
      <form className="recloud-inventory-search" onSubmit={searchRecloudInventory}>
        <label className="inventory-search-field">
          <span aria-hidden="true">⌕</span>
          <input value={recloudQuery} onChange={(event) => setRecloudQuery(event.target.value)} placeholder="仓库编码或配件编码" aria-label="瑞云备件库存查询" />
        </label>
        <button type="submit" disabled={!recloudQuery.trim() || recloudLoading}>{recloudLoading ? "查询中…" : "查询"}</button>
      </form>
      {!recloudResult && !recloudError && <p className="recloud-inventory-hint"><span>数据源</span> 瑞云 · 备件管理 · 备件库存</p>}
      {recloudError && <p className="error-text recloud-inventory-message">{recloudError}</p>}
      {recloudResult && <>
        <div className="recloud-inventory-summary"><span>查询结果</span><strong>{recloudResult.count} 条</strong></div>
        <div className="recloud-inventory-results">
          {!recloudResult.records.length && <p>瑞云未查询到匹配库存</p>}
          {recloudResult.records.map((part, index) => <div key={`${part.warehouseCode}-${part.partCode}-${index}`}>
            <span><strong>{part.partName || "配件名称未记录"}</strong><small>{part.partCode || "编码未记录"} · {part.productLine || "产品线未记录"}</small><em>{part.warehouseName || "仓库未记录"}（{part.warehouseCode || "--"}）</em></span>
            <b>{part.quantity}<small>{part.unit || ""}</small></b>
          </div>)}
        </div>
      </>}
    </section>

    <section className="card compact-data-card inventory-person-card">
      <div className="section-title-row inventory-section-title"><div><small>PERSONAL STOCK</small><h2>{isTechnicianRole ? "个人库存" : "全部师傅库存"}</h2></div><span>{personalPartCount} 件</span></div>
      <div className="compact-scroll-list inventory-person-list">
      {personalEntries.map(([technicianId, stock]) => <div className="inventory-item" key={technicianId}>
        <div className="inventory-person-profile">
          <span>{stringOrFallback(stock.technicianName)}</span>
          <div><h3>{stock.technicianName}</h3><small>{stock.parts.length ? `${stock.parts.length} 种备件` : "当前无领用备件"}</small></div>
          <b>{stock.parts.reduce((sum, part) => sum + Number(part.stock || 0), 0)}<small>件</small></b>
        </div>
        {stock.parts.length === 0 ? <div className="inventory-empty-state"><span><AppIcon name="archive" size={20} /></span><strong>暂无个人库存</strong><small>领用备件后会显示在这里</small></div> : stock.parts.map((part) => <div className="inventory-person-part" key={part.code}>
          <p>{part.name}（{part.code}）：{part.stock}</p>
          {isTechnicianRole && <div>
            <input type="number" min="1" value={quantities[part.code] || 1} onChange={(event) => setQuantities({ ...quantities, [part.code]: event.target.value })} />
            <button onClick={() => act("use", part.code)}>使用</button>
            <button onClick={() => act("return", part.code)}>申请退还</button>
          </div>}
        </div>)}
      </div>)}</div>
    </section>
    <details className="card compact-data-card compact-details inventory-ledger-card"><summary><span className="inventory-ledger-icon"><AppIcon name="history" size={19} /></span><span><small>INVENTORY LOG</small><strong>库存流水</strong></span><b>{inventory.transactions.length} 条</b><i>⌄</i></summary><div className="compact-scroll-list transaction-list">
      {inventory.transactions.length === 0 ? <p>暂无流水</p> : inventory.transactions.slice().reverse().map((item) => <p key={item.id}><strong>{item.type} · {item.partName} × {item.quantity}</strong><small>SN {item.sn || "--"} · {item.technicianName || "--"} · {item.createdAt}</small></p>)}
    </div></details>
    {message && <div className="card"><p>{message}</p></div>}
  </div>
}

function stringOrFallback(name) {
  return String(name || "库").trim().slice(0, 1) || "库"
}

function Inventory({ setPage }) {
  const [view, setView] = useState("apps")
  const canUseWarehouse = canAccessPage("warehouse", getCurrentUser())
  function navigateInside(next) {
    if (next !== "appBack") { setPage(next); return }
    const expanded = [...document.querySelectorAll(".page details[open]")].at(-1)
    if (expanded) { expanded.open = false; return }
    setView("apps")
  }
  if (view !== "apps") return <>
    {view === "warehouse" && canUseWarehouse ? <Warehouse setPage={navigateInside} /> : <InventoryContent setPage={navigateInside} />}
  </>
  return <div className="page home-desktop">
    <h1>库存</h1>
    <section className="desktop-app-group"><h2>库存与库房</h2><div className="desktop-app-grid">
      <button type="button" className="desktop-app" onClick={() => setView("overview")}><span className="desktop-app-icon desktop-tone-0"><AppIcon name="inventory" size={27} /></span><span>库存总览</span></button>
      {canUseWarehouse && <button type="button" className="desktop-app" onClick={() => setView("warehouse")}><span className="desktop-app-icon desktop-tone-1"><AppIcon name="warehouse" size={27} /></span><span>库房作业</span></button>}
    </div></section>
  </div>
}

export default Inventory
