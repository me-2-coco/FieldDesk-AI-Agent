import { useCallback, useEffect, useState } from "react"
import { getLocalRepairOrders, getShippingOrders, getSystemHealth, getTechnicianWorkloads, getWarrantyConversionRequests } from "../shared/crmService.js"
import { findRepairOrderByCrmOrderNo, getCurrentRepairOrder, REPAIR_STATUS, saveCurrentRepairOrder } from "../shared/repairOrderStore.js"
import { pageForRepairStatus, repairStatusForLocalWorkflow, resumePageForLocalWorkflow } from "../shared/repairNavigation.js"
import { USER_ROLES } from "../shared/userStore.js"
import { buildTechnicianDirectory, categorizeTechnicianWorkflows, technicianWorkloadStatusLabel } from "../shared/homeWorkload.js"
import SupervisionInbox from "../components/SupervisionInbox.jsx"
import DailyWorkloadBoard from "../components/DailyWorkloadBoard.jsx"
import MonthlyStatistics from "../components/MonthlyStatistics.jsx"
import HomeTodos from "../components/HomeTodos.jsx"
import { AppIcon } from "../components/AppIcons.jsx"
import "../home-desktop.css"

const COMPLETED_WORKFLOW_STATUSES = new Set(["REPAIR_COMPLETED_PENDING_SHIPMENT", "SHIPPED_PENDING_COMPLETION", "COMPLETED"])

function fullLocalPhone(workflow) {
  const directPhone = String(workflow.phone || "").trim()
  if (/^1[3-9]\d{9}$/.test(directPhone)) return directPhone
  const savedPhone = String(findRepairOrderByCrmOrderNo(workflow.rmaNo)?.phone || "").trim()
  if (/^1[3-9]\d{9}$/.test(savedPhone)) return savedPhone
  return workflow.phoneMasked || directPhone || "电话未记录"
}

