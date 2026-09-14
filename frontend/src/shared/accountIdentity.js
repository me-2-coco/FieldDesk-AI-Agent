export function accountPersonName(user = {}) {
  const name = String(user.name ?? user.displayName ?? '').trim()
  const owner = (user.id || user.userId) === 'FieldDesk0001'
  return owner && name === '负责人' ? '' : name
}

export function accountRoleLabel(user = {}) {
  if ((user.id || user.userId) === 'FieldDesk0001') return '负责人'
  const role = String(user.role || '').toLowerCase()
  if (role === 'technician') {
    const specialties = user.repairSpecialties || []
    return specialties.length === 1 ? `${specialties[0]}师傅` : '维修师傅'
  }
  return { admin: '管理员', information_clerk: '信息员', warehouse: '库管' }[role] || '未配置角色'
}
