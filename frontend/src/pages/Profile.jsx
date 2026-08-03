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

    <div className="page">





      <h1>
        我的
      </h1>


      <div className="card">

        <h2>
          当前账号
        </h2>


        <p>
          姓名：
          {currentUser.name}
        </p>


        <p>
          账号：
          {currentUser.account}
        </p>


        <p>
          角色：
          {getRoleName(currentUser.role)}
        </p>

      </div>

      {currentUser.role === USER_ROLES.ADMIN && (
        <div className="card">
          <h2>瑞云同步管理</h2>
          <p>查看本地业务节点的异步同步任务和失败重试。</p>
          <button type="button" onClick={() => setPage("syncTasks")}>同步任务</button>
        </div>
      )}


      <div className="card">

        <h2>
          切换测试账号
        </h2>


        <p>
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

            <strong>
              {user.name}
            </strong>

            <span>
              {getRoleName(user.role)}
            </span>

          </button>

        ))}

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
