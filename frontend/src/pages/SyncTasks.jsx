import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { getRecloudSyncTasks, retryRecloudSyncTask, getRepairSyncStatus, reconcileServiceOrderNotCreated, reconcileReceiptConfirmed } from "../shared/crmService.js"

const NODE_LABELS = {
  RECEIPT: "签收",
  INSPECTION_COMPLETED: "检测完成",
  REPAIR_COMPLETED: "维修完工",
  RETURN_SHIPPED: "返件发货",
  ORDER_COMPLETED: "工单完结"
}

const STATUS_LABELS = {
  PENDING: "等待执行",
  PROCESSING: "执行中",
  SUCCESS: "同步完成",
  FAILED: "执行失败",
  MANUAL_REVIEW: "需要人工复核",
  READY_DRY_RUN: "演练检查通过",
  AWAITING_FINAL_CONFIRM: "等待最终确认",
  CANCELLED: "工单恢复后已撤销"
}

const STATUS_HINTS = {
  PENDING: "任务正在排队，系统会自动执行。",
  PROCESSING: "系统正在核对瑞云远端状态，请勿重复操作。",
  SUCCESS: "该节点已完成远端复核。",
  FAILED: "本次执行失败；可由管理员重新执行。",
  MANUAL_REVIEW: "检测到远端数据冲突，需要管理员核对后再继续。",
  READY_DRY_RUN: "页面结构和业务资料已通过演练，尚未写入瑞云。",
  AWAITING_FINAL_CONFIRM: "配件、维修字段和附件均已复核，最终确认仍未点击。",
  CANCELLED: "管理员恢复了工单处理方式，本次旧同步任务已停止。"
}

const REPAIR_STEP_LABELS = {
  PARTS_VERIFIED: "更换配件已核对",
  FIELDS_VERIFIED: "维修字段已核对",
  ATTACHMENTS_VERIFIED: "完工附件已核对"
}

const REVIEW_STEP_LABELS = {
  FORM: "维修字段",
  PARTS: "更换配件",
  ATTACHMENTS: "完工附件"
}

const ACTIONABLE_STATUSES = new Set(["FAILED", "MANUAL_REVIEW", "READY_DRY_RUN", "AWAITING_FINAL_CONFIRM"])
const PAGE_SIZE = 30

function isStoppedHandoff(task) {
  return task.status === "SUCCESS"
    && ["AWAITING_PARTS", "AWAITING_INFORMATION_CLERK"].includes(task.resultStatus)
}

