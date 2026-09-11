const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
// Lab-only lifecycle helper, not an installed OS service or a hang detector.
function superviseLab(script, options) {
  const events = new EventEmitter();
  let child, timer, stopped = false, restarts = 0;
  let port = options.env.FIELDDESK_LAB_PORT || '0';
  function persistAlert(status) {
    if (!options.alertFile) return;
    let temp;
    try {
      let previous;
      try { previous = JSON.parse(fs.readFileSync(options.alertFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (status === 'RECOVERED' && previous?.status !== 'OPEN') return;
      const repeated = status === 'OPEN' && previous?.status === 'OPEN';
      const record = {
        id: previous?.status === 'OPEN' ? previous.id : randomUUID(),
        code: 'LAB_SERVICE_RESTART_EXHAUSTED', status,
        openedAt: previous?.status === 'OPEN' ? previous.openedAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(), restartAttempts: restarts,
        notificationStatus: 'NOT_CONFIGURED',
        message: status === 'OPEN' ? '隔离服务自动重启失败，需要人工检查' : '隔离服务已重新启动',
      };
      fs.mkdirSync(path.dirname(options.alertFile), { recursive: true, mode: 0o700 });
      temp = `${options.alertFile}.${randomUUID()}.tmp`;
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, options.alertFile); temp = null;
      if (!repeated) events.emit('alert', record);
    } catch {
      if (temp) { try { fs.unlinkSync(temp); } catch {} }
      events.emit('alertPersistenceFailed', { code: 'LAB_ALERT_SAVE_FAILED' });
    }
  }
  function start() {
    if (stopped) return;
    child = spawn(process.execPath, [script], { cwd: options.cwd,
      env: { ...options.env, FIELDDESK_LAB_PORT: port }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.on('message', message => {
      if (message.type === 'ready') { port = String(message.port); persistAlert('RECOVERED'); events.emit('ready', { ...message, pid: child.pid }); }
    });
    child.on('error', error => events.emit('spawnFailure', error));
    child.on('close', () => {
      child = null;
      if (stopped) return;
      if (restarts >= (options.maxRestarts ?? 3)) { persistAlert('OPEN'); events.emit('exhausted'); return; }
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
