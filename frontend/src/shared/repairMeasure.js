function cleanPartName(value) {
  return String(value || "").trim().replace(/^售后/, "")
}

export function buildRepairMeasure(template, usedParts = [], reportedFault = "") {
  if (!template) return ""
  const faultPrefix = String(reportedFault || "机器故障").trim().replace(/#+$/, "")
  const partNames = [...new Set(
    usedParts.map((part) => cleanPartName(part.partName)).filter(Boolean)
  )]
  const partsText = partNames.join("，")
  let description

  if (template.includes("故障未复现")) {
    description = `${faultPrefix}# 客诉故障未复现，清理，测试ok寄回`
  } else if (template.includes("客户弃修")) {
    description = partsText
      ? `${faultPrefix}# 客诉故障复现，检测${partsText}不良，客户弃修，清理，寄回`
      : `${faultPrefix}# 客诉故障复现，客户弃修，清理，寄回`
  } else if (partsText) {
    description = `${faultPrefix}# 客诉故障复现，检测${partsText}不良，更换${partsText}，清理，测试ok寄回`
  } else {
    description = `${faultPrefix}# ${template}`
  }

  if (partNames.some((name) => name.includes("充电母端子组件"))) {
    description += "，充电母端子组件已打胶"
  }
  return description
}
