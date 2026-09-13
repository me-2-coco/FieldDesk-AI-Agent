const test = require('node:test');
const assert = require('node:assert/strict');
const { locateLabelSelection } = require('../connectors/recloud-old-part-labels');
function cell(nativeCount, roleCount, nestedCount = 0) {
  const native = { count: async () => nativeCount };
  const role = { count: async () => roleCount, locator: () => ({ count: async () => nestedCount }) };
  return { native, role, locator: selector => selector.startsWith('input') ? native : role };
}
test('Recloud role wrapper and its input are one selection control', async () => {
  const value = cell(1, 1, 1);
  assert.equal(await locateLabelSelection(value), value.native);
});
test('standalone native and standalone ARIA checkboxes remain supported', async () => {
  const native = cell(1, 0), aria = cell(0, 1);
  assert.equal(await locateLabelSelection(native), native.native);
  assert.equal(await locateLabelSelection(aria), aria.role);
});
test('missing or genuinely distinct selection controls remain blocked', async () => {
  for (const value of [cell(0,0),cell(2,1,2),cell(1,1,0),cell(1,2,1),cell(0,2)]) {
    await assert.rejects(locateLabelSelection(value), {code:'RECLOUD_LABEL_SELECTION_AMBIGUOUS'});
  }
});
