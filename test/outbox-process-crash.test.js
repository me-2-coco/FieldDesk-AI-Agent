const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { JsonRecloudSyncOutbox, TASK_STATUS } = require('../database/recloud-sync-outbox');
const { RecloudSyncService, NODE_METHODS } = require('../services/recloud-sync-service');

for (const [node, method] of Object.entries(NODE_METHODS)) {
  for (const boundary of ['remote-submitted', 'result-saved']) {
    test(`${node}: SIGKILL at ${boundary} does not duplicate submission`, { timeout: 10000 }, async t => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fielddesk-outbox-crash-'));
      const child = fork(path.join(__dirname, 'fixtures/outbox-crash-worker.cjs'), [dir, node, boundary], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      const exited = once(child, 'exit');
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
        await fs.rm(dir, { recursive: true, force: true });
      });
      const [message] = await Promise.race([
        once(child, 'message'), exited.then(() => { throw new Error('worker exited before checkpoint'); }),
      ]);
      assert.equal(message, 'checkpoint');
      child.kill('SIGKILL');
      await exited;
      const outbox = new JsonRecloudSyncOutbox(path.join(dir, 'outbox.json'));
      const [interrupted] = await outbox.readAll();
      assert.equal(interrupted.status, TASK_STATUS.PROCESSING);
      // Expire the lease deterministically; the data itself comes from the killed worker.
      await outbox.writeAll([{ ...interrupted, updatedAt: '2000-01-01T00:00:00.000Z' }]);
      let otherCalls = 0;
      const service = new RecloudSyncService(outbox, { [method]: async task => {
        assert.notEqual(task.id, interrupted.id, 'interrupted write must never replay');
        otherCalls++;
        return { status: 'SUCCESS' };
      } }, { scheduler: () => {}, retryScheduler: () => {} });
      await service.resumePendingTasks();
      await service.processTask(interrupted.id);
      const result = await outbox.get(interrupted.id);
      assert.equal(result.status, boundary === 'result-saved' ? TASK_STATUS.SUCCESS : TASK_STATUS.MANUAL_REVIEW);
      if (boundary === 'remote-submitted') await assert.rejects(service.retry(interrupted.id), { code: 'SYNC_TASK_RECONCILIATION_REQUIRED' });
      const next = await outbox.enqueue({ rmaNo: 'LAB-OTHER', nodeType: node, idempotencyKey: 'other', payload: {} });
      await service.processTask(next.id);
      assert.equal((await outbox.get(next.id)).status, TASK_STATUS.SUCCESS);
      assert.equal(otherCalls, 1);
      assert.equal(await fs.readFile(path.join(dir, 'remote-ledger'), 'utf8'), 'submitted\n');
    });
  }
}
