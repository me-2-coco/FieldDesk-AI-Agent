const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function uncertain() {
  return Object.assign(new Error('该配件已尝试保存，结果须先只读核对，禁止再次新增'), {
    code: 'RECLOUD_PART_WRITE_UNCERTAIN', phase: 'PARTS', status: 409, resultUnknown: true, permanent: true,
  });
}
function blocksPartRetry(code) {
  return ['RECLOUD_PART_WRITE_UNCERTAIN', 'RECLOUD_PART_REMOTE_CONFLICT',
    'RECLOUD_REPAIR_PART_POSTVERIFY_FAILED', 'RECLOUD_REPAIR_PART_PRECHECK_FAILED'].includes(code);
}
class RecloudPartWriteGuard {
  constructor(directory = path.join(process.env.FIELDDESK_DATA_DIRECTORY || path.join(__dirname, '../database/data'), 'part-write-intents')) {
    this.directory = directory;
  }
  file(rmaNo, code) {
    if (!String(rmaNo || '').trim() || !String(code || '').trim()) throw uncertain();
    return path.join(this.directory, crypto.createHash('sha256').update(JSON.stringify([
      String(rmaNo).trim(), String(code).trim().toUpperCase(),
    ])).digest('hex') + '.json');
  }
  async assertUnattempted(rmaNo, code) {
    try { await fs.access(this.file(rmaNo, code)); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw uncertain();
  }
  async claim(rmaNo, code) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await fs.open(this.file(rmaNo, code), 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ attemptedAt: new Date().toISOString() }));
      await handle.sync();
    } catch (error) { if (error.code === 'EEXIST') throw uncertain(); throw error; }
    finally { await handle?.close(); }
  }
}
function existingPartMatches(parts, part) {
  const code = String(part.partCode || '').trim().toUpperCase();
  const matches = parts.filter(row => String(row.partCode || '').trim().toUpperCase() === code);
  if (!matches.length) return false;
  if (matches.length !== 1 || Number(matches[0].quantity) !== Number(part.quantity)) {
    throw Object.assign(new Error('瑞云已有重复配件或数量不一致，禁止继续新增'), {
      code: 'RECLOUD_PART_REMOTE_CONFLICT', phase: 'PARTS', status: 409, permanent: true,
    });
  }
  return true;
}
module.exports = { RecloudPartWriteGuard, existingPartMatches, blocksPartRetry };
