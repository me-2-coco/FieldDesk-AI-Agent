const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

// Only remove a lock after the OS confirms its recorded process no longer exists.
// Serialize cleanup so competing restarts cannot remove a newly acquired lock.
async function clearDeadLock(file) {
  const claimFile = `${file}.recovery`;
  const claim = await fs.open(claimFile, 'wx', 0o600);
  await claim.close();
  try {
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    const pid = Number(text);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('INVALID_PROCESS_LOCK');
    try { process.kill(pid, 0); throw Error('PROCESS_STILL_OWNS_LOCK'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    // Preserve the old record for diagnosis; never remove an unknown live PID's lock.
    await fs.rename(file, `${file}.stale-${randomUUID()}`);
  } finally { await fs.unlink(claimFile); }
}
async function acquireProcessLock(file) {
  let handle;
  try { handle = await fs.open(file, 'wx', 0o600); }
  catch (e) { if (e.code !== 'EEXIST') throw e; await clearDeadLock(file); handle = await fs.open(file, 'wx', 0o600); }
  try { await handle.writeFile(String(process.pid)); await handle.sync(); } finally { await handle.close(); }
}
module.exports = { acquireProcessLock, clearDeadLock };
