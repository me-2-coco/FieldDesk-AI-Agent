import { dailyWorkload, shanghaiDay } from "../shared/dailyWorkload.js"

export default function DailyWorkloadBoard({ orders, technicians, user, now, loading, error }) {
  const day = shanghaiDay(now)
  const boards = dailyWorkload({ orders, technicians, user, day })
  return <section className="daily-workload-board" aria-label="当日维修看板">
    <div className="daily-board-heading"><h2>当日维修看板</h2><span>{day}</span></div>
    <p className="daily-board-note">北京时间 00:00–24:00 · 按 FieldDesk 完工提交时间统计 · 每 30 秒更新</p>
    {loading ? <p role="status">正在加载当天工作量…</p> : error ? <p role="alert">工作量加载失败：{error}，正在自动重试</p> : boards.map(({ product, people, totals }) => <section className="daily-product-board" key={product}>
      <div className="daily-product-heading"><h3>{product}</h3><span>合计 <strong>{totals.total}</strong> 台</span></div>
      <table><thead><tr><th scope="col">师傅</th><th scope="col">维修</th><th scope="col">弃修</th><th scope="col">调试</th><th scope="col">只检测<br />不维修</th><th scope="col">合计</th></tr></thead>
        <tbody>{people.map(row => <tr key={row.userId}><th scope="row">{row.displayName}</th>{["repair", "abandoned", "debugging", "inspection", "total"].map(key => <td key={key}>{row[key]}</td>)}</tr>)}</tbody>
        <tfoot><tr><th scope="row">合计</th>{["repair", "abandoned", "debugging", "inspection", "total"].map(key => <td key={key}>{totals[key]}</td>)}</tr></tfoot>
      </table>
      {!people.length && <p className="daily-board-note">暂无该品类师傅</p>}
    </section>)}
  </section>
}
