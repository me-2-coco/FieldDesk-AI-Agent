const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRuntimeConfig } = require('../config/runtime-config');
const base = {
  NODE_ENV: 'production', FIELDDESK_AUTH_MODE: 'accounts',
  FRONTEND_ORIGIN: 'https://fielddesk.example.com',
  DRY_RUN: 'false', RECLOUD_WRITE_ENABLED: 'true',
  FIELDDESK_PRODUCTION_RECLOUD_MODE: 'manual-review',
  RECLOUD_MANUAL_REVIEW_REQUIRED: 'true',
};
test('production write trial requires explicit mode and final-submit guard', () => {
  assert.equal(validateRuntimeConfig(base).production, true);
  for (const value of [undefined, '', 'false', 'TRUE', 'typo']) {
    assert.throws(() => validateRuntimeConfig({...base, RECLOUD_MANUAL_REVIEW_REQUIRED: value}), {code:'PRODUCTION_CONFIG_INVALID'});
  }
  for (const value of [undefined, '', 'auto', 'manual-reveiw']) {
    assert.throws(() => validateRuntimeConfig({...base, FIELDDESK_PRODUCTION_RECLOUD_MODE: value}), {code:'PRODUCTION_CONFIG_INVALID'});
  }
});
test('production write trial retains account, HTTPS and private-phone protections', () => {
  for (const invalid of [{FIELDDESK_AUTH_MODE:'local'}, {FRONTEND_ORIGIN:'http://example.com'}, {RECLOUD_REVEAL_PHONE_ENABLED:'true'}, {FIELDDESK_BOOTSTRAP_ADMIN_TOKEN:'password'}]) {
    assert.throws(() => validateRuntimeConfig({...base,...invalid}), {code:'PRODUCTION_CONFIG_INVALID'});
  }
});
