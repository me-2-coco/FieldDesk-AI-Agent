import { useState } from "react"

import {
  getUsers,
  setAuthenticatedUser,
  setCurrentUser
} from "../shared/userStore.js"
import { getCurrentFieldDeskUser, setApiAccessToken } from "../shared/crmService.js"


function Login({ onLogin }) {

  const users = getUsers()

  const [account, setAccount] = useState("")
  const [accessToken, setAccessToken] = useState("")
  const [message, setMessage] = useState("")


  async function handleLogin() {

    if (accessToken) {
      try {
        setApiAccessToken(accessToken)
        const profile = await getCurrentFieldDeskUser()
        const user = setAuthenticatedUser({
          id: profile.userId,
          name: profile.displayName,
          account: profile.userId,
          role: String(profile.role).toLowerCase(),
          repairSpecialties: profile.repairSpecialties || []
        })
        setAccessToken("")
        onLogin(user)
        return
      } catch (error) {
        setApiAccessToken("")
        setMessage(error.message)
        return
      }
    }

    const inputAccount = account.trim().toLowerCase()

    if (inputAccount === "") {
      setMessage("请输入账号")
      return
    }


    const user = users.find(
      (item) =>
        item.account.toLowerCase() === inputAccount
    )


    if (!user) {
      setMessage("没有找到该账号")
      return
    }


    const loggedInUser = setCurrentUser(user.id)

    if (!loggedInUser) {
      setMessage("登录失败")
      return
    }


    localStorage.setItem(
      "isLoggedIn",
      "true"
    )


    setMessage("登录成功")


    setTimeout(() => {

      onLogin(loggedInUser)

    }, 300)

  }


  function handleKeyDown(event) {

    if (event.key === "Enter") {
      handleLogin()
    }

  }


  return (

    <div className="login-page">


      <div className="login-card">


        <div className="login-logo">
          FD
        </div>


        <h1>
          FieldDesk AI
        </h1>


        <p className="login-subtitle">
          智能维修工作台
        </p>


        <label htmlFor="login-account">
          登录账号
        </label>


        <input
          id="login-account"
          value={account}
          onChange={(event) => {
            setAccount(event.target.value)
            setMessage("")
          }}
          onKeyDown={handleKeyDown}
          placeholder="请输入账号"
          autoComplete="username"
        />


        <button
          type="button"
          className="login-button"
          onClick={handleLogin}
        >
          登录
        </button>

        <label htmlFor="login-token">正式账号访问令牌</label>
        <input id="login-token" type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} placeholder="生产模式使用，不在浏览器保存" autoComplete="current-password" />


        {message && (

          <p className="login-message">
            {message}
          </p>

        )}


        <div className="login-demo-accounts">

          <strong>
            测试账号
          </strong>


          <button
            type="button"
            onClick={() => setAccount("zhang")}
          >
            张师傅：zhang
          </button>


          <button
            type="button"
            onClick={() => setAccount("wang")}
          >
            王库管：wang
          </button>


          <button
            type="button"
            onClick={() => setAccount("admin")}
          >
            管理员：admin
          </button>

        </div>


      </div>


    </div>

  )

}


export default Login
