const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { provision } = require('./start-isolated-lab');
const names = [
  'recloud-part-write-guard',
  'recloud-label-selection',
  'recloud-return-flags', 'recloud-repair-parts-reader',
  'reported-fault-sync', 'repair-measure',
  'recloud-write-guard', 'recloud-write-admissions',
  'media-formats',
  'business-alert-monitor',
  'hold-reconciliation', 'receipt-reconciliation',
  'receipt-result-safety',
  'receipt-attachment-identity',
  'receipt-snapshot-reconciliation',
  'service-recovery-policy', 'owned-service-process', 'service-guardian', 'process-lock',
  'attachment-interruption', 'upload-admission', 'upload-client-retry', 'completion-api-recovery',
  'recloud-session', 'recloud-command-executor', 'recovery-fault-injection',
  'recloud-sync-outbox', 'recloud-repair-completion-orchestrator',
  'recloud-repair-attachment-uploader', 'recloud-recovery-policy',
  'recloud-repair-attachments-reader',
  'recloud-repair-checkpoint-store', 'repair-attachment-identity',
  'safe-background-retry', 'detection-crash-recovery', 'outbox-process-crash',
  'global-sync-alert', 'database-backup-integrity', 'deployment-storage-config', 'production-preflight', 'rate-limit-concurrency', 'business-rate-limit', 'lab-real-api-concurrency',
];
(async () => {
  const source = path.resolve(__dirname, '..');
  const root = await provision(source);
  const tests = names.map(name => `test/${name}.test.js`);
  for (const file of [...tests, 'test/fixtures/detection-crash-worker.cjs',
    'services/recloud-part-write-guard.js',
    'frontend/src/shared/repairMeasure.js',
    'services/recloud-write-admissions.js',
    'services/receipt-reconciliation-evidence.js',
    'services/receipt-attachment-identity.js',
    'services/repair-attachment-identity.js',
    'services/service-recovery-policy.js', 'services/owned-service-process.js', 'services/process-lock.js', 'scripts/start-service-guardian.js',
    'test/fixtures/owned-service.cjs', 'test/fixtures/guardian-entry.cjs', 'test/fixtures/guardian-backend.cjs', 'test/fixtures/guardian-notifier.cjs',
    'shared/media-formats.json',
    'services/business-alert-monitor.js', 'services/monitor-health.js', 'services/feishu-alert-notifier.js', 'scripts/start-business-alerts.js',
    'test/fixtures/outbox-crash-worker.cjs', 'init-recloud-login.js',
    'scripts/production-preflight.js', 'config/upload-paths.js', 'deploy/env/production.env.template', 'deploy/systemd/fielddesk.service', 'deploy/nginx/fielddesk.conf',
    'scripts/database-maintenance.js', 'services/upload-admission.js', 'frontend/package.json', 'frontend/src/shared/uploadRetry.js', 'frontend/src/App.jsx', 'frontend/src/pages/SyncTasks.jsx', '.gitignore']) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.copyFile(path.join(source, file), path.join(root, file));
  }
  console.log(`RECOVERY_TEST_ROOT=${root}`);
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...tests], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), NODE_ENV: 'test',
      DRY_RUN: 'true', FIELDDESK_STORAGE_DRIVER: 'json',
      FIELDDESK_DATA_DIRECTORY: path.join(root, 'database/data'),
      RECLOUD_WRITE_ENABLED: 'false', RECLOUD_RECEIPT_WRITE_ENABLED: 'false',
      RECLOUD_INSPECTION_WRITE_ENABLED: 'false', RECLOUD_COMPLETION_WRITE_ENABLED: 'false',
      RECLOUD_HOLD_WRITE_ENABLED: 'false',
    },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk); });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('close', async code => {
    await fs.writeFile(path.join(root, 'recovery-test-output.txt'), output, { mode: 0o600 });
    process.exitCode = code ?? 1;
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
