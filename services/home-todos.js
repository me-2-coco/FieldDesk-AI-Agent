const { detectOrderExceptions, detectSyncExceptions } = require('./information-exception-center');
function buildHomeTodos(orders, tasks, user) {
  const role = String(user?.role || '').toUpperCase();
  const id = user?.userId || user?.id;
  if (!['ADMIN','TECHNICIAN','INFORMATION_CLERK'].includes(role) || (role === 'TECHNICIAN' && !id)) return {groups:[],items:[]};
  const admin = role === 'ADMIN';
  const tech = role === 'TECHNICIAN';
  const own = tech ? orders.filter(o => (o.technicianId || o.operatorId) === id) : orders;
  const ownIds = new Set(own.map(o => o.rmaNo));
  const groups = [{id:'exceptions',label:'待处理异常'}, {id:'shortage',label:'缺件'}];
  if (tech) groups.push({id:'messages',label:'督办消息'},{id:'materials',label:'资料待补充'});
  else groups.push({id:'warranty',label:'待审核转保'});
  if (admin) groups.push({id:'sync',label:'瑞云同步失败'});
  const items = [];
  const add = (group, o, message, suffix='') => items.push({id:`${group}:${o.rmaNo}:${suffix}`,group,rmaNo:o.rmaNo,message,technicianName:o.technicianName || o.operatorName || '',updatedAt:o.updatedAt || o.createdAt || ''});
  for (const o of own) {
    for (const e of detectOrderExceptions(o)) {
      const material = ['REPORT_INCOMPLETE','COMPLETION_MEDIA_MISSING','ATTACHMENT_FILE_MISSING'].includes(e.type);
      add(['PARTS_SHORTAGE_PENDING','MATERIAL_HOLD_PENDING'].includes(e.type)?'shortage':tech && material?'materials':'exceptions',o,e.message,e.type);
    }
    if(tech) for(const s of o.supervisionOrders || []) if(!s.archivedAt && !(s.readBy || []).some(r=>r.userId===user.userId)) add('messages',o,'有未读督办消息',s.id);
    const w=o.manufacturerWarrantyConversion;
    if(!tech && w?.requested && (!w.status || w.status==='PENDING_APPROVAL')) add('warranty',o,'转保申请待跟进，请核对并补充申请凭证');
  }
  for (const e of detectSyncExceptions(tasks.filter(t=>['FAILED','MANUAL_REVIEW'].includes(t.status) && (!tech || ownIds.has(t.rmaNo))))) add(admin?'sync':'exceptions',e,e.message,e.id);
  items.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return {groups:groups.map(g=>({...g,count:new Set(items.filter(i=>i.group===g.id).map(i=>i.rmaNo || i.id)).size})),items};
}
module.exports={buildHomeTodos};
