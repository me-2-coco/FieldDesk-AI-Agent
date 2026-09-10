const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { watchRmaQueryOutcome } = require('../connectors/recloud-query-outcome');
const missing = { ErrorCode: -1, Data: null, Message: '无对应物流单号/工单号/订单号/退换单号/手机号/设备序列号!' };
const response = (query, body = missing, status = 200) => ({
  url: () => 'https://crm2.recloud.com.cn/t/dreame/api/custom/new_srv_rma/Rma/SearchRmaOrderMulti',
  status: () => status,
  request: () => ({ postData: () => JSON.stringify({ query }) }),
  json: async () => body,
});
test('only exact query success response with explicit missing result is recognized', async () => {
  const page = new EventEmitter();
  const outcome = watchRmaQueryOutcome(page, 'TEST1');
  for (const event of [response('TEST2'), response('TEST10'), response('TEST1', missing, 502), response('TEST1', { ErrorCode: -1, Data: null, Message: '网络异常' }), response('TEST1', { ErrorCode: 0, Data: [] })]) {
    page.emit('response', event); await new Promise(setImmediate);
    assert.equal(outcome.isMissing(), false);
  }
  page.emit('response', response('TEST1')); await new Promise(setImmediate);
  assert.equal(outcome.isMissing(), true);
  outcome.stop();
  assert.equal(page.listenerCount('response'), 0);
});
