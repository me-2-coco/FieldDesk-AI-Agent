// Evaluate only pure predicates; never import the live server or its stores.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../server'), 'utf8');
const context = vm.createContext({
  NON_RETRYABLE_DETECTION_ERRORS: new Set(['STOP']),
  RECLOUD_FAILED_RETRY_COOLDOWN_MS: 60000,
  blocksPartRetry: code => code === 'STOP',
});
const begin = source.indexOf('function timestampAgeMs(');
const end = source.indexOf('function recloudRecoverySweepIntervalMs(', begin);
assert(begin > 0 && end > begin);
vm.runInContext(source.slice(begin, end), context);
const base = { status:'REPAIR_COMPLETED_PENDING_SHIPMENT', inspectionUpdatedAt:'2026-01-01', recloudDetectionSyncStatus:'PENDING' };
assert.equal(context.shouldAutoResumeDetection(base), true);
for (const status of ['DELETED','CANCELLED','SHIPPED']) {
  assert.equal(context.shouldAutoResumeDetection({...base,status}),false);
}
for (const patch of [
  {recloudDetectionSyncStatus:'RESULT_UNKNOWN'},
  {recloudDetectionSubmissionStartedAt:'2026-01-01'},
  {recloudDetectionConfirmedAt:'2026-01-01'},
  {recloudDetectionSyncStatus:'FAILED',recloudDetectionLastError:{code:'STOP'}},
]) assert.equal(context.shouldAutoResumeDetection({...base,...patch}),false);
const prepared = {...base,recloudDetectionConfirmedAt:'2026-01-01',recloudRepairPreparation:{status:'PENDING'},recloudServiceOrderSyncStatus:'PENDING'};
assert.equal(context.shouldAutoResumeServiceOrder(prepared),true);
for (const patch of [
  {recloudDetectionConfirmedAt:''},
  {recloudServiceOrderSyncStatus:'RESULT_UNKNOWN'},
  {recloudServiceOrderCreatedAt:'2026-01-01'},
  {status:'SHIPPED'},
  {recloudRepairPreparation:{status:'PENDING',lastError:{code:'STOP'}}},
]) assert.equal(context.shouldAutoResumeServiceOrder({...prepared,...patch}),false);
console.log('Completed-order recovery guards passed');
