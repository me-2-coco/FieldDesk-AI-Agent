const test = require('node:test');
const assert = require('node:assert/strict');
const { orderQuery } = require('../services/recloud-order-query');
test('walk-in orders use RMA instead of absent logistics placeholders', () => {
  for (const value of [undefined, '', ' -- ', '—', '无', '暂无', '未提供']) {
    const result = orderQuery({ rmaNo: 'JXTH900000001', logisticsNo: value });
    assert.equal(result.identifier, 'JXTH900000001');
    assert.equal(result.logisticsNo, '');
    assert.equal(result.options.requirePickupLogisticsNo, false);
    assert.equal(result.options.expectedRmaNo, 'JXTH900000001');
  }
});
test('real logistics remain unchanged and require pickup verification', () => {
  const result = orderQuery({ rmaNo: 'JXTH900000001', logisticsNo: ' SF1234567890123 ' });
  assert.equal(result.identifier, 'SF1234567890123');
  assert.equal(result.options.requirePickupLogisticsNo, true);
});
