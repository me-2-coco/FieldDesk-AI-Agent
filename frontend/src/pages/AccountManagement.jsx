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

  return <div className="page">
    <div className="top-bar"><button className="arrow-back" onClick={() => setPage("profile")}>←</button><h1>账号管理</h1></div>
    <div className="card">
      <p>管理员统一配置登录账号、密码、角色和维修品类。密码不会显示或保存在浏览器中。</p>
      <form onSubmit={submit}>
        <input value={form.userId} onChange={(event) => setForm({ ...form, userId: event.target.value })} placeholder="用户 ID" required />
        <input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="显示名称" required />
        <select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value, repairSpecialties: [] })}>
          <option value="ADMIN">管理员</option><option value="INFORMATION_CLERK">信息员</option><option value="WAREHOUSE">库房</option><option value="TECHNICIAN">维修师傅</option>
        </select>
        {(form.role === "TECHNICIAN" || form.role === "ADMIN") && <div>
          {["扫地机", "洗地机"].map((item) => <label key={item}><input type="checkbox" checked={form.repairSpecialties.includes(item)} onChange={() => toggleSpecialty(item)} />{item}</label>)}
        </div>}
        <input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={users.some((user) => user.userId === form.userId) ? "新密码（不修改可留空）" : "设置登录密码"} autoComplete="new-password" required={!users.some((user) => user.userId === form.userId)} />
        <label><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} />账号启用</label>
        <button type="submit">保存账号</button>
        {form.userId && <button type="button" onClick={() => setForm(EMPTY)}>取消编辑</button>}
      </form>
    </div>
    <div className="card"><h2>正式账号</h2>{users.map((user) => <div key={user.userId}><p>{user.displayName}（{user.userId}） · {user.role} · {user.repairSpecialties.join("/") || "无维修品类"} · {user.active ? "启用" : "停用"}</p><button type="button" onClick={() => editUser(user)}>编辑账号</button></div>)}</div>
    {message && <p role="status">{message}</p>}
  </div>
}

export default AccountManagement
