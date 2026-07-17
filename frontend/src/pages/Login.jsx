import { useState } from "react"

import {
  getUsers,
  setCurrentUser
} from "../shared/userStore.js"


function Login({ onLogin }) {

  const users = getUsers()

  const [account, setAccount] = useState("")
  const [message, setMessage] = useState("")


  function handleLogin() {

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