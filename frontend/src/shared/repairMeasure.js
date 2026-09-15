function cleanPartName(value) {
  return String(value || "").trim().replace(/^售后\s*/, "")
}

export function buildRepairMeasure(template, usedParts = [], reportedFault = "", detectedFault = "") {
  if (!template) return ""
  if (!String(reportedFault || "").trim()) return ""
  const faultPrefix = String(reportedFault).trim().replace(/#+$/, "")
  const withReportedFault = (description) => `${faultPrefix}# ${description}`
  const quantities = new Map()
  for (const part of usedParts) {
    const name = cleanPartName(part.partName)
    if (!name) continue
    const quantity = Number(part.quantity ?? 1)
    quantities.set(name, (quantities.get(name) || 0) + (Number.isInteger(quantity) && quantity > 0 ? quantity : 1))
  }
  const partNames = [...quantities.keys()]
  const partsText = partNames.map(name => quantities.get(name) > 1 ? `${name}${quantities.get(name)}个` : name).join("、")
  const detectedFaultText = String(detectedFault || "").trim() || partsText || "故障部件"
  let description

  if (template.includes("故障未复现")) {
    description = withReportedFault("机器正常使用，客诉故障未复现，清理，测试ok寄回")
  } else if (template.includes("客户弃修")) {
    description = withReportedFault(`客诉故障复现，检测${detectedFaultText}不良，客户弃修，清理，寄回`)
  } else if (template.includes("检测报告") || template.includes("只检测")) {
    description = withReportedFault(`客诉故障复现，检测${detectedFaultText}不良，客户机无法使用，只检测不维修，清理，寄回`)
  } else if (template.includes("调试")) {
    description = withReportedFault("机器正常使用，客诉故障未复现，清理，测试ok寄回")
  } else if (partsText) {
    description = withReportedFault(`客诉故障复现，检测${partsText}不良，更换${partsText}，清理，测试ok寄回`)
  } else {
    description = withReportedFault(template)
  }

  if (partNames.some((name) => name.includes("充电母端子组件"))) {
    description += "，充电母端子组件已打胶"
  }
  return description
}
