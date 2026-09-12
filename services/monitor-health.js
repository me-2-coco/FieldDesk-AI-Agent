const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

// Keep successful scan time distinct from process activity: failed reads are not recovery.
async function writeMonitorHealth(file, state) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, file);
}
function monitorIsHealthy(state, now = Date.now(), maxAge = 120000) {
  const at = Date.parse(state?.lastSuccessfulScanAt || '');
  return state?.status === 'HEALTHY' && Number.isFinite(at) && now >= at && now - at < maxAge;
}
module.exports = { writeMonitorHealth, monitorIsHealthy };
