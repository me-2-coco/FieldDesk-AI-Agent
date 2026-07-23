import {
  createRepairOrder,
  findRepairOrderByLogisticsNo,
  setCurrentRepairOrderId
} from "./repairOrderStore.js"

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
    throw new Error(result?.message || `CRM 请求失败（${response.status}）`)
  }
  return result.data
}

function toRepairOrder(data, logisticsNo) {
  const isDryRun = data.receipt?.dryRun !== false
  return {
    crmOrderNo: data.crmOrderNo || data.rmaNo || "",
    logisticsNo: data.logisticsNo || logisticsNo,
    customer: data.customer || "",
    phone: data.phone || "",
    address: data.address || "",
    product: data.product || data.productType || "",
    model: data.model || "",
    sn: data.sn || "",
    originalFault: data.originalFault || "",
    warrantyType: data.warrantyType || "待确认",
    status: isDryRun ? "待签收" : "待维修",
    statusReason: isDryRun
      ? "DRY_RUN：已填写 SN 和备注，尚未确认签收"
      : "瑞云 CRM 已确认签收",
    crmSyncStatus: isDryRun ? "待确认" : "已同步",
    crmSyncMessage:
      data.receipt?.message ||
      (isDryRun ? "DRY_RUN：未确认签收" : "签收完成")
  }
}

export async function queryCrmOrderByLogisticsNo(logisticsNo) {
  const value = String(logisticsNo || "").trim()
  if (!value) throw new Error("请输入物流单号")

  const existingOrder = findRepairOrderByLogisticsNo(value)
  if (existingOrder) {
    setCurrentRepairOrderId(existingOrder.id)
    return { source: "local", isNew: false, order: existingOrder }
  }

  const crmOrder = await request("/api/crm/repairs/receive", {
    logisticsNo: value
  })
  const newOrder = createRepairOrder(toRepairOrder(crmOrder, value))
  return { source: "recloud-crm", isNew: true, order: newOrder }
}

export async function queryCrmRepair(logisticsNo) {
  return request("/api/crm/repairs/query", { logisticsNo })
}

export async function receiveCrmRepair(logisticsNo, sn, remark) {
  return request("/api/crm/repairs/receive", { logisticsNo, sn, remark })
}
