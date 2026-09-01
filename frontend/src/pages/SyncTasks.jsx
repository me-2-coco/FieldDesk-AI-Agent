import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { getRecloudSyncTasks, retryRecloudSyncTask } from "../shared/crmService.js"

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
  AWAITING_FINAL_CONFIRM: "等待最终确认"
}

const STATUS_HINTS = {
  PENDING: "任务正在排队，系统会自动执行。",
  PROCESSING: "系统正在核对瑞云远端状态，请勿重复操作。",
  SUCCESS: "该节点已完成远端复核。",
  FAILED: "本次执行失败；可由管理员重新执行。",
  MANUAL_REVIEW: "检测到远端数据冲突，需要管理员核对后再继续。",
  READY_DRY_RUN: "页面结构和业务资料已通过演练，尚未写入瑞云。",
  AWAITING_FINAL_CONFIRM: "配件、维修字段和附件均已复核，最终确认仍未点击。"
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

function SyncTasks({ setPage, onOpenOrder }) {
  const [tasks, setTasks] = useState([])
  const [message, setMessage] = useState("")
  const [statusNotice, setStatusNotice] = useState("")
  const [lastRefreshedAt, setLastRefreshedAt] = useState("")
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState("")
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

  async function retry(taskId) {
    try {
      await retryRecloudSyncTask(taskId)
      setMessage("任务已重新加入同步队列")
      await refresh({ announce: true })
    } catch (error) {
      setMessage(error.message)
    }
  }

  return <div className="page sync-tasks-page">
    <div className="top-bar">
      <button className="arrow-back" onClick={() => setPage("profile")}>←</button>
      <h1>瑞云同步</h1>
    </div>
    <div className="card">
      <p>本地业务不等待瑞云同步。当前安全开关关闭真实写入时使用 DRY_RUN 适配器。</p>
      <p>页面每5秒自动刷新；状态变化会在本页提示，不会自动点击最终确认。</p>
      <button type="button" onClick={() => refresh({ showLoading: true, announce: true })} disabled={loading}>立即刷新</button>
      {lastRefreshedAt && <p>最近刷新：{lastRefreshedAt}</p>}
    </div>
    <div className="card">
      <label htmlFor="sync-task-search">按寄修单号筛选</label>
      <input
        id="sync-task-search"
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
        placeholder="输入完整或部分寄修单号"
      />
      <label htmlFor="sync-status-filter">任务范围</label>
      <select id="sync-status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
        <option value="ACTIONABLE">只看待处理</option>
        <option value="ALL">全部历史任务</option>
      </select>
      <p>共找到 {filteredTasks.length} 个任务，当前显示 {Math.min(visibleTasks.length, filteredTasks.length)} 个。</p>
    </div>
    {statusNotice && <div className="card" role="status">
      <strong>同步状态更新</strong>
      <p>{statusNotice}</p>
      <button type="button" className="secondary-btn" onClick={() => setStatusNotice("")}>知道了</button>
    </div>}
    {loading && <p>正在读取同步任务...</p>}
    {!loading && tasks.length === 0 && <p>暂无同步任务</p>}
    {!loading && tasks.length > 0 && filteredTasks.length === 0 && <p>当前筛选条件下没有同步任务</p>}
    {visibleTasks.map((task) => <div className="card" key={task.id}>
      <h2>{NODE_LABELS[task.nodeType] || task.nodeType}</h2>
      <p>寄修单号：{task.rmaNo || "-"}</p>
      <p>状态：{STATUS_LABELS[task.status] || task.status}</p>
      <p>{STATUS_HINTS[task.status] || "请查看任务状态后决定下一步。"}</p>
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
      <p>重试次数：{task.retryCount}</p>
      <p>错误分类：{task.errorCategory || "无"}</p>
      <p>最后错误：{task.lastError || "无"}</p>
      <p>创建时间：{new Date(task.createdAt).toLocaleString()}</p>
      {task.rmaNo && typeof onOpenOrder === "function" && (
        <button type="button" className="secondary-btn" onClick={() => onOpenOrder(task.rmaNo)}>
          打开对应工单
        </button>
      )}
      {["FAILED", "MANUAL_REVIEW", "READY_DRY_RUN"].includes(task.status) && (
        <button type="button" onClick={() => retry(task.id)}>
          {task.status === "READY_DRY_RUN" ? "重新核对并执行" : "人工重试"}
        </button>
      )}
    </div>)}
    {visibleTasks.length < filteredTasks.length && (
      <button type="button" className="secondary-btn" onClick={() => setVisibleLimit((current) => current + PAGE_SIZE)}>
        再显示 {Math.min(PAGE_SIZE, filteredTasks.length - visibleTasks.length)} 个
      </button>
    )}
    {message && <p role="status">{message}</p>}
  </div>
}

export default SyncTasks
