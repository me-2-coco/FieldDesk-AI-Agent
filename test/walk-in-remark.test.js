const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRecloudRepairFormPlan } = require('../connectors/recloud-sync-mapping');
test('queued walk-in tasks map the primary picklist without changing zero fees or details', () => {
  const plan = buildRecloudRepairFormPlan({treatmentMode:'ABANDONED', pricing:{warrantyStatus:'OUT_OF_WARRANTY', primaryRemark:'送修，无运费', secondaryRemark:'送修，无运费', totalFee:0, roundTripLogisticsFee:0}});
  const fields = Object.fromEntries(plan.safeWrites.map(x=>[x.key,x.value]));
  assert.equal(fields.primaryRemark,'无减免');
  assert.equal(fields.secondaryRemark,'送修，无运费');
  assert.equal(fields.customerPaidAmount,0);
  assert.equal(fields.logisticsAmount,0);
});
