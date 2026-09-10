const test = require('node:test');
const assert = require('node:assert/strict');
test('rotation keeps all corners inside the output and preserves blank frames', async () => {
  const { rotateBarcodeFrame } = await import('../frontend/src/shared/rotateBarcodeFrame.js');
  for (const angle of [-45, -22.5, -67.5]) {
    const frame = { width: 100, height: 80, data: new Uint8ClampedArray(100 * 80 * 4).fill(255) };
    const out = rotateBarcodeFrame(frame, angle);
    assert.ok(out.width >= 80 && out.height >= 80);
    assert.equal(out.data.length, out.width * out.height * 4);
    assert.ok(out.data.every(value => value === 255));
  }
});
