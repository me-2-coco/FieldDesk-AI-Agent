const test = require('node:test');
const assert = require('node:assert/strict');
test('manual and scanned identifiers normalize identically', async () => {
  const { normalizeQueryIdentifier, isPlausibleScannedIdentifier } = await import('../frontend/src/shared/queryIdentifier.js');
  const value = 'SF1234567890123';
  for (const scan of [value, `]C1${value}\r\n`, `\u200b${value}\u001d`, ` ${value} `]) {
    assert.equal(normalizeQueryIdentifier(scan), value);
    assert.equal(isPlausibleScannedIdentifier(scan), true);
  }
  assert.equal(isPlausibleScannedIdentifier('SFz234567890123'), false);
  assert.equal(normalizeQueryIdentifier('SFz234567890123'), 'SFz234567890123');
});
