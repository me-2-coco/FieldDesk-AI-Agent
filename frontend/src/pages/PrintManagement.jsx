import { useEffect, useMemo, useState } from "react"
import {
  deletePrintTerminal,
  getAdminUsers,
  getPrintTerminals,
  queuePrintTest,
  retryPrintJob,
  savePrintTerminal,
  renewPrintEnrollment
} from "../shared/crmService.js"
import { buildStoredZip, installerFiles } from "../shared/printInstaller.js"
import './print-management.css'

const EMPTY_FORM = { id: "", name: "", printerName: "XP-420B", memberUserIds: [], active: true }

const STATUS_LABELS = {
  PENDING: "等待打印",
  PRINTING: "正在打印",
  SUCCESS: "已打印",
  FAILED: "打印失败",
  UNASSIGNED: "未分配终端"
}

function PrintManagement({ setPage }) {
  const [terminals, setTerminals] = useState([])
  const [jobs, setJobs] = useState([])
  const [users, setUsers] = useState([])
  const [form, setForm] = useState(EMPTY_FORM)
  const [credential, setCredential] = useState(null)
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)

  const printableUsers = useMemo(() => users.filter((user) => (
    ["TECHNICIAN", "ADMIN"].includes(user.role) && user.active !== false
  )), [users])

  async function refresh({ quiet = false } = {}) {
    try {
      const data = await getPrintTerminals()
      setTerminals(data.terminals || [])
      setJobs(data.jobs || [])
      if (!quiet) setMessage("")
    } catch (error) {
      if (!quiet) setMessage(error.message)
    }
  }

  useEffect(() => {
    let active = true
    Promise.all([getPrintTerminals(), getAdminUsers()])
      .then(([data, accountRows]) => {
        if (!active) return
        setTerminals(data.terminals || [])
        setJobs(data.jobs || [])
        setUsers(accountRows || [])
      })
      .catch((error) => active && setMessage(error.message))
    const timer = window.setInterval(() => active && refresh({ quiet: true }), 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  function edit(terminal) {
    setForm({
      id: terminal.id,
      name: terminal.name,
      printerName: terminal.printerName,
      memberUserIds: terminal.memberUserIds || [],
      active: terminal.active !== false
    })
    setCredential(null)
    setMessage("正在编辑打印终端")
  }

  function toggleMember(userId) {
    setForm((current) => ({
      ...current,
      memberUserIds: current.memberUserIds.includes(userId)
        ? current.memberUserIds.filter((id) => id !== userId)
        : [...current.memberUserIds, userId]
    }))
  }

  async function submit(event) {
    event.preventDefault()
    try {
      setBusy(true)
      const result = await savePrintTerminal(form)
      setCredential(result.enrollmentToken ? { terminal: result.terminal, token: result.enrollmentToken } : null)
      setForm(EMPTY_FORM)
      setMessage(result.enrollmentToken ? "终端已创建，请下载预配置安装包" : "打印终端已保存")
      await refresh({ quiet: true })
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!form.id || !window.confirm(`确定删除打印终端“${form.name}”吗？未完成任务仍保留在记录中。`)) return
    try {
      setBusy(true)
      await deletePrintTerminal(form.id)
      setForm(EMPTY_FORM)
      setMessage("打印终端已删除")
      await refresh({ quiet: true })
    } catch (error) { setMessage(error.message) }
    finally { setBusy(false) }
  }

  async function testPrint(terminalId) {
    try {
      setBusy(true)
      await queuePrintTest(terminalId)
      setMessage("测试标签已进入队列，在线终端通常会在 2 秒内取走")
      await refresh({ quiet: true })
    } catch (error) { setMessage(error.message) }
    finally { setBusy(false) }
  }

  async function retry(job) {
    try {
      setBusy(true)
      await retryPrintJob(job.id, job.terminalId)
      setMessage("任务已重新进入打印队列")
      await refresh({ quiet: true })
    } catch (error) { setMessage(error.message) }
    finally { setBusy(false) }
  }

  async function downloadPackage(existingTerminal) {
    if (existingTerminal && !window.confirm("生成新安装包会使旧电脑的终端密钥失效。请先退出旧电脑的打印助手，确认继续？")) return
    setBusy(true)
    try {
      const scripts = await Promise.all(['installer', 'agent'].map(async (name) => {
        const response = await fetch(`/api/print-agent/download/${name}`, { cache: 'no-store' })
        if (!response.ok) throw new Error('安装文件下载失败，请重试')
        return response.text()
      }))
      let current = credential
      if (existingTerminal) {
        const result = await renewPrintEnrollment(existingTerminal.id)
        current = { terminal: result.terminal, token: result.enrollmentToken }
        setCredential(current)
      }
      if (!current) throw new Error('请先选择打印终端')
      const blob = buildStoredZip(installerFiles(current, window.location.origin, ...scripts))
      const url = URL.createObjectURL(blob), link = document.createElement('a')
      link.href = url; link.download = 'FieldDesk-Print-Setup.zip'; link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 30000)
      setMessage('安装包已下载：解压后双击 Install.cmd，无需填写服务器地址或密钥。')
    } catch (error) { setMessage(error.message) }
    finally { setBusy(false) }
  }

  return <div className="page print-management-page">
    <div className="print-page-header"><button aria-label="返回" onClick={() => credential ? setCredential(null) : form.id ? setForm(EMPTY_FORM) : setPage("appBack")}>←</button><div><h1>打印终端</h1><small>连接电脑，让标签自动打印</small></div></div>

    {credential && <section className="card print-credential-card">
      <div className="section-title-row"><div><small>已自动配置</small><h2>Windows 打印终端安装包</h2></div></div>
      <p>已包含服务器地址和终端密钥。解压全部文件，双击 Install.cmd，允许管理员授权即可安装。安装后请删除安装包，不要转发。</p>
      <button type="button" disabled={busy} onClick={() => downloadPackage()}>下载预配置安装包</button>
    </section>}

    <section className="card print-editor-card">
      <div className="section-title-row"><div><small>电脑与打印机</small><h2>{form.id ? "编辑终端" : "新增终端"}</h2></div><span>{form.id ? "已配置" : "开机自启"}</span></div>
      <p className="section-description">选择共用账号，保存后下载安装。电脑需保持联网且不休眠。</p>
      <form onSubmit={submit}>
        <label>终端名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：维修区一号打印机" required /></label>
        <label>Windows 打印机名称<input value={form.printerName} onChange={(event) => setForm({ ...form, printerName: event.target.value })} placeholder="例如：XP-420B" required /><small>必须与 Windows“打印机和扫描仪”中的名称完全一致</small></label>
        <fieldset className="print-member-picker"><legend>共用账号</legend>
          <div>{printableUsers.map((user) => <label key={user.userId} className={form.memberUserIds.includes(user.userId) ? "selected" : ""}><input type="checkbox" checked={form.memberUserIds.includes(user.userId)} onChange={() => toggleMember(user.userId)} /><span><strong>{user.displayName}</strong><small>{user.userId}</small></span></label>)}</div>
          {!printableUsers.length && <p>暂无可分配账号</p>}
        </fieldset>
        {form.id && <label className="switch-row"><span>终端启用</span><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} /></label>}
        <div className="compact-action-row"><button type="submit" disabled={busy}>{busy ? "处理中…" : "保存终端"}</button>{form.id && <button type="button" className="secondary-btn" onClick={() => setForm(EMPTY_FORM)}>取消</button>}</div>
        {form.id && <button type="button" className="account-delete-button" onClick={remove} disabled={busy}>删除终端</button>}
      </form>
    </section>

    <section className="card print-terminal-card">
      <div className="section-title-row"><div><small>实时状态</small><h2>共享打印机</h2></div><span>{terminals.filter((item) => item.online).length}/{terminals.length} 在线</span></div>
      <div className="print-terminal-list">{terminals.map((terminal) => <article key={terminal.id}>
        <button type="button" className="print-terminal-main" onClick={() => edit(terminal)}>
          <i className={terminal.online ? "online" : "offline"} />
          <span><strong>{terminal.name}</strong><small>{terminal.printerName} · {(terminal.memberUserIds || []).length} 名师傅</small></span>
          <em>{terminal.online ? "在线" : "离线"}</em><b>›</b>
        </button>
        <div className="print-terminal-stats"><span>等待 {terminal.queue?.pending || 0}</span><span>失败 {terminal.queue?.failed || 0}</span><span>成功 {terminal.queue?.success || 0}</span><button type="button" onClick={() => testPrint(terminal.id)} disabled={busy}>测试打印</button><button type="button" onClick={() => downloadPackage(terminal)} disabled={busy}>下载终端</button></div>
      </article>)}</div>
      {!terminals.length && <p className="print-empty">还没有打印终端，请先新增一台 Windows 电脑。</p>}
    </section>

    <section className="card print-jobs-card">
      <div className="section-title-row"><div><small>最近 100 条</small><h2>打印任务</h2></div><span>{jobs.filter((job) => ["PENDING", "PRINTING", "FAILED", "UNASSIGNED"].includes(job.status)).length} 待处理</span></div>
      <div className="print-job-list">{jobs.map((job) => <article key={job.id}>
        <span><strong>{job.title}</strong><small>{job.rmaNo || "测试任务"} · {job.requestedByName || job.requestedBy || "系统"}</small>{job.lastError && <small className="error-text">{job.lastError}</small>}</span>
        <em className={String(job.status || "").toLowerCase()}>{STATUS_LABELS[job.status] || job.status}</em>
        {["FAILED", "UNASSIGNED"].includes(job.status) && job.terminalId && <button type="button" onClick={() => retry(job)} disabled={busy}>重试</button>}
      </article>)}</div>
      {!jobs.length && <p className="print-empty">暂无打印任务。</p>}
    </section>
    {message && <p className="inline-status" role="status">{message}</p>}
  </div>
}

export default PrintManagement
