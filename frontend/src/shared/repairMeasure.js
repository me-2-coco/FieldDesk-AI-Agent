function cleanPartName(value) {
  return String(value || "").trim().replace(/^售后/, "")
}

export function buildRepairMeasure(template, usedParts = [], reportedFault = "", detectedFault = "") {
  if (!template) return ""
  const faultPrefix = String(reportedFault || "机器故障").trim().replace(/#+$/, "")
  const partNames = [...new Set(
    usedParts.map((part) => cleanPartName(part.partName)).filter(Boolean)
  )]
  const partsText = partNames.join("，")
  const detectedFaultText = String(detectedFault || "").trim() || partsText || "故障部件"
  let description

  if (template.includes("故障未复现")) {
    description = `机器正常使用，客诉故障未复现，清理，测试ok寄回`
  } else if (template.includes("客户弃修")) {
    description = `客诉故障复现，检测${detectedFaultText}不良，客户弃修，清理，寄回`
  } else if (template.includes("检测报告") || template.includes("只检测")) {
    description = `客诉故障复现，检测${detectedFaultText}不良，客户机无法使用，只检测不维修，清理，寄回`
  } else if (template.includes("调试")) {
    description = `机器正常使用，客诉故障未复现，清理，测试ok寄回`
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
