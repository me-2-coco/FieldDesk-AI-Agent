import { useEffect, useState } from "react"
import { createAdminAccount, deleteAdminAccount, getAdminUsers, getNextAdminAccount, resetAdminAccountPassword, saveAdminUser } from "../shared/crmService.js"

const EMPTY = { userId: "", displayName: "", phone: "", role: "", repairSpecialties: [], password: "", active: true, recloudAssignmentMode: "DIRECT", recloudAssigneeName: "", recloudFallbackAssigneeName: "" }

function AccountManagement({ setPage }) {
  const [users, setUsers] = useState([])
  const [nextAccount, setNextAccount] = useState("FieldDesk0005")
  const [form, setForm] = useState(EMPTY)
  const [message, setMessage] = useState("")

  async function refresh() {
    try {
      const [userList, next] = await Promise.all([getAdminUsers(), getNextAdminAccount()])
      setUsers(userList)
      setNextAccount(next.userId)
    }
    catch (error) { setMessage(error.message) }
  }
  useEffect(() => {
    let active = true
    Promise.all([getAdminUsers(), getNextAdminAccount()])
      .then(([userList, next]) => { if (active) { setUsers(userList); setNextAccount(next.userId) } })
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
        : await createAdminAccount({ displayName: form.displayName, phone: form.phone, role: form.role, repairSpecialties: form.repairSpecialties })
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

  async function removeUser() {
    if (!window.confirm(`确定删除账号 ${form.userId}（${form.displayName}）吗？删除后该账号将无法登录。`)) return
    try {
      await deleteAdminAccount(form.userId)
      setForm(EMPTY)
      setMessage("账号已删除")
      await refresh()
    } catch (error) { setMessage(error.message) }
  }

  async function resetUserPassword() {
    if (!window.confirm(`确定把 ${form.userId}（${form.displayName}）的密码重置为 000000 吗？`)) return
    try {
      await resetAdminAccountPassword(form.userId)
      setMessage("密码已重置为 000000；该用户下次登录必须修改密码")
    } catch (error) { setMessage(error.message) }
  }

  return <div className="page account-management-page">
    <div className="top-bar"><button className="arrow-back" onClick={() => setPage("home")}>←</button><div><small>账号与权限</small><h1>账号管理</h1></div></div>
    <div className="card account-editor-card">
      <div className="section-title-row"><div><small>账号配置</small><h2>{form.userId ? "编辑账号" : "新增账号"}</h2></div><span>仅管理员</span></div>
      <p className="section-description">账号从 FieldDesk0005 开始按顺序生成；姓名、电话、角色和对应权限均为必填。</p>
      <form onSubmit={submit}>
        <label>FieldDesk 账号<input value={form.userId || nextAccount} readOnly aria-readonly="true" /></label>
        {!form.userId && <label>初始密码<input value="000000" readOnly aria-readonly="true" /></label>}
        <label>姓名<input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="请输入姓名" required /></label>
        <label>电话<input type="tel" inputMode="numeric" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="请输入11位手机号" required /></label>
        <label>账号角色<select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value, repairSpecialties: [] })} required>
          <option value="" disabled>请选择账号角色</option>
          {form.userId && <option value="ADMIN">管理员</option>}<option value="INFORMATION_CLERK">信息员</option><option value="WAREHOUSE">库管</option><option value="TECHNICIAN">维修师傅</option>
        </select></label>
        {(form.role === "TECHNICIAN" || form.role === "ADMIN") && <fieldset className="choice-fieldset"><legend>维修品类</legend>
          {["扫地机", "洗地机"].map((item) => <label key={item}><input type="checkbox" checked={form.repairSpecialties.includes(item)} onChange={() => toggleSpecialty(item)} /><span>{item}</span></label>)}
        </fieldset>}
        {form.userId && form.role === "TECHNICIAN" && <fieldset className="choice-fieldset"><legend>瑞云改派</legend>
          <label><input type="radio" name="recloud-mode" checked={form.recloudAssignmentMode === "DIRECT"} onChange={() => setForm({ ...form, recloudAssignmentMode: "DIRECT" })} /><span>瑞云已有本人</span></label>
          <label><input type="radio" name="recloud-mode" checked={form.recloudAssignmentMode === "FALLBACK"} onChange={() => setForm({ ...form, recloudAssignmentMode: "FALLBACK" })} /><span>暂用兜底负责人</span></label>
          {form.recloudAssignmentMode === "DIRECT"
            ? <label>瑞云姓名<input value={form.recloudAssigneeName} onChange={(event) => setForm({ ...form, recloudAssigneeName: event.target.value })} placeholder="留空则使用显示名称" /></label>
            : <label>兜底负责人<input value={form.recloudFallbackAssigneeName} onChange={(event) => setForm({ ...form, recloudFallbackAssigneeName: event.target.value })} placeholder="请输入瑞云中已存在的姓名" required /></label>}
        </fieldset>}
        <label>登录密码<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={users.some((user) => user.userId === form.userId) ? "不修改可留空" : "设置登录密码"} autoComplete="new-password" required={!users.some((user) => user.userId === form.userId)} /></label>
        <label className="switch-row"><span>账号启用</span><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} /></label>
        <div className="compact-action-row"><button type="submit">保存账号</button>{form.userId && <button type="button" className="secondary-btn" onClick={() => setForm(EMPTY)}>取消</button>}</div>
        {form.userId && form.role !== "ADMIN" && <button type="button" className="secondary-btn" onClick={resetUserPassword}>重置密码为 000000</button>}
        {form.userId && form.role !== "ADMIN" && <button type="button" className="account-delete-button" onClick={removeUser}>删除账号</button>}
      </form>
    </div>
    <div className="card account-list-card"><div className="section-title-row"><div><small>账号目录</small><h2>正式账号</h2></div><span>{users.length} 个</span></div><div className="account-directory">{users.map((user) => <button type="button" className="account-directory-row" key={user.userId} onClick={() => editUser(user)}><span className="account-directory-avatar">{user.displayName.slice(0, 1)}</span><span><strong>{user.displayName}</strong><small>{user.userId} · {user.phone || "未填写电话"} · {user.role}</small></span><em className={user.active ? "active" : "disabled"}>{user.active ? "启用" : "停用"}</em><b>›</b></button>)}</div></div>
    {message && <p className="inline-status" role="status">{message}</p>}
  </div>
}

export default AccountManagement
