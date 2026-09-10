const test = require('node:test');
const assert = require('node:assert/strict');
const { hasExplicitMissingOrder, waitForRmaDetail } = require('../connectors/recloud');

test('only explicit order-not-found messages count as missing', () => {
  for (const message of ['未找到对应工单，请核对单号', '没有查询到相关工单', '未查询到寄修单', '工单不存在', '暂无相关工单']) {
    assert.equal(hasExplicitMissingOrder(message), true, message);
  }
  for (const message of ['', '暂无数据', '网络连接失败', '查询超时', '未找到按钮', '报修描述：工单不存在', '用户说未找到配件']) {
    assert.equal(hasExplicitMissingOrder(message), false, message);
  }
});

test('explicit missing query returns 404 without retrying Enter', async () => {
  let presses = 0;
  const page = {
    url: () => 'https://crm2.recloud.com.cn/example#/scanSignin/query',
    locator: selector => selector === 'body'
      ? { innerText: async () => '扫码签收\n没有查询到相关工单' }
      : { first: () => ({ isVisible: async () => true }) },
    keyboard: { press: async () => { presses++; } },
    waitForTimeout: async () => {},
  };
  await assert.rejects(waitForRmaDetail(page, 'TEST-NO-ORDER', { timeout: 100, retryDelay: 0 }), error =>
    error.code === 'RECLOUD_ORDER_NOT_FOUND' && error.status === 404);
  assert.equal(presses, 0);
});
