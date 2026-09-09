import { buildTechnicianDirectory, isCompletedWorkflow } from "./homeWorkload.js"

export function shanghaiDay(value = new Date()) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
}
const MODES = { REPAIR: "repair", ABANDONED: "abandoned", DEBUGGING: "debugging", INSPECTION_ONLY: "inspection" }
const emptyCounts = () => ({ repair: 0, abandoned: 0, debugging: 0, inspection: 0, total: 0 })
export function workloadProducts(user) {
  const admin = String(user?.role || "").toLowerCase() === "admin" || user?.accountAuthority === "OWNER"
  return ["扫地机", "洗地机"].filter(product => admin || (user?.repairSpecialties || []).includes(product))
}

export function dailyWorkload({ orders = [], technicians = [], user, day = shanghaiDay() }) {
  const ownId = String(user?.userId || user?.id || "")
  const admin = String(user?.role || "").toLowerCase() === "admin" || user?.accountAuthority === "OWNER"
  const rows = admin ? orders : orders.filter(o => ownId && String(o.technicianId || o.operatorId || "") === ownId)
  const directory = buildTechnicianDirectory(admin ? technicians : [{ userId: ownId, displayName: user?.name || user?.displayName || ownId, repairSpecialties: user?.repairSpecialties || [] }], rows)
  return workloadProducts(user).map(product => {
    const byId = new Map(directory.filter(t => admin ? t.repairSpecialties.includes(product) || rows.some(o => (o.technicianId || o.operatorId) === t.userId && (o.productLine || o.specialty) === product) : t.userId === ownId).map(t => [t.userId, { ...t, ...emptyCounts() }]))
    const seen = new Set()
    for (const o of rows) {
      const mode = MODES[o.treatmentMode]
      const completed = o.repairCompletion?.submittedAt || o.completedAt
      if (!mode || !completed || !isCompletedWorkflow(o) || shanghaiDay(completed) !== day || (o.productLine || o.specialty) !== product) continue
      const id = String(o.technicianId || o.operatorId || "")
      if (!id || !o.rmaNo || seen.has(o.rmaNo)) continue
      seen.add(o.rmaNo)
      if (!byId.has(id)) byId.set(id, { userId: id, displayName: o.technicianName || o.operatorName || id, ...emptyCounts() })
      byId.get(id)[mode]++
      byId.get(id).total++
    }
    const people = [...byId.values()]
    const totals = people.reduce((sum, row) => { for (const key of Object.keys(sum)) sum[key] += row[key]; return sum }, emptyCounts())
    return { product, people, totals }
  })
}
