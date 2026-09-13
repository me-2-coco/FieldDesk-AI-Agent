import { useEffect, useState } from 'react'
import { getCurrentUser } from '../shared/userStore.js'
import { isOwnerAccount } from '../shared/accountAccessPolicy.js'
import { getPayroll, downloadPayroll } from '../shared/crmService.js'
import './payroll.css'

const currentMonth = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date())
const money = value => Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const tabs = [{ key: 'rows', label: '已计薪' }, { key: 'duplicates', label: '重复已排除' }, { key: 'pending', label: '待核对' }]

export default function Payroll({ setPage }) {
  const [month, setMonth] = useState(currentMonth)
  const [includeTest, setIncludeTest] = useState(false)
  const [version, setVersion] = useState(0)
  const [report, setReport] = useState(null)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(null)
  const [tab, setTab] = useState('rows')
  const [search, setSearch] = useState('')
  const [page, setDetailPage] = useState(1)
  const user = getCurrentUser(), allowed = isOwnerAccount(user)
  const userId = user.id || user.userId
  const ready = report && report.month === month && report.includeTest === includeTest && !busy

  useEffect(() => {
    let active = true
    if (!allowed || !month) return
    // Loading state resets when a new report request starts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBusy(true); setError(''); setReport(null); setSelected(null); setDetailPage(1)
    getPayroll({ month, includeTest: String(includeTest) }).then(data => {
      if (active) setReport(data)
    }).catch(e => { if (active) setError(e.message) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [month, includeTest, version, allowed, userId])

  async function exportSheet() {
    setExporting(true); setError('')
    try {
      const file = await downloadPayroll({ month, includeTest: String(includeTest) })
      if (!isOwnerAccount(getCurrentUser())) return
      const url = URL.createObjectURL(file.blob), link = document.createElement('a')
      link.href = url; link.download = file.name; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) { setError(e.message) } finally { setExporting(false) }
  }
  function selectPerson(id) { setSelected(id); setSearch(''); setTab('rows'); setDetailPage(1) }
  if (!allowed) return <div className="card"><p>工资核算仅负责人可见。</p><button onClick={() => setPage('profile')}>返回我的</button></div>
  const person = report?.people.find(p => p.technicianId === selected)
  const records = ready ? report[tab].filter(row => (selected === null || row.technicianId === selected) && (!search.trim() || [row.rmaNo, row.sn, row.technicianId, row.technicianName].some(value => value.toLowerCase().includes(search.trim().toLowerCase())))) : []
  const totalPages = Math.max(1, Math.ceil(records.length / 30))
  const visiblePage = Math.min(page, totalPages)
  return <main className="payroll-page">
    <header className="payroll-heading"><div><span className="payroll-eyebrow">财务 · 仅负责人可见</span><h1>工资核算</h1><p>按提交完工时间，核对每位师傅的月度计件工资。</p></div><button onClick={() => setPage('profile')}>返回我的</button></header>
    <section className="payroll-panel payroll-filters">
      <label>核算月份<input aria-label="核算月份" type="month" value={month} onChange={e => setMonth(e.target.value)} /></label>
      <label className="payroll-check"><input type="checkbox" checked={includeTest} onChange={e => setIncludeTest(e.target.checked)} />包含测试账号（试算）</label>
      <button disabled={busy || !month} onClick={() => setVersion(v => v + 1)}>刷新核算</button>
      <button className="payroll-primary" disabled={!ready || exporting} onClick={exportSheet}>{exporting ? '正在导出…' : '导出工资表（WPS / Excel）'}</button>
    </section>
    <p className="payroll-note">北京时间自然月：每月1日00:00起，至次月1日00:00前。同一寄修单只计一次；非弃修的完工类型均按维修单价。</p>
    {error && <div className="payroll-error" role="alert">{error}</div>}
    {busy && <p role="status">正在核算本月工单…</p>}
    {ready && <>
      {includeTest && <div className="payroll-warning">当前包含测试账号，仅供试算。正式工资表请取消勾选。</div>}
      {!includeTest && report.excludedTest > 0 && <p className="payroll-note">已排除 {report.excludedTest} 条测试账号记录；核对 FieldDesk0004 的测试单请勾选“包含测试账号”。</p>}
      <section className="payroll-totals" aria-label="本月汇总">
        <div><span>本月计件工资</span><strong>¥{money(report.summary.amount)}</strong><small>{report.month} · {report.people.length} 位师傅</small></div>
        <div><span>维修台数</span><strong>{report.summary.repair}</strong><small>洗地机 ¥15 / 扫地机 ¥30</small></div>
        <div><span>弃修台数</span><strong>{report.summary.abandoned}</strong><small>洗地机 ¥5 / 扫地机 ¥10</small></div>
        <div><span>核对记录</span><strong>{report.summary.pending + report.summary.duplicates}</strong><small>待核对 {report.summary.pending} · 重复排除 {report.summary.duplicates}</small></div>
      </section>
      {report.summary.pending > 0 && <div className="payroll-warning">有 {report.summary.pending} 单待核对，暂未计入工资。请在下方“待核对”中检查原因。</div>}
      <section className="payroll-panel"><div className="payroll-section-title"><div><h2>师傅工资表</h2><p>点击师傅或“查看明细”，核对台数和对应工单。</p></div><span>共计 {report.summary.total} 台</span></div>
        <div className="payroll-scroll"><table><thead><tr><th>师傅 / 账号</th>{report.rates.map(rate => <th key={rate.key}>{rate.product}{rate.category}<small>台数 × ¥{rate.price}</small></th>)}<th>维修 / 弃修 / 合计</th><th>工资合计</th><th>核对 / 明细</th></tr></thead><tbody>
          {report.people.map(p => <tr key={p.technicianId} className={selected === p.technicianId ? 'payroll-selected' : ''}><td><button className="payroll-link" onClick={() => selectPerson(p.technicianId)}>{p.technicianName}</button><small>{p.technicianId || '未归属'}</small></td>{report.rates.map(rate => <td key={rate.key}>{p.counts[rate.key]} × {rate.price}<small>¥{money(p.counts[rate.key] * rate.price)}</small></td>)}<td>{p.repair} / {p.abandoned} / {p.total}</td><td className="payroll-amount">¥{money(p.amount)}</td><td><button className="payroll-link" onClick={() => selectPerson(p.technicianId)}>查看明细</button><small>待核对 {p.pending} · 重复 {p.duplicates}</small></td></tr>)}
          {!report.people.length && <tr><td colSpan="8" className="payroll-empty">本月暂无师傅或完工记录。</td></tr>}
        </tbody><tfoot><tr><th>合计</th>{report.rates.map(rate => <td key={rate.key}>{report.summary.counts[rate.key]} 台</td>)}<td>{report.summary.repair} / {report.summary.abandoned} / {report.summary.total}</td><td>¥{money(report.summary.amount)}</td><td>重复不计薪</td></tr></tfoot></table></div>
      </section>
      <section className="payroll-panel" aria-label="工单明细"><div className="payroll-section-title"><div><h2>{person ? `${person.technicianName}的明细` : '全部师傅明细'}</h2><p>{person ? `${person.technicianId || '未归属'} · 维修 ${person.repair} 台 + 弃修 ${person.abandoned} 台 = ${person.total} 台 · ¥${money(person.amount)}` : '可按寄修单号、机器 SN 或师傅账号搜索。'}</p></div>{selected !== null && <button onClick={() => selectPerson(null)}>查看全部师傅</button>}</div>
        <div className="payroll-detail-controls"><label>筛选师傅 <select aria-label="筛选师傅" value={selected === null ? "__all__" : selected} onChange={e => selectPerson(e.target.value === "__all__" ? null : e.target.value)}><option value="__all__">全部师傅</option>{report.people.map(p => <option key={p.technicianId} value={p.technicianId}>{p.technicianName}（{p.technicianId || "未归属"}）</option>)}</select></label><div className="payroll-tabs" role="tablist" aria-label="明细分类">{tabs.map(t => <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => { setTab(t.key); setDetailPage(1) }}>{t.label}（{report[t.key].filter(row => selected === null || row.technicianId === selected).length}）</button>)}</div><input aria-label="搜索工单明细" placeholder="搜索寄修单号 / SN / 师傅账号" value={search} onChange={e => { setSearch(e.target.value); setDetailPage(1) }} /></div>
        <p className="payroll-note">{tab === 'duplicates' ? '以下记录已排除，不会重复计入台数或工资；核对说明列出首次提交时间及账号。' : tab === 'pending' ? '以下记录尚未计薪，修正源工单后刷新核算。' : '每行一台，计薪金额按机型和维修分类计算。'}</p>
        <div className="payroll-scroll"><table><thead><tr><th>寄修单号 / SN</th><th>师傅 / 账号</th><th>机型</th><th>维修类型</th><th>提交完工时间</th><th>单价</th><th>计薪金额</th>{tab !== 'rows' && <th>核对说明</th>}</tr></thead><tbody>{records.slice((visiblePage - 1) * 30, visiblePage * 30).map(row => <tr key={row.rowId}><td>{row.rmaNo || '缺少单号'}<small>{row.sn || '未记录SN'}</small></td><td>{row.technicianName}<small>{row.technicianId || '未归属'}</small></td><td>{row.product || '未分类'}<small>{row.model}</small></td><td>{row.treatment}<small>计薪分类：{row.category}</small></td><td>{row.completedTime}<small>北京时间</small></td><td>{row.unitPrice === null ? '待确认' : `¥${money(row.unitPrice)}`}</td><td>{row.amount === null ? '暂不计薪' : `¥${money(row.amount)}`}</td>{tab !== 'rows' && <td className="payroll-reason">{row.reason}</td>}</tr>)}{!records.length && <tr><td colSpan={tab === 'rows' ? 7 : 8} className="payroll-empty">没有符合条件的记录。</td></tr>}</tbody></table></div>
        <div className="payroll-pagination"><span>共 {records.length} 条 · 第 {visiblePage} / {totalPages} 页</span><button disabled={visiblePage <= 1} onClick={() => setDetailPage(visiblePage - 1)}>上一页</button><button disabled={visiblePage >= totalPages} onClick={() => setDetailPage(visiblePage + 1)}>下一页</button></div>
      </section><p className="payroll-note">当前为实时核算，未锁账或标记工资发放。导出包含全部师傅汇总、计薪明细、重复记录、待核对记录和核算说明，不受明细搜索条件影响。</p>
    </>}
  </main>
}
