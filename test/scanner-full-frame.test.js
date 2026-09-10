const test = require('node:test');
const assert = require('node:assert/strict');

test('scanner decodes full frame with no center crop', async () => {
  const { fullFrameScanConfig } = await import('../frontend/src/shared/scannerConfig.js');
  assert.equal('qrbox' in fullFrameScanConfig, false);
  assert.equal(fullFrameScanConfig.fps, 20);
  assert.equal(fullFrameScanConfig.videoConstraints.facingMode.ideal, 'environment');
});

test('continuous focus is optional and unsupported cameras still work', async () => {
  const { enableContinuousFocus } = await import('../frontend/src/shared/scannerConfig.js');
  let applied;
  await enableContinuousFocus({ getRunningTrackCapabilities: () => ({ focusMode: ['continuous'] }), applyVideoConstraints: async c => { applied = c; } });
  assert.deepEqual(applied, { advanced: [{ focusMode: 'continuous' }] });
  await enableContinuousFocus({ getRunningTrackCapabilities: () => ({}) });
  await enableContinuousFocus({ getRunningTrackCapabilities: () => { throw Error('unsupported'); } });
});
