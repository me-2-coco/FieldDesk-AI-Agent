const { spawn } = require('node:child_process');
// Never adopts an arbitrary PID. A new child cannot start until the previous child closes.
function createOwnedProcess({ script, cwd, env, output }) {
  let child = null; let lastPid;
  return {
    get pid() { return child?.pid || lastPid; },
    get alive() { return !!child && child.exitCode === null && child.signalCode === null; },
    start() {
      if (child) throw Error('SERVICE_ALREADY_OWNED');
      const target = spawn(process.execPath, [script], { cwd, env, stdio: ['ignore', output, output, 'ipc'] });
      lastPid = target.pid;
      child = target;
      target.on('error', () => {});
      target.once('close', () => { if (child === target) child = null; });
    },
    async stop(timeoutMs = 10000) {
      const target = child;
      if (!target) return;
      await new Promise(resolve => {
        const timer = setTimeout(() => { if (target.exitCode === null && target.signalCode === null) target.kill('SIGKILL'); }, timeoutMs);
        target.once('close', () => { clearTimeout(timer); resolve(); });
        if (target.exitCode === null && target.signalCode === null) target.kill('SIGTERM');
      });
    },
  };
}
module.exports = { createOwnedProcess };
