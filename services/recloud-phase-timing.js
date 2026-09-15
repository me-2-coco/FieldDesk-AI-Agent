// Timings contain identifiers and durations only, never attachment contents.
const { AsyncLocalStorage } = require('node:async_hooks');
const timingContext = new AsyncLocalStorage();
function withRecloudTimingContext(task, operation) {
  return timingContext.run({ taskId: task.id, nodeType: task.nodeType, retryCount: task.retryCount || 0 }, operation);
}
async function timeRecloudPhase(orderKey, phase, operation) {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let success = false;
  try {
    const result = await operation();
    success = true;
    return result;
  } finally {
    console.info('RECLOUD_PHASE_TIMING', JSON.stringify({ ...timingContext.getStore(), orderKey, phase,
      startedAt, finishedAt: new Date().toISOString(),
      ms: Math.round(performance.now() - start), success }));
  }
}
module.exports = { timeRecloudPhase, withRecloudTimingContext };
