const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { abandonedReturnPricing } = require('../server');
test('abandoned orders default to no relief and only charge actual freight', () => {
  const input = {partsFee: 100, repairFee: 30, oneWayLogisticsFee: 20, logisticsChargeMode: 'ROUND_TRIP'};
  const normal = abandonedReturnPricing(input);
  assert.equal(normal.primaryRemark, '无减免');
  assert.equal(normal.totalFee, 40);
  assert.equal(normal.logisticsFee, 40);
  assert.equal(normal.outOfWarrantyReliefEnabled, false);
  assert.doesNotMatch(normal.secondaryRemark, /免运费寄回/);
  const enabled = abandonedReturnPricing({...input, outOfWarrantyReliefEnabled: true});
  assert.equal(enabled.totalFee, 0);
  assert.equal(enabled.primaryRemark, '申请运费减免');
  assert.equal(abandonedReturnPricing({...input, outOfWarrantyReliefEnabled: false}).totalFee, 40);
});
test('server requires boolean consent, filters stale generated attachments and guards draft generation', () => {
  const source = fs.readFileSync(require.resolve('../server'), 'utf8');
  assert.match(source, /req\.body\?\.outOfWarrantyReliefEnabled === true/);
  assert.match(source, /if \(submit && outOfWarrantyReliefEnabled\)/);
  assert.match(source, /order\.repairCompletion\?\.outOfWarrantyReliefEnabled !== true\) return null/);
  assert.match(source, /req\.body\.attachments\.filter[\s\S]*?FREIGHT_WAIVER_APPLICATION_SOURCE/);
});
