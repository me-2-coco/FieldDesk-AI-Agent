import { useEffect, useRef, useState } from "react"
import { enterApp, exitApp } from "./shared/appNavigation.js"

import Login from "./pages/Login.jsx"
import Home from "./pages/Home.jsx"
import Repair from "./pages/Repair.jsx"
import RepairWork from "./pages/RepairWork.jsx"
import RepairProcess from "./pages/RepairProcess.jsx"
import PartsApplication from "./pages/PartsApplication.jsx"
import RepairDecision from "./pages/RepairDecision.jsx"
import RepairWarranty from "./pages/RepairWarranty.jsx"
import RepairCompletion from "./pages/RepairCompletion.jsx"
import ReturnShipping from "./pages/ReturnShipping.jsx"
import RepairFinish from "./pages/RepairFinish.jsx"
import RepairHistoryLookup from "./pages/RepairHistoryLookup.jsx"
import MachineTracking from "./pages/MachineTracking.jsx"
import InformationRepairReports from "./pages/InformationRepairReports.jsx"
import InformationExceptionCenter from "./pages/InformationExceptionCenter.jsx"
import WarrantyConversionApprovals from "./pages/WarrantyConversionApprovals.jsx"
import Inventory from "./pages/Inventory.jsx"
import Warehouse from "./pages/Warehouse.jsx"
import Profile from "./pages/Profile.jsx"
import SyncTasks from "./pages/SyncTasks.jsx"
import SyncDiagnostics from "./pages/SyncDiagnostics.jsx"
import AccountManagement from "./pages/AccountManagement.jsx"
import AdminRepairRecovery from "./pages/AdminRepairRecovery.jsx"
import PrintManagement from "./pages/PrintManagement.jsx"

import BottomNav from "./components/BottomNav.jsx"
import NotificationCenter from "./components/NotificationCenter.jsx"

import {
  canAccessPage,
  getCurrentUser,
  isWorkflowRestrictedTechnician,
  setAuthenticatedUser,
  USER_ROLES
} from "./shared/userStore.js"
import { hasBusinessRole } from "./shared/accountAccessPolicy.js"
import {
  getMyRepairSyncAlerts,
  getLocalRepairState,
  getRecloudSyncTasks,
  getInformationExceptions,
  getSupervisionInbox,
  getSupervisionMonitorStatus,
  logoutFieldDeskAccount,
  setApiAccessToken
} from "./shared/crmService.js"
import {
  findRepairOrderByCrmOrderNo,
  getCurrentRepairOrder,
  removeDeletedRepairOrder,
  setCurrentRepairOrderId
} from "./shared/repairOrderStore.js"
import { isTechnicianWorkflowLocked, pageForRepairStatus, resumePageForLocalWorkflow } from "./shared/repairNavigation.js"

import "./App.css"
import "./step-headings.css"


