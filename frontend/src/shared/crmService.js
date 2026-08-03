const API_BASE_URL = String(
  import.meta.env.VITE_API_BASE_URL || "http://localhost:3000"
).replace(/\/$/, "")

async function request(path, body) {
  let response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    response = await fetch(`${API_BASE_URL}${path}`)
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

export async function saveInspection(payload) {
  return request("/api/repairs/inspection", payload)
}

export async function applyLocalPart(payload) {
  return request("/api/repairs/parts/apply", payload)
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

export async function getCurrentFieldDeskUser() {
  return get("/api/auth/me")
}
