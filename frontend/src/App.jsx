import { useEffect, useState } from "react"

import Login from "./pages/Login.jsx"
import Home from "./pages/Home.jsx"
import Repair from "./pages/Repair.jsx"
import RepairWork from "./pages/RepairWork.jsx"
import RepairProcess from "./pages/RepairProcess.jsx"
import PartsApplication from "./pages/PartsApplication.jsx"
import RepairDecision from "./pages/RepairDecision.jsx"
import RepairCompletion from "./pages/RepairCompletion.jsx"
import ReturnShipping from "./pages/ReturnShipping.jsx"
import RepairFinish from "./pages/RepairFinish.jsx"
import RepairHistoryLookup from "./pages/RepairHistoryLookup.jsx"
import MachineTracking from "./pages/MachineTracking.jsx"
import InformationRepairReports from "./pages/InformationRepairReports.jsx"
import InformationExceptionCenter from "./pages/InformationExceptionCenter.jsx"
import Inventory from "./pages/Inventory.jsx"
import Warehouse from "./pages/Warehouse.jsx"
import Profile from "./pages/Profile.jsx"
import SyncTasks from "./pages/SyncTasks.jsx"
import SyncDiagnostics from "./pages/SyncDiagnostics.jsx"
import AccountManagement from "./pages/AccountManagement.jsx"
import AdminRepairRecovery from "./pages/AdminRepairRecovery.jsx"

import BottomNav from "./components/BottomNav.jsx"

