import { useEffect, useState } from "react"
import { AppIcon } from "../components/AppIcons.jsx"
import { createAdminAccount, deleteAdminAccount, getAdminUsers, getCurrentFieldDeskUser, getNextAdminAccount, resetAdminAccountPassword, saveAdminUser } from "../shared/crmService.js"

const EMPTY = { userId: "", displayName: "", phone: "", role: "", repairSpecialties: [], active: true, recloudAssignmentMode: "DIRECT", recloudAssigneeName: "", recloudFallbackAssigneeName: "" }

function permissionValue(form) {
  if (form.userId === "FieldDesk0004" || form.accountPurpose === "RECLOUD_TECHNICIAN_TEST") return "TECHNICIAN_TEST"
  if (form.role !== "TECHNICIAN") return form.role
  if (form.repairSpecialties.length > 1) return "TECHNICIAN_DUAL"
  return form.repairSpecialties[0] === "扫地机" ? "TECHNICIAN_SWEEP" : form.repairSpecialties[0] === "洗地机" ? "TECHNICIAN_WASH" : ""
}

function permissionFields(value) {
  if (value === "TECHNICIAN_TEST") return { role: "TECHNICIAN", repairSpecialties: ["扫地机", "洗地机"] }
  if (value === "TECHNICIAN_SWEEP") return { role: "TECHNICIAN", repairSpecialties: ["扫地机"] }
  if (value === "TECHNICIAN_WASH") return { role: "TECHNICIAN", repairSpecialties: ["洗地机"] }
  if (value === "TECHNICIAN_DUAL") return { role: "TECHNICIAN", repairSpecialties: ["扫地机", "洗地机"] }
  return { role: value, repairSpecialties: [] }
}

const ROLE_CHOICES = [
  { value: "TECHNICIAN_SWEEP", title: "扫地机师傅", description: "仅查看和处理扫地机工单", icon: "work", tone: "sweep" },
  { value: "TECHNICIAN_WASH", title: "洗地机师傅", description: "仅查看和处理洗地机工单", icon: "work", tone: "wash" },
  { value: "WAREHOUSE", title: "库管", description: "管理配件入库、发放与退还", icon: "warehouse", tone: "warehouse" },
  { value: "INFORMATION_CLERK", title: "信息员", description: "查看异常、进度与维修档案", icon: "records", tone: "information" },
]
const ADMIN_CHOICE = { value: "ADMIN", title: "管理员", description: "管理普通账号、工单、库存与系统设置", icon: "accounts", tone: "admin" }
const RECLOUD_TEST_CHOICE = { value: "TECHNICIAN_TEST", title: "双品类测试师傅", description: "同时测试扫地机和洗地机的瑞云姓名识别", icon: "work", tone: "admin" }

function roleDisplay(user) {
  if (user.accountAuthority === "OWNER") return "负责人"
  if (user.userId === "FieldDesk0004") return "双品类测试师傅"
  if (user.role === "TECHNICIAN") return `${user.repairSpecialties?.[0] || "未配置"}师傅`
  if (user.role === "WAREHOUSE") return "库管"
  if (user.role === "INFORMATION_CLERK") return "信息员"
  return "管理员"
}

