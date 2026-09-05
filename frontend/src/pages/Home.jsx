import { useCallback, useEffect, useState } from "react"
import { getLocalRepairOrders, getShippingOrders, getWarrantyConversionRequests } from "../shared/crmService.js"
import { findRepairOrderByCrmOrderNo, getCurrentRepairOrder, REPAIR_STATUS, saveCurrentRepairOrder } from "../shared/repairOrderStore.js"
import { pageForRepairStatus, repairStatusForLocalWorkflow, resumePageForLocalWorkflow } from "../shared/repairNavigation.js"
import { USER_ROLES } from "../shared/userStore.js"
import SupervisionInbox from "../components/SupervisionInbox.jsx"
import { AppIcon } from "../components/AppIcons.jsx"

const COMPLETED_WORKFLOW_STATUSES = new Set(["REPAIR_COMPLETED_PENDING_SHIPMENT", "SHIPPED_PENDING_COMPLETION", "COMPLETED"])
const WAITING_PART_STATUSES = new Set(["PARTS_REQUESTED", "WAITING_PARTS", "WAITING_PART"])

function localDateKey(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return ""
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function completionDate(order) { return order.repairCompletion?.submittedAt || order.completedAt || "" }
function isAbandoned(order) { return /弃修/.test(`${order.repairCompletion?.repairMeasure || ""} ${order.repairCompletion?.speechTemplate || ""}`) }
function workflowStatusLabel(status) {
  if (COMPLETED_WORKFLOW_STATUSES.has(status)) return "维修已完成"
  if (WAITING_PART_STATUSES.has(status)) return "待料"
  return "维修中"
}

function fullLocalPhone(workflow) {
  const directPhone = String(workflow.phone || "").trim()
  if (/^1[3-9]\d{9}$/.test(directPhone)) return directPhone
  const savedPhone = String(findRepairOrderByCrmOrderNo(workflow.rmaNo)?.phone || "").trim()
  if (/^1[3-9]\d{9}$/.test(savedPhone)) return savedPhone
  return workflow.phoneMasked || directPhone || "电话未记录"
}

function Home({ setPage, currentUser, supervisionOpenKey = 0, supervisionTargetRmaNo = "" }) {
  const [order, setOrder] = useState(() => getCurrentRepairOrder())
  const [resumeError, setResumeError] = useState("")
  const [backgroundShippingCount, setBackgroundShippingCount] = useState(0)
  const [pendingWarrantyCount, setPendingWarrantyCount] = useState(0)
  const [workflows, setWorkflows] = useState([])
  const [statStartDate, setStatStartDate] = useState(() => `${localDateKey(new Date()).slice(0, 7)}-01`)
  const [statEndDate, setStatEndDate] = useState(() => localDateKey(new Date()))
  const [detailStatus, setDetailStatus] = useState("")
  const isTechnician = currentUser?.role === USER_ROLES.TECHNICIAN
  const isWarehouse = currentUser?.role === USER_ROLES.WAREHOUSE
  const isAdmin = currentUser?.role === USER_ROLES.ADMIN
  const isInformationClerk = currentUser?.role === USER_ROLES.INFORMATION_CLERK
  const nextPage = pageForRepairStatus(order?.status)

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
      address: workflow.regionAddress || "",
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
        : targetPage === "repairProcess"
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
    if (!isTechnician && !isAdmin) return undefined
    let active = true
    getLocalRepairOrders().then((rows) => active && setWorkflows(Array.isArray(rows) ? rows : [])).catch(() => active && setWorkflows([]))
    return () => { active = false }
  }, [isTechnician, isAdmin])

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
    REPAIR_STATUS.REPAIR_COMPLETED_PENDING_SHIPMENT,
    REPAIR_STATUS.SHIPPED_PENDING_COMPLETION,
    REPAIR_STATUS.COMPLETED
  ].includes(order?.status)
  const roleName = isAdmin ? "管理员" : isWarehouse ? "库房" : isInformationClerk ? "信息员" : "维修师傅"
  const accountName = currentUser?.name || "未识别"
  const completedOrders = workflows.filter((item) => item.repairCompletion?.submittedAt || COMPLETED_WORKFLOW_STATUSES.has(item.status))
  const waitingParts = workflows.filter((item) => !item.repairCompletion?.submittedAt && resumePageForLocalWorkflow(item) === "partsApplication")
  const unfinished = workflows.filter((item) => item.receiptCompletedAt && !item.repairCompletion?.submittedAt && !COMPLETED_WORKFLOW_STATUSES.has(item.status) && !waitingParts.includes(item))
  const currentMonth = localDateKey(new Date()).slice(0, 7)
  const summarize = (rows) => ({ repaired: rows.filter((item) => !isAbandoned(item)).length, abandoned: rows.filter(isAbandoned).length, total: rows.length })
  const monthSummary = summarize(completedOrders.filter((item) => localDateKey(completionDate(item)).startsWith(currentMonth)))
  const selectedSummary = summarize(completedOrders.filter((item) => {
    const date = localDateKey(completionDate(item))
    return date && (!statStartDate || date >= statStartDate) && (!statEndDate || date <= statEndDate)
  }))
  const detailOrders = detailStatus === "unfinished" ? unfinished : detailStatus === "waiting" ? waitingParts : detailStatus === "completed" ? completedOrders : []
  const quickActions = isTechnician ? [
    { page: "repair", title: "扫码签收", description: "查询物流并开始寄修", icon: "work" },
    { page: "records", title: "工单查询", description: "查找历史工单", icon: "records" },
    { page: "inventory", title: "个人库存", description: "查看配件和流水", icon: "inventory" }
  ] : []
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

  return <div className="page home-page">
    <div className="card home-identity-card">
      <div className="home-identity-glow" />
      <div className="home-brand-row">
        <div className="home-brand-mark">FD</div>
        <div><span>FieldDesk 工作台</span><h1>网点维修管理</h1></div>
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

    {isTechnician && <div className="card home-quick-card">
      <div className="home-section-heading">
        <div><span>{roleName}工作台</span><h2>快捷操作</h2></div>
        <small>{quickActions.length} 个入口</small>
      </div>
      <div className="home-quick-grid">
        {quickActions.map((action) => <button type="button" key={action.page} onClick={() => setPage(action.page)}>
          <span className="home-quick-icon"><AppIcon name={action.icon} size={19} /></span>
          <span className="home-quick-copy"><strong>{action.title}</strong><small>{action.description}</small></span>
          <b>›</b>
        </button>)}
      </div>
    </div>}

    {!isTechnician && <div className="home-workspace-groups">
      <div className="home-workspace-heading">
        <div><span>{roleName}工作台</span><h2>全部功能</h2></div>
        <small>{workspaceGroups.reduce((count, group) => count + group.actions.length, 0)} 项</small>
      </div>
      {workspaceGroups.map((group) => <section className="card home-workspace-card" key={group.title}>
        <div className="home-workspace-group-heading"><div><h3>{group.title}</h3><p>{group.description}</p></div><span>{group.actions.length}</span></div>
        <div className="home-workspace-list">
          {group.actions.map((action) => <button type="button" key={action.page} onClick={() => setPage(action.page)}>
            <span className="home-workspace-icon"><AppIcon name={action.icon} size={20} /></span>
            <span className="home-workspace-copy"><strong>{action.title}</strong><small>{action.description}</small></span>
            <b>›</b>
          </button>)}
        </div>
      </section>)}
    </div>}

    {isTechnician && <SupervisionInbox openKey={supervisionOpenKey} targetRmaNo={supervisionTargetRmaNo} />}

    {isTechnician && <div className="card">
      <div className="home-section-heading"><div><span>实时工作量</span><h2>维修执行</h2></div><small>共 {workflows.length} 台</small></div>
      <div className="home-workload-grid">
        <button type="button" className={`workload-unfinished ${detailStatus === "unfinished" ? "active" : ""}`} onClick={() => setDetailStatus(detailStatus === "unfinished" ? "" : "unfinished")}><span>未完成维修</span><strong>{unfinished.length}</strong><small>台</small></button>
        <button type="button" className={`workload-waiting ${detailStatus === "waiting" ? "active" : ""}`} onClick={() => setDetailStatus(detailStatus === "waiting" ? "" : "waiting")}><span>待料</span><strong>{waitingParts.length}</strong><small>台</small></button>
        <button type="button" className={`workload-completed ${detailStatus === "completed" ? "active" : ""}`} onClick={() => setDetailStatus(detailStatus === "completed" ? "" : "completed")}><span>维修已完成</span><strong>{completedOrders.length}</strong><small>台</small></button>
      </div>
      {detailStatus && <div className="home-work-order-list">
        <div className="home-list-heading"><strong>{detailStatus === "unfinished" ? "未完成维修" : detailStatus === "waiting" ? "待料工单" : "已完成维修"}</strong><span>{detailOrders.length} 台</span></div>
        {!detailOrders.length && <p>当前没有该状态的机器</p>}
        {detailOrders.map((item) => <button type="button" key={item.rmaNo} onClick={() => openWorkflow(item)}>
          <span className="home-order-main"><strong>{fullLocalPhone(item)}</strong><small>{item.productLine || item.specialty || "品类未记录"} · SN {item.sn || "未记录"}</small></span>
          <span className={`home-order-status ${detailStatus}`}>{workflowStatusLabel(item.status)}</span><b>›</b>
        </button>)}
      </div>}
      {order?.crmOrderNo && !technicianOrderFinished && <>
        <p>当前工单：{order.crmOrderNo}</p>
        <p>当前状态：{order.status || "未提供"}</p>
        <button className="primary-btn" onClick={() => syncCurrentProgress({ navigate: true })}>继续当前工单</button>
        {resumeError && <p className="error-text">进度同步失败：{resumeError}</p>}
      </>}
    </div>}

    {isTechnician && <div className="card home-performance-card">
      <div className="home-section-heading"><div><span>{currentMonth.replace("-", "年")}月</span><h2>维修统计</h2></div></div>
      <div className="home-performance-summary">
        <div><span>维修完成</span><strong>{monthSummary.repaired}</strong><small>台</small></div>
        <div><span>弃修</span><strong>{monthSummary.abandoned}</strong><small>台</small></div>
        <div><span>总计</span><strong>{monthSummary.total}</strong><small>台</small></div>
      </div>
      <div className="home-stat-filter">
        <div className="home-filter-heading"><strong>日期范围</strong><span>可筛选任意时间段</span></div>
        <div className="home-filter-controls">
          <label><span>开始日期</span><input type="date" value={statStartDate} max={statEndDate || undefined} onChange={(event) => setStatStartDate(event.target.value)} aria-label="开始日期" /></label>
          <i>至</i>
          <label><span>结束日期</span><input type="date" value={statEndDate} min={statStartDate || undefined} onChange={(event) => setStatEndDate(event.target.value)} aria-label="结束日期" /></label>
        </div>
        <div className="home-filter-result"><span>{statStartDate || "不限"} 至 {statEndDate || "不限"}</span><strong>{selectedSummary.total} 台</strong><small>完成 {selectedSummary.repaired} · 弃修 {selectedSummary.abandoned}</small></div>
      </div>
    </div>}

    <p className="dry-run-notice">当前保持演练模式，本地业务操作不会写入瑞云。</p>
  </div>
}

export default Home