function App() {


  const [isLoggedIn, setIsLoggedIn] = useState(
    localStorage.getItem("isLoggedIn") === "true"
  )


  const [currentUser, setCurrentUser] = useState(() =>
    getCurrentUser()
  )


  const [page, setPageState] = useState("home")
  const appTrail = useRef([])
  const [activeTab, setActiveTab] = useState("home")
  const [tabSnapshots, setTabSnapshots] = useState({})
  const tabScroll = useRef({})


  const [permissionMessage, setPermissionMessage] =
    useState("")

  const [supervisionUnreadCount, setSupervisionUnreadCount] = useState(0)
  const [supervisionOpenKey, setSupervisionOpenKey] = useState(0)
  const [latestSupervision, setLatestSupervision] = useState(null)
  const [supervisionTargetRmaNo, setSupervisionTargetRmaNo] = useState("")
  const [recloudLoginWarning, setRecloudLoginWarning] = useState("")
  const [supervisionMonitorWarning, setSupervisionMonitorWarning] = useState("")
  const [syncAttentionTasks, setSyncAttentionTasks] = useState([])
  const [mySyncAlerts, setMySyncAlerts] = useState([])
  const [partsShortageNotices, setPartsShortageNotices] = useState([])
  const [selectedInformationReportRmaNo, setSelectedInformationReportRmaNo] = useState("")

  const currentRepairOrder = getCurrentRepairOrder()
  const workflowRestricted = isWorkflowRestrictedTechnician(currentUser)
  const workflowLocked = workflowRestricted
    && isTechnicianWorkflowLocked(currentRepairOrder)
  const notificationUserId = String(currentUser?.id || "anonymous")

  useEffect(() => {
    const handleDeletedOrder = (event) => {
      if (!event.detail?.removedCurrent) return
      appTrail.current = []
      tabScroll.current = {}
      setTabSnapshots({})
      setActiveTab("orders")
      setPageState("repair")
      setPermissionMessage("已清理失效工单页面，可以继续处理其他工单")
    }
    window.addEventListener("fielddesk-order-deleted", handleDeletedOrder)
    return () => window.removeEventListener("fielddesk-order-deleted", handleDeletedOrder)
  }, [])

  const activeRmaNo = currentRepairOrder?.crmOrderNo
  const activeWorkflowLocked = isTechnicianWorkflowLocked(currentRepairOrder)
  useEffect(() => {
    if (!isLoggedIn || !activeRmaNo || !activeWorkflowLocked) return
    let active = true
    let busy = false
    const verify = async () => {
      if (busy) return
      busy = true
      try {
        const result = await getLocalRepairState(activeRmaNo)
        if (active && result?.rmaNo === activeRmaNo && result.exists === false
          && getCurrentRepairOrder()?.crmOrderNo === activeRmaNo) {
          removeDeletedRepairOrder(activeRmaNo)
        }
      } catch {
        // Network, permission and server errors are not proof of deletion.
      } finally { busy = false }
    }
    verify()
    const timer = window.setInterval(verify, 10000)
    window.addEventListener("focus", verify)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener("focus", verify)
    }
  }, [isLoggedIn, activeRmaNo, activeWorkflowLocked, currentUser?.id, page])

  useEffect(() => {
    if (!isLoggedIn || !workflowRestricted) return
    const activeOrder = getCurrentRepairOrder()
    if (!isTechnicianWorkflowLocked(activeOrder) || page !== "home") return
    queueMicrotask(() => {
      setActiveTab("orders")
      setPageState(resumePageForLocalWorkflow(activeOrder) || pageForRepairStatus(activeOrder.status))
      setPermissionMessage("当前工单尚未形成处理结果，请先完成或暂存本单")
    })
  }, [isLoggedIn, workflowRestricted, page])

  useEffect(() => {
    const handleExpiredSession = () => {
      setAuthenticatedUser(null)
      setIsLoggedIn(false)
      setPageState("home")
      setPermissionMessage("登录状态已失效，请重新登录")
    }
    window.addEventListener("fielddesk-auth-expired", handleExpiredSession)
    return () => window.removeEventListener("fielddesk-auth-expired", handleExpiredSession)
  }, [])

  useEffect(() => {
    if (!isLoggedIn) {
      queueMicrotask(() => setMySyncAlerts([]))
      return undefined
    }
    let active = true
    let timer
    const refreshMySyncAlerts = async () => {
      try {
        const alerts = await getMyRepairSyncAlerts()
        if (active) setMySyncAlerts(Array.isArray(alerts) ? alerts : [])
      } catch {
        // 监测接口瞬时失败时保留上一条提醒，下一轮继续恢复。
      } finally {
        if (active) timer = window.setTimeout(refreshMySyncAlerts, 10000)
      }
    }
    refreshMySyncAlerts()
    return () => {
      active = false
      if (timer) window.clearTimeout(timer)
    }
  }, [isLoggedIn, currentUser?.id])

  useEffect(() => {
    const canMonitorSync = isLoggedIn && hasBusinessRole(currentUser, USER_ROLES.ADMIN)
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
  }, [isLoggedIn, currentUser])

  useEffect(() => {
    const canReceiveSupervision = isLoggedIn && hasBusinessRole(currentUser, USER_ROLES.TECHNICIAN, USER_ROLES.ADMIN)
    if (!canReceiveSupervision) return undefined
    let active = true
    let timer
    let busy = false
    const refresh = async () => {
      if (busy) return
      busy = true
      if (timer) window.clearTimeout(timer)
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
        busy = false
        if (active) timer = window.setTimeout(refresh, 10000)
      }
    }
    refresh()
    window.addEventListener("supervision-read-changed", refresh)
    return () => {
      active = false
      if (timer) window.clearTimeout(timer)
      window.removeEventListener("supervision-read-changed", refresh)
    }
  }, [isLoggedIn, currentUser])

  useEffect(() => {
    const canInspectSupervisionMonitor = isLoggedIn && hasBusinessRole(currentUser, USER_ROLES.INFORMATION_CLERK, USER_ROLES.ADMIN)
    if (!canInspectSupervisionMonitor) {
      queueMicrotask(() => {
        setRecloudLoginWarning("")
        setSupervisionMonitorWarning("")
      })
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
          setRecloudLoginWarning("")
          setSupervisionMonitorWarning("督办监测未启动，请联系信息员检查后台服务")
        } else if (status?.lastErrorCode === "RECLOUD_LOGIN_REQUIRED") {
          setRecloudLoginWarning("瑞云登录已失效，请联系信息员重新登录")
          setSupervisionMonitorWarning("督办单监测已失效，恢复瑞云登录后系统会自动重试")
        } else if (status?.lastErrorCode) {
          setRecloudLoginWarning("")
          setSupervisionMonitorWarning("督办监测出现异常，系统正在自动重试，请联系信息员检查")
        } else if (isStale) {
          setRecloudLoginWarning("")
          setSupervisionMonitorWarning("督办监测长时间未成功检查，请联系信息员检查后台服务")
        } else {
          setRecloudLoginWarning("")
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
  }, [isLoggedIn, currentUser])

  useEffect(() => {
    const canReceivePartsShortage = isLoggedIn && currentUser?.role === USER_ROLES.INFORMATION_CLERK
    if (!canReceivePartsShortage) {
      queueMicrotask(() => setPartsShortageNotices([]))
      return undefined
    }
    let active = true
    let timer
    const refresh = async () => {
      try {
        const items = await getInformationExceptions()
        if (active) setPartsShortageNotices((items || []).filter((item) => [
          "PARTS_SHORTAGE_PENDING",
          "INSPECTION_ONLY_ADDRESS_AND_SUBMIT_PENDING",
        ].includes(item.type)))
      } catch {
        // 通知接口短暂不可用时保留上次结果，下一轮自动重试。
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
    appTrail.current = []
    setTabSnapshots({})
    tabScroll.current = {}
    setActiveTab("home")

    setCurrentUser(user)

    localStorage.setItem("isLoggedIn", "true")
    localStorage.setItem("currentUserId", user.id)

    setIsLoggedIn(true)

    setPageState("home")

    setPermissionMessage("")

    setSupervisionUnreadCount(0)
    setLatestSupervision(null)
    setSupervisionMonitorWarning("")
    setSyncAttentionTasks([])
    setPartsShortageNotices([])

  }




  async function handleLogout() {
    appTrail.current = []
    setTabSnapshots({})
    tabScroll.current = {}
    setActiveTab("home")

    await logoutFieldDeskAccount().catch(() => {})

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





  function switchTab(tab) {
    if (tab === activeTab) return
    if (workflowLocked && tab === "home") { setPermissionMessage("当前工单处理完成或暂存后才能返回首页"); return }
    const target = tabSnapshots[tab] || { page: tab, trail: [] }
    if (!canAccessPage(target.page, getCurrentUser())) return
    tabScroll.current[activeTab] = window.scrollY
    const previousTab = { page, trail: [...appTrail.current] }
    setTabSnapshots(previous => ({ ...previous, [activeTab]: previousTab }))
    appTrail.current = [...target.trail]
    setPermissionMessage("")
    setActiveTab(tab)
    setPageState(target.page)
    requestAnimationFrame(() => window.scrollTo(0, tabScroll.current[tab] || 0))
  }

  function setPage(nextPage, options = {}) {
    if (nextPage === "appBack") {
      const expanded = [...document.querySelectorAll(".tab-surface:not([hidden]) .page details[open]")].at(-1)
      if (expanded) { expanded.open = false; return }
    }
    const returning = nextPage === "appBack"
    const destination = returning ? exitApp(appTrail.current, page) : null
    if (returning) nextPage = destination.page


   const latestUser = getCurrentUser()



    if (!latestUser) {

      setPageState("login")

      return

    }

    setCurrentUser(latestUser)

    const activeOrder = getCurrentRepairOrder()
    if (isWorkflowRestrictedTechnician(latestUser) && isTechnicianWorkflowLocked(activeOrder)) {
      if (nextPage === "home") {
        setPermissionMessage("当前工单必须先完成、弃修、调试、只检测、转寄总部或暂存，才能返回首页")
        return
      }
      if (nextPage === "repair" && !options.withinApp) {
        setPermissionMessage("")
        setPageState(resumePageForLocalWorkflow(activeOrder) || pageForRepairStatus(activeOrder.status))
        return
      }
    }



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


    appTrail.current = returning ? destination.trail : enterApp(appTrail.current, page, nextPage)
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

    <div className={`app role-${String(currentUser?.role || "guest").trim().toLowerCase()}`}>


      <main className="app-content">
        {Object.entries({ ...tabSnapshots, [activeTab]: { page } }).map(([tab, snapshot]) => {
          const page = snapshot.page
          return <div className="tab-surface" key={`${currentUser?.id}:${tab}`} hidden={tab !== activeTab}>



        {permissionMessage && (

          <div className="permission-message">

            {permissionMessage}

          </div>

        )}




        {page === "orders" && <Home key="orders" setPage={setPage} currentUser={currentUser} ordersHub />}
        {page === "home" && (

          <Home
            setPage={setPage}
            currentUser={currentUser}
            supervisionOpenKey={supervisionOpenKey}
            supervisionUnreadCount={supervisionUnreadCount}
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

        {page === "repairWarranty" && (
          <RepairWarranty setPage={setPage} />
        )}

        {page === "repairCompletion" && (
          <RepairCompletion setPage={setPage} currentUser={currentUser} />
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
          <MachineTracking setPage={setPage} currentUser={currentUser} />
        )}

        {page === "repairReports" && (
          <InformationRepairReports setPage={setPage} initialRmaNo={selectedInformationReportRmaNo} />
        )}

        {page === "exceptionCenter" && (
          <InformationExceptionCenter setPage={setPage} onOpenReport={openInformationReport} />
        )}

        {page === "warrantyApprovals" && (
          <WarrantyConversionApprovals setPage={setPage} />
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
            onProfileChange={setCurrentUser}
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

        {page === "printManagement" && (
          <PrintManagement setPage={setPage} />
        )}




          </div>
        })}
      </main>

      <NotificationCenter
        key={notificationUserId}
        userId={notificationUserId}
        operations={mySyncAlerts}
        tasks={hasBusinessRole(currentUser, USER_ROLES.ADMIN) ? syncAttentionTasks : []}
        shortages={currentUser?.role === USER_ROLES.INFORMATION_CLERK ? partsShortageNotices : []}
        supervisionCount={supervisionUnreadCount}
        latestSupervision={latestSupervision}
        warnings={[recloudLoginWarning, supervisionMonitorWarning].filter(Boolean)}
        onRepair={openRepairOrderFromSyncTask}
        onSync={() => setPage("syncTasks")}
        onShortage={() => setPage("exceptionCenter")}
        onSupervision={() => openSupervisionInbox(latestSupervision?.rmaNo)}
      />





      <BottomNav

        page={activeTab}

        setPage={switchTab}

        supervisionUnreadCount={supervisionUnreadCount}

        onOpenSupervision={() => openSupervisionInbox(latestSupervision?.rmaNo)}

        workflowLocked={workflowLocked}

      />



    </div>

  )


}



export default App
