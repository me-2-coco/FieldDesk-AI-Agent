// Timings contain identifiers and durations only, never attachment contents.
async function timeRecloudPhase(orderKey, phase, operation) {
  const start = Date.now();
  let success = false;
  try {
    const result = await operation();
    success = true;
    return result;
  } finally {
    console.info('RECLOUD_PHASE_TIMING', JSON.stringify({ orderKey, phase, ms: Date.now() - start, success }));
  }
}
module.exports = { timeRecloudPhase };
