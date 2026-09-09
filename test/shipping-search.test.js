const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../frontend/src/shared/shippingSearch.js');
const orders = [
  {rmaNo:'TEST001',customerName:'测试甲',logisticsNo:'SFTEST123',phoneMasked:'138****1234',sn:'SN-Abc',returnShipment:{trackingNo:'OUT567'}},
  {rmaNo:'TEST002',customerName:'测试乙',phone:'13900005678'},
];
test('shipping search matches partial identifiers, names and available phone values', async () => {
  const {filterShippingOrders:f}=await load();
  for(const q of ['001','试甲','sftest','1234','sn-abc','out567','  TeSt001  ']) assert.deepEqual(f(orders,q),[orders[0]]);
  assert.deepEqual(f(orders,'5678'),[orders[1]]);
  assert.deepEqual(f(orders,'missing'),[]);
  assert.equal(f(orders,'  '),orders);
  assert.deepEqual(f([{}, {rmaNo:'ABC'}],'abc'),[{rmaNo:'ABC'}]);
  assert.equal(orders.length,2);
});
