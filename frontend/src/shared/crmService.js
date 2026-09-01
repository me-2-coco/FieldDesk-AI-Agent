const API_BASE_URL = String(
  import.meta.env.VITE_API_BASE_URL || "http://localhost:3000"
).replace(/\/$/, "")
let API_ACCESS_TOKEN = ""

export function setApiAccessToken(value) {
  API_ACCESS_TOKEN = String(value || "")
}

export async function loginFieldDeskAccount(userId, password) {
  const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: String(userId || "").trim(), password: String(password || "") })
  }).catch(() => null)
  if (!response) throw new Error("无法连接系统后端，请确认服务已启动")
  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.success) throw new Error(result?.message || "登录失败")
  setApiAccessToken(result.data.sessionToken)
  return result.data
}

function apiHeaders() {
  const localUserId =
    typeof localStorage === "undefined"
      ? ""
      : String(localStorage.getItem("currentUserId") || "")
  return {
    "Content-Type": "application/json",
    ...(API_ACCESS_TOKEN
      ? { Authorization: `Bearer ${API_ACCESS_TOKEN}` }
      : localUserId
        ? { "X-FieldDesk-Local-User": localUserId }
        : {})
  }
}

async function request(path, body, { timeoutMs = 0 } = {}) {
  let response
  const controller = timeoutMs > 0 ? new AbortController() : null
  const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {})
    })
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("线上查询超过25秒，请稍后重试")
    }
    throw new Error("无法连接 FieldDesk 后端，请确认 API 已启动")
  } finally {
    if (timer) window.clearTimeout(timer)
  }

  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.success) {
    const error = new Error(
      result?.message || `CRM 请求失败（${response.status}）`
    )
    error.code = result?.code || "RECLOUD_ERROR"
    error.status = response.status
    throw error
  }
  return result.data
}

async function get(path, { timeoutMs = 0 } = {}) {
  let response
  const controller = timeoutMs > 0 ? new AbortController() : null
  const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers: apiHeaders(),
      ...(controller ? { signal: controller.signal } : {})
    })
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("本地查询超过3秒，请检查 FieldDesk 后端状态")
    }
    throw new Error("无法连接 FieldDesk 后端，请确认 API 已启动")
  } finally {
    if (timer) window.clearTimeout(timer)
  }
  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.success) {
    throw new Error(result?.message || `请求失败（${response.status}）`)
  }
  return result.data
}

async function downloadFile(path, fallbackName) {
  let response
  try { response = await fetch(`${API_BASE_URL}${path}`, { headers: apiHeaders() }) }
  catch { throw new Error("无法连接 FieldDesk 后端，请确认 API 已启动") }
  if (!response.ok) {
    const result = await response.json().catch(() => null)
    throw new Error(result?.message || `附件下载失败（${response.status}）`)
  }
  const disposition = response.headers.get("Content-Disposition") || ""
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const simpleName = disposition.match(/filename="?([^";]+)"?/i)?.[1]
  return {
    blob: await response.blob(),
    name: encodedName ? decodeURIComponent(encodedName) : simpleName || fallbackName
  }
}

export async function queryCrmOrderByLogisticsNo(queryValue) {
  const value = String(queryValue || "").trim()
  if (!value) throw new Error("请输入物流单号、电话、SN或寄修单号")

  return request("/api/crm/repairs/query", {
    queryValue: value
  })
}

export async function queryCrmRepairByAnyIdentifier(queryValue) {
  return queryCrmOrderByLogisticsNo(queryValue)
}

export async function queryCrmRepair(logisticsNo) {
  return request("/api/crm/repairs/query", { logisticsNo })
}

export async function prepareReceipt(payload) {
  return request("/api/repairs/prepare-receipt", payload)
}

export async function cancelReceiptPreparation(rmaNo) {
  return request("/api/repairs/prepare-receipt/cancel", { rmaNo })
}

export async function completeLocalReceipt(rmaNo) {
  return request("/api/repairs/complete-local-receipt", { rmaNo })
}

export async function saveTreatmentDecision(rmaNo, treatmentMode) {
  return request("/api/repairs/treatment-decision", { rmaNo, treatmentMode })
}

export async function getLocalRepairOrders() {
  return get("/api/repairs/local-orders")
}

export async function uploadReceiptAttachment(payload) {
  return request("/api/repairs/receipt/attachments", payload)
}

export async function transferToHeadquarters(rmaNo) {
  return request("/api/repairs/transfer-to-headquarters", { rmaNo })
}

export async function saveInspection(payload) {
  return request("/api/repairs/inspection", payload)
}

export async function getSupervisionOrders(rmaNo) {
  return get(`/api/repairs/supervision?rmaNo=${encodeURIComponent(String(rmaNo || "").trim())}`)
}

export async function getSupervisionInbox() {
  return get("/api/repairs/supervision/inbox")
}

export async function getSupervisionMonitorStatus() {
  return get("/api/supervision/monitor/status")
}

export async function markSupervisionOrderRead(rmaNo, supervisionOrderId) {
  return request("/api/repairs/supervision/read", { rmaNo, supervisionOrderId })
}

export async function syncSupervisionOrders(payload) {
  return request("/api/repairs/supervision/sync", payload)
}

export async function checkInspectionWarranty(payload) {
  return request("/api/repairs/inspection/warranty-check", payload)
}

