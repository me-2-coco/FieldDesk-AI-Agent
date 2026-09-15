import { accountPersonName, accountRoleLabel } from "../shared/accountIdentity.js"
import { useState } from "react"
import { isOwnerAccount } from "../shared/accountAccessPolicy.js"

import {
  getCurrentUser,
  setAuthenticatedUser,
  USER_ROLES
} from "../shared/userStore.js"
import { AppIcon } from "../components/AppIcons.jsx"
import "../home-desktop.css"
import { updateRecloudOperatorName } from "../shared/crmService.js"


function Profile({
  setPage,
  onLogout,
  onProfileChange
}) {

  const [currentUser, setCurrentUserState] = useState(() =>
    getCurrentUser()
  )

  const [recloudMessage, setRecloudMessage] = useState("")
  const [isSavingRecloudName, setIsSavingRecloudName] = useState(false)
  const canSetRecloudOperatorName = ["FieldDesk0001", "FieldDesk0004"].includes(currentUser.id)
  const [recloudOperatorName, setRecloudOperatorName] = useState(() => currentUser.recloudAssigneeName || (currentUser.id === "FieldDesk0004" ? currentUser.name : ""))
  const isTechnician = currentUser.role === USER_ROLES.TECHNICIAN
  const isWarehouse = currentUser.role === USER_ROLES.WAREHOUSE
  const isInformationClerk = currentUser.role === USER_ROLES.INFORMATION_CLERK
  const isAdmin = currentUser.role === USER_ROLES.ADMIN
  const personalActions = isTechnician ? [
    { page: "records", title: "维修记录", description: "查看个人历史工单", icon: "records" },
    { page: "inventory", title: "个人库存", description: "查看配件和库存流水", icon: "inventory" }
  ] : isWarehouse ? [
    { page: "inventory", title: "库存记录", description: "查看总库和师傅库存", icon: "inventory" },
    { page: "warehouse", title: "库房记录", description: "查看退件确认进度", icon: "warehouse" }
  ] : isInformationClerk ? [
    { page: "repairReports", title: "维修档案", description: "查看维修措施和附件", icon: "archive" },
    { page: "machineTracking", title: "机器去向", description: "查询机器当前状态", icon: "tracking" },
    { page: "exceptionCenter", title: "问题记录", description: "查看待处理异常", icon: "alert" }
  ] : [
    { page: "records", title: "全部工单", description: "查询历史业务记录", icon: "records" },
    { page: "exceptionCenter", title: "异常中心", description: "查看全局问题工单", icon: "alert" }
  ]




  function handleLogout() {

    const confirmed = window.confirm(
      "确定要退出当前账号吗？"
    )

    if (!confirmed) {
      return
    }

    onLogout()
  }

  async function saveRecloudOperatorName(event) {
    event.preventDefault()
    try {
      setIsSavingRecloudName(true)
      setRecloudMessage("")
      const profile = await updateRecloudOperatorName(recloudOperatorName)
      const updatedUser = { ...currentUser, name: profile.displayName, recloudAssigneeName: profile.recloudAssigneeName }
      setAuthenticatedUser(updatedUser)
      setCurrentUserState(updatedUser)
      onProfileChange?.(updatedUser)
      setRecloudMessage(`已保存：后续瑞云操作将使用“${profile.recloudAssigneeName}”`)
    } catch (error) {
      setRecloudMessage(error.message)
    } finally {
      setIsSavingRecloudName(false)
    }
  }


  return (

    <div className="page profile-page home-desktop">

      <div className="card profile-identity-card">
        <div className="profile-identity-glow" />

        <div className="profile-heading-row">
          <div>
            <span>FieldDesk 个人中心</span>
            <h1>我的</h1>
          </div>
          <div className="profile-heading-mark">FD</div>
        </div>

        <div className="profile-user-panel">
          <div className="profile-user-avatar">
            {accountPersonName(currentUser).slice(0, 1) || "人"}
          </div>
          <div className="profile-user-copy">
            <span>当前账号</span>
            <strong>{accountPersonName(currentUser) || "\u00a0"}</strong>
            <small>{currentUser.account}</small>
          </div>
          <span className="profile-role-badge">
            {accountRoleLabel(currentUser)}
          </span>
        </div>
      </div>

      <div className="card profile-section-card">
        <div className="profile-section-heading">
          <div><span>个人工作</span><h2>我的功能</h2></div>
          <small>{accountRoleLabel(currentUser)}</small>
        </div>
        <div className="desktop-app-grid">
          {personalActions.map((action, index) => (
            <button type="button" className="desktop-app" key={action.page} title={action.description} onClick={() => setPage(action.page)}>
              <span className={`desktop-app-icon desktop-tone-${index % 5}`}><AppIcon name={action.icon} size={27} /></span>
              <span>{action.title}</span>
            </button>
          ))}
        </div>
      </div>

      {isOwnerAccount(currentUser) && <div className="card profile-section-card">
        <div className="profile-section-heading"><div><span>财务</span><h2>工资核算</h2></div><small>仅负责人可见</small></div>
        <p className="profile-section-description">查看每月师傅工资、逐单核对台数，导出 WPS 工资表。</p>
        <div className="desktop-app-grid"><button type="button" className="desktop-app" onClick={() => setPage("payroll")}><span className="desktop-app-icon desktop-tone-0"><AppIcon name="records" size={27} /></span><span>工资核算</span></button></div>
      </div>}

      {isAdmin && (
        <div className="card profile-section-card">
          <div className="profile-section-heading">
            <div><span>管理工具</span><h2>系统管理</h2></div>
            <small>{accountRoleLabel(currentUser)}</small>
          </div>
          <div className="desktop-app-grid">
            {[
              { page: "syncTasks", title: "瑞云同步", icon: "sync" },
              { page: "syncDiagnostics", title: "同步检查", icon: "diagnostic" },
              { page: "printManagement", title: "打印终端", icon: "inventory" },
              { page: "accountManagement", title: "账号管理", icon: "accounts" }
            ].map((action, index) => <button type="button" className="desktop-app" key={action.page} onClick={() => setPage(action.page)}><span className={`desktop-app-icon desktop-tone-${index}`}><AppIcon name={action.icon} size={27} /></span><span>{action.title}</span></button>)}
          </div>
        </div>
      )}



      {canSetRecloudOperatorName && <div className="card profile-section-card">
        <div className="profile-section-heading">
          <div><span>瑞云真实操作身份</span><h2>{currentUser.id === "FieldDesk0004" ? "测试师傅姓名" : "负责人瑞云姓名"}</h2></div>
          <small>扫地机 + 洗地机</small>
        </div>
        <p className="profile-section-description">两类工单都会使用这里的姓名匹配瑞云服务人员。</p>
        <form onSubmit={saveRecloudOperatorName}>
          <label>瑞云操作姓名<input value={recloudOperatorName} onChange={(event) => setRecloudOperatorName(event.target.value)} placeholder="请输入瑞云中的真实姓名" required /></label>
          <button type="submit" disabled={isSavingRecloudName || !recloudOperatorName.trim()}>
            {isSavingRecloudName ? "正在保存..." : "保存瑞云姓名"}
          </button>
          {recloudMessage && <p className="profile-inline-message" role="status">{recloudMessage}</p>}
        </form>
      </div>}

      <div className="card profile-section-card profile-settings-card">
        <div className="profile-section-heading">
          <div><span>服务与支持</span><h2>设置与帮助</h2></div>
        </div>
        <div className="profile-info-row"><span>当前角色</span><strong>{accountRoleLabel(currentUser)}</strong></div>
        {isTechnician && <div className="profile-info-row"><span>维修品类</span><strong>{currentUser.repairSpecialties?.join(" / ") || "未配置"}</strong></div>}
        <div className="profile-info-row"><span>系统版本</span><strong>FieldDesk 当前版本</strong></div>
        <p className="profile-help-tip">使用过程中遇到账号、权限或同步问题，请联系系统管理员。</p>
      </div>




      <button
        type="button"
        className="logout-button"
        onClick={handleLogout}
      >
        退出登录
      </button>


    </div>

  )

}


export default Profile
