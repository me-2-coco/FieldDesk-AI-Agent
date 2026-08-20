import { useEffect, useState } from "react"

import Login from "./pages/Login.jsx"
import Home from "./pages/Home.jsx"
import Repair from "./pages/Repair.jsx"
import RepairWork from "./pages/RepairWork.jsx"
import RepairProcess from "./pages/RepairProcess.jsx"
import PartsApplication from "./pages/PartsApplication.jsx"
import RepairCompletion from "./pages/RepairCompletion.jsx"
import ReturnShipping from "./pages/ReturnShipping.jsx"
import RepairFinish from "./pages/RepairFinish.jsx"
import Records from "./pages/Records.jsx"
import Inventory from "./pages/Inventory.jsx"
import Warehouse from "./pages/Warehouse.jsx"
import Profile from "./pages/Profile.jsx"
import SyncTasks from "./pages/SyncTasks.jsx"
import SyncDiagnostics from "./pages/SyncDiagnostics.jsx"
import AccountManagement from "./pages/AccountManagement.jsx"

import BottomNav from "./components/BottomNav.jsx"

import {
  canAccessPage,
  getCurrentUser,
  setAuthenticatedUser,
  USER_ROLES
} from "./shared/userStore.js"
import { getSupervisionInbox, setApiAccessToken } from "./shared/crmService.js"

import "./App.css"


function App() {


  const [isLoggedIn, setIsLoggedIn] = useState(
    localStorage.getItem("isLoggedIn") === "true"
  )


  const [currentUser, setCurrentUser] = useState(() =>
    getCurrentUser()
  )


  const [page, setPageState] = useState("home")


  const [permissionMessage, setPermissionMessage] =
    useState("")

  const [supervisionUnreadCount, setSupervisionUnreadCount] = useState(0)
  const [supervisionOpenKey, setSupervisionOpenKey] = useState(0)
  const [latestSupervision, setLatestSupervision] = useState(null)
  const [supervisionTargetRmaNo, setSupervisionTargetRmaNo] = useState("")

  useEffect(() => {
    const canReceiveSupervision = isLoggedIn && [USER_ROLES.TECHNICIAN, USER_ROLES.ADMIN].includes(currentUser?.role)
    if (!canReceiveSupervision) return undefined
    let active = true
    let timer
    const refresh = async () => {
      try {
        const items = await getSupervisionInbox()
        if (active) {
          const unread = (items || []).filter((item) => !item.isRead)
          const latest = [...unread].sort((left, right) =>
            String(right.updatedAt || right.capturedAt || "").localeCompare(String(left.updatedAt || left.capturedAt || ""))
          )[0] || null
          setSupervisionUnreadCount(unread.length)
          setLatestSupervision(latest)
        }
      } catch {
        // 全局红点不可用时不阻断业务操作，下一轮自动重试。
      } finally {
        if (active) timer = window.setTimeout(refresh, 10000)
      }
    }
    refresh()
    return () => {
      active = false
      if (timer) window.clearTimeout(timer)
    }
  }, [isLoggedIn, currentUser?.id, currentUser?.role])



  function handleLogin(user) {

    setCurrentUser(user)

    setIsLoggedIn(true)

    setPageState("home")

    setPermissionMessage("")

    setSupervisionUnreadCount(0)
    setLatestSupervision(null)

  }




  function handleLogout() {

    localStorage.removeItem("isLoggedIn")
    setAuthenticatedUser(null)
    setApiAccessToken("")

    setIsLoggedIn(false)

    setPageState("home")

    setPermissionMessage("")

    setSupervisionUnreadCount(0)
    setLatestSupervision(null)

  }





  function setPage(nextPage) {


   const latestUser = getCurrentUser()



    if (!latestUser) {

      setPageState("login")

      return

    }

    setCurrentUser(latestUser)



    if (!canAccessPage(nextPage, latestUser)) {


      setPermissionMessage(
        `${latestUser.name || "当前用户"}没有权限访问该页面`
      )


      return

    }



    setPermissionMessage("")


    setPageState(nextPage)


  }

  function openSupervisionInbox(rmaNo = "") {
    setPage("home")
    setSupervisionTargetRmaNo(String(rmaNo || ""))
    setSupervisionOpenKey((current) => current + 1)
  }





  if (!isLoggedIn) {


    return (

      <Login
        onLogin={handleLogin}
      />

    )

  }





  return (

    <div className="app">


      <main className="app-content">



        {permissionMessage && (

          <div className="permission-message">

            {permissionMessage}

          </div>

        )}




        {page === "home" && (

          <Home
            setPage={setPage}
            currentUser={currentUser}
            supervisionOpenKey={supervisionOpenKey}
            supervisionTargetRmaNo={supervisionTargetRmaNo}
          />

        )}




        {page === "repair" && (

          <Repair
            setPage={setPage}
          />

        )}









        {page === "repairWork" && (

          <RepairWork
            setPage={setPage}
          />

        )}





        {page === "repairProcess" && (

          <RepairProcess
            setPage={setPage}
          />

        )}

        {page === "partsApplication" && (

          <PartsApplication
            setPage={setPage}
          />

        )}

        {page === "repairCompletion" && (
          <RepairCompletion setPage={setPage} />
        )}

        {page === "returnShipping" && (
          <ReturnShipping setPage={setPage} />
        )}





        {page === "repairFinish" && (

          <RepairFinish
            setPage={setPage}
          />

        )}





        {page === "records" && (

          <Records
            setPage={setPage}
          />

        )}





        {page === "inventory" && (

          <Inventory
            setPage={setPage}
          />

        )}





        {page === "warehouse" && (

          <Warehouse
            setPage={setPage}
          />

        )}





        {page === "profile" && (

          <Profile
            setPage={setPage}
            onLogout={handleLogout}
          />

        )}

        {page === "syncTasks" && (
          <SyncTasks setPage={setPage} />
        )}

        {page === "syncDiagnostics" && (
          <SyncDiagnostics setPage={setPage} />
        )}

        {page === "accountManagement" && (
          <AccountManagement setPage={setPage} />
        )}




      </main>

      {supervisionUnreadCount > 0 && (
        <button
          type="button"
          className="global-supervision-alert"
          onClick={() => openSupervisionInbox(latestSupervision?.rmaNo)}
          aria-label={`查看${supervisionUnreadCount}条未读督办通知`}
        >
          <span className="global-supervision-alert-text">
            <b>新督办 · {latestSupervision?.rmaNo || "待查看"}</b>
            <small>{String(latestSupervision?.originalContent || "点击查看督办内容").slice(0, 28)}</small>
          </span>
          <strong>{supervisionUnreadCount > 99 ? "99+" : supervisionUnreadCount}</strong>
        </button>
      )}





      <BottomNav

        page={page}

        setPage={setPage}

        supervisionUnreadCount={supervisionUnreadCount}

        onOpenSupervision={() => openSupervisionInbox(latestSupervision?.rmaNo)}

      />



    </div>

  )


}



export default App
