import { useState } from "react"

import {
  getUsers,
  setAuthenticatedUser,
  setCurrentUser
} from "../shared/userStore.js"
import { changeFieldDeskPassword, loginFieldDeskAccount } from "../shared/crmService.js"


function Login({ onLogin }) {

  const users = getUsers()

  const [account, setAccount] = useState("")
  const [password, setPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [passwordChangeProfile, setPasswordChangeProfile] = useState(null)
  const [message, setMessage] = useState("")

  function completeLogin(profile) {
    const user = setAuthenticatedUser({
      id: profile.userId,
      name: profile.displayName,
      account: profile.userId,
      role: String(profile.role).toLowerCase(),
      repairSpecialties: profile.repairSpecialties || []
    })
    onLogin(user)
  }


  async function handleLogin() {

    if (password) {
      try {
        const profile = await loginFieldDeskAccount(account, password)
        setPassword("")
        if (profile.mustChangePassword) {
          setPasswordChangeProfile(profile)
          setMessage("首次登录，请先设置新密码")
          return
        }
        completeLogin(profile)
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

  async function handlePasswordChange() {
    if (newPassword.length < 6) { setMessage("新密码至少需要6位"); return }
    if (newPassword !== confirmPassword) { setMessage("两次输入的新密码不一致"); return }
    try {
      await changeFieldDeskPassword(newPassword)
      const profile = passwordChangeProfile
      setNewPassword("")
      setConfirmPassword("")
      setPasswordChangeProfile(null)
      completeLogin(profile)
    } catch (error) { setMessage(error.message) }
  }


  function handleKeyDown(event) {

    if (event.key === "Enter") {
      if (passwordChangeProfile) handlePasswordChange()
      else handleLogin()
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
          disabled={Boolean(passwordChangeProfile)}
        />

        <label htmlFor="login-password">登录密码</label>
        <input id="login-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={handleKeyDown} placeholder="请输入登录密码" autoComplete="current-password" disabled={Boolean(passwordChangeProfile)} />

        {!passwordChangeProfile && <button type="button" className="login-button" onClick={handleLogin}>登录</button>}

        {passwordChangeProfile && <div className="login-password-change">
          <strong>设置新密码</strong>
          <label htmlFor="login-new-password">新密码</label>
          <input id="login-new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} onKeyDown={handleKeyDown} placeholder="至少6位，不能使用0000" autoComplete="new-password" />
          <label htmlFor="login-confirm-password">确认新密码</label>
          <input id="login-confirm-password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} onKeyDown={handleKeyDown} placeholder="请再次输入新密码" autoComplete="new-password" />
          <button type="button" className="login-button" onClick={handlePasswordChange}>修改密码并进入系统</button>
        </div>}


        {message && (

          <p className="login-message">
            {message}
          </p>

        )}


        {!passwordChangeProfile && <div className="login-demo-accounts">

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

        </div>}


      </div>


    </div>

  )

}


export default Login
