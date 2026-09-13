const { detectOrderExceptions, detectSyncExceptions } = require('./information-exception-center');
const categories = require('../shared/todo-categories.json');
function buildHomeTodos(orders, tasks, user) {
  const role = String(user?.role || '').toUpperCase();
  const id = user?.userId || user?.id;
  if (!['ADMIN','TECHNICIAN','INFORMATION_CLERK'].includes(role) || (role === 'TECHNICIAN' && !id)) return {groups:[],items:[]};
  const tech = role === 'TECHNICIAN';
  const own = tech ? orders.filter(o => (o.technicianId || o.operatorId) === id) : orders;
  const ownIds = new Set(own.map(o => o.rmaNo));
  const groups = tech ? [{id:'exceptions',label:'待处理异常'}, {id:'shortage',label:'缺件'}] : categories.groups;
  if (tech) groups.push({id:'messages',label:'督办消息'},{id:'materials',label:'资料待补充'});
  const items = [];
  const add = (group, o, message, suffix='') => items.push({id:`${group}:${o.rmaNo}:${suffix}`,group,rmaNo:o.rmaNo,message,action:categories.groups.find(g=>g.id===group)?.action || '查看工单详情',technicianName:o.technicianName || o.operatorName || '未记录',updatedAt:o.updatedAt || o.createdAt || ''});
  for (const o of own) {
    const payment = require('./payment-followup');
    const followup = payment.currentFollowup(o);
    if (payment.eligible(o) && !tech) {
      const pending = followup?.entries?.some(e=>e.syncStatus!=='CONFIRMED');
      if (!followup?.paid || pending) {
        add('payment',o,followup?.paid?'费用已收到；跟进备注待同步瑞云':`保外暂存：${o.hold.reason}；费用未收到`,'PAYMENT');
        Object.assign(items.at(-1),{payment:{holdRequestedAt:o.hold.requestedAt,remark:o.hold.remark,entries:followup?.entries || [],paid:!!followup?.paid}});
      }
    }
    if (tech && payment.eligible(o) && followup?.paid) add('messages',o,'信息员已确认费用收到，请继续维修','PAYMENT_RECEIVED');
    for (const e of detectOrderExceptions(o)) {
      const material = ['REPORT_INCOMPLETE','COMPLETION_MEDIA_MISSING','ATTACHMENT_FILE_MISSING'].includes(e.type);
      const group = tech ? (['PARTS_SHORTAGE_PENDING','MATERIAL_HOLD_PENDING'].includes(e.type)?'shortage':material?'materials':'exceptions') : categories.types[e.type] || 'exceptions';
      add(group,o,e.message,e.type);
    }
    if(tech) for(const s of o.supervisionOrders || []) if(!s.archivedAt && !(s.readBy || []).some(r=>r.userId===user.userId)) add('messages',o,'有未读督办消息',s.id);
    const w=o.manufacturerWarrantyConversion;
    if(!tech && w?.requested && (!w.status || w.status==='PENDING_APPROVAL')) add('warranty',o,'转保申请待跟进，请核对并补充申请凭证');
  }
  for (const e of detectSyncExceptions(tasks.filter(t=>['FAILED','MANUAL_REVIEW'].includes(t.status) && (!tech || ownIds.has(t.rmaNo))))) {
    const order = own.find(o=>o.rmaNo===e.rmaNo);
    add(tech?'exceptions':'sync',{...e,technicianName:order?.technicianName || order?.operatorName},e.message,e.id);
  }
  items.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return {groups:groups.map(g=>({...g,count:new Set(items.filter(i=>i.group===g.id).map(i=>i.rmaNo || i.id)).size})),items};
}
module.exports={buildHomeTodos};
