const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function alertText(alert) {
  if (alert.scope === 'INFRA') {
    const component = alert.component === 'BACKEND' ? '后端服务' : '告警监测程序';
    const state = alert.status === 'RECOVERED' ? '连续健康检查已通过，服务已恢复（不代表工单已完成）'
      : alert.kind === 'EXHAUSTED' ? '自动启动次数已达上限，已停止重试，需要人工检查'
      : '健康检查异常，正在检查并尝试恢复；请暂缓提交';
    const id = String(alert.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
    return `【FieldDesk 服务告警】${component}：${state}。故障编号：${id}。`;
  }
  if (alert.scope === 'BUSINESS_TEST') return '【FieldDesk 正式告警通道验证】这是一条启用验证消息，不是真实故障。';
  if (alert.scope === 'BUSINESS') {
    const safe = value => String(value || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
    const stages = { HOLD: '暂存', RECEIPT: '签收', PROJECT: '项目核对', RECEIPT_ATTACHMENTS: '签收附件', DETECTION: '检测', SERVICE_ORDER: '建维修单', REPAIR_PREPARATION: '维修资料', REPAIR_COMPLETED: '维修完工', RETURN_SHIPPED: '寄回', ORDER_COMPLETED: '工单完结' };
    const state = alert.status === 'RECOVERED' ? '本地记录已确认该步骤成功' : alert.kind === 'STALLED' ? '长时间未完成，请检查' : alert.kind === 'RESULT_UNKNOWN' ? '结果未知，请核对瑞云，不要重复提交' : '同步异常，需要检查';
    return `【FieldDesk 做单告警】工单：${safe(alert.rmaNo)}；步骤：${stages[alert.stage] || '同步'}；${state}。故障编号：${safe(alert.id)}。请在 FieldDesk 查看详情。`;
  }
  return `【FieldDesk 隔离演练】${alert.status === 'OPEN' ? '服务自动恢复失败，需要检查' : '服务已重新启动'}。故障编号：${alert.id}。不是正式业务故障。`;
}

function createFeishuAlertSender(env, fetchImpl = fetch) {
  return async (alert, uuid) => {
    if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET || !env.FEISHU_ALERT_OPEN_ID) throw new Error('ALERT_CONFIG_MISSING');
    let response, auth;
    try {
      response = await fetchImpl('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
      });
      auth = await response.json();
    } catch { throw new Error('ALERT_AUTH_UNAVAILABLE'); }
    if (!response.ok || auth.code !== 0 || !auth.tenant_access_token) throw new Error('ALERT_AUTH_REJECTED');
    let body;
    try {
      response = await fetchImpl('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${auth.tenant_access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ receive_id: env.FEISHU_ALERT_OPEN_ID, msg_type: 'text', uuid,
          content: JSON.stringify({ text: alertText(alert) }),
        }),
      });
      body = await response.json();
    } catch { throw Object.assign(new Error('ALERT_SEND_RESULT_UNKNOWN'), { unknown: true }); }
    if (response.status === 429) throw Object.assign(new Error('ALERT_RATE_LIMITED'), { retryable: true });
    if (response.status >= 500) throw Object.assign(new Error('ALERT_SEND_RESULT_UNKNOWN'), { unknown: true });
    if (!response.ok || body.code !== 0 || !body.data?.message_id) throw new Error('ALERT_SEND_REJECTED');
    return { messageId: body.data.message_id };
  };
}

// One instance owns this directory. It is not a distributed delivery queue.
function createAlertNotifier({ directory, send, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  let queue = Promise.resolve();
  async function deliver(alert) {
    if (!alert.id || !['OPEN', 'RECOVERED'].includes(alert.status)) throw new Error('INVALID_ALERT');
    const key = createHash('sha256').update(`${alert.id}:${alert.status}`).digest('hex');
    const file = path.join(directory, key + '.json');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let previous;
    try { previous = JSON.parse(await fs.readFile(file)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (previous) return previous; // Failed/uncertain deliveries require explicit review, not blind replay.
    const record = { id: alert.id, event: alert.status, uuid: key.slice(0, 32), status: 'SENDING' };
    async function persist() {
      const temp = file + '.' + randomUUID() + '.tmp';
      const fd = await fs.open(temp, 'wx', 0o600);
      try { await fd.writeFile(JSON.stringify(record)); await fd.sync(); } finally { await fd.close(); }
      await fs.rename(temp, file);
    }
    await persist();
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await send(alert, record.uuid);
        record.status = 'SENT'; record.messageId = result.messageId; record.attempts = attempt;
        break;
      } catch (error) {
        if (error.retryable && attempt < 3) { await sleep(3000 * attempt); continue; }
        record.status = error.unknown ? 'UNKNOWN' : 'FAILED'; record.attempts = attempt;
        record.code = error.unknown ? 'ALERT_RESULT_UNKNOWN' : 'ALERT_DELIVERY_FAILED';
      }
      break;
    }
    await persist();
    return record;
  }
  return { deliver(alert) { const job = queue.then(() => deliver(alert)); queue = job.catch(() => {}); return job; } };
}
module.exports = { createAlertNotifier, createFeishuAlertSender };
