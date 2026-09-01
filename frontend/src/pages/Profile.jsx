import { useState } from "react"

import {
  getUsers,
  getCurrentUser,
  getRoleName,
  setCurrentUser,
  USER_ROLES
} from "../shared/userStore.js"


function Profile({
  setPage,
  onLogout
}) {

  const [users] = useState(() =>
    getUsers()
  )

  const [currentUser, setCurrentUserState] = useState(() =>
    getCurrentUser()
  )

  const [message, setMessage] = useState("")
  const isTechnician = currentUser.role === USER_ROLES.TECHNICIAN
  const isWarehouse = currentUser.role === USER_ROLES.WAREHOUSE
  const isInformationClerk = currentUser.role === USER_ROLES.INFORMATION_CLERK
  const isAdmin = currentUser.role === USER_ROLES.ADMIN
  const personalActions = isTechnician ? [
    { page: "records", title: "维修记录", description: "查看个人历史工单" },
    { page: "inventory", title: "个人库存", description: "查看配件和库存流水" }
  ] : isWarehouse ? [
    { page: "inventory", title: "库存记录", description: "查看总库和师傅库存" },
    { page: "warehouse", title: "库房记录", description: "查看退件确认进度" }
  ] : isInformationClerk ? [
    { page: "repairReports", title: "维修档案", description: "查看维修措施和附件" },
    { page: "machineTracking", title: "机器去向", description: "查询机器当前状态" },
    { page: "exceptionCenter", title: "问题记录", description: "查看待处理异常" }
  ] : [
    { page: "records", title: "全部工单", description: "查询历史业务记录" },
    { page: "inventory", title: "库存总览", description: "查看全局库存情况" },
    { page: "exceptionCenter", title: "异常中心", description: "查看全局问题工单" }
  ]


  function changeUser(userId) {

    const updatedUser = setCurrentUser(userId)

    if (!updatedUser) {
      setMessage("账号切换失败")
      return
    }

    setCurrentUserState(updatedUser)

    setMessage(
      `已切换为：${updatedUser.name}`
    )

    setTimeout(() => {
      setPage("home")
    }, 500)
  }


  function handleLogout() {

    const confirmed = window.confirm(
      "确定要退出当前账号吗？"
    )

    if (!confirmed) {
      return
    }

    onLogout()
  }


  return (

    <div className="page profile-page">

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
            {currentUser.name.slice(0, 1)}
          </div>
          <div className="profile-user-copy">
            <span>当前账号</span>
            <strong>{currentUser.name}</strong>
            <small>@{currentUser.account}</small>
          </div>
          <span className="profile-role-badge">
            {getRoleName(currentUser.role)}
          </span>
        </div>
      </div>

      <div className="card profile-section-card">
        <div className="profile-section-heading">
          <div><span>个人工作</span><h2>我的功能</h2></div>
          <small>{getRoleName(currentUser.role)}</small>
        </div>
        <div className="profile-action-list">
          {personalActions.map((action) => (
            <button type="button" key={action.page} onClick={() => setPage(action.page)}>
              <span className="profile-action-icon">{action.title.slice(0, 1)}</span>
              <span><strong>{action.title}</strong><small>{action.description}</small></span>
              <b>›</b>
            </button>
          ))}
        </div>
      </div>

      {isAdmin && (
        <div className="card profile-section-card">
          <div className="profile-section-heading">
            <div><span>管理工具</span><h2>系统管理</h2></div>
            <small>管理员</small>
          </div>
          <p className="profile-section-description">查看本地业务节点的瑞云同步记录和失败重试。</p>
          <div className="profile-management-grid">
            <button type="button" onClick={() => setPage("syncTasks")}><strong>瑞云同步</strong><span>查看任务 ›</span></button>
            <button type="button" onClick={() => setPage("syncDiagnostics")}><strong>同步检查</strong><span>运行诊断 ›</span></button>
            <button type="button" onClick={() => setPage("accountManagement")}><strong>账号管理</strong><span>权限设置 ›</span></button>
          </div>
        </div>
      )}


      {isAdmin && <div className="card profile-section-card">

        <div className="profile-section-heading">
          <div><span>账号管理</span><h2>切换测试账号</h2></div>
          <small>{users.length} 个账号</small>
        </div>

        <p className="profile-section-description">
          当前阶段用于测试不同角色的菜单和权限。
        </p>


        {users.map((user) => (

          <button
            type="button"
            key={user.id}
            className={
              currentUser.id === user.id
                ? "account-switch-button active"
                : "account-switch-button"
            }
            onClick={() =>
              changeUser(user.id)
            }
          >

            <span className="account-switch-avatar">{user.name.slice(0, 1)}</span>
            <span className="account-switch-copy">
              <strong>{user.name}</strong>
              <small>@{user.account}</small>
            </span>
            <span className="account-switch-role">
              {getRoleName(user.role)}
            </span>
            <span className="account-switch-arrow">›</span>

          </button>

        ))}

      </div>}

      <div className="card profile-section-card profile-settings-card">
        <div className="profile-section-heading">
          <div><span>服务与支持</span><h2>设置与帮助</h2></div>
        </div>
        <div className="profile-info-row"><span>当前角色</span><strong>{getRoleName(currentUser.role)}</strong></div>
        {isTechnician && <div className="profile-info-row"><span>维修品类</span><strong>{currentUser.repairSpecialties?.join(" / ") || "未配置"}</strong></div>}
        <div className="profile-info-row"><span>系统版本</span><strong>FieldDesk 当前版本</strong></div>
        <p className="profile-help-tip">使用过程中遇到账号、权限或同步问题，请联系系统管理员。</p>
      </div>


      {message && (

        <div className="card message-card">

          <p>
            {message}
          </p>

        </div>

      )}


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
