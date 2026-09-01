import { useState } from "react"

import {
  getUsers,
  setAuthenticatedUser,
  setCurrentUser
} from "../shared/userStore.js"
import { loginFieldDeskAccount } from "../shared/crmService.js"


function Login({ onLogin }) {

  const users = getUsers()

  const [account, setAccount] = useState("")
  const [password, setPassword] = useState("")
  const [message, setMessage] = useState("")


  async function handleLogin() {

    if (password) {
      try {
        const profile = await loginFieldDeskAccount(account, password)
        const user = setAuthenticatedUser({
          id: profile.userId,
          name: profile.displayName,
          account: profile.userId,
          role: String(profile.role).toLowerCase(),
          repairSpecialties: profile.repairSpecialties || []
        })
        setPassword("")
        onLogin(user)
        return
      } catch (error) {
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
          维
        </div>


        <h1>
          网点维修管理
        </h1>


        <p className="login-subtitle">
          维修工单系统
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

        <label htmlFor="login-password">登录密码</label>
        <input id="login-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={handleKeyDown} placeholder="请输入登录密码" autoComplete="current-password" />


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

          <button type="button" onClick={() => setAccount("li")}>洗地机师傅：li</button>
          <button type="button" onClick={() => setAccount("zhao")}>双品类师傅：zhao</button>

        </div>


      </div>


    </div>

  )

}


export default Login
