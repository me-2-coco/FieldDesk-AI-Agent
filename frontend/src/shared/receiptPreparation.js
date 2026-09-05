export function normalizeReceiptSn(value) {
  return String(value || "").trim().toUpperCase()
}

export const REPAIR_SPECIALTIES = ["扫地机", "洗地机"]

export function getAllowedSpecialties(user) {
  const role = String(user?.role || "").trim().toUpperCase()
  if (role === "ADMIN") return [...REPAIR_SPECIALTIES]
  if (role !== "TECHNICIAN") return []
  return Array.isArray(user?.repairSpecialties)
    ? user.repairSpecialties.filter((item) =>
        REPAIR_SPECIALTIES.includes(item)
      )
    : []
}

export function getReceiptSpecialtyGate(user, productLine) {
  const specialties = getAllowedSpecialties(user)
  if (specialties.length === 0) {
    return {
      specialties,
      specialty: "",
      error: "当前账号未配置维修品类，请联系管理员"
    }
  }
  const product = REPAIR_SPECIALTIES.includes(productLine)
    ? productLine
    : ""
  if (product && !specialties.includes(product)) {
    return {
      specialties,
      specialty: "",
      error: `该工单属于${product}，当前账号无维修权限`
    }
  }
  return {
    specialties,
    specialty: specialties.length === 1 ? specialties[0] : "",
    error: ""
  }
}

export function validateReceiptSn(value, logisticsNo = "") {
  const sn = normalizeReceiptSn(value)
  if (!sn) return "SN 不能为空"
  if (!/^[A-Z0-9-]+$/.test(sn)) {
    return "SN 只允许字母、数字和连字符“-”"
  }
  if (/^1[3-9]\d{9}$/.test(sn)) {
    return "扫描内容疑似联系电话，请重新扫描机器 SN"
  }
  const logistics = normalizeReceiptSn(logisticsNo)
  if (
    sn === logistics ||
    /^(SF|YT|JD|ST|ZTO|YTO|EMS)[A-Z0-9-]{6,}$/.test(sn)
  ) {
    return "扫描内容疑似物流单号，请重新扫描机器 SN"
  }
  return ""
}
