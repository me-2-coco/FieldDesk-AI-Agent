import { useEffect, useState } from "react"
import { getRecloudSyncTasks, retryRecloudSyncTask } from "../shared/crmService.js"

const NODE_LABELS = {
  RECEIPT: "签收",
  INSPECTION_COMPLETED: "检测完成",
  REPAIR_COMPLETED: "维修完成",
  RETURN_SHIPPED: "返件发货",
  ORDER_COMPLETED: "工单完结"
}

function SyncTasks({ setPage }) {
  const [tasks, setTasks] = useState([])
  const [message, setMessage] = useState("")
  const [loading, setLoading] = useState(true)

  async function refresh() {
    try {
      setLoading(true)
      setTasks(await getRecloudSyncTasks())
      setMessage("")
    } catch (error) {
      setMessage(error.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    getRecloudSyncTasks()
      .then((data) => active && setTasks(data))
      .catch((error) => active && setMessage(error.message))
      .finally(() => active && setLoading(false))
    return () => { active = false }
  }, [])

  async function retry(taskId) {
    try {
      await retryRecloudSyncTask(taskId)
      setMessage("任务已重新加入同步队列")
      await refresh()
    } catch (error) {
      setMessage(error.message)
    }
  }

  return <div className="page sync-tasks-page">
    <div className="top-bar">
      <button className="arrow-back" onClick={() => setPage("profile")}>←</button>
      <h1>瑞云同步任务</h1>
    </div>
    <div className="card">
      <p>本地业务不等待瑞云同步。当前安全开关关闭真实写入时使用 DRY_RUN 适配器。</p>
      <button type="button" onClick={refresh} disabled={loading}>刷新</button>
    </div>
    {loading && <p>正在读取同步任务...</p>}
    {!loading && tasks.length === 0 && <p>暂无同步任务</p>}
    {tasks.map((task) => <div className="card" key={task.id}>
      <h2>{NODE_LABELS[task.nodeType] || task.nodeType}</h2>
      <p>寄修单号：{task.rmaNo || "-"}</p>
      <p>状态：{task.status}</p>
      <p>重试次数：{task.retryCount}</p>
      <p>最后错误：{task.lastError || "无"}</p>
      <p>创建时间：{new Date(task.createdAt).toLocaleString()}</p>
      {["FAILED", "MANUAL_REVIEW"].includes(task.status) && (
        <button type="button" onClick={() => retry(task.id)}>人工重试</button>
      )}
    </div>)}
    {message && <p role="status">{message}</p>}
  </div>
}

export default SyncTasks
