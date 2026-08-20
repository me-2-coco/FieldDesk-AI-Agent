const API_BASE_URL = String(
  import.meta.env.VITE_API_BASE_URL || "http://localhost:3000"
).replace(/\/$/, "")
let API_ACCESS_TOKEN = ""

export function setApiAccessToken(value) {
  API_ACCESS_TOKEN = String(value || "")
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

async function request(path, body) {
  let response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(body)
    })
  } catch {
    throw new Error("无法连接 FieldDesk 后端，请确认 API 已启动")
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

async function get(path) {
  let response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { headers: apiHeaders() })
  } catch {
    throw new Error("无法连接 FieldDesk 后端，请确认 API 已启动")
  }
  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.success) {
    throw new Error(result?.message || `请求失败（${response.status}）`)
  }
  return result.data
}

export async function queryCrmOrderByLogisticsNo(logisticsNo) {
  const value = String(logisticsNo || "").trim()
  if (!value) throw new Error("请输入物流单号")

  return request("/api/crm/repairs/query", {
    logisticsNo: value
  })
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

export async function checkInspectionWarranty(payload) {
  return request("/api/repairs/inspection/warranty-check", payload)
}

export async function searchRecloudFaultCategories(payload) {
  const keyword = encodeURIComponent(String(payload?.faultKeyword || "").trim())
  const local = await get(`/api/recloud/fault-catalog?keyword=${keyword}&limit=80`)
  if (local.items?.length || local.complete) return local
  const live = await request("/api/crm/repairs/detection-form/inspect", payload)
  return {
    source: "RECLOUD_LIVE_AND_CACHED",
    syncedAt: new Date().toISOString(),
    items: live.inspection?.faultOptions || []
  }
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

export async function getLocalInventory() {
  return get("/api/inventory")
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
  return get("/api/recloud-sync/tasks")
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
