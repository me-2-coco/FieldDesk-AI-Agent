import { useState } from "react"
import { dailyWorkload, shanghaiDay } from "../shared/dailyWorkload.js"

const columns = [["repaired", "维修"], ["abandoned", "弃修"]]

export default function DailyWorkloadBoard({ orders, technicians, user, now, loading, error }) {
  const day = shanghaiDay(now)
  const boards = dailyWorkload({ orders, technicians, user, day })
  const [productIndex, setProductIndex] = useState(0)
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(0)
  const activeIndex = Math.min(productIndex, Math.max(0, boards.length - 1))
  const board = boards[activeIndex]
  const personal = String(user?.role || "").toLowerCase() !== "admin" && user?.accountAuthority !== "OWNER"
  if (!board) return <section className="card"><p>账号尚未配置维修品类，请联系管理员。</p></section>
  const product = board.product
  const people = board.people.map(row => ({ ...row, repaired: row.total - row.abandoned }))
  const totals = { ...board.totals, repaired: board.totals.total - board.totals.abandoned }
  const filtered = people.filter(person => `${person.displayName} ${person.userId}`.toLowerCase().includes(query.trim().toLowerCase()))
  const pages = Math.max(1, Math.ceil(filtered.length / 10))
  const currentPage = Math.min(page, pages - 1)
  const visible = filtered.slice(currentPage * 10, currentPage * 10 + 10)
  return <section className="daily-workload-board" aria-label="当日维修看板">
    <div className="daily-board-heading"><span>{day} · 今日</span><span>每 30 秒更新</span></div>
    {boards.length === 1 ? <div className="daily-product-identity"><span>{product}</span><small>我的当日工作量 · 仅统计本人</small></div> : <div className="daily-product-tabs" role="group" aria-label="选择品类">{boards.map((board, index) => <button key={board.product} type="button" aria-pressed={index === activeIndex} onClick={() => { setProductIndex(index); setPage(0) }}>{board.product}</button>)}</div>}
    {loading ? <p role="status">正在加载当天工作量…</p> : error ? <p role="alert">工作量加载失败：{error}，正在自动重试</p> : <>
      <section className={`daily-summary ${product === "洗地机" ? "daily-summary-wash" : ""}`} aria-label={`${product}当日汇总`}>
        <div className="daily-summary-total"><div><span>今日已完成</span><p><strong>{totals.total}</strong> 台</p></div><span>{personal ? "我的成绩" : `${people.length} 位师傅`}</span></div>
        <div className="daily-summary-metrics">{columns.map(([key, label]) => <div key={key}><strong>{totals[key]}</strong><span>{label}</span></div>)}</div>
      </section>
      <div className="daily-list-heading"><h2>{personal ? "我的明细" : "师傅明细"}</h2>{!personal && <span>{filtered.length} 人</span>}</div>
      {people.length > 1 && <input className="daily-person-search" aria-label="搜索师傅" placeholder="搜索师傅姓名 / 账号" value={query} onChange={event => { setQuery(event.target.value); setPage(0) }} />}
      <div className="daily-people-list">{visible.map(row => <article className="daily-person" key={row.userId}>
        <div className="daily-person-heading"><span className="daily-person-avatar" aria-hidden="true">{row.displayName.slice(0, 1)}</span><h3>{row.displayName}</h3><span className="daily-person-total"><strong>{row.total}</strong> 台</span></div>
        <div className="daily-person-metrics">{columns.map(([key, label]) => <span key={key}>{label}<b>{row[key]}</b></span>)}</div>
      </article>)}</div>
      {!visible.length && <p className="daily-board-note">{query ? "没有匹配的师傅" : "暂无该品类师傅"}</p>}
      {pages > 1 && <nav className="daily-pagination" aria-label="师傅明细分页"><button type="button" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage + 1} / {pages}</span><button type="button" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button></nav>}
    </>}
    <p className="daily-board-note">维修含维修、调试、只检测不维修。<br />北京时间自然日 · 按 FieldDesk 完工提交时间统计</p>
  </section>
}
