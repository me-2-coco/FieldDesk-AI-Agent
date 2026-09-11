#!/usr/bin/env node
// Read-only preparation checks. Never starts services, creates data or contacts Recloud.
const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");
const { validateRuntimeConfig } = require("../config/runtime-config");
const { resolveBackupUploadDirectory } = require("../config/upload-paths");

const PATH_KEYS = ["FIELDDESK_DATA_DIRECTORY", "FIELDDESK_UPLOAD_DIRECTORY", "FIELDDESK_BACKUP_DIRECTORY", "LOG_DIRECTORY"];
const contains = (parent, child) => child === parent || child.startsWith(parent + path.sep);
function checkConfig(env) {
  const failures = [];
  try { validateRuntimeConfig(env); } catch (error) {
    failures.push(...(error.details || ["运行配置无效"]));
  }
  if (env.NODE_ENV !== "production") failures.push("NODE_ENV 必须为 production");
  if (env.FIELDDESK_STORAGE_DRIVER !== "sqlite") failures.push("本单机部署方案要求 sqlite 存储");
  for (const key of [...PATH_KEYS, "FIELDDESK_SQLITE_FILE"]) {
    if (!env[key] || !path.isAbsolute(env[key])) failures.push(`${key} 必须显式设置绝对路径`);
  }
  const dirs = PATH_KEYS.filter(key => env[key] && path.isAbsolute(env[key]));
  for (let i = 0; i < dirs.length; i++) {
    for (let j = i + 1; j < dirs.length; j++) {
      const a = path.resolve(env[dirs[i]]); const b = path.resolve(env[dirs[j]]);
      if (contains(a, b) || contains(b, a)) failures.push(`${dirs[i]} 与 ${dirs[j]} 不得重叠`);
    }
  }
  if (env.FIELDDESK_SQLITE_FILE && env.FIELDDESK_DATA_DIRECTORY &&
    path.dirname(path.resolve(env.FIELDDESK_SQLITE_FILE)) !== path.resolve(env.FIELDDESK_DATA_DIRECTORY)) {
    failures.push("SQLite 文件必须位于已纳入备份的数据目录下");
  }
  try { resolveBackupUploadDirectory(env); } catch { failures.push("附件与备份附件目录配置不一致"); }
  try {
    const origin = new URL(env.FRONTEND_ORIGIN);
    if (origin.protocol !== "https:" || origin.hostname === "example.com" || origin.hostname.endsWith(".example.com") || origin.username || origin.password) throw new Error();
  } catch { failures.push("FRONTEND_ORIGIN 必须配置实际 HTTPS 域名，不能使用模板占位域名"); }
  if (env.TRUST_PROXY !== "loopback") failures.push("同机 Nginx 模板要求 TRUST_PROXY=loopback");
  // This preparation profile matches the checked-in proxy template, not every possible deployment.
  if (env.REQUEST_BODY_LIMIT !== "140mb" || Number(env.UPLOAD_MAX_FILE_BYTES) !== 100000000) {
    failures.push("上传大小配置须与当前 140m 代理模板及 100MB 文件验收口径一致");
  }
  return failures;
}

function checkHost(env, { platform = process.platform, fileSystem = fs } = {}) {
  const failures = [];
  if (platform !== "linux") failures.push("目标部署方案需要在 Linux 服务器核验，本机结果不能替代");
  if (process.getuid?.() === 0) failures.push("请以 fielddesk 服务账号运行检查，root 可写不代表服务账号可写");
  for (const key of PATH_KEYS) {
    if (!env[key] || !path.isAbsolute(env[key])) continue;
    try {
      const stat = fileSystem.lstatSync(env[key]);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
      fileSystem.accessSync(env[key], fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    } catch { failures.push(`${key} 目录不存在、不是普通目录或当前账号没有读写访问权限`); }
  }
  return failures;
}

function main(args = process.argv.slice(2)) {
  const configOnly = args.includes("--config-only");
  const envIndex = args.indexOf("--env-file");
  if (envIndex < 0 || !args[envIndex + 1] || args[envIndex + 1].startsWith("--")) {
    console.error("用法：node scripts/production-preflight.js --env-file <配置文件> [--config-only]");
    return 2;
  }
  let env;
  try { env = parseEnv(fs.readFileSync(args[envIndex + 1], "utf8")); }
  catch { console.error("无法读取或解析指定配置文件；未输出配置内容"); return 2; }
  const failures = checkConfig(env);
  if (!configOnly) failures.push(...checkHost(env));
  for (const failure of failures) console.error(`未通过：${failure}`);
  console.log(configOnly ? "范围：仅配置静态检查" : "范围：配置与当前账号目录权限检查");
  console.log("不包含 Nginx/systemd 实际运行、远端业务、并发容量或备份恢复验收；未改动任何数据。");
  return failures.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { checkConfig, checkHost, main };