function SyncTasks({ setPage, onOpenOrder }) {
  const [tasks, setTasks] = useState([])
  const [message, setMessage] = useState("")
  const [statusNotice, setStatusNotice] = useState("")
  const [lastRefreshedAt, setLastRefreshedAt] = useState("")
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState("")
  const [creationStatus, setCreationStatus] = useState(null)
  const [confirmedEmpty, setConfirmedEmpty] = useState(false)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [recoveryMessage, setRecoveryMessage] = useState("")
  const [statusFilter, setStatusFilter] = useState("ACTIONABLE")
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE)
  const statusSnapshotRef = useRef(new Map())
  const initializedRef = useRef(false)
  const refreshingRef = useRef(false)

  const refresh = useCallback(async ({ showLoading = false, announce = false } = {}) => {
    if (refreshingRef.current) return
    try {
      refreshingRef.current = true
      if (showLoading) setLoading(true)
      const nextTasks = await getRecloudSyncTasks()
      const nextSnapshot = new Map(nextTasks.map((task) => [task.id, task.status]))
      if (initializedRef.current) {
        const changes = nextTasks.flatMap((task) => {
          const previousStatus = statusSnapshotRef.current.get(task.id)
          if (!previousStatus) return [`${task.rmaNo || "新任务"}：已进入${STATUS_LABELS[task.status] || task.status}`]
          if (previousStatus === task.status) return []
          return [`${task.rmaNo || "同步任务"}：${STATUS_LABELS[previousStatus] || previousStatus} → ${STATUS_LABELS[task.status] || task.status}`]
        })
        if (changes.length) setStatusNotice(changes.slice(0, 3).join("；"))
        else if (announce) setStatusNotice("同步任务状态已刷新，当前没有变化")
      }
      statusSnapshotRef.current = nextSnapshot
      initializedRef.current = true
      setTasks(nextTasks)
      setLastRefreshedAt(new Date().toLocaleTimeString())
      setMessage("")
    } catch (error) {
      setMessage(error.message)
    } finally {
      refreshingRef.current = false
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const initialTimer = window.setTimeout(() => refresh({ showLoading: true }), 0)
    const timer = window.setInterval(() => refresh(), 5000)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    const timer = window.setTimeout(() => setVisibleLimit(PAGE_SIZE), 0)
    return () => window.clearTimeout(timer)
  }, [keyword, statusFilter])

  const filteredTasks = useMemo(() => {
    const normalizedKeyword = keyword.trim().toUpperCase()
    return [...tasks]
      .sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")))
      .filter((task) => !normalizedKeyword || String(task.rmaNo || "").toUpperCase().includes(normalizedKeyword))
      .filter((task) => statusFilter === "ALL" || ACTIONABLE_STATUSES.has(task.status))
  }, [tasks, keyword, statusFilter])

  const visibleTasks = filteredTasks.slice(0, visibleLimit)
  const actionableCount = tasks.filter((task) => ACTIONABLE_STATUSES.has(task.status)).length
  const successCount = tasks.filter((task) => task.status === "SUCCESS").length
  const processingCount = tasks.filter((task) => ["PENDING", "PROCESSING"].includes(task.status)).length

  async function retry(taskId) {
    try {
      await retryRecloudSyncTask(taskId)
      setMessage("任务已重新加入同步队列")
      await refresh({ announce: true })
    } catch (error) {
      setMessage(error.message)
    }
  }

  async function checkCreation() {
    setRecoveryBusy(true)
    setCreationStatus(null)
    setConfirmedEmpty(false)
    try {
      const result = await getRepairSyncStatus(keyword.trim().toUpperCase())
      setCreationStatus(result)
      setRecoveryMessage(`维修建单状态：${result.recloudServiceOrderSyncStatus}`)
    } catch (error) { setRecoveryMessage(error.message) }
    finally { setRecoveryBusy(false) }
  }

  async function recoverCreation() {
    if (!confirmedEmpty || recoveryBusy || creationStatus?.rmaNo !== keyword.trim().toUpperCase()) return
    setRecoveryBusy(true)
    try {
      const result = await reconcileServiceOrderNotCreated(creationStatus.rmaNo)
      setRecoveryMessage(result.message)
      setCreationStatus(null)
      setConfirmedEmpty(false)
    } catch (error) { setRecoveryMessage(error.message) }
    finally { setRecoveryBusy(false) }
  }

  async function recoverReceipt() {
    if (recoveryBusy || creationStatus?.rmaNo !== keyword.trim().toUpperCase()) return
    if (!window.confirm(`请确认已核对瑞云 ${creationStatus.rmaNo}，SN ${creationStatus.sn} 对应行已显示“已签收”。恢复只继续后续同步，不重复签收。`)) return
    setRecoveryBusy(true)
    try {
      const result = await reconcileReceiptConfirmed(creationStatus.rmaNo, creationStatus.sn)
      setRecoveryMessage(result.message)
      setCreationStatus(null)
    } catch (error) { setRecoveryMessage(error.message) }
    finally { setRecoveryBusy(false) }
  }

  return <div className="page sync-tasks-page">
    <div className="top-bar">
      <button className="arrow-back" onClick={() => setPage("appBack")}>←</button>
      <div><small>系统管理</small><h1>瑞云同步</h1></div>
    </div>
    <div className="backoffice-metric-grid sync-metric-grid">
      <div><span>待处理</span><strong>{actionableCount}</strong></div>
      <div><span>执行中</span><strong>{processingCount}</strong></div>
      <div><span>已完成</span><strong>{successCount}</strong></div>
    </div>
    <div className="card sync-control-card compact-search-card">
      <div className="section-title-row"><div><small>任务筛选</small><h2>同步任务</h2></div><button type="button" className="mini-refresh-button" onClick={() => refresh({ showLoading: true, announce: true })} disabled={loading}>刷新</button></div>
      <input
        id="sync-task-search"
        value={keyword}
        onChange={(event) => { setKeyword(event.target.value); setCreationStatus(null); setConfirmedEmpty(false); setRecoveryMessage("") }}
        placeholder="输入完整或部分寄修单号"
      />
      <div className="segmented-control" aria-label="任务范围">
        <button type="button" className={statusFilter === "ACTIONABLE" ? "active" : ""} onClick={() => setStatusFilter("ACTIONABLE")}>只看待处理</button>
        <button type="button" className={statusFilter === "ALL" ? "active" : ""} onClick={() => setStatusFilter("ALL")}>全部历史任务</button>
      </div>
      <p className="compact-result-count">按寄修单号筛选 · 共 {filteredTasks.length} 个任务{lastRefreshedAt ? ` · ${lastRefreshedAt} 更新` : ""}</p>
      <p className="sync-safety-hint">系统只刷新任务状态，不会自动点击最终确认。</p>
      <button type="button" disabled={recoveryBusy || !/^JXTH\d+$/i.test(keyword.trim())} onClick={checkCreation}>核对维修建单状态</button>
      {creationStatus?.recloudServiceOrderSyncStatus === "RESULT_UNKNOWN" && <div className="inline-notice-card">
        <p>请先在瑞云核对 {creationStatus.rmaNo} 的维修单栏。只有确认没有生成维修单，才能恢复；已有单号时禁止重复创建。</p>
        <label><input type="checkbox" checked={confirmedEmpty} onChange={(event) => setConfirmedEmpty(event.target.checked)} />已核对瑞云维修单栏为空</label>
        <button type="button" disabled={!confirmedEmpty || recoveryBusy} onClick={recoverCreation}>确认未建单并恢复</button>
      </div>}
      {creationStatus?.recloudReceiptSyncStatus === "RESULT_UNKNOWN" && <div className="inline-notice-card">
        <p>签收结果未知。先在瑞云核对 {creationStatus.rmaNo} / SN {creationStatus.sn}，不得在仍待签收时使用此操作。</p>
        <button type="button" disabled={recoveryBusy} onClick={recoverReceipt}>已核对瑞云已签收，恢复后续同步</button>
      </div>}
      {recoveryMessage && <p role="status">{recoveryMessage}</p>}
    </div>
    {statusNotice && <div className="inline-notice-card" role="status">
      <strong>同步状态更新</strong>
      <p>{statusNotice}</p>
      <button type="button" onClick={() => setStatusNotice("")}>×</button>
    </div>}
    {loading && <p>正在读取同步任务...</p>}
    {!loading && tasks.length === 0 && <p>暂无同步任务</p>}
    {!loading && tasks.length > 0 && filteredTasks.length === 0 && <p>当前筛选条件下没有同步任务</p>}
    <div className="compact-result-list sync-task-list">{visibleTasks.map((task) => <details className={`card compact-record-card sync-task-card status-${String(task.status || "").toLowerCase()}`} key={task.id}>
      <summary><span className="compact-record-main"><small>{NODE_LABELS[task.nodeType] || task.nodeType}</small><strong>{task.rmaNo || "未关联寄修单"}</strong><em>{STATUS_HINTS[task.status] || "请查看任务状态后决定下一步。"}</em></span><span className="record-status">{STATUS_LABELS[task.status] || task.status}</span><b>⌄</b></summary>
      <div className="compact-record-detail sync-task-detail">
        <div><small>重试次数</small><strong>{task.retryCount}</strong></div>
        <div><small>错误分类</small><strong>{task.errorCategory || "无"}</strong></div>
        <div><small>创建时间</small><strong>{new Date(task.createdAt).toLocaleString()}</strong></div>
      </div>
      {task.nodeType === "REPAIR_COMPLETED" && Array.isArray(task.completedSteps) && task.completedSteps.length > 0 && (
        <div className="sync-step-summary">
          <p>已完成步骤：</p>
          <ul>
            {task.completedSteps.map((step) => <li key={step}>{REPAIR_STEP_LABELS[step] || step}</li>)}
          </ul>
        </div>
      )}
      {task.nodeType === "REPAIR_COMPLETED" && Array.isArray(task.reviewSteps) && task.reviewSteps.length > 0 && (
        <p>需复核阶段：{task.reviewSteps.map((step) => REVIEW_STEP_LABELS[step] || step).join("、")}</p>
      )}
      {task.lastError && <p className="compact-error-detail">最后错误：{task.lastError}</p>}
      {(task.reconciliationRequired || task.errorCategory === "RESULT_UNKNOWN") && (
        <p role="alert">上次提交结果未知，已隔离此单，不能直接重复提交。系统会对支持的节点进行只读核对；未能确认时需要负责人复核。
          {task.reconciliationStatus === "CHECK_FAILED" && " 最近一次核对失败，稍后再检查。"}
          {task.reconciliationStatus === "NOT_CONFIRMED" && " 尚未取得可确认成功的依据。"}
        </p>
      )}
      <div className="compact-action-row">
      {task.rmaNo && typeof onOpenOrder === "function" && (
        <button type="button" className="secondary-btn" onClick={() => onOpenOrder(task.rmaNo)}>
          打开对应工单
        </button>
      )}
      {!task.reconciliationRequired && task.errorCategory !== "RESULT_UNKNOWN" && (["FAILED", "MANUAL_REVIEW", "READY_DRY_RUN"].includes(task.status) || isStoppedHandoff(task)) && (
        <button type="button" onClick={() => retry(task.id)}>
          {isStoppedHandoff(task) ? "重新核对瑞云状态" : task.status === "READY_DRY_RUN" ? "重新核对并执行" : "人工重试"}
        </button>
      )}
      </div>
    </details>)}</div>
    {visibleTasks.length < filteredTasks.length && (
      <button type="button" className="secondary-btn" onClick={() => setVisibleLimit((current) => current + PAGE_SIZE)}>
        再显示 {Math.min(PAGE_SIZE, filteredTasks.length - visibleTasks.length)} 个
      </button>
    )}
    {message && <p className="inline-status" role="status">{message}</p>}
  </div>
}

export default SyncTasks
