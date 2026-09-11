const path = require('node:path');
const fs = require('node:fs/promises');
const { JsonRecloudSyncOutbox } = require('../../database/recloud-sync-outbox');
const { RecloudSyncService, NODE_METHODS } = require('../../services/recloud-sync-service');
const [dir, node, boundary] = process.argv.slice(2);
const pause = async () => {
  process.send('checkpoint');
  await new Promise(() => {});
};
(async () => {
  const outbox = new JsonRecloudSyncOutbox(path.join(dir, 'outbox.json'));
  const task = await outbox.enqueue({ rmaNo: 'LAB-CRASH', nodeType: node, idempotencyKey: node, payload: {} });
  const originalUpdate = outbox.update.bind(outbox);
  outbox.update = async (id, fields) => {
    const saved = await originalUpdate(id, fields);
    if (boundary === 'result-saved' && fields.localRecoveryResult) await pause();
    return saved;
  };
  const service = new RecloudSyncService(outbox, { [NODE_METHODS[node]]: async () => {
    // A file is our synthetic remote ledger; no external connector exists.
    await fs.appendFile(path.join(dir, 'remote-ledger'), 'submitted\n');
    if (boundary === 'remote-submitted') await pause();
    return { status: 'SUCCESS' };
  } }, { scheduler: () => {}, retryScheduler: () => {} });
  await service.processTask(task.id);
})().catch(error => { console.error(error); process.exit(1); });
