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

test('QR payload only yields a unique tracking identifier', async () => {
  const { extractScannedIdentifier } = await import('../frontend/src/shared/queryIdentifier.js');
  assert.equal(extractScannedIdentifier('SF1234567890123'), 'SF1234567890123');
  assert.equal(extractScannedIdentifier('https://example.invalid/?waybill=SF1234567890123'), 'SF1234567890123');
  assert.equal(extractScannedIdentifier('{"no":"SF1234567890123"}'), 'SF1234567890123');
  assert.equal(extractScannedIdentifier('SF1234567890123,SF9999999999999'), '');
  assert.equal(extractScannedIdentifier('https://example.invalid/other'), '');
  assert.equal(extractScannedIdentifier('SORTING123456', 'logistics', true), '');
  assert.equal(extractScannedIdentifier('https://example.invalid/?sn=SF1234567890123', 'sn'), '');
});
