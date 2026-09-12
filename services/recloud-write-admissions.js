const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// A durable admission is permission to attempt recovery, never proof of success.
// Bind it to the particular record, so another order cannot borrow permission.
function admissionKey(rmaNo, candidate = {}) {
  if (!rmaNo || !candidate.createdAt || !Number.isFinite(Date.parse(candidate.createdAt))) return null;
  if (candidate.rmaNo && candidate.rmaNo !== rmaNo) return null;
  return crypto.createHash('sha256').update(JSON.stringify([
    rmaNo, candidate.nodeType ? 'task' : 'order', candidate.id || rmaNo,
    candidate.createdAt, candidate.nodeType || '',
  ])).digest('hex');
}

class RecloudWriteAdmissions {
  constructor(file) {
    this.file = file;
    this.entries = {};
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.version !== 1 || !data.entries || Array.isArray(data.entries)
        || typeof data.entries !== 'object'
        || Object.entries(data.entries).some(([key, value]) => !/^[a-f0-9]{64}$/.test(key) || value !== true)) {
        throw Error('INVALID_RECLOUD_WRITE_ADMISSIONS');
      }
      this.entries = data.entries;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  has(key) { return Boolean(key && this.entries[key] === true); }
  grant(key) {
    if (!key) return false;
    if (this.has(key)) return true;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const entries = { ...this.entries, [key]: true };
    const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ version: 1, entries }));
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.file);
      this.entries = entries;
      return true;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
module.exports = { RecloudWriteAdmissions, admissionKey };
