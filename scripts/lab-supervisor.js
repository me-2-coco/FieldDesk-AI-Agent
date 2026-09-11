const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
// Lab-only lifecycle helper, not an installed OS service or a hang detector.
function superviseLab(script, options) {
  const events = new EventEmitter();
  let child, timer, stopped = false, restarts = 0;
  let port = options.env.FIELDDESK_LAB_PORT || '0';
  function start() {
    if (stopped) return;
    child = spawn(process.execPath, [script], { cwd: options.cwd,
      env: { ...options.env, FIELDDESK_LAB_PORT: port }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.on('message', message => {
      if (message.type === 'ready') { port = String(message.port); events.emit('ready', { ...message, pid: child.pid }); }
    });
    child.on('error', error => events.emit('spawnFailure', error));
    child.on('close', () => {
      child = null;
      if (stopped) return;
      if (restarts >= (options.maxRestarts ?? 3)) { events.emit('exhausted'); return; }
      const delay = Math.min(5000, (options.delayMs ?? 1000) * 2 ** restarts++);
      timer = setTimeout(start, delay);
    });
  }
  events.stop = async () => {
    stopped = true; clearTimeout(timer);
    if (!child) return;
    const target = child;
    await new Promise(resolve => {
      const force = setTimeout(() => target.kill('SIGKILL'), 2000);
      target.once('close', () => { clearTimeout(force); resolve(); });
      target.kill('SIGTERM');
    });
  };
  queueMicrotask(start);
  return events;
}
module.exports = { superviseLab };
