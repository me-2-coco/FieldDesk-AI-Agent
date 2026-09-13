const crypto = require('node:crypto');
function eligible(order) {
  return order?.status === 'ON_HOLD' && order.hold?.category === '保外'
    && !['网点缺件', '总部缺件', '待补寄配件'].includes(order.hold?.reason);
}
function currentFollowup(order) {
  return order.paymentFollowup?.holdRequestedAt === order.hold?.requestedAt ? order.paymentFollowup : null;
}
function appendRemark(original, entry) {
  const text = String(original || '');
  if (text.includes(entry.marker)) {
    if (!text.includes(entry.line)) throw Object.assign(new Error('同一跟进标识的内容不一致，请人工核对'), {status:409});
    return text;
  }
  const result = text + (text ? '\n' : '') + entry.line;
  if (result.length > 5000) throw Object.assign(new Error('追加后备注超过瑞云5000字限制，原备注未修改'), {status:409});
  return result;
}
function recordFollowup(order, input, user) {
  const fail = (message, status=409) => {throw Object.assign(new Error(message), {status});};
  if (!['ADMIN','INFORMATION_CLERK'].includes(user?.role)) fail('只有信息员或管理员可以登记收费跟进',403);
  if (!eligible(order)) fail('工单不再是保外非缺件暂存，请刷新');
  if (input.holdRequestedAt !== order.hold.requestedAt) fail('暂存批次已变化，请刷新');
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.id || '')) fail('缺少有效操作标识',400);
  const current = currentFollowup(order) || {holdRequestedAt:order.hold.requestedAt, entries:[], paid:false};
  const duplicate=current.entries.find(e=>e.id===input.id);
  if (duplicate) {
    if (duplicate.paid!==input.paid || duplicate.note!==String(input.note || '').trim()) fail('同一操作标识的内容已变化，请刷新');
    return order;
  }
  if (current.paid) fail('已经确认收款，不可重复登记');
  if (typeof input.paid !== 'boolean') fail('请选择费用收到或未收到',400);
  const note = String(input.note || '').trim();
  if (!note || note.length>1500) fail('请填写跟进备注（最多1500字）',400);
  if (input.paid && !(order.technicianId || order.operatorId)) fail('未找到负责师傅，不能确认通知');
  const at = new Date().toISOString();
  const marker = `[FD跟进:${input.id}]`;
  const line = `【${at}｜${user.displayName || user.userId}｜${input.paid?'费用已收到，可继续维修':'费用未收到'}】${note} ${marker}`;
  const entry = {id:input.id, marker, line, note, paid:input.paid, at, operatorId:user.userId, operatorName:user.displayName || user.userId, syncStatus:'PENDING'};
  return {...order, paymentFollowup:{...current, paid:input.paid, entries:[...current.entries,entry]},
    hold:{...order.hold,remark:appendRemark(order.hold.remark,entry)},
    timeline:[...(order.timeline||[]),{id:crypto.randomUUID(),type:'PAYMENT_FOLLOWUP',label:line,at,operatorId:user.userId}],
    updatedAt:at};
}
module.exports={eligible,currentFollowup,appendRemark,recordFollowup};
