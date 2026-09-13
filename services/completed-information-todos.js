// Completion requires persisted positive evidence, never disappearance from a query.
function completedInformationTodos(orders, tasks) {
  const items=[];
  const add=(order,type,at,message,by='系统核对')=>{
    if(!at) return;
    items.push({id:`DONE:${type}:${order.rmaNo}:${at}`,type,rmaNo:order.rmaNo,
      logisticsNo:order.logisticsNo || '',technicianName:order.technicianName || order.operatorName || '未记录',
      status:'COMPLETED',completedAt:at,updatedAt:at,completedBy:by,message,severity:'LOW'});
  };
  for(const order of orders) {
    const handoff=order.inspectionOnlyHandoff;
    if(handoff?.status==='CONFIRMED') add(order,'RECLOUD_COMPLETED_SUBMIT_PENDING',handoff.confirmedAt,'已核对瑞云最终提交完成');
    const shortage=order.partsShortage;
    if(shortage?.status==='RESOLVED') add(order,'PARTS_SHORTAGE_PENDING',shortage.resolvedAt,'信息员已确认在瑞云补件并提交',shortage.resolvedBy?.displayName || '信息员人工确认');
    for(const entry of order.paymentFollowup?.entries || []) {
      if(entry.paid && entry.syncStatus==='CONFIRMED') add(order,'PAYMENT_FOLLOWUP',entry.syncedAt,`费用已收到，已通知原师傅；${entry.note}`,entry.operatorName);
    }
  }
  for(const task of tasks) {
    if(task.status!=='SUCCESS' || task.resultStatus!=='SUCCESS' || !task.updatedAt) continue;
    const order=orders.find(o=>o.rmaNo===task.rmaNo);
    if(!order) continue;
    add(order,'SYNC_ATTENTION_REQUIRED',task.updatedAt,`瑞云同步已完成（${task.nodeType || '业务任务'}）`);
    items[items.length-1].id=`DONE:SYNC:${task.id}`;
  }
  return items.sort((a,b)=>String(b.completedAt).localeCompare(String(a.completedAt)));
}
module.exports={completedInformationTodos};
