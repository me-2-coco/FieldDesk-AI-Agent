import { useEffect, useState } from "react"
import { getMonthlyStatistics, downloadMonthlyStatistics } from "../shared/crmService.js"
import { shanghaiDay } from "../shared/dailyWorkload.js"
import "./monthly-statistics.css"

export default function MonthlyStatistics() {
  const [month, setMonth] = useState(() => shanghaiDay(new Date()).slice(0, 7))
  const [data, setData] = useState(null)
  const [error, setError] = useState("")
  const [product, setProduct] = useState("")
  const [person, setPerson] = useState("")
  const [exporting, setExporting] = useState(false)
  const [includeTest, setIncludeTest] = useState(false)
  useEffect(() => {
    let active = true
    setData(null); setError("")
    getMonthlyStatistics({ month, includeTest }).then(result => { if (active) setData(result) }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [month, includeTest])
  const rows = (data?.rows || []).filter(row => (!product || row.product === product) && (!person || row.technicianId === person))
  const people = (data?.people || []).filter(row => (!product || row.product === product) && (!person || row.technicianId === person))
  const options = [...new Map((data?.people || []).map(row => [row.technicianId, row.technicianName])).entries()]
  const abandoned = rows.filter(row => row.category === "弃修").length
  async function exportDetails() {
    if (!data?.canExport || exporting) return
    setExporting(true); setError("")
    try {
      const file = await downloadMonthlyStatistics({ month, product, technicianId: person, includeTest })
      const url = URL.createObjectURL(file.blob)
      const link = document.createElement("a")
      link.href = url; link.download = file.name; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) { setError(e.message) } finally { setExporting(false) }
  }
  return <section className="monthly-statistics card">
    <p className="monthly-note">按北京时间自然月、FieldDesk 完工提交时间统计。维修含调试及只检测，弃修单独统计。</p>
    <div className="monthly-filters">
      <label>月份<input aria-label="统计月份" type="month" value={month} onChange={e => { if (e.target.value) { setMonth(e.target.value); setPerson("") } }} /></label>
      <label>品类<select aria-label="统计品类" value={product} onChange={e => setProduct(e.target.value)}><option value="">全部品类</option><option>扫地机</option><option>洗地机</option></select></label>
      {data?.canExport && <label>师傅<select aria-label="统计师傅" value={person} onChange={e => setPerson(e.target.value)}><option value="">全部师傅</option>{options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>}
    </div>
    {error && <p role="alert" className="error-text">{error}</p>}
    {!data && !error && <p>正在读取月度统计…</p>}
    {data && <>
      {data.canExport && <label><input type="checkbox" checked={includeTest} onChange={e => { setIncludeTest(e.target.checked); setPerson('') }} />包含测试账号</label>}
      <p className="monthly-note">{data.canExport ? "可查看所有师傅，导出范围与当前筛选一致。" : "仅显示本人数据，可查看和筛选，不提供导出。"}</p>
      <div className="home-performance-summary"><div><span>维修</span><strong>{rows.length - abandoned}</strong><small>台</small></div><div><span>弃修</span><strong>{abandoned}</strong><small>台</small></div><div><span>合计</span><strong>{rows.length}</strong><small>台</small></div></div>
      <div className="monthly-toolbar"><div><h2>人员汇总</h2><small>{data.canExport ? includeTest ? '包含测试账号' : '仅正式账号' : '仅本人'} · 列表可上下滑动</small></div>{data.canExport && <button type="button" className="monthly-export" title="导出汇总、工单与配件明细，WPS 可打开" disabled={exporting || !rows.length} onClick={exportDetails}>{exporting ? "导出中…" : "↓ 导出表格"}</button>}</div>
      <div className="monthly-table-wrap" tabIndex={0} role="region" aria-label="人员汇总，可上下滚动"><table><thead><tr><th>师傅 / 品类</th><th>维修</th><th>弃修</th><th>合计</th></tr></thead><tbody>{people.map(row => <tr key={`${row.technicianId}-${row.product}`}><td>{row.technicianName}<small>{row.product || "未记录品类"}</small></td><td>{row.repair}</td><td>{row.abandoned}</td><td>{row.total}</td></tr>)}</tbody></table></div>
      {!rows.length && <p>当前筛选范围暂无完工记录</p>}
    </>}
  </section>
}
