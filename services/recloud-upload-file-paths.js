const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveUploadDirectory } = require('../config/upload-paths');
const MAX_FILE_BYTES = 100_000_000;

// Browser uploads must use file paths: Playwright buffer payloads have a
// 50 MiB aggregate limit. Keep content-addressed files in private upload storage
// so the browser can continue reading them until the remote upload finishes.
async function prepareRecloudUploadPaths(files, root = path.join(resolveUploadDirectory(), 'browser-staging')) {
  for (const file of files) {
    if (!Buffer.isBuffer(file.buffer) || !file.buffer.length || file.buffer.length > MAX_FILE_BYTES) {
      throw Object.assign(new Error('单个附件必须大于0且不超过100MB'), {code:'RECLOUD_UPLOAD_SINGLE_FILE_SIZE_INVALID'});
    }
    if (!file.name || path.basename(file.name) !== file.name || /[\\/]/.test(file.name)) throw new Error('附件名称无效');
  }
  const paths = [];
  for (const file of files) {
    const digest = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const directory = path.join(root, digest);
    await fs.mkdir(directory, {recursive:true, mode:0o700});
    const target = path.join(directory, file.name);
    try { await fs.writeFile(target, file.buffer, {flag:'wx',mode:0o600}); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (crypto.createHash('sha256').update(await fs.readFile(target)).digest('hex') !== digest) throw new Error('上传暂存文件校验失败');
    }
    paths.push(target);
  }
  return paths;
}
module.exports = {prepareRecloudUploadPaths, MAX_FILE_BYTES};
