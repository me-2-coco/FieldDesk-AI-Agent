import { useEffect, useState } from "react"
import {
  captureRecloudSyncDiagnostic,
  getRecloudSyncDiagnostics
} from "../shared/crmService.js"

const STATUS_LABELS = {
  UNCONFIGURED: "未配置",
  WAITING_CAPTURE: "待采集",
  CAPTURED: "已采集",
  READY: "可联调",
  FAILED: "联调失败"
}

const EMPTY_FORM = {
  entryFeatures: "",
  httpMethod: "POST",
  urlPathTemplate: "",
  requestFieldNames: "",
  responseStatus: "200",
  responseFieldNames: "",
  successCriteriaFieldNames: "",
  idempotencyFieldNames: "",
  enumStatusValues: ""
}

function splitNames(value) {
  return String(value || "").split(/[,，\n]/).map((item) => item.trim()).filter(Boolean)
}

function hasMetadata(form) {
  return [
    form.entryFeatures,
    form.urlPathTemplate,
    form.requestFieldNames,
    form.responseFieldNames,
    form.successCriteriaFieldNames,
    form.idempotencyFieldNames,
    form.enumStatusValues
  ].some((value) => String(value || "").trim())
}

function capturePayload(form) {
  return {
    entryFeatures: splitNames(form.entryFeatures),
    httpMethod: form.httpMethod,
    urlPathTemplate: form.urlPathTemplate,
    requestFieldNames: splitNames(form.requestFieldNames),
    responseStatus: Number(form.responseStatus),
    responseFieldNames: splitNames(form.responseFieldNames),
    successCriteriaFieldNames: splitNames(form.successCriteriaFieldNames),
    idempotencyFieldNames: splitNames(form.idempotencyFieldNames),
    enumStatusValues: splitNames(form.enumStatusValues)
  }
}

function SyncDiagnostics({ setPage }) {
  const [nodes, setNodes] = useState([])
  const [forms, setForms] = useState({})
  const [message, setMessage] = useState("")

  async function refresh() {
    try { setNodes(await getRecloudSyncDiagnostics()) }
    catch (error) { setMessage(error.message) }
  }

  useEffect(() => {
    let active = true
    getRecloudSyncDiagnostics()
      .then((data) => active && setNodes(data))
      .catch((error) => active && setMessage(error.message))
    return () => { active = false }
  }, [])

  function formFor(nodeKey) { return forms[nodeKey] || EMPTY_FORM }
  function update(nodeKey, field, value) {
    setForms((current) => ({
      ...current,
      [nodeKey]: { ...(current[nodeKey] || EMPTY_FORM), [field]: value }
    }))
  }

  async function capture(nodeKey) {
    const form = formFor(nodeKey)
    try {
      await captureRecloudSyncDiagnostic(nodeKey, capturePayload(form))
      setMessage("只读结构元数据已保存")
      await refresh()
    } catch (error) { setMessage(error.message) }
  }

  async function captureAll() {
    const pending = nodes.filter((node) => hasMetadata(formFor(node.nodeKey)))
    if (!pending.length) {
      setMessage("没有可保存的元数据，五个节点保持待采集")
      return
    }
    try {
      await Promise.all(pending.map((node) =>
        captureRecloudSyncDiagnostic(node.nodeKey, capturePayload(formFor(node.nodeKey)))
      ))
      setMessage(`已批量保存 ${pending.length} 个节点的只读元数据`)
      await refresh()
    } catch (error) { setMessage(error.message) }
  }
  const readyCount = nodes.filter((node) => ["READY", "CAPTURED"].includes(node.status)).length
  const attentionCount = nodes.length - readyCount

  return <div className="page sync-diagnostics-page">
    <div className="top-bar">
      <button className="arrow-back" onClick={() => setPage("profile")}>←</button>
      <div><small>系统管理</small><h1>同步检查</h1></div>
    </div>
    <div className="backoffice-metric-grid diagnostic-metric-grid">
      <div><span>同步节点</span><strong>{nodes.length}</strong></div>
      <div><span>已就绪</span><strong>{readyCount}</strong></div>
      <div><span>待处理</span><strong>{attentionCount}</strong></div>
    </div>
    <div className="card backoffice-intro-card diagnostic-intro-card">
      <span className="backoffice-intro-icon">同</span><div><strong>只读结构检查</strong><p>仅保存入口特征、路径模板和字段名称，不记录客户资料、凭据或完整 URL。</p></div>
      <button type="button" onClick={captureAll}>一次保存五节点元数据</button>
    </div>
    <div className="diagnostic-node-list compact-result-list">{nodes.map((node) => {
      const form = formFor(node.nodeKey)
      return <details className="card compact-record-card diagnostic-node-card" key={node.nodeKey}>
        <summary><span className="compact-record-main"><small>同步节点</small><strong>{node.label}</strong><em>{node.missingFields.length ? `缺少 ${node.missingFields.length} 项配置` : "配置完整"}</em></span><span className={`record-status status-${String(node.status).toLowerCase()}`}>{STATUS_LABELS[node.status] || node.status}</span><b>⌄</b></summary>
        <div className="diagnostic-rule-summary"><p><strong>缺少配置</strong>{node.missingFields.length ? node.missingFields.join("、") : "无"}</p><p><strong>待确认规则</strong>{node.unresolvedRules.join("、") || "无"}</p></div>
        <div className="diagnostic-form-grid">
        <input value={form.entryFeatures} onChange={(event) => update(node.nodeKey, "entryFeatures", event.target.value)} placeholder="入口特征名称，逗号分隔" />
        <select value={form.httpMethod} onChange={(event) => update(node.nodeKey, "httpMethod", event.target.value)}>
          {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => <option key={method}>{method}</option>)}
        </select>
        <input value={form.urlPathTemplate} onChange={(event) => update(node.nodeKey, "urlPathTemplate", event.target.value)} placeholder="脱敏路径模板，如 /api/rma/{id}" />
        <input value={form.requestFieldNames} onChange={(event) => update(node.nodeKey, "requestFieldNames", event.target.value)} placeholder="请求字段名称" />
        <input value={form.responseStatus} onChange={(event) => update(node.nodeKey, "responseStatus", event.target.value)} placeholder="响应状态码" />
        <input value={form.responseFieldNames} onChange={(event) => update(node.nodeKey, "responseFieldNames", event.target.value)} placeholder="响应字段名称" />
        <input value={form.successCriteriaFieldNames} onChange={(event) => update(node.nodeKey, "successCriteriaFieldNames", event.target.value)} placeholder="成功判断字段名称" />
        <input value={form.idempotencyFieldNames} onChange={(event) => update(node.nodeKey, "idempotencyFieldNames", event.target.value)} placeholder="幂等查询字段名称" />
        <input value={form.enumStatusValues} onChange={(event) => update(node.nodeKey, "enumStatusValues", event.target.value)} placeholder="枚举/状态值（禁止录入业务数据）" />
        </div><button type="button" onClick={() => capture(node.nodeKey)}>保存该节点</button>
      </details>
    })}</div>
    {message && <p className="inline-status" role="status">{message}</p>}
  </div>
}

export default SyncDiagnostics
