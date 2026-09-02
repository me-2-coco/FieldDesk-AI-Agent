import { useEffect, useState } from "react"
import { getAdminUsers, saveAdminUser } from "../shared/crmService.js"

const EMPTY = { userId: "", displayName: "", role: "TECHNICIAN", repairSpecialties: [], password: "", active: true }

function AccountManagement({ setPage }) {
  const [users, setUsers] = useState([])
  const [form, setForm] = useState(EMPTY)
  const [message, setMessage] = useState("")

  async function refresh() {
    try { setUsers(await getAdminUsers()) }
    catch (error) { setMessage(error.message) }
  }
  useEffect(() => {
    let active = true
    getAdminUsers()
      .then((data) => { if (active) setUsers(data) })
      .catch((error) => { if (active) setMessage(error.message) })
    return () => { active = false }
  }, [])

  function toggleSpecialty(value) {
    setForm((current) => ({ ...current, repairSpecialties: current.repairSpecialties.includes(value)
      ? current.repairSpecialties.filter((item) => item !== value)
      : [...current.repairSpecialties, value] }))
  }

  async function submit(event) {
    event.preventDefault()
    try {
      await saveAdminUser(form)
      setForm(EMPTY)
      setMessage("账号配置已保存")
      await refresh()
    } catch (error) { setMessage(error.message) }
  }

  function editUser(user) {
    setForm({ userId: user.userId, displayName: user.displayName, role: user.role, repairSpecialties: user.repairSpecialties || [], password: "", active: user.active !== false })
    setMessage("正在编辑账号；不填写新密码则保留原密码")
  }

  return <div className="page account-management-page">
    <div className="top-bar"><button className="arrow-back" onClick={() => setPage("home")}>←</button><div><small>账号与权限</small><h1>账号管理</h1></div></div>
    <div className="card account-editor-card">
      <div className="section-title-row"><div><small>账号配置</small><h2>{form.userId ? "编辑账号" : "新增账号"}</h2></div><span>仅管理员</span></div>
      <p className="section-description">统一配置登录账号、角色和维修品类；密码不会显示或保存在浏览器中。</p>
      <form onSubmit={submit}>
        <label>用户 ID<input value={form.userId} onChange={(event) => setForm({ ...form, userId: event.target.value })} placeholder="例如 USER-007" required /></label>
        <label>显示名称<input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="请输入姓名" required /></label>
        <label>账号角色<select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value, repairSpecialties: [] })}>
          <option value="ADMIN">管理员</option><option value="INFORMATION_CLERK">信息员</option><option value="WAREHOUSE">库房</option><option value="TECHNICIAN">维修师傅</option>
        </select></label>
        {(form.role === "TECHNICIAN" || form.role === "ADMIN") && <fieldset className="choice-fieldset"><legend>维修品类</legend>
          {["扫地机", "洗地机"].map((item) => <label key={item}><input type="checkbox" checked={form.repairSpecialties.includes(item)} onChange={() => toggleSpecialty(item)} /><span>{item}</span></label>)}
        </fieldset>}
        <label>登录密码<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={users.some((user) => user.userId === form.userId) ? "不修改可留空" : "设置登录密码"} autoComplete="new-password" required={!users.some((user) => user.userId === form.userId)} /></label>
        <label className="switch-row"><span>账号启用</span><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} /></label>
        <div className="compact-action-row"><button type="submit">保存账号</button>{form.userId && <button type="button" className="secondary-btn" onClick={() => setForm(EMPTY)}>取消</button>}</div>
      </form>
    </div>
    <div className="card account-list-card"><div className="section-title-row"><div><small>账号目录</small><h2>正式账号</h2></div><span>{users.length} 个</span></div><div className="account-directory">{users.map((user) => <button type="button" className="account-directory-row" key={user.userId} onClick={() => editUser(user)}><span className="account-directory-avatar">{user.displayName.slice(0, 1)}</span><span><strong>{user.displayName}</strong><small>{user.userId} · {user.role} · {user.repairSpecialties.join("/") || "无品类"}</small></span><em className={user.active ? "active" : "disabled"}>{user.active ? "启用" : "停用"}</em><b>›</b></button>)}</div></div>
    {message && <p className="inline-status" role="status">{message}</p>}
  </div>
}

export default AccountManagement
