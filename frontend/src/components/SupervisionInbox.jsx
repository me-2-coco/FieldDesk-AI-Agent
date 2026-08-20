import { useEffect, useMemo, useRef, useState } from "react"
import { getSupervisionInbox, markSupervisionOrderRead } from "../shared/crmService.js"

const LOCAL_REFRESH_MS = 10000

function SupervisionInbox({ openKey = 0, targetRmaNo = "" }) {
  const [items, setItems] = useState([])
  const [expandedOrders, setExpandedOrders] = useState([])
  const sectionRef = useRef(null)

  useEffect(() => {
    let active = true
    let timer
    const refresh = async () => {
      try {
        const data = await getSupervisionInbox()
        if (active) setItems([...(data || [])].reverse())
      } catch {
        // 首页通知不可用时不阻断维修流程，下一轮自动重试。
      } finally {
        if (active) timer = window.setTimeout(refresh, LOCAL_REFRESH_MS)
      }
    }
    refresh()
    return () => {
      active = false
      if (timer) window.clearTimeout(timer)
    }
  }, [])

  const groups = useMemo(() => {
    const grouped = new Map()
    for (const item of items) {
      if (!grouped.has(item.rmaNo)) grouped.set(item.rmaNo, [])
      grouped.get(item.rmaNo).push(item)
    }
    return [...grouped.entries()]
  }, [items])

  const viewOrder = async (rmaNo, orderItems) => {
    setExpandedOrders((current) => current.includes(rmaNo) ? current : [...current, rmaNo])
    const unread = orderItems.filter((item) => !item.isRead)
    const markedIds = []
    for (const item of unread) {
      try {
        await markSupervisionOrderRead(rmaNo, item.id)
        markedIds.push(item.id)
      } catch {
        // 已读记录失败不妨碍查看，稍后可再次点击重试。
      }
    }
    if (markedIds.length) {
      setItems((current) => current.map((item) => markedIds.includes(item.id) ? { ...item, isRead: true } : item))
    }
  }

  useEffect(() => {
    if (!openKey || !groups.length) return
    const timer = window.setTimeout(() => {
      sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
      for (const [rmaNo, orderItems] of groups) {
        if (targetRmaNo ? rmaNo === targetRmaNo : orderItems.some((item) => !item.isRead)) {
          viewOrder(rmaNo, orderItems)
        }
      }
    }, 0)
    return () => window.clearTimeout(timer)
  // 点击全局提醒时执行一次；收件箱轮询更新不应重复自动展开。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey])

  if (!groups.length) return null
  const totalUnread = items.filter((item) => !item.isRead).length

  return <section ref={sectionRef} className="card supervision-notice-card" aria-live="polite">
    <div className="machine-card-header">
      <h2>我的督办通知</h2>
      <span className={`repair-status-badge ${totalUnread ? "status-warning" : "status-working"}`}>
        {totalUnread ? `${totalUnread}条未读` : "全部已读"}
      </span>
    </div>
    <p className="field-hint">这里只汇总本人负责的寄修工单；瑞云督办单仍由信息员统一回复。</p>
    {groups.map(([rmaNo, orderItems]) => {
      const expanded = expandedOrders.includes(rmaNo)
      const unread = orderItems.filter((item) => !item.isRead).length
      return <article key={rmaNo} className="message-card">
        <div className="machine-card-header">
          <div>
            <strong>寄修单：{rmaNo}</strong>
            <p className="field-hint">当前状态：{orderItems[0]?.orderStatus || "待确认"}</p>
          </div>
          <span className={`repair-status-badge ${unread ? "status-warning" : "status-working"}`}>
            {unread ? `${unread}条未读` : `${orderItems.length}条已读`}
          </span>
        </div>
        {!expanded && <button className="primary-btn" type="button" onClick={() => viewOrder(rmaNo, orderItems)}>查看这单督办</button>}
        {expanded && orderItems.map((item) => <div key={item.id} className="supervision-inbox-item">
          <p><strong>{item.originalContent}</strong></p>
          <p>识别类型：{(item.analysis?.intents || []).map((intent) => intent.label).join("、") || "待信息员判断"}</p>
          <ul>
            {(item.analysis?.technicianActions || ["请联系信息员确认具体处理要求"]).map((action) => <li key={action}>{action}</li>)}
          </ul>
          {item.analysis?.requiresManualReview && <p className="error-message">涉及政策或费用时，必须等待信息员确认</p>}
        </div>)}
      </article>
    })}
  </section>
}

export default SupervisionInbox
