import { useEffect, useRef, useState } from 'react'
import './notification-center.css'

function readSeen(userId) {
  try { const values = JSON.parse(sessionStorage.getItem(`notification-seen:${userId}`) || '[]'); return new Set(Array.isArray(values) ? values : []) } catch { return new Set() }
}

export function notificationRows(operations, tasks, shortages) {
  const grouped = new Map()
  for (const [kind, items] of [['repair', operations], ['sync', tasks], ['shortage', shortages]]) {
    for (const item of items) {
      const key = item.rmaNo || `${kind}:${item.id}`
      const existing = grouped.get(key)
      const message = item.message || item.stageLabel || '人工复核、执行失败或等待最终确认'
      if (existing) { if (!existing.messages.includes(message)) existing.messages.push(message); continue }
      grouped.set(key, { key, kind, rmaNo: item.rmaNo, messages: [message] })
    }
  }
  return [...grouped.values()]
}

export default function NotificationCenter({ userId, operations, tasks, shortages, supervisionCount, latestSupervision, warnings, onRepair, onSync, onShortage, onSupervision }) {
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState(false)
  const root = useRef(null)
  const seen = useRef(readSeen(userId))
  const rows = notificationRows(operations, tasks, shortages)
  const keys = [...rows.map(row => row.key), ...warnings.map(w => `warning:${w}`), ...(supervisionCount ? [`supervision:${latestSupervision?.id || latestSupervision?.rmaNo}:${supervisionCount}`] : [])]
  const signature = JSON.stringify(keys)
  const count = rows.length + warnings.length + supervisionCount
  useEffect(() => {
    const keys = JSON.parse(signature)
    if (!keys.some(key => !seen.current.has(key))) return
    keys.forEach(key => seen.current.add(key))
    try { sessionStorage.setItem(`notification-seen:${userId}`, JSON.stringify([...seen.current])) } catch { /* Storage failure must not block repairs. */ }
    setHint(true)
    const timer = setTimeout(() => setHint(false), 3000)
    return () => { clearTimeout(timer); setHint(false) }
  }, [signature, userId])
  useEffect(() => {
    if (!open) return
    const close = event => { if (event.key === 'Escape' || (event.type === 'pointerdown' && !root.current?.contains(event.target))) setOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close) }
  }, [open])
  function visit(action) { setOpen(false); setHint(false); action() }
  return <aside className="notification-center" ref={root}>
    <button className="notification-bell" type="button" aria-label={`通知，${count}条待查看`} aria-expanded={open} onClick={() => { setOpen(!open); setHint(false) }}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
      {count > 0 && <b>{count > 99 ? '99+' : count}</b>}
    </button>
    {hint && !open && <div className="notification-hint" role="status">有新消息，点击铃铛查看</div>}
    {open && <section className="notification-panel" aria-label="通知列表">
      <header><strong>消息通知</strong><button type="button" onClick={() => setOpen(false)} aria-label="收起通知">×</button></header>
      <p>收起提示不会清除待处理事项</p>
      <div className="notification-items">
        {supervisionCount > 0 && <button type="button" onClick={() => visit(onSupervision)}><strong>督办消息 · {supervisionCount} 条未读</strong><span>点击进入督办消息查看详情</span></button>}
        {warnings.map(warning => <div className="notification-warning" key={warning}>{warning}</div>)}
        {rows.map(row => <button type="button" key={row.key} onClick={() => visit(row.kind === 'repair' ? () => onRepair(row.rmaNo) : row.kind === 'sync' ? onSync : onShortage)}><strong>{row.rmaNo || '系统任务'}</strong><span>{row.messages.join('；')}</span></button>)}
        {!count && <p>暂无待查看消息</p>}
      </div>
    </section>}
  </aside>
}
