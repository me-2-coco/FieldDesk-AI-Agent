const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveReturnFlag, selectRemoteReturnParts } = require('../connectors/recloud-repair-parts-reader');
test('only explicit remote yes/no or a unique checkbox is authoritative', () => {
  assert.equal(resolveReturnFlag('是', 0), true);
  assert.equal(resolveReturnFlag('否', 0), false);
  assert.equal(resolveReturnFlag('', 1, true), true);
  assert.equal(resolveReturnFlag('', 1, false), false);
  for (const args of [['',0], ['--',0], ['是',1,false], ['',2,true]]) {
    assert.throws(() => resolveReturnFlag(...args), { code: 'RECLOUD_RETURN_FLAG_UNKNOWN' });
  }
});
test('remote return selection requires exact unique code and quantity', () => {
  const expected = [{partCode:'P1',quantity:2,returnRequired:false}];
  const remote = [{partCode:'P1',quantity:2,returnRequired:true}];
  assert.deepEqual(selectRemoteReturnParts(expected, remote), [{...expected[0],returnRequired:true}]);
  for (const rows of [[], [...remote,...remote], [{...remote[0],quantity:1}], [{...remote[0],returnRequired:undefined}]]) {
    assert.throws(() => selectRemoteReturnParts(expected, rows), {code:'RECLOUD_RETURN_PARTS_MISMATCH'});
  }
});
