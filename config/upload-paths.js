const path = require("node:path");

function resolveUploadDirectory(env = process.env) {
  return path.resolve(env.FIELDDESK_UPLOAD_DIRECTORY || path.join(__dirname, "..", "database", "uploads"));
}

function resolveBackupUploadDirectory(env = process.env) {
  const explicit = env.FIELDDESK_UPLOAD_DIRECTORY;
  const override = env.FIELDDESK_BACKUP_UPLOAD_DIRECTORY;
  if (explicit && override && path.resolve(explicit) !== path.resolve(override)) {
    throw new Error("附件存储目录与备份附件目录不一致，请统一配置");
  }
  return path.resolve(explicit || override || (env.FIELDDESK_DATA_DIRECTORY
    ? path.join(env.FIELDDESK_DATA_DIRECTORY, "..", "uploads")
    : resolveUploadDirectory(env)));
}

module.exports = { resolveUploadDirectory, resolveBackupUploadDirectory };
