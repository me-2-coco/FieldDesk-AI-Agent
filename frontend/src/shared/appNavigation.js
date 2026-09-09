export const APP_HUBS = ["home", "orders", "inventory", "profile"]
export const APP_ROOTS = ["repair", "records", "adminRepairRecovery", "warrantyApprovals", "exceptionCenter", "machineTracking", "repairReports", "returnShipping", "warehouse", "syncTasks", "syncDiagnostics", "printManagement", "accountManagement"]

export function enterApp(trail, from, to) {
  if (APP_HUBS.includes(to)) return []
  if (to !== from && APP_ROOTS.includes(to) && (APP_HUBS.includes(from) || APP_ROOTS.includes(from))) return [...trail, from]
  return trail
}

export function exitApp(trail, page) {
  const fallback = ["syncTasks", "syncDiagnostics", "printManagement", "accountManagement"].includes(page) ? "profile" : page === "warehouse" ? "inventory" : "orders"
  return { page: trail.at(-1) || fallback, trail: trail.slice(0, -1) }
}
