const test = require('node:test');
const assert = require('node:assert/strict');
test('pending shortage overrides locally completed display, resolved shortage does not', async () => {
  const { workOrderStage } = await import('../frontend/src/shared/workOrderDetail.js');
  const order = { status: 'REPAIR_COMPLETED_PENDING_SHIPMENT', partsShortage: { status: 'PENDING_INFORMATION' } };
  assert.equal(workOrderStage(order), '瑞云缺件，待信息员处理');
  order.partsShortage.status = 'RESOLVED';
  assert.equal(workOrderStage(order), '维修完成，待发货');
});
