import { useState } from 'react'
import '../continuing-repairs.css'
import { continuingRepairs, continuingStatus, elapsedLabel } from '../shared/continuingRepairs.js'
import { resumePageForLocalWorkflow } from '../shared/repairNavigation.js'

const labels = { all: '全部', repairing: '维修中', waiting: '待料', held: '暂存' }
const steps = { repairWarranty: '保修判断', repairDecision: '处理方式', partsApplication: '配件申请', repairProcess: '检测与维修', repairCompletion: '完工提交' }

export default function ContinuingRepairs({ orders, user, technicians, loading, error, now, onOpen }) {
  const [keyword, setKeyword] = useState('')
  const [technicianId, setTechnicianId] = useState('')
  const [status, setStatus] = useState('all')
  const [expanded, setExpanded] = useState('')
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState('')
  async function open(order) {
    setOpening(true)
    setOpenError('')
    try { await onOpen(order) } catch (error) { setOpenError(error.message) } finally { setOpening(false) }
  }
  const manager = user?.role === 'admin' || user?.accountAuthority === 'OWNER'
  const { rows, counts } = continuingRepairs(orders, user, { keyword, technicianId, status })
  return <section className="continue-repairs">
    <header><div><h2>继续维修</h2><p>{manager ? '在手工单 · 可按师傅筛选' : '我的在手工单 · 仅本人'} · 最近更新优先</p></div><span>{counts.all} 台</span></header>
    <div className="continue-filters">
      <input type="search" aria-label="搜索在手工单" placeholder="搜索工单号 / SN" value={keyword} onChange={e => setKeyword(e.target.value)} />
      {manager && <select aria-label="筛选维修师傅" value={technicianId} onChange={e => setTechnicianId(e.target.value)}><option value="">全部师傅</option>{technicians.map(person => <option key={person.userId} value={person.userId}>{person.displayName}</option>)}</select>}
    </div>
    <div className="continue-tabs">{Object.entries(labels).map(([key, label]) => <button type="button" key={key} aria-pressed={status === key} onClick={() => setStatus(key)}>{label}<b>{counts[key]}</b></button>)}</div>
    {openError && <p role="alert">{openError}</p>}
    {opening && <p role="status">正在确认最新维修进度…</p>}
    {loading ? <p role="status">正在读取维修进度…</p> : error ? <p role="alert">读取失败：{error}</p> : !rows.length ? <div className="continue-empty">{keyword || technicianId || status !== 'all' ? '没有符合筛选条件的工单' : '暂无在手工单，点击上方“维修”开始做单'}</div> :
      <div className="continue-list" tabIndex={0} aria-label="在手工单列表，可上下滚动">{rows.map(order => {
        const state = continuingStatus(order)
        const target = resumePageForLocalWorkflow(order)
        const resumable = Boolean(target) && order.status !== 'ON_HOLD'
        return <article className="continue-order" key={order.rmaNo}>
          <button type="button" disabled={opening} className="continue-order-button" onClick={() => resumable ? open(order) : setExpanded(expanded === order.rmaNo ? '' : order.rmaNo)} aria-expanded={resumable ? undefined : expanded === order.rmaNo}>
            <div className="continue-order-top"><strong>{order.productModel || order.model || order.productLine || order.specialty || '维修机器'}</strong><span data-status={state}>{labels[state]}</span></div>
            <p>{order.rmaNo} · SN {order.sn ? String(order.sn).slice(-8) : '未记录'}</p>
            <div className="continue-order-bottom"><span>{manager ? `${order.technicianName || order.operatorName || '未记录师傅'} · ` : ''}{elapsedLabel(order, now?.getTime())}</span><b>{resumable ? steps[target] || '继续处理' : '查看原因'} ›</b></div>
          </button>
          {!resumable && expanded === order.rmaNo && <div className="continue-hold-detail">{order.hold?.category || '当前进度'} · {order.hold?.reason || '暂无可直接继续的维修步骤'}<p>暂存工单需按原恢复流程处理后继续维修。</p></div>}
        </article>
      })}</div>}
    {rows.length > 5 && <small className="continue-scroll-hint">共 {rows.length} 台 · 上下滑动查看其余工单</small>}
  </section>
}
