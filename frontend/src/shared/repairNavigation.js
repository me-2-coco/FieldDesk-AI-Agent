import { REPAIR_STATUS } from "./repairOrderStore.js"

const RESUMABLE_PAGES = new Set(["repairWarranty", "repairDecision", "partsApplication", "repairProcess", "repairCompletion"])

export function resumePageForLocalWorkflow(order = {}) {
  if (["REPAIR_COMPLETED_PENDING_SHIPMENT", "SHIPPED_PENDING_COMPLETION", "COMPLETED"].includes(order.status)) return "repairCompletion"
  if (order.treatmentMode === "REPAIR" && order.inspectionUpdatedAt && !order.repairStartedAt && !order.recloudServiceOrderCreatedAt) return "repairProcess"
  if (RESUMABLE_PAGES.has(order.resumeStep)) return order.resumeStep
  if (order.repairCompletion?.savedAt || order.status === "REPAIR_COMPLETION_DRAFT") return "repairCompletion"
  const hasSavedInspection = Boolean(order.inspectionUpdatedAt && order.faultCategory && order.technicianWarranty)
  if (hasSavedInspection) {
    if (order.treatmentMode && order.treatmentMode !== "REPAIR") return "repairCompletion"
    return order.repairStartedAt || order.recloudServiceOrderCreatedAt ? "repairCompletion" : "repairProcess"
  }
  if (order.treatmentMode === "REPAIR") return "partsApplication"
  if (order.treatmentMode) return "repairProcess"
  if (order.receiptCompletedAt) return order.technicianWarranty ? "repairDecision" : "repairWarranty"
  return ""
}

export function pageForRepairStatus(status) {
  if (status === REPAIR_STATUS.WAIT_RECEIPT) return "repair"
  if (status === REPAIR_STATUS.WAIT_DECISION) return "repairDecision"
  if (status === REPAIR_STATUS.WAIT_INSPECTION) return "partsApplication"
  if (status === REPAIR_STATUS.INSPECTION_COMPLETE) return "repairCompletion"
  if (status === REPAIR_STATUS.WAIT_PARTS) return "inventory"
  if ([REPAIR_STATUS.WAIT_REPAIR, REPAIR_STATUS.REPAIRING, REPAIR_STATUS.PAUSED].includes(status)) return "repairWork"
  if (status === REPAIR_STATUS.WAIT_CONFIRM) return "repairProcess"
  if ([REPAIR_STATUS.REPAIR_COMPLETED_PENDING_SHIPMENT, REPAIR_STATUS.SHIPPED_PENDING_COMPLETION].includes(status)) return "repairCompletion"
  if (status === REPAIR_STATUS.COMPLETED) return "records"
  return "repair"
}

export function pageForLocalWorkflowStatus(status) {
  if (["RECEIVED_PENDING_INSPECTION", "INSPECTION_IN_PROGRESS"].includes(status)) return "repairWarranty"
  if (["INSPECTION_COMPLETED_PENDING_REPAIR", "REPAIR_COMPLETION_DRAFT"].includes(status)) return "repairCompletion"
  if (["REPAIR_COMPLETED_PENDING_SHIPMENT", "SHIPPED_PENDING_COMPLETION"].includes(status)) return "repairCompletion"
  if (status === "COMPLETED") return "records"
  return ""
}

export function repairStatusForLocalWorkflow(status) {
  if (["RECEIVED_PENDING_INSPECTION", "INSPECTION_IN_PROGRESS"].includes(status)) return REPAIR_STATUS.WAIT_INSPECTION
  if (status === "INSPECTION_COMPLETED_PENDING_REPAIR") return REPAIR_STATUS.INSPECTION_COMPLETE
  if (status === "REPAIR_COMPLETION_DRAFT") return REPAIR_STATUS.REPAIRING
  if (status === "REPAIR_COMPLETED_PENDING_SHIPMENT") return REPAIR_STATUS.REPAIR_COMPLETED_PENDING_SHIPMENT
  if (status === "SHIPPED_PENDING_COMPLETION") return REPAIR_STATUS.SHIPPED_PENDING_COMPLETION
  if (status === "COMPLETED") return REPAIR_STATUS.COMPLETED
  return REPAIR_STATUS.WAIT_RECEIPT
}