import {
  canAccessPage,
  getCurrentUser,
  setAuthenticatedUser,
  USER_ROLES
} from "./shared/userStore.js"
import {
  getRecloudSyncTasks,
  getSupervisionInbox,
  getSupervisionMonitorStatus,
  setApiAccessToken
} from "./shared/crmService.js"
import {
  findRepairOrderByCrmOrderNo,
  setCurrentRepairOrderId
} from "./shared/repairOrderStore.js"
import { pageForRepairStatus } from "./shared/repairNavigation.js"

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
  const [supervisionMonitorWarning, setSupervisionMonitorWarning] = useState("")
  const [syncAttentionTasks, setSyncAttentionTasks] = useState([])
  const [selectedInformationReportRmaNo, setSelectedInformationReportRmaNo] = useState("")

  useEffect(() => {
    const canMonitorSync = isLoggedIn && currentUser?.role === USER_ROLES.ADMIN
    if (!canMonitorSync) {
      queueMicrotask(() => setSyncAttentionTasks([]))
      return undefined
    }
    let active = true
    let timer
    const refreshSyncAttention = async () => {
      try {
        const tasks = await getRecloudSyncTasks()
        if (active) {
          setSyncAttentionTasks((tasks || [])
            .filter((task) => ["FAILED", "MANUAL_REVIEW", "READY_DRY_RUN", "AWAITING_FINAL_CONFIRM"].includes(task.status))
            .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))))
        }
      } catch {
        // 全局同步提醒短暂不可用时不阻断本地业务，下一轮自动重试。
      } finally {
        if (active) timer = window.setTimeout(refreshSyncAttention, 10000)
      }
    }
    refreshSyncAttention()
    return () => {
      active = false
      if (timer) window.clearTimeout(timer)
    }
  }, [isLoggedIn, currentUser?.id, currentUser?.role])

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

  useEffect(() => {
    const canInspectSupervisionMonitor = isLoggedIn && [USER_ROLES.INFORMATION_CLERK, USER_ROLES.ADMIN].includes(currentUser?.role)
    if (!canInspectSupervisionMonitor) {
      queueMicrotask(() => setSupervisionMonitorWarning(""))
      return undefined
    }
    let active = true
    let timer
    const refreshMonitorStatus = async () => {
      try {
        const status = await getSupervisionMonitorStatus()
        if (!active) return
        const now = Date.now()
        const staleAfterMs = Math.max(Number(status?.intervalMs || 30000) * 6, 90000)
        const lastSuccessAt = Date.parse(status?.lastSuccessAt || "")
        const startedAt = Date.parse(status?.startedAt || "")
        const startupExpired = Number.isFinite(startedAt) && now - startedAt > staleAfterMs
        const isStale = Number.isFinite(lastSuccessAt)
          ? now - lastSuccessAt > staleAfterMs
          : startupExpired

        if (!status?.enabled) {
          setSupervisionMonitorWarning("督办监测未启动，请联系信息员检查后台服务")
        } else if (status?.lastErrorCode === "RECLOUD_LOGIN_REQUIRED") {
          setSupervisionMonitorWarning("瑞云登录已失效，督办提醒暂时中断，请联系信息员重新登录")
        } else if (status?.lastErrorCode) {
          setSupervisionMonitorWarning("督办监测出现异常，系统正在自动重试，请联系信息员检查")
        } else if (isStale) {
          setSupervisionMonitorWarning("督办监测长时间未成功检查，请联系信息员检查后台服务")
        } else {
          setSupervisionMonitorWarning("")
        }
      } catch {
        // 状态接口短暂不可用时保留上次结果，避免网络抖动反复提示。
      } finally {
        if (active) timer = window.setTimeout(refreshMonitorStatus, 30000)
      }
    }
    refreshMonitorStatus()
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
    setSupervisionMonitorWarning("")
    setSyncAttentionTasks([])

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
    setSupervisionMonitorWarning("")

  }





  function setPage(nextPage, options = {}) {


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

    if (nextPage === "repairReports") {
      setSelectedInformationReportRmaNo(String(options.initialRmaNo || "").trim())
    }


    setPageState(nextPage)


  }

  function openSupervisionInbox(rmaNo = "") {
    setPage("home")
    setSupervisionTargetRmaNo(String(rmaNo || ""))
    setSupervisionOpenKey((current) => current + 1)
  }

  function openRepairOrderFromSyncTask(rmaNo = "") {
    const order = findRepairOrderByCrmOrderNo(String(rmaNo || "").trim())
    if (!order) {
      setPermissionMessage("没有找到该同步任务对应的本地工单")
      return
    }
    setCurrentRepairOrderId(order.id)
    setPage(pageForRepairStatus(order.status))
  }

  function openInformationReport(rmaNo = "") {
    setPage("repairReports", { initialRmaNo: rmaNo })
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
            currentUser={currentUser}
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

        {page === "repairDecision" && (
          <RepairDecision setPage={setPage} />
        )}

        {page === "repairCompletion" && (
          <RepairCompletion setPage={setPage} />
        )}

        {page === "adminRepairRecovery" && (
          <AdminRepairRecovery setPage={setPage} />
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

          <RepairHistoryLookup setPage={setPage} />

        )}

        {page === "machineTracking" && (
          <MachineTracking setPage={setPage} />
        )}

        {page === "repairReports" && (
          <InformationRepairReports setPage={setPage} initialRmaNo={selectedInformationReportRmaNo} />
        )}

        {page === "exceptionCenter" && (
          <InformationExceptionCenter setPage={setPage} onOpenReport={openInformationReport} />
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
          <SyncTasks setPage={setPage} onOpenOrder={openRepairOrderFromSyncTask} />
        )}

        {page === "syncDiagnostics" && (
          <SyncDiagnostics setPage={setPage} />
        )}

        {page === "accountManagement" && (
          <AccountManagement setPage={setPage} />
        )}




      </main>

      {supervisionMonitorWarning && (
        <div className="global-monitor-warning" role="status">
          <b>督办监测状态</b>
          <span>{supervisionMonitorWarning}</span>
        </div>
      )}

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

      {currentUser?.role === USER_ROLES.ADMIN && syncAttentionTasks.length > 0 && page !== "syncTasks" && (
        <button
          type="button"
          className={`global-sync-alert${supervisionUnreadCount > 0 ? " with-supervision" : ""}`}
          onClick={() => setPage("syncTasks")}
          aria-label={`查看${syncAttentionTasks.length}个待处理同步任务`}
        >
          <span>
            <b>同步任务待处理 · {syncAttentionTasks[0]?.rmaNo || "待查看"}</b>
            <small>人工复核、执行失败或等待最终确认</small>
          </span>
          <strong>{syncAttentionTasks.length > 99 ? "99+" : syncAttentionTasks.length}</strong>
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
