import { useEffect, useState } from "react"
import { createAdminTechnician, getAdminUsers, saveAdminUser } from "../shared/crmService.js"

const EMPTY = { userId: "", displayName: "", phone: "", role: "TECHNICIAN", repairSpecialties: [], password: "", active: true, recloudAssignmentMode: "DIRECT", recloudAssigneeName: "", recloudFallbackAssigneeName: "" }

function nextTechnicianAccount(users) {
  const highest = users.reduce((current, user) => {
    const match = /^FieldDesk(\d+)$/.exec(user.userId || "")
    return match ? Math.max(current, Number(match[1])) : current
  }, 0)
  return `FieldDesk${String(highest + 1).padStart(4, "0")}`
}

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
      const saved = form.userId
        ? await saveAdminUser(form)
        : await createAdminTechnician({ displayName: form.displayName, phone: form.phone })
      setForm(EMPTY)
      setMessage(form.userId
        ? "账号配置已保存"
        : `账号创建成功：${saved.userId}，初始密码 ${saved.initialPassword}`)
      await refresh()
    } catch (error) { setMessage(error.message) }
  }

  function editUser(user) {
    setForm({ userId: user.userId, displayName: user.displayName, phone: user.phone || "", role: user.role, repairSpecialties: user.repairSpecialties || [], password: "", active: user.active !== false, recloudAssignmentMode: user.recloudAssignmentMode || "DIRECT", recloudAssigneeName: user.recloudAssigneeName || "", recloudFallbackAssigneeName: user.recloudFallbackAssigneeName || "" })
    setMessage("正在编辑账号；不填写新密码则保留原密码")
  }

  return <div className="page account-management-page">
    <div className="top-bar"><button className="arrow-back" onClick={() => setPage("home")}>←</button><div><small>账号与权限</small><h1>账号管理</h1></div></div>
    <div className="card account-editor-card">
      <div className="section-title-row"><div><small>账号配置</small><h2>{form.userId ? "编辑账号" : "新增账号"}</h2></div><span>仅管理员</span></div>
      <p className="section-description">新增师傅时只需填写姓名和电话，登录账号按顺序自动生成。</p>
      <form onSubmit={submit}>
        <label>FieldDesk 账号<input value={form.userId || nextTechnicianAccount(users)} readOnly aria-readonly="true" /></label>
        {!form.userId && <label>初始密码<input value="0000" readOnly aria-readonly="true" /></label>}
        <label>师傅姓名<input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="请输入师傅姓名" required /></label>
        <label>师傅电话<input type="tel" inputMode="numeric" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="请输入11位手机号" required /></label>
        {form.userId && <><label>账号角色<select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value, repairSpecialties: [] })}>
          <option value="ADMIN">管理员</option><option value="INFORMATION_CLERK">信息员</option><option value="WAREHOUSE">库房</option><option value="TECHNICIAN">维修师傅</option>
        </select></label>
        {(form.role === "TECHNICIAN" || form.role === "ADMIN") && <fieldset className="choice-fieldset"><legend>维修品类</legend>
          {["扫地机", "洗地机"].map((item) => <label key={item}><input type="checkbox" checked={form.repairSpecialties.includes(item)} onChange={() => toggleSpecialty(item)} /><span>{item}</span></label>)}
        </fieldset>}
        {form.role === "TECHNICIAN" && <fieldset className="choice-fieldset"><legend>瑞云改派</legend>
          <label><input type="radio" name="recloud-mode" checked={form.recloudAssignmentMode === "DIRECT"} onChange={() => setForm({ ...form, recloudAssignmentMode: "DIRECT" })} /><span>瑞云已有本人</span></label>
          <label><input type="radio" name="recloud-mode" checked={form.recloudAssignmentMode === "FALLBACK"} onChange={() => setForm({ ...form, recloudAssignmentMode: "FALLBACK" })} /><span>暂用兜底负责人</span></label>
          {form.recloudAssignmentMode === "DIRECT"
            ? <label>瑞云姓名<input value={form.recloudAssigneeName} onChange={(event) => setForm({ ...form, recloudAssigneeName: event.target.value })} placeholder="留空则使用显示名称" /></label>
            : <label>兜底负责人<input value={form.recloudFallbackAssigneeName} onChange={(event) => setForm({ ...form, recloudFallbackAssigneeName: event.target.value })} placeholder="请输入瑞云中已存在的姓名" required /></label>}
        </fieldset>}
        <label>登录密码<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={users.some((user) => user.userId === form.userId) ? "不修改可留空" : "设置登录密码"} autoComplete="new-password" required={!users.some((user) => user.userId === form.userId)} /></label>
        <label className="switch-row"><span>账号启用</span><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} /></label>
        </>}
        <div className="compact-action-row"><button type="submit">保存账号</button>{form.userId && <button type="button" className="secondary-btn" onClick={() => setForm(EMPTY)}>取消</button>}</div>
      </form>
    </div>
    <div className="card account-list-card"><div className="section-title-row"><div><small>账号目录</small><h2>正式账号</h2></div><span>{users.length} 个</span></div><div className="account-directory">{users.map((user) => <button type="button" className="account-directory-row" key={user.userId} onClick={() => editUser(user)}><span className="account-directory-avatar">{user.displayName.slice(0, 1)}</span><span><strong>{user.displayName}</strong><small>{user.userId} · {user.phone || "未填写电话"} · {user.role}</small></span><em className={user.active ? "active" : "disabled"}>{user.active ? "启用" : "停用"}</em><b>›</b></button>)}</div></div>
    {message && <p className="inline-status" role="status">{message}</p>}
  </div>
}

export default AccountManagement
