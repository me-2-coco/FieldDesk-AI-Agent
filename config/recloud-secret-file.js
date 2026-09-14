const fs = require('node:fs');
const path = require('node:path');

function readRecloudSecretFile(file, username) {
  let fd;
  try {
    if (!path.isAbsolute(file)) throw new Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 16384 ||
      (process.getuid && stat.uid !== 0 && stat.uid !== process.getuid())) throw new Error();
    const bytes = fs.readFileSync(fd);
    let credential;
    try { credential = JSON.parse(bytes.toString('utf8')); } finally { bytes.fill(0); }
    if (credential.username !== username || typeof credential.password !== 'string' || !credential.password) throw new Error();
    return Buffer.from(credential.password, 'utf8');
  } catch {
    throw Object.assign(new Error('瑞云凭据文件不可用，请检查文件权限及账号配置'), {code:'RECLOUD_SECRET_FILE_INVALID'});
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
module.exports = {readRecloudSecretFile};
