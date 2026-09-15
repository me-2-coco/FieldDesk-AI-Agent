// Delay only scheduled background scans, never user submissions or writes.
function backgroundSyncDelay(intervalMs, failures = 0, random = Math.random) {
  const base = Math.max(1000, Number(intervalMs) || 60000);
  const cap = Math.max(base, 30 * 60 * 1000);
  const delay = Math.min(cap, base * 2 ** Math.min(6, Math.max(0, failures)));
  return Math.min(cap, delay + Math.floor(Math.max(0, Math.min(1, random())) * Math.min(30000, base * 0.1)));
}
module.exports = { backgroundSyncDelay };
