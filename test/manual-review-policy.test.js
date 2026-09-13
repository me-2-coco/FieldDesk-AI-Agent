const test = require('node:test');
const assert = require('node:assert/strict');
const { requiresManualReview, assertAutomaticSubmitAllowed } = require('../services/manual-review-policy');
test('manual review defaults closed, including invalid settings', () => {
  for (const value of [undefined, '', 'true', 'FALSE', 'invalid']) {
    assert.equal(requiresManualReview({RECLOUD_MANUAL_REVIEW_REQUIRED: value}), true);
  }
  assert.equal(requiresManualReview({RECLOUD_MANUAL_REVIEW_REQUIRED: 'false'}), false);
});
test('submit guard blocks even direct adapter callers', () => {
  const before = process.env.RECLOUD_MANUAL_REVIEW_REQUIRED;
  try {
    process.env.RECLOUD_MANUAL_REVIEW_REQUIRED = 'true';
    assert.throws(assertAutomaticSubmitAllowed, {code:'RECLOUD_MANUAL_REVIEW_REQUIRED'});
  } finally {
    if (before === undefined) delete process.env.RECLOUD_MANUAL_REVIEW_REQUIRED;
    else process.env.RECLOUD_MANUAL_REVIEW_REQUIRED = before;
  }
});