export async function searchRecloudFaultCategories(payload) {
  const keyword = encodeURIComponent(String(payload?.faultKeyword || "").trim())
  const rmaNo = encodeURIComponent(String(payload?.rmaNo || "").trim())
  const local = await get(`/api/recloud/fault-catalog?keyword=${keyword}&rmaNo=${rmaNo}&limit=80`)
  return local
}

export async function matchInspectionModel(payload) {
  return request("/api/repairs/inspection/model-match", payload)
}

export async function applyLocalPart(payload) {
  return request("/api/repairs/parts/apply", payload)
}

export async function searchPartsCatalog(payload) {
  const rmaNo = encodeURIComponent(String(payload?.rmaNo || "").trim())
  const keyword = encodeURIComponent(String(payload?.keyword || "").trim())
  return get(`/api/parts-catalog?rmaNo=${rmaNo}&keyword=${keyword}`)
}

export async function getRepairParts(rmaNo) {
  return get(`/api/repairs/parts?rmaNo=${encodeURIComponent(String(rmaNo || "").trim())}`)
}

export async function updateRepairPart(payload) {
  return request("/api/repairs/parts/update", payload)
}

export async function confirmRepairParts(rmaNo) {
  return request("/api/repairs/parts/confirm", { rmaNo })
}

export async function getLocalInventory() {
  return get("/api/inventory")
}

export async function receiveInventoryPart(payload) {
  return request("/api/inventory/stock-in", payload)
}

export async function allocateInventoryPart(payload) {
  return request("/api/inventory/allocate", payload)
}

export async function recordLocalPartUse(payload) {
  return request("/api/inventory/use", payload)
}

export async function requestLocalPartReturn(payload) {
  return request("/api/inventory/returns", payload)
}

export async function confirmLocalPartReturn(requestId) {
  return request("/api/inventory/returns/confirm", { requestId })
}

export async function getRepairCompletionContext(rmaNo) {
  return request("/api/repairs/completion/context", { rmaNo })
}

export async function getFaultCatalog() {
  return get("/api/repairs/completion/fault-catalog")
}

export async function uploadRepairAttachment(payload) {
  return request("/api/repairs/completion/attachments", payload)
}

export async function saveRepairCompletionDraft(payload) {
  return request("/api/repairs/completion/draft", payload)
}

export async function submitRepairCompletion(payload) {
  return request("/api/repairs/completion/submit", payload)
}

export async function getShippingOrders() {
  return get("/api/shipping/orders")
}

export async function getShippingContext(rmaNo) {
  return request("/api/shipping/context", { rmaNo })
}

export async function uploadShippingProof(payload) {
  return request("/api/shipping/attachments", payload)
}

export async function submitReturnShipment(payload) {
  return request("/api/shipping/submit", payload)
}

export async function confirmLocalOrderCompletion(rmaNo) {
  return request("/api/shipping/complete", { rmaNo })
}

export async function getRecloudSyncTasks() {
  return get("/api/recloud-sync/tasks", { timeoutMs: 3000 })
}

export async function getRepairSyncOrderStatus(rmaNo) {
  return get(`/api/recloud-sync/order-status?rmaNo=${encodeURIComponent(String(rmaNo || "").trim())}`)
}

export async function getRepairHistoryByPhone(keyword) {
  return get(`/api/repairs/history?keyword=${encodeURIComponent(String(keyword || "").trim())}`, { timeoutMs: 3000 })
}

export async function getRepeatRepairBySn(sn, excludeRmaNo = "") {
  const params = new URLSearchParams({
    sn: String(sn || "").trim(),
    excludeRmaNo: String(excludeRmaNo || "").trim()
  })
  return get(`/api/repairs/repeat-repair?${params.toString()}`, { timeoutMs: 3000 })
}

export async function getMachinesInHand(keyword) {
  return get(`/api/repairs/machines-in-hand?keyword=${encodeURIComponent(String(keyword || "").trim())}`, { timeoutMs: 3000 })
}

export async function getInformationRepairReports(keyword) {
  return get(`/api/information/repair-reports?keyword=${encodeURIComponent(String(keyword || "").trim())}`, { timeoutMs: 3000 })
}

export async function getInformationExceptions() {
  return get("/api/information/exceptions", { timeoutMs: 10000 })
}

export async function getInformationRepairReport(rmaNo) {
  return get(`/api/information/repair-reports/${encodeURIComponent(String(rmaNo || "").trim())}`, { timeoutMs: 3000 })
}

export async function downloadInformationAttachment(rmaNo, attachment) {
  return downloadFile(
    `/api/information/repair-reports/${encodeURIComponent(rmaNo)}/attachments/${encodeURIComponent(attachment.category)}/${encodeURIComponent(attachment.id)}`,
    attachment.name || "attachment"
  )
}

export async function retryRecloudSyncTask(taskId) {
  return request("/api/recloud-sync/tasks/retry", { taskId })
}

export async function getRecloudSyncDiagnostics() {
  return get("/api/recloud-sync/diagnostics")
}

export async function captureRecloudSyncDiagnostic(nodeKey, payload) {
  return request(`/api/recloud-sync/diagnostics/${nodeKey}/capture`, payload)
}

export async function getCurrentFieldDeskUser() {
  return get("/api/auth/me")
}

export async function getAdminUsers() {
  return get("/api/admin/users")
}

export async function saveAdminUser(payload) {
  return request("/api/admin/users", payload)
}
