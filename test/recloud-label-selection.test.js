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
  let checked = false, clicks = 0;
  value.native.isChecked = async () => checked;
  value.role.click = async () => { checked = !checked; clicks++; };
  const selection = await locateLabelSelection(value);
  await selection.setChecked(true);
  await selection.setChecked(true);
  assert.equal(await selection.isChecked(), true);
  assert.equal(clicks, 1);
  await selection.setChecked(false);
  assert.equal(checked, false);
});
test('a click without a state change fails verification', async () => {
  const value = cell(1,1,1);
  value.native.isChecked = async () => false;
  value.role.click = async () => {};
  await assert.rejects((await locateLabelSelection(value)).setChecked(true), {code:'RECLOUD_LABEL_SELECTION_FAILED'});
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
