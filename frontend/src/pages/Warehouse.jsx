import { useEffect, useState } from "react"
import { AppIcon } from "../components/AppIcons.jsx"
import {
  allocateInventoryPart,
  confirmLocalPartReturn,
  getLocalInventory,
  getInventoryTechnicians,
  receiveInventoryPart
} from "../shared/crmService.js"

function Warehouse({ setPage, embedded = false }) {
  const [inventory, setInventory] = useState(null)
  const [message, setMessage] = useState("")
  const [stockForm, setStockForm] = useState({ partCode: "", partName: "", quantity: 1 })
  const [allocateForm, setAllocateForm] = useState({ partCode: "", technicianId: "", quantity: 1 })
  const [technicians, setTechnicians] = useState([])
  const [technicianQuery, setTechnicianQuery] = useState("")
  const [busy, setBusy] = useState(false)
  const [activeTool, setActiveTool] = useState("stockIn")
  async function refresh() { setInventory(await getLocalInventory()) }
  useEffect(() => {
    getInventoryTechnicians().then(setTechnicians).catch((error) => setMessage(error.message))
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
    if (busy) return
    setBusy(true)
    try { const result = await receiveInventoryPart(stockForm); setMessage(result.message); await refresh() }
    catch (error) { setMessage(error.message) }
    finally { setBusy(false) }
  }
  async function allocate(event) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    try { const result = await allocateInventoryPart(allocateForm); setMessage(result.message); await refresh() }
    catch (error) { setMessage(error.message) }
    finally { setBusy(false) }
  }
  if (!inventory) return <div className={embedded ? "" : "page"}><p>{message || "正在读取本地库存..."}</p></div>
  const pendingReturns = inventory.returnRequests.filter((item) => item.status === "PENDING_WAREHOUSE_CONFIRMATION")
  return <div className={`${embedded ? "" : "page "}warehouse-page compact-backoffice-page`}>
    {!embedded && <div className="top-bar"><button className="arrow-back" onClick={() => setPage("appBack")}>←</button><div><small>库存与库房</small><h1>库房作业</h1></div></div>}
    <div className="card compact-data-card warehouse-pending-card"><div className="section-title-row"><div><small>优先处理</small><h2>待确认退还</h2></div><span>{pendingReturns.length} 单</span></div>
      {!pendingReturns.length && <p className="empty-compact-state">当前没有待确认退件</p>}
      <div className="compact-scroll-list">{pendingReturns.map((item) =>
        <div className="inventory-item return-request-row" key={item.id}>
          <div><strong>{item.partName} × {item.quantity}</strong><small>{item.technicianName} · SN {item.sn || "--"}<br />寄修单 {item.rmaNo || "--"}</small></div>
          <button onClick={() => confirm(item.id)}>确认退还入总库</button>
        </div>
      )}</div>
    </div>
    <section className="warehouse-toolbox" aria-label="库房工具">
      <div className="warehouse-toolbox-heading"><strong>库房工具</strong><small>选择下方功能办理</small></div>
      <div className="warehouse-app-grid" role="tablist" aria-label="库房功能">
        {[
          ["stockIn", "配件入库", "inventory", 0],
          ["allocate", "发放给师傅", "accounts", 1],
          ["total", "总库", "warehouse", 2],
          ["personal", "师傅库存", "profile", 0],
          ["ledger", "库存流水", "history", 3],
        ].map(([key, label, icon, tone]) => <button key={key} type="button" role="tab" id={`warehouse-tab-${key}`} aria-selected={activeTool === key} aria-controls={`warehouse-panel-${key}`} onClick={() => { setActiveTool(key); setMessage("") }}><span className={`desktop-app-icon desktop-tone-${tone}`}><AppIcon name={icon} size={25} /></span><span>{label}</span></button>)}
      </div>
    </section>
    <div className="warehouse-operation-grid warehouse-forms">
    <section hidden={activeTool !== "stockIn"} role="tabpanel" id="warehouse-panel-stockIn" aria-labelledby="warehouse-tab-stockIn" className="card compact-data-card warehouse-tool-panel"><h2>配件入库</h2><form onSubmit={stockIn}>
      <p className="warehouse-form-hint">登记到货配件，数量计入总库。</p>
      <label>物料编码<input aria-label="入库配件编码" value={stockForm.partCode} onChange={(event) => setStockForm({ ...stockForm, partCode: event.target.value })} placeholder="请输入完整物料编码" required /></label>
      <div className="warehouse-form-row"><label>配件名称<input aria-label="入库配件名称" value={stockForm.partName} onChange={(event) => setStockForm({ ...stockForm, partName: event.target.value })} placeholder="请输入配件名称" required /></label>
      <label>入库数量<input aria-label="入库数量" type="number" min="1" step="1" required value={stockForm.quantity} onChange={(event) => setStockForm({ ...stockForm, quantity: event.target.value })} /></label></div>
      <button type="submit" disabled={busy}>{busy ? "处理中…" : "确认入库"}</button>
    </form></section>
    <section hidden={activeTool !== "allocate"} role="tabpanel" id="warehouse-panel-allocate" aria-labelledby="warehouse-tab-allocate" className="card compact-data-card warehouse-tool-panel"><h2>发放给师傅</h2><form onSubmit={allocate}>
      <p className="warehouse-form-hint">选择领用师傅，配件自动计入对应账号库存。</p>
      <label>领用师傅<input aria-label="搜索师傅姓名" type="search" placeholder="搜索师傅姓名" value={technicianQuery} onChange={(event) => setTechnicianQuery(event.target.value)} />
      <select aria-label="选择领用师傅" required value={allocateForm.technicianId} onChange={(event) => setAllocateForm({ ...allocateForm, technicianId: event.target.value })}>
        <option value="">请选择师傅</option>
        {technicians.filter((item) => item.userId === allocateForm.technicianId || String(item.displayName || "").includes(technicianQuery.trim())).map((item) => <option key={item.userId} value={item.userId}>{item.displayName} · {(item.repairSpecialties || []).join(" / ")}{technicians.filter((other) => other.displayName === item.displayName).length > 1 ? ` · ${item.userId}` : ""}</option>)}
      </select></label>
      {!technicians.length && <p className="warehouse-form-hint">暂无可选师傅，请先确认师傅账号已启用。</p>}
      <div className="warehouse-form-row"><label>发放配件<select aria-label="发放配件编码" value={allocateForm.partCode} onChange={(event) => setAllocateForm({ ...allocateForm, partCode: event.target.value })} required><option value="">请选择库存配件</option>{inventory.totalStock.filter((part) => part.stock > 0).map((part) => <option key={part.code} value={part.code}>{part.name} · {part.code}（库存 {part.stock}）</option>)}</select></label>
      <label>发放数量<input aria-label="发放数量" type="number" min="1" step="1" max={inventory.totalStock.find((part) => part.code === allocateForm.partCode)?.stock} required value={allocateForm.quantity} onChange={(event) => setAllocateForm({ ...allocateForm, quantity: event.target.value })} /></label></div>
      <button type="submit" disabled={busy || !allocateForm.technicianId || !allocateForm.partCode}>{busy ? "处理中…" : "确认发放给师傅"}</button>
    </form></section></div>
    <section hidden={activeTool !== "total"} role="tabpanel" id="warehouse-panel-total" aria-labelledby="warehouse-tab-total" className="card compact-data-card warehouse-tool-panel"><h2>总库 · {inventory.totalStock.length} 种</h2>{!inventory.totalStock.length && <p className="empty-compact-state">暂无配件，入库后在这里查看</p>}<div className="compact-stock-list">{inventory.totalStock.map((part) => <div key={part.code}><span><strong>{part.name}</strong><small>{part.code}</small></span><b>{part.stock}</b></div>)}</div></section>
    <section hidden={activeTool !== "personal"} role="tabpanel" id="warehouse-panel-personal" aria-labelledby="warehouse-tab-personal" className="card compact-data-card warehouse-tool-panel"><h2>师傅库存 · {Object.keys(inventory.technicianStock).length} 人</h2>{!Object.keys(inventory.technicianStock).length && <p className="empty-compact-state">暂无领用记录</p>}<div className="compact-scroll-list">{Object.entries(inventory.technicianStock).map(([id, stock]) => <div className="inventory-item" key={id}><h3>{stock.technicianName}</h3>{stock.parts.length ? stock.parts.map((part) => <p key={part.code}>{part.name}：{part.stock}</p>) : <p>暂无库存</p>}</div>)}</div></section>
    <section hidden={activeTool !== "ledger"} role="tabpanel" id="warehouse-panel-ledger" aria-labelledby="warehouse-tab-ledger" className="card compact-data-card warehouse-tool-panel"><h2>库存流水 · {inventory.transactions.length} 条</h2>{!inventory.transactions.length && <p className="empty-compact-state">暂无库存变动记录</p>}<div className="compact-scroll-list transaction-list">{inventory.transactions.slice().reverse().map((item) => <p key={item.id}><strong>{item.type} · {item.partName} × {item.quantity}</strong><small>{item.technicianName || "--"} · {item.createdAt}</small></p>)}</div></section>
    {message && <p className="inline-status" role="status">{message}</p>}
  </div>
}
export default Warehouse
