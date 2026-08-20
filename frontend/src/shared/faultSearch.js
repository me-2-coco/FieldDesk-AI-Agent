export function getPreferredFaultKeyword(parts = [], reportedFault = "") {
  const partName = String(parts?.[0]?.name || parts?.[0]?.partName || "").trim()
  if (!partName) return String(reportedFault || "").trim()

  return partName
    .replace(/(?:主机|总成|组件)$/u, "")
    .trim() || partName
}

function normalizeFaultText(value) {
  return String(value || "")
    .replace(/[\s，。；、/()（）&]+/gu, "")
    .replace(/不工作/gu, "不转")
    .replace(/电机/gu, "")
    .trim()
}

function similarityScore(left, right) {
  const a = normalizeFaultText(left)
  const b = normalizeFaultText(right)
  if (!a || !b) return 0
  if (a.includes(b) || b.includes(a)) return 50
  const chars = new Set(a)
  return [...new Set(b)].filter((char) => chars.has(char)).length
}

export function rankFaultOptions(options = [], { reportedFault = "", parts = [] } = {}) {
  const partKeyword = normalizeFaultText(getPreferredFaultKeyword(parts))
  return [...options].sort((left, right) => {
    const score = (item) => {
      const levels = String(item || "").split("/").map((value) => value.trim())
      const level2 = levels[1] || ""
      const level3 = levels[2] || ""
      const partScore = partKeyword && normalizeFaultText(level3).includes(partKeyword) ? 100 : 0
      return partScore + similarityScore(level2, reportedFault)
    }
    return score(right) - score(left)
  })
}