function Home({ setPage, currentUser, ordersHub = false, supervisionOpenKey = 0, supervisionTargetRmaNo = "" }) {
  const [desktopView, setDesktopView] = useState("desktop")
  useEffect(() => {
    if (supervisionOpenKey) queueMicrotask(() => setDesktopView("messages"))
  }, [supervisionOpenKey])
  const [order, setOrder] = useState(() => getCurrentRepairOrder())
  const [resumeError, setResumeError] = useState("")
  const [todoError, setTodoError] = useState("")
  const [backgroundShippingCount, setBackgroundShippingCount] = useState(0)
  const [pendingWarrantyCount, setPendingWarrantyCount] = useState(0)
  const [workflows, setWorkflows] = useState([])
  const [technicians, setTechnicians] = useState([])
  const [selectedTechnicianId, setSelectedTechnicianId] = useState("")
  const [technicianSearch, setTechnicianSearch] = useState("")
  const [technicianLoadError, setTechnicianLoadError] = useState("")
  const [detailStatus, setDetailStatus] = useState("")
  const [liveSyncEnabled, setLiveSyncEnabled] = useState(null)
  const [boardNow, setBoardNow] = useState(() => new Date())
  const [workloadLoading, setWorkloadLoading] = useState(true)
  const isTechnician = currentUser?.role === USER_ROLES.TECHNICIAN
  const isWarehouse = currentUser?.role === USER_ROLES.WAREHOUSE
  const isAdmin = currentUser?.role === USER_ROLES.ADMIN
  const isInformationClerk = currentUser?.role === USER_ROLES.INFORMATION_CLERK
  const nextPage = pageForRepairStatus(order?.status)

  useEffect(() => {
    let active = true
    getSystemHealth().then((health) => {
      if (!active) return
      setLiveSyncEnabled(Boolean(
        health.receiptWriteEnabled
        || health.inspectionWriteEnabled
        || health.holdWriteEnabled
        || health.completionWriteEnabled
      ))
    }).catch(() => active && setLiveSyncEnabled(null))
    return () => { active = false }
  }, [])

  const restoreLocalOrder = useCallback((workflow, targetPage = resumePageForLocalWorkflow(workflow)) => {
    const restoredParts = workflow.repairCompletion?.usedParts?.length
      ? workflow.repairCompletion.usedParts
      : Array.isArray(workflow.partApplications)
        ? workflow.partApplications
        : []
    const restored = saveCurrentRepairOrder({
      id: `RMA-${workflow.rmaNo}`,
      crmOrderNo: workflow.rmaNo,
      logisticsNo: workflow.logisticsNo || "",
      customer: workflow.customerName || "",
      phone: fullLocalPhone(workflow),
      address: workflow.customerAddress || workflow.regionAddress || "",
      product: workflow.productLine || workflow.specialty || "",
      model: workflow.productLine || workflow.specialty || "",
      sn: workflow.sn || "",
      projectCode: workflow.recloudProjectCode || workflow.projectCode || "",
      warrantyType: workflow.technicianWarranty || workflow.warrantyType || "",
      warrantyDecision: workflow.warrantyDecision || null,
      manufacturerWarrantyConversion: workflow.manufacturerWarrantyConversion || null,
      originalFault: workflow.reportedFault || "",
      inspectionResult: workflow.inspectionResult || "",
      inspectionRemark: workflow.inspectionRemark || "",
      crmFault: workflow.faultCategory || "",
      level3Fault: workflow.faultCategory || "",
      treatmentMode: workflow.treatmentMode || "",
      treatmentLabel: workflow.treatmentLabel || "",
      inspectionFaultOutcome: workflow.inspectionFaultOutcome || "",
      resumeStep: targetPage,
      specialty: workflow.specialty || workflow.productLine || "",
      receiptRemark: workflow.remark || "",
      technician: workflow.technicianName || workflow.operatorName || "",
      usedParts: restoredParts,
      parts: restoredParts,
      attachments: workflow.repairCompletion?.attachments || [],
      photos: workflow.repairCompletion?.attachments || [],
      solution: workflow.repairCompletion?.repairMeasure || "",
      status: COMPLETED_WORKFLOW_STATUSES.has(workflow.status)
        ? repairStatusForLocalWorkflow(workflow.status)
        : targetPage === "repairCompletion"
          ? REPAIR_STATUS.REPAIRING
          : targetPage === "repairProcess" && workflow.faultCategory
            ? REPAIR_STATUS.INSPECTION_COMPLETE
            : repairStatusForLocalWorkflow(workflow.status),
      createdAt: workflow.createdAt || "",
      completedAt: workflow.completedAt || ""
    })
    setOrder(restored)
    return restored
  }, [])

  async function syncCurrentProgress({ navigate = false } = {}) {
    if (!order?.crmOrderNo) return
    try {
      const rows = await getLocalRepairOrders()
      const workflow = rows.find((item) => item.rmaNo === order.crmOrderNo)
      if (!workflow?.receiptCompletedAt) {
        if (navigate) setPage(nextPage)
        return
      }
      const targetPage = resumePageForLocalWorkflow(workflow)
      const restored = restoreLocalOrder(workflow, targetPage)
      setResumeError("")
      if (navigate) setPage(targetPage || pageForRepairStatus(restored.status))
    } catch (error) {
      setResumeError(error.message)
      if (navigate) setPage(nextPage)
    }
  }

  useEffect(() => {
    const rmaNo = order?.crmOrderNo
    if (!rmaNo) return undefined
    let active = true
    const timer = window.setTimeout(async () => {
      try {
        const rows = await getLocalRepairOrders()
        if (!active) return
        const workflow = rows.find((item) => item.rmaNo === rmaNo)
        if (!workflow?.receiptCompletedAt) return
        restoreLocalOrder(workflow, resumePageForLocalWorkflow(workflow))
        setResumeError("")
      } catch (error) {
        if (active) setResumeError(error.message)
      }
    }, 0)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [order?.crmOrderNo, restoreLocalOrder])

  useEffect(() => {
    if (!isTechnician && !isInformationClerk && !isAdmin) return undefined
    let active = true
    let busy = false
    async function refresh() {
      if (busy) return
      busy = true
      try {
        const data = isTechnician ? { orders: await getLocalRepairOrders(), technicians: [] } : await getTechnicianWorkloads()
        if (!active) return
        setTechnicians(Array.isArray(data?.technicians) ? data.technicians : [])
        setWorkflows(Array.isArray(data?.orders) ? data.orders : [])
        setTechnicianLoadError("")
      } catch (error) {
        if (!active) return
        setTechnicianLoadError(error.message)
      } finally {
        busy = false
        if (active) { setWorkloadLoading(false); setBoardNow(new Date()) }
      }
    }
    refresh()
    const timer = window.setInterval(() => { setBoardNow(new Date()); refresh() }, 30000)
    window.addEventListener("focus", refresh)
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", refresh) }
  }, [isTechnician, isInformationClerk, isAdmin, currentUser?.id])

  useEffect(() => {
    if (!isInformationClerk && !isAdmin) return undefined
    let active = true
    getShippingOrders()
      .then((rows) => active && setBackgroundShippingCount(rows.length))
      .catch(() => active && setBackgroundShippingCount(0))
    return () => { active = false }
  }, [isInformationClerk, isAdmin])

  useEffect(() => {
    if (!isInformationClerk && !isAdmin) return undefined
    let active = true
    getWarrantyConversionRequests()
      .then((rows) => active && setPendingWarrantyCount((rows || []).filter((item) => item.status === "PENDING_APPROVAL").length))
      .catch(() => active && setPendingWarrantyCount(0))
    return () => { active = false }
  }, [isInformationClerk, isAdmin])

  const technicianOrderFinished = isTechnician && [
    REPAIR_STATUS.ON_HOLD,
    REPAIR_STATUS.TRANSFERRED_TO_HEADQUARTERS,
    REPAIR_STATUS.REPAIR_COMPLETED_PENDING_SHIPMENT,
    REPAIR_STATUS.SHIPPED_PENDING_COMPLETION,
    REPAIR_STATUS.COMPLETED
  ].includes(order?.status)
  const roleName = isAdmin ? "管理员" : isWarehouse ? "库房" : isInformationClerk ? "信息员" : "维修师傅"
  const accountName = currentUser?.name || "未识别"
  const canViewTechnicians = isInformationClerk || isAdmin
  const technicianDirectory = buildTechnicianDirectory(technicians, workflows)
  const searchedTechnicians = technicianDirectory.filter(item => item.displayName.toLocaleLowerCase().includes(technicianSearch.trim().toLocaleLowerCase()))
  const selectedTechnician = technicianDirectory.find((item) => item.userId === selectedTechnicianId) || null
  const visibleWorkflows = isTechnician
    ? workflows.filter(item => (item.technicianId || item.operatorId) === (currentUser?.userId || currentUser?.id))
    : selectedTechnicianId
      ? workflows.filter((item) => (item.technicianId || item.operatorId) === selectedTechnicianId)
      : []
  const showTechnicianDashboard = isTechnician || Boolean(selectedTechnician)
  const workload = categorizeTechnicianWorkflows(visibleWorkflows)
  const completedOrders = workload.completed
  const unfinished = workload.unfinished
  const waitingMaterial = [...new Map([...workload.waitingMaterial, ...visibleWorkflows.filter(o => o.partsShortage?.status === "PENDING_INFORMATION")].map(o => [o.rmaNo, o])).values()]
  const outOfWarranty = workload.outOfWarranty
  const otherHeld = workload.otherHeld
  const detailOrders = detailStatus === "unfinished"
    ? unfinished
    : detailStatus === "waiting"
      ? waitingMaterial
      : detailStatus === "outOfWarranty"
        ? outOfWarranty
        : detailStatus === "held"
          ? otherHeld
          : detailStatus === "completed" ? completedOrders : []
  const workspaceGroups = isWarehouse ? [
    {
      title: "库房作业",
      description: "入库、发放与退件集中处理",
      actions: [
        { page: "warehouse", title: "退件与出入库", description: "确认退件、配件入库和发放", icon: "warehouse" },
        { page: "inventory", title: "库存总览", description: "查看总库、师傅库存与流水", icon: "inventory" }
      ]
    }
  ] : isInformationClerk ? [
    {
      title: "发货与异常",
      description: "优先处理需要跟进的工单",
      actions: [
        { page: "warrantyApprovals", title: "转保申请", description: pendingWarrantyCount ? `${pendingWarrantyCount} 单待申请上传` : "暂无待处理申请", icon: "archive" },
        { page: "returnShipping", title: "后台发货进度", description: backgroundShippingCount ? `${backgroundShippingCount} 单待查看` : "查看待发货和待完结", icon: "shipping" },
        { page: "exceptionCenter", title: "问题工单", description: "集中处理业务异常", icon: "alert" }
      ]
    },
    {
      title: "查询与档案",
      description: "机器状态、维修资料统一查询",
      actions: [
        { page: "machineTracking", title: "机器去向", description: "查询机器当前位置", icon: "tracking" },
        { page: "repairReports", title: "维修档案", description: "查看措施、费用和附件", icon: "archive" },
        { page: "records", title: "历史工单", description: "按条件检索业务记录", icon: "history" }
      ]
    }
  ] : isAdmin ? [
    {
      title: "工单运营",
      description: "处理异常并管理工单状态",
      actions: [
        { page: "adminRepairRecovery", title: "工单恢复", description: "恢复到处理方式选择", icon: "recovery" },
        { page: "warrantyApprovals", title: "转保申请", description: pendingWarrantyCount ? `${pendingWarrantyCount} 单待申请上传` : "暂无待处理申请", icon: "archive" },
        { page: "exceptionCenter", title: "问题工单", description: "查看全局业务异常", icon: "alert" },
        { page: "records", title: "全部工单", description: "查询历史业务记录", icon: "records" }
      ]
    },
    {
      title: "查询与流转",
      description: "掌握机器、档案与发货进度",
      actions: [
        { page: "machineTracking", title: "机器去向", description: "查询机器当前位置", icon: "tracking" },
        { page: "repairReports", title: "维修档案", description: "查看维修资料和附件", icon: "archive" },
        { page: "returnShipping", title: "后台发货进度", description: backgroundShippingCount ? `${backgroundShippingCount} 单待查看` : "查看返件流转", icon: "shipping" }
      ]
    },
    {
      title: "库存与库房",
      description: "总库、师傅库存和退件管理",
      actions: [
        { page: "inventory", title: "库存总览", description: "查看全局库存和流水", icon: "inventory" },
        { page: "warehouse", title: "库房作业", description: "入库、发放与退件确认", icon: "warehouse" }
      ]
    },
    {
      title: "系统管理",
      description: "账号权限与瑞云连接维护",
      actions: [
        { page: "syncTasks", title: "瑞云同步", description: "任务、失败与人工复核", icon: "sync" },
        { page: "syncDiagnostics", title: "同步检查", description: "检查系统连接状态", icon: "diagnostic" },
        { page: "printManagement", title: "打印终端", description: "共享打印机与任务队列", icon: "inventory" },
        { page: "accountManagement", title: "账号管理", description: "维护角色和权限", icon: "accounts" }
      ]
    }
  ] : []

  function openWorkflow(item) {
    const targetPage = resumePageForLocalWorkflow(item)
    const restored = restoreLocalOrder(item, targetPage)
    if (COMPLETED_WORKFLOW_STATUSES.has(item.status)) { setPage("repairCompletion"); return }
    setPage(targetPage || pageForRepairStatus(restored.status))
  }

  function openDesktopView(view) {
    setDesktopView(view)
    setSelectedTechnicianId("")
    setDetailStatus("")
    window.scrollTo({ top: 0, behavior: "instant" })
  }
  function openTodo(item) {
    setTodoError("")
    if (!isTechnician) { setPage(item.group === "warranty" ? "warrantyApprovals" : item.group === "sync" ? "syncTasks" : "exceptionCenter"); return }
    if (item.group === "messages") { openDesktopView("messages"); return }
    const workflow = workflows.find(order => order.rmaNo === item.rmaNo && (order.technicianId || order.operatorId) === (currentUser.userId || currentUser.id))
    if (!workflow) { setTodoError("工单进度正在更新，请稍后重试"); return }
    if (item.group === "shortage" || workflow.status === "ON_HOLD") { openDesktopView("work"); setDetailStatus("waiting"); return }
    openWorkflow(workflow)
  }
  const desktopGroups = ordersHub ? [
    { title: "工单", actions: [
      ...((isAdmin || isTechnician) ? [{ page: "repair", title: "维修", icon: "work", description: "签收、检测、维修与完工" }] : []),
      { page: "records", title: "历史记录", icon: "history", description: "查询历史工单" }
    ] },
    ...workspaceGroups.filter((group) => !["库存与库房", "库房作业", "系统管理"].includes(group.title)).map((group) => ({ ...group, actions: group.actions.filter((action) => action.page !== "records") }))
  ].filter((group) => group.actions.length) : [
    { title: "工作", actions: [
      ...((isAdmin || isTechnician) ? [{ view: "dailyBoard", title: "当日看板", icon: "records" }, { view: "stats", title: "月度统计", icon: "records" }] : []),
      ...(canViewTechnicians ? [{ view: "team", title: "师傅工作台", icon: "accounts" }] : []),
      ...(isTechnician ? [
        { view: "work", title: "师傅工作台", icon: "accounts" },
        { view: "messages", title: "督办消息", icon: "alert" }
      ] : [])
    ] },
  ].filter((group) => group.actions.length)

  return <div className="page home-page home-desktop">
    {desktopView !== "desktop" && <div className="desktop-subpage-heading"><button type="button" onClick={() => detailStatus ? setDetailStatus("") : selectedTechnicianId ? setSelectedTechnicianId("") : openDesktopView("desktop")}>← {detailStatus ? "返回维修概览" : selectedTechnicianId ? "返回师傅列表" : "返回首页"}</button><h1>{({ dailyBoard: "当日看板", team: "师傅工作台", work: "师傅工作台", stats: "月度统计", messages: "督办消息" })[desktopView]}</h1></div>}
    {desktopView === "desktop" && <><div className="card home-identity-card">
      <div className="home-identity-glow" />
      <div className="home-brand-row">
        <div className="home-brand-mark">FD</div>
        <div><span>FieldDesk 工作台</span><h1>{ordersHub ? "维修管理" : "网点维修管理"}</h1></div>
      </div>
      <div className="home-user-panel">
        <div className="home-user-avatar">{accountName.slice(0, 1)}</div>
        <div className="home-user-copy"><span>欢迎回来</span><strong>{accountName}</strong></div>
        <span className="home-role-badge">{roleName}</span>
      </div>
      {isTechnician && <div className="home-specialty-row">
        <span>维修品类</span>
        <div>{(currentUser.repairSpecialties?.length ? currentUser.repairSpecialties : ["未配置"]).map((item) => <strong key={item}>{item}</strong>)}</div>
      </div>}
    </div>
    {ordersHub && <h1>维修管理</h1>}
    <div className="desktop-app-groups">
      {desktopGroups.map((group, groupIndex) => <section className="desktop-app-group" key={group.title}>
        <h2>{group.title}</h2>
        <div className="desktop-app-grid">{group.actions.map((action, index) => <button type="button" className="desktop-app" key={action.page || action.view} title={action.description || action.title} onClick={() => action.view ? openDesktopView(action.view) : setPage(action.page)}>
          <span className={`desktop-app-icon desktop-tone-${(groupIndex + index) % 5}`}><AppIcon name={action.icon} size={27} /></span>
          <span>{action.title}</span>
        </button>)}</div>
      </section>)}
    </div></>}


    {desktopView === "dailyBoard" && !ordersHub && (isAdmin || isTechnician) && <DailyWorkloadBoard orders={workflows} technicians={technicians} user={currentUser} now={boardNow} loading={workloadLoading} error={technicianLoadError} />}
    {desktopView === "team" && canViewTechnicians && !selectedTechnician && <section className="card home-technician-directory">
      <div className="home-section-heading">
        <div><span>人员工作量</span><h2>师傅</h2></div>
        <small>{technicianDirectory.length} 人</small>
      </div>
      <p className="home-technician-hint">选择师傅，查看他名下的在手机器及维修进度。</p>
      <input className="home-technician-search" type="search" aria-label="搜索师傅姓名" placeholder="输入师傅姓名搜索" value={technicianSearch} onChange={event => setTechnicianSearch(event.target.value)} />
      {technicianLoadError && <p className="error-text">师傅数据读取失败：{technicianLoadError}</p>}
      {!technicianLoadError && !technicianDirectory.length && <p className="empty-state">当前没有可查看的师傅账号</p>}
      <div className="home-technician-list">
        {!!technicianDirectory.length && !searchedTechnicians.length && <p className="empty-state">没有找到匹配的师傅，请更换姓名搜索</p>}
        {searchedTechnicians.map((technician) => {
          const rows = workflows.filter((item) => (item.technicianId || item.operatorId) === technician.userId)
          const technicianWorkload = categorizeTechnicianWorkflows(rows)
          return <button type="button" key={technician.userId} onClick={() => { setSelectedTechnicianId(technician.userId); setDetailStatus("") }}>
            <span className="home-technician-avatar">{technician.displayName.slice(0, 1)}</span>
            <span className="home-technician-copy">
              <strong>{technician.displayName}</strong>
              <small>{technician.repairSpecialties.length ? technician.repairSpecialties.join(" + ") : "维修品类未配置"} · {technician.userId}</small>
            </span>
            <span className="home-technician-count"><strong>{technicianWorkload.unfinished.length}</strong><small>台在手</small></span>
            <b>›</b>
          </button>
        })}
      </div>
    </section>}

    {desktopView === "team" && canViewTechnicians && selectedTechnician && <section className="card home-technician-selected">
      <div className="home-technician-profile">
        <span className="home-technician-avatar">{selectedTechnician.displayName.slice(0, 1)}</span>
        <div><span>当前查看师傅</span><strong>{selectedTechnician.displayName}</strong><small>{selectedTechnician.repairSpecialties.length ? selectedTechnician.repairSpecialties.join(" + ") : "维修品类未配置"} · {selectedTechnician.userId}</small></div>
        <em>只读</em>
      </div>
    </section>}

    {desktopView === "work" && isTechnician && <section className="card home-technician-selected"><div className="home-technician-profile">
      <span className="home-technician-avatar">{accountName.slice(0, 1)}</span>
      <div><span>我的工作台</span><strong>{accountName}</strong><small>{(currentUser.repairSpecialties || []).join(" + ")} · {currentUser.userId || currentUser.id}</small></div><em>仅本人</em>
    </div></section>}


    {desktopView === "messages" && isTechnician && <SupervisionInbox openKey={supervisionOpenKey} targetRmaNo={supervisionTargetRmaNo} />}

    {(desktopView === "team" || desktopView === "work") && showTechnicianDashboard && <div className="card">
      <div className="home-section-heading"><div><span>实时工作量</span><h2>维修执行</h2></div><small>手上共 {unfinished.length} 台</small></div>
      <div className="home-workload-grid">
        <button type="button" className={`workload-unfinished ${detailStatus === "unfinished" ? "active" : ""}`} onClick={() => setDetailStatus(detailStatus === "unfinished" ? "" : "unfinished")}><span>未完成维修</span><strong>{unfinished.length}</strong><small>台</small></button>
        <button type="button" className={`workload-waiting ${detailStatus === "waiting" ? "active" : ""}`} onClick={() => setDetailStatus(detailStatus === "waiting" ? "" : "waiting")}><span>待料</span><strong>{waitingMaterial.length}</strong><small>台</small></button>
        <button type="button" className={`workload-out-of-warranty ${detailStatus === "outOfWarranty" ? "active" : ""}`} onClick={() => setDetailStatus(detailStatus === "outOfWarranty" ? "" : "outOfWarranty")}><span>保外</span><strong>{outOfWarranty.length}</strong><small>台</small></button>
        <button type="button" className={`workload-held ${detailStatus === "held" ? "active" : ""}`} onClick={() => setDetailStatus(detailStatus === "held" ? "" : "held")}><span>暂存</span><strong>{otherHeld.length}</strong><small>台</small></button>
        <button type="button" className={`workload-completed ${detailStatus === "completed" ? "active" : ""}`} onClick={() => setDetailStatus(detailStatus === "completed" ? "" : "completed")}><span>维修已完成</span><strong>{completedOrders.length}</strong><small>台</small></button>
      </div>
      {detailStatus && <div className="home-work-order-list">
        <div className="home-list-heading"><strong>{detailStatus === "unfinished" ? "师傅手上未修走的机器" : detailStatus === "waiting" ? "待料工单" : detailStatus === "outOfWarranty" ? "保外暂存工单" : detailStatus === "held" ? "其他暂存工单" : "已完成维修"}</strong><span>{detailOrders.length} 台</span></div>
        {!detailOrders.length && <p>当前没有该状态的机器</p>}
        {!!detailOrders.length && <div className="home-work-order-scroll">
          {detailOrders.map((item) => <button type="button" key={item.rmaNo} className={canViewTechnicians ? "read-only" : ""} onClick={() => isTechnician && item.status !== "ON_HOLD" && openWorkflow(item)} aria-disabled={canViewTechnicians || item.status === "ON_HOLD"}>
            <span className="home-order-main"><strong>{canViewTechnicians ? item.phoneMasked || "电话未记录" : fullLocalPhone(item)}</strong><small>{item.productLine || item.specialty || "品类未记录"} · SN {item.sn || "未记录"}{item.status === "ON_HOLD" && <> · {item.hold?.category || "分类未记录"}/{item.hold?.reason || "原因未记录"}</>}</small></span>
            <span className={`home-order-status ${detailStatus}`}>{technicianWorkloadStatusLabel(item)}</span>{isTechnician && <b>›</b>}
          </button>)}
        </div>}
      </div>}
      {isTechnician && order?.crmOrderNo && !technicianOrderFinished && <>
        <p>当前工单：{order.crmOrderNo}</p>
        <p>当前状态：{order.status || "未提供"}</p>
        <button className="primary-btn" onClick={() => syncCurrentProgress({ navigate: true })}>继续当前工单</button>
        {resumeError && <p className="error-text">进度同步失败：{resumeError}</p>}
      </>}
    </div>}

    {desktopView === "stats" && !ordersHub && (isAdmin || isTechnician) && <MonthlyStatistics />}

    {desktopView === "desktop" && !ordersHub && (isAdmin || isTechnician || isInformationClerk) && <HomeTodos key={currentUser.userId || currentUser.id} technician={isTechnician} onOpen={openTodo} />}
    {todoError && <p className="error-text">{todoError}</p>}

    {liveSyncEnabled === false && <p className="dry-run-notice">当前保持演练模式，本地业务操作不会写入瑞云。</p>}
    {liveSyncEnabled === true && <p className="home-sync-status">● 瑞云后台同步已开启</p>}
  </div>
}

export default Home
