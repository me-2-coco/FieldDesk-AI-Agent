// Opt-in sidecar for the current single-machine JSON deployment. No Recloud writes.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createBusinessAlertMonitor } = require('../services/business-alert-monitor');
const { writeMonitorHealth } = require('../services/monitor-health');
const { acquireProcessLock } = require('../services/process-lock');
const { createAlertNotifier, createFeishuAlertSender } = require('../services/feishu-alert-notifier');
async function main() {
  try { process.loadEnvFile?.(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (process.env.FEISHU_BUSINESS_ALERTS_ENABLED !== 'true') throw new Error('ALERTS_NOT_ENABLED');
  if ((process.env.FIELDDESK_STORAGE_DRIVER || 'json') !== 'json') throw new Error('ALERTS_JSON_ONLY');
  if (!process.env.FEISHU_ALERT_OPEN_ID || !process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) throw new Error('ALERT_CONFIG_MISSING');
  const data = process.env.FIELDDESK_DATA_DIRECTORY || path.join(__dirname, '../database/data');
  const directory = path.join(data, 'business-alerts');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await acquireProcessLock(path.join(directory, 'monitor.lock'));
  let timer; let stopping = false;
  let lastSuccessfulScanAt = null;
  const healthFile = path.join(directory, 'health.json');
  const notifier = createAlertNotifier({ directory: path.join(directory, 'deliveries'), send: createFeishuAlertSender(process.env) });
  const monitor = createBusinessAlertMonitor({ file: path.join(directory, 'incidents.json'), notifier });
  async function tick(initial = false) {
    timer = null;
    try {
      const [orders, tasks] = await Promise.all(['receipt-preparations.json', 'recloud-sync-outbox.json'].map(async name => JSON.parse(await fs.readFile(path.join(data, name), 'utf8'))));
      const result = await monitor.scan(orders, tasks);
      lastSuccessfulScanAt = new Date().toISOString();
      await writeMonitorHealth(healthFile, { pid: process.pid, status: result.attention ? 'DELIVERY_FAILED' : 'HEALTHY', lastSuccessfulScanAt, checkedAt: new Date().toISOString() });
      if (result.baseline) console.log('BUSINESS_ALERTS: historical baseline saved');
      if (result.attention) console.warn('BUSINESS_ALERTS: delivery needs review');
    } catch (error) {
      await writeMonitorHealth(healthFile, { pid: process.pid, status: 'SCAN_FAILED', lastSuccessfulScanAt, checkedAt: new Date().toISOString() }).catch(() => {});
      console.error('BUSINESS_ALERTS: scan failed; no recovery inferred');
      if (initial) { await fs.unlink(path.join(directory, 'monitor.lock')); throw error; }
    }
    if (!stopping) timer = setTimeout(tick, 10000);
    else await fs.unlink(path.join(directory, 'monitor.lock'));
  }
  function stop() { stopping = true; if (process.connected) process.disconnect(); if (timer) { clearTimeout(timer); timer = null; fs.unlink(path.join(directory, 'monitor.lock')).catch(() => {}); } }
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  if (process.send) process.once('disconnect', stop);
  await tick(true);
  console.log('BUSINESS_ALERTS: running (10 second checks, JSON only)');
}
if (require.main === module) main().catch(() => { console.error('BUSINESS_ALERTS: startup failed; check configuration or existing monitor lock'); process.exitCode = 1; });
