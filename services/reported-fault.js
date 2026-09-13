function resolveReportedFault(rmaNo, sources = []) {
  return String(sources.find(item => String(item?.rmaNo || '').trim() === String(rmaNo || '').trim()
    && String(item.reportedFault || '').trim())?.reportedFault || '').trim();
}
function assertReportedFaultForSubmission(order, repairMeasure) {
  const fault = String(order.reportedFault || '').trim();
  if (!fault) throw Object.assign(new Error('报修描述尚未同步，请重新进入维修页面读取瑞云原文；可先保存草稿，暂不能提交完工'), { code: 'REPORTED_FAULT_REQUIRED', status: 409 });
  const prefix = `${fault.replace(/#+$/, '')}#`;
  if (!String(repairMeasure || '').startsWith(prefix)) throw Object.assign(new Error('维修措施中的报修描述与已同步原文不一致，请重新进入维修页面生成后再提交'), { code: 'REPORTED_FAULT_MISMATCH', status: 409 });
}

function createReportedFaultLoader({ query, save }) {
  const pending = new Map();
  return async function load(order) {
    if (String(order.reportedFault || '').trim()) return order;
    if (!pending.has(order.rmaNo)) {
      const task = (async () => {
        let detail;
        for (let attempt = 0; attempt < 2; attempt++) {
          try { detail = await query(order); break; }
          catch (error) {
            if (attempt || error.code === 'RECLOUD_LOGIN_REQUIRED') throw error;
          }
        }
        if (detail?.rmaNo !== order.rmaNo) throw Object.assign(new Error('瑞云返回工单不一致，未写入描述'), { code: 'REPORTED_FAULT_ORDER_MISMATCH', status: 409 });
        const fault = String(detail.reportedFault || '').trim();
        if (!fault) throw Object.assign(new Error('已读取瑞云，但报修描述为空；请核实瑞云原文后重试，可先保存草稿'), { code: 'REPORTED_FAULT_EMPTY', status: 409 });
        await save(order.rmaNo, fault);
        return fault;
      })().finally(() => pending.delete(order.rmaNo));
      pending.set(order.rmaNo, task);
    }
    return { ...order, reportedFault: await pending.get(order.rmaNo) };
  };
}
module.exports = { resolveReportedFault, assertReportedFaultForSubmission, createReportedFaultLoader };
