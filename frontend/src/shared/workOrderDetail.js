export function workOrderStage(order = {}) {
  if (order.partsShortage?.status === 'PENDING_INFORMATION') return '瑞云缺件，待信息员处理'
  const statuses = {
    ON_HOLD: "暂存", CANCELLED: "已取消", TRANSFERRED_TO_HEADQUARTERS: "已转总部",
    TRANSFER_TO_HEADQUARTERS_PENDING: "待转总部", REPAIR_COMPLETED_PENDING_SHIPMENT: "维修完成，待发货",
    SHIPPED_PENDING_COMPLETION: "已发货，待完结", COMPLETED: "已完结",
  }
  if (statuses[order.status]) return statuses[order.status]
  const steps = { repairWarranty: "确认保修状态", repairDecision: "选择处理方式", partsApplication: "申请配件", repairProcess: "检测及维修处理", repairCompletion: "维修完工资料" }
  return steps[order.resumeStep] || ({ RECEIPT_PREPARED: "签收准备", RECEIVED_PENDING_INSPECTION: "已签收，待检测", INSPECTION_IN_PROGRESS: "检测中", INSPECTION_COMPLETED_PENDING_REPAIR: "检测完成，待维修", REPAIR_COMPLETION_DRAFT: "维修完工草稿" })[order.status] || order.status || "未记录"
}

export function workOrderHolder(order = {}) {
  if (["SHIPPED_PENDING_COMPLETION", "COMPLETED", "TRANSFERRED_TO_HEADQUARTERS", "CANCELLED"].includes(order.status)) return "已离开在手维修流程；当前接收人请核对交接记录"
  return order.technicianName || order.operatorName || "未分配"
}
