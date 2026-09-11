const UPLOAD_PATHS = new Set([
  '/api/repairs/receipt/attachments', '/api/repairs/completion/attachments',
  '/api/shipping/attachments', '/api/information/warranty-conversions/attachments',
]);
function bounded(value, fallback, max) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(max, Math.floor(number)) : fallback;
}
function createUploadAdmission(options = {}) {
  const concurrency = bounded(options.concurrency, 2, 4);
  const maxQueue = bounded(options.maxQueue, 60, 120);
  const waitMs = bounded(options.waitMs, 30000, 60000);
  let active = 0;
  const queue = [];
  function pump() {
    while (active < concurrency && queue.length) queue.shift().start();
  }
  const middleware = (req, res, next) => {
    if (req.method !== 'POST' || !UPLOAD_PATHS.has(req.path)) return next();
    let acquired = false;
    let done = false;
    let timer;
    const release = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      if (acquired) active--;
      pump();
    };
    const reject = () => {
      res.setHeader('Retry-After', '3');
      res.setHeader('Connection', 'close');
      res.status(503).json({ success: false, code: 'UPLOAD_BUSY', message: '上传繁忙，本次文件尚未接收，请稍后重试' });
      release();
    };
    const entry = { start() {
      if (done) return;
      acquired = true;
      active++;
      clearTimeout(timer);
      // Install the body parser before resuming a queued request.
      next();
      req.resume();
    } };
    req.once('aborted', release);
    res.once('finish', release);
    res.once('close', release);
    if (active < concurrency) return entry.start();
    req.pause();
    if (queue.length >= maxQueue) return reject();
    queue.push(entry);
    timer = setTimeout(reject, waitMs);
    timer.unref?.();
  };
  middleware.snapshot = () => ({ active, queued: queue.length, concurrency, maxQueue });
  return middleware;
}
module.exports = { createUploadAdmission, UPLOAD_PATHS };
