import { useEffect, useState } from "react"
import { getSupervisionOrders } from "../shared/crmService.js"

const LOCAL_REFRESH_MS = 10000

function SupervisionNoticeCard({ rmaNo }) {
  const [orders, setOrders] = useState([])

  useEffect(() => {
    let active = true
    let timer
    const refresh = async () => {
      try {
        const items = await getSupervisionOrders(rmaNo)
        if (active) setOrders([...(items || [])].reverse())
      } catch {
        // 督办通知不阻断师傅当前维修操作；后端恢复后下一轮自动更新。
      } finally {
        if (active) timer = window.setTimeout(refresh, LOCAL_REFRESH_MS)
      }
    }
    if (rmaNo) refresh()
    return () => {
      active = false
      if (timer) window.clearTimeout(timer)
    }
  }, [rmaNo])

  if (!orders.length) return null

  return (
    <section className="card supervision-notice-card" aria-live="polite">
      <div className="machine-card-header">
        <h2>客服督办通知</h2>
        <span className="repair-status-badge status-working">{orders.length}条</span>
      </div>
      <p className="field-hint">师傅只需查看并执行相关事项；瑞云督办单仍由信息员统一回复。</p>
      {orders.map((item) => (
        <article key={item.id} className="message-card">
          <p><strong>{item.originalContent}</strong></p>
          <p>识别类型：{(item.analysis?.intents || []).map((intent) => intent.label).join("、") || "待信息员判断"}</p>
          <p>师傅需处理：</p>
          <ul>
            {(item.analysis?.technicianActions || ["请联系信息员确认具体处理要求"]).map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
          {item.analysis?.requiresManualReview && <p className="error-message">此通知需要信息员确认后再执行涉及政策或费用的内容</p>}
        </article>
      ))}
    </section>
  )
}

export default SupervisionNoticeCard