function AccountManagement({ setPage }) {
  const [users, setUsers] = useState([])
  const [nextAccount, setNextAccount] = useState("FieldDesk0005")
  const [accountSuffix, setAccountSuffix] = useState("0005")
  const [form, setForm] = useState(EMPTY)
  const [currentProfile, setCurrentProfile] = useState(null)
  const [message, setMessage] = useState("")
  const editingRecloudTestAccount = form.userId === "FieldDesk0004"
  const creatingRecloudTestAccount = !form.userId && `FieldDesk${accountSuffix.padStart(4, "0")}` === "FieldDesk0004"
  const recloudTestAccount = editingRecloudTestAccount || creatingRecloudTestAccount
  const availableRoleChoices = recloudTestAccount
    ? [RECLOUD_TEST_CHOICE]
    : [...ROLE_CHOICES, ...(currentProfile?.accountAuthority === "OWNER" ? [ADMIN_CHOICE] : [])]

  async function refresh() {
    try {
      const [userList, next, profile] = await Promise.all([getAdminUsers(), getNextAdminAccount(), getCurrentFieldDeskUser()])
      setUsers(userList)
      setNextAccount(next.userId)
      setAccountSuffix(next.userId.replace(/^FieldDesk/, ""))
      setCurrentProfile(profile)
    }
    catch (error) { setMessage(error.message) }
  }
  useEffect(() => {
    let active = true
    Promise.all([getAdminUsers(), getNextAdminAccount(), getCurrentFieldDeskUser()])
      .then(([userList, next, profile]) => { if (active) { setUsers(userList); setNextAccount(next.userId); setAccountSuffix(next.userId.replace(/^FieldDesk/, "")); setCurrentProfile(profile) } })
      .catch((error) => { if (active) setMessage(error.message) })
    return () => { active = false }
  }, [])

  async function submit(event) {
    event.preventDefault()
    try {
      const saved = form.userId
        ? await saveAdminUser(form)
        : await createAdminAccount({ userId: `FieldDesk${accountSuffix.padStart(4, "0")}`, displayName: form.displayName, phone: form.phone, role: form.role, repairSpecialties: form.repairSpecialties })
      setForm(EMPTY)
      setMessage(form.userId
        ? "账号配置已保存"
        : `账号创建成功：${saved.userId}，初始密码 ${saved.initialPassword}`)
      await refresh()
    } catch (error) { setMessage(error.message) }
  }

  function editUser(user) {
    setForm({ userId: user.userId, displayName: user.displayName, phone: user.phone || "", role: user.role, accountAuthority: user.accountAuthority || "", repairSpecialties: user.repairSpecialties || [], active: user.active !== false, recloudAssignmentMode: user.recloudAssignmentMode || "DIRECT", recloudAssigneeName: user.recloudAssigneeName || "", recloudFallbackAssigneeName: user.recloudFallbackAssigneeName || "" })
    setMessage(user.accountAuthority === "OWNER" ? "负责人账号受系统保护，仅可查看" : "正在编辑账号角色和权限")
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
      <p className="section-description">FieldDesk0004 为瑞云姓名识别测试账号；正常账号从 FieldDesk0005 开始按顺序生成。姓名、电话、角色和对应权限均为必填。</p>
      <form onSubmit={submit}>
        {form.userId
          ? <label>FieldDesk 账号<input value={form.userId} readOnly aria-readonly="true" /></label>
          : <label>FieldDesk 账号<div className="account-id-editor"><span>FieldDesk</span><input aria-label="账号数字" inputMode="numeric" value={accountSuffix} onChange={(event) => setAccountSuffix(event.target.value.replace(/\D/g, "").slice(0, 8))} onBlur={() => setAccountSuffix((value) => (value || nextAccount.replace(/^FieldDesk/, "")).padStart(4, "0"))} placeholder={nextAccount.replace(/^FieldDesk/, "")} required /></div><small className="account-id-hint">默认使用下一个编号；手动填写 0004 可创建瑞云对接测试账号</small></label>}
        {!form.userId && <label>初始密码<input value="000000" readOnly aria-readonly="true" /></label>}
        <label>{recloudTestAccount ? "测试师傅姓名" : "姓名"}<input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="请输入姓名" required disabled={form.accountAuthority === "OWNER"} />{recloudTestAccount && <small className="account-id-hint">保存后，该姓名会直接用于瑞云负责人识别测试</small>}</label>
        <label>电话<input type="tel" inputMode="numeric" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="请输入11位手机号" required disabled={form.accountAuthority === "OWNER"} /></label>
        <fieldset className="account-role-picker"><legend>账号角色与权限</legend><div className="account-role-grid">
          {availableRoleChoices.map((choice) => <button type="button" key={choice.value} disabled={form.accountAuthority === "OWNER"} className={`account-role-option ${choice.tone} ${permissionValue(form) === choice.value ? "is-selected" : ""}`} aria-pressed={permissionValue(form) === choice.value} onClick={() => setForm({ ...form, ...permissionFields(choice.value) })}>
            <span className="account-role-icon"><AppIcon name={choice.icon} size={20} /></span>
            <span className="account-role-copy"><strong>{choice.title}</strong><small>{choice.description}</small></span>
            <span className="account-role-check">✓</span>
          </button>)}
          {form.userId && form.role === "TECHNICIAN" && form.repairSpecialties.length > 1 && <button type="button" className={`account-role-option legacy ${permissionValue(form) === "TECHNICIAN_DUAL" ? "is-selected" : ""}`} onClick={() => setForm({ ...form, ...permissionFields("TECHNICIAN_DUAL") })}><span className="account-role-icon"><AppIcon name="work" size={20} /></span><span className="account-role-copy"><strong>现有双品类师傅</strong><small>建议调整为一个维修品类</small></span><span className="account-role-check">✓</span></button>}
        </div></fieldset>
        {form.userId && form.role === "TECHNICIAN" && <fieldset className="choice-fieldset"><legend>瑞云改派</legend>
          <label><input type="radio" name="recloud-mode" checked={form.recloudAssignmentMode === "DIRECT"} onChange={() => setForm({ ...form, recloudAssignmentMode: "DIRECT" })} /><span>瑞云已有本人</span></label>
          <label><input type="radio" name="recloud-mode" checked={form.recloudAssignmentMode === "FALLBACK"} onChange={() => setForm({ ...form, recloudAssignmentMode: "FALLBACK" })} /><span>暂用兜底负责人</span></label>
          {editingRecloudTestAccount
            ? <p className="section-description">当前测试姓名：{form.displayName || "未填写"}。无需另外填写瑞云姓名。</p>
            : form.recloudAssignmentMode === "DIRECT"
            ? <label>瑞云姓名<input value={form.recloudAssigneeName} onChange={(event) => setForm({ ...form, recloudAssigneeName: event.target.value })} placeholder="留空则使用显示名称" /></label>
            : <label>兜底负责人<input value={form.recloudFallbackAssigneeName} onChange={(event) => setForm({ ...form, recloudFallbackAssigneeName: event.target.value })} placeholder="请输入瑞云中已存在的姓名" required /></label>}
        </fieldset>}
        {form.accountAuthority !== "OWNER" && <label className="switch-row"><span>账号启用</span><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} /></label>}
        <div className="compact-action-row">{form.accountAuthority !== "OWNER" && <button type="submit">保存账号</button>}{form.userId && <button type="button" className="secondary-btn" onClick={() => setForm(EMPTY)}>取消</button>}</div>
        {form.userId && form.accountAuthority !== "OWNER" && <button type="button" className="secondary-btn" onClick={resetUserPassword}>重置密码为 000000</button>}
        {form.userId && form.accountAuthority !== "OWNER" && <button type="button" className="account-delete-button" onClick={removeUser}>删除账号</button>}
      </form>
    </div>
    <div className="card account-list-card"><div className="section-title-row"><div><small>账号目录</small><h2>正式账号</h2></div><span>{users.length} 个</span></div><div className="account-directory">{users.map((user) => <button type="button" className="account-directory-row" key={user.userId} onClick={() => editUser(user)}><span className="account-directory-avatar">{user.displayName.slice(0, 1)}</span><span><strong>{user.displayName}</strong><small>{user.userId} · {user.phone || "未填写电话"} · {roleDisplay(user)}</small></span><em className={user.active ? "active" : "disabled"}>{user.active ? "启用" : "停用"}</em><b>›</b></button>)}</div></div>
    {message && <p className="inline-status" role="status">{message}</p>}
  </div>
}

export default AccountManagement
