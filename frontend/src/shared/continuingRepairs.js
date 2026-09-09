import { isCompletedWorkflow, isMaterialHold } from './homeWorkload.js'

export function continuingStatus(order) {
  if (isMaterialHold(order) || order.partsShortage?.status === 'PENDING_INFORMATION') return 'waiting'
  return order.status === 'ON_HOLD' ? 'held' : 'repairing'
}

export function continuingRepairs(orders, user, { keyword = '', technicianId = '', status = 'all' } = {}) {
  const manager = user?.role === 'admin' || user?.accountAuthority === 'OWNER'
  const ownId = user?.userId || user?.id
  if (!manager && (user?.role !== 'technician' || !ownId)) return { rows: [], counts: { all: 0, repairing: 0, waiting: 0, held: 0 } }
  const query = keyword.trim().toLowerCase()
  const base = orders.filter(order => {
    const owner = order.technicianId || order.operatorId
    return order.receiptCompletedAt && !isCompletedWorkflow(order)
      && !['CANCELLED', 'TRANSFERRED_TO_HEADQUARTERS'].includes(order.status)
      && (manager ? !technicianId || owner === technicianId : owner === ownId)
      && (!query || [order.rmaNo, order.sn].some(value => String(value || '').toLowerCase().includes(query)))
  })
  const counts = { all: base.length, repairing: 0, waiting: 0, held: 0 }
  base.forEach(order => counts[continuingStatus(order)]++)
  return { counts, rows: base.filter(order => status === 'all' || continuingStatus(order) === status)
    .sort((a, b) => updatedTime(b) - updatedTime(a)) }
}

export function updatedTime(order) {
  const value = Date.parse(order.updatedAt || order.inspectionUpdatedAt || order.receiptCompletedAt || '')
  return Number.isFinite(value) ? value : 0
}

export function elapsedLabel(order, now = Date.now()) {
  const time = updatedTime(order)
  if (!time) return '更新时间未记录'
  const hours = Math.max(0, Math.floor((now - time) / 3600000))
  return hours < 1 ? '最近更新 · 不足1小时' : `距上次更新 ${hours < 24 ? `${hours}小时` : `${Math.floor(hours / 24)}天${hours % 24}小时`}`
}
