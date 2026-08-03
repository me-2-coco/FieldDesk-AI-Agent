import { useEffect, useState } from "react"
import { getAdminUsers, saveAdminUser } from "../shared/crmService.js"

const EMPTY = { userId: "", displayName: "", role: "TECHNICIAN", repairSpecialties: [], accessToken: "", active: true }

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

  return <div className="page">
    <div className="top-bar"><button className="arrow-back" onClick={() => setPage("profile")}>←</button><h1>账号与权限</h1></div>
    <div className="card">
      <p>访问令牌只用于本次提交，不在浏览器本地保存。角色和维修品类仅允许管理员配置。</p>
      <form onSubmit={submit}>
        <input value={form.userId} onChange={(event) => setForm({ ...form, userId: event.target.value })} placeholder="用户 ID" required />
        <input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="显示名称" required />
        <select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value, repairSpecialties: [] })}>
          <option value="ADMIN">管理员</option><option value="WAREHOUSE">库房</option><option value="TECHNICIAN">维修师傅</option>
        </select>
        {(form.role === "TECHNICIAN" || form.role === "ADMIN") && <div>
          {["扫地机", "洗地机"].map((item) => <label key={item}><input type="checkbox" checked={form.repairSpecialties.includes(item)} onChange={() => toggleSpecialty(item)} />{item}</label>)}
        </div>}
        <input type="password" value={form.accessToken} onChange={(event) => setForm({ ...form, accessToken: event.target.value })} placeholder="新账号访问令牌" autoComplete="new-password" required />
        <button type="submit">保存账号</button>
      </form>
    </div>
    <div className="card"><h2>正式账号</h2>{users.map((user) => <p key={user.userId}>{user.displayName} · {user.role} · {user.repairSpecialties.join("/") || "无维修品类"} · {user.active ? "启用" : "停用"}</p>)}</div>
    {message && <p role="status">{message}</p>}
  </div>
}

export default AccountManagement
