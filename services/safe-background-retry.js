// Timer callbacks must not leak rejected promises into the backend process.
// Durable task state remains the source of truth for the next recovery sweep.
function scheduleBackgroundRetry(work, delayMs, options = {}) {
  const timer = (options.setTimeout || setTimeout)(() => Promise.resolve()
    .then(work)
    .catch(() => {
      try { (options.logger || console).error("RECLOUD_BACKGROUND_RETRY_FAILED"); } catch {}
    }), delayMs);
  timer?.unref?.();
  return timer;
}

function scheduleBackgroundWork(work) {
  return scheduleBackgroundRetry(work, 0, { setTimeout: setImmediate });
}

module.exports = { scheduleBackgroundRetry, scheduleBackgroundWork };
