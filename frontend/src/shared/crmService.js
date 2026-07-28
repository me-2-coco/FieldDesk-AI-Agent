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
