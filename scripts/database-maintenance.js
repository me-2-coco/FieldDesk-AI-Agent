#!/usr/bin/env node
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const command = process.argv[2];
const source = path.resolve(process.env.FIELDDESK_DATA_DIRECTORY || path.join(__dirname, "..", "database", "data"));
const backupRoot = path.resolve(process.env.FIELDDESK_BACKUP_DIRECTORY || path.join(__dirname, "..", "backups"));
const sqliteFile = path.resolve(process.env.FIELDDESK_SQLITE_FILE || path.join(source, "fielddesk.sqlite"));
const MANIFEST_FILE = "fielddesk-backup-manifest.json";

function assertInside(location, root) {
  if (location !== root && !location.startsWith(`${root}${path.sep}`)) throw new Error("路径超出允许目录");
}

async function copyDirectory(from, to) {
  await fsp.mkdir(to, { recursive: true, mode: 0o700 });
  for (const entry of await fsp.readdir(from, { withFileTypes: true }).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error))) {
    const sourcePath = path.join(from, entry.name);
    const targetPath = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDirectory(sourcePath, targetPath);
    else await fsp.copyFile(sourcePath, targetPath);
  }
}

async function fileDigest(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(await fsp.readFile(filePath));
  return hash.digest("hex");
}

async function backupFiles(root, current = root) {
  const files = [];
  for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
    if (entry.name === MANIFEST_FILE) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await backupFiles(root, absolute));
    else if (entry.isFile()) {
      const relative = path.relative(root, absolute);
      const stat = await fsp.stat(absolute);
      files.push({ path: relative, size: stat.size, sha256: await fileDigest(absolute) });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function writeManifest(directory) {
  const manifest = { version: 1, createdAt: new Date().toISOString(), files: await backupFiles(directory) };
  await fsp.writeFile(path.join(directory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

async function verifyBackup(directory) {
  assertInside(directory, backupRoot);
  const manifestPath = path.join(directory, MANIFEST_FILE);
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") throw new Error("备份缺少完整性校验清单");
    throw error;
  }));
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error("备份校验清单格式无效");
  for (const item of manifest.files) {
    const relative = String(item.path || "");
    const absolute = path.resolve(directory, relative);
    assertInside(absolute, directory);
    const stat = await fsp.stat(absolute).catch(() => null);
    if (!stat?.isFile() || stat.size !== item.size || await fileDigest(absolute) !== item.sha256) {
      throw new Error(`备份完整性校验失败：${relative}`);
    }
  }
  const actualFiles = await backupFiles(directory);
  if (actualFiles.length !== manifest.files.length) throw new Error("备份完整性校验失败：文件数量不一致");
  return manifest;
}

async function init() {
  await fsp.mkdir(source, { recursive: true, mode: 0o700 });
  if (String(process.env.FIELDDESK_STORAGE_DRIVER || "json") === "sqlite") {
    const database = new DatabaseSync(sqliteFile);
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS fielddesk_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS fielddesk_documents(namespace TEXT PRIMARY KEY,payload TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL)");
    database.close();
  }
}

async function migrate() {
  await init();
  if (String(process.env.FIELDDESK_STORAGE_DRIVER || "json") !== "sqlite") return;
  const database = new DatabaseSync(sqliteFile);
  database.exec("BEGIN IMMEDIATE; INSERT OR IGNORE INTO fielddesk_schema_migrations(version,applied_at) VALUES(1,datetime('now')); COMMIT;");
  database.close();
}

async function backup() {
  await init();
  await fsp.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const destination = path.join(backupRoot, new Date().toISOString().replace(/[:.]/g, "-"));
  await copyDirectory(source, destination);
  await writeManifest(destination);
  await verifyBackup(destination);
  const retentionDays = Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS || 30));
  const cutoff = Date.now() - retentionDays * 86400_000;
  for (const entry of await fsp.readdir(backupRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && (await fsp.stat(path.join(backupRoot, entry.name))).mtimeMs < cutoff) await fsp.rm(path.join(backupRoot, entry.name), { recursive: true, force: true });
  }
  process.stdout.write(`${destination}\n`);
}

async function restore() {
  const backup = path.resolve(process.argv[3] || "");
  if (!process.argv.includes("--confirm") || !backup) throw new Error("恢复需要指定备份目录并使用 --confirm");
  assertInside(backup, backupRoot);
  if (!fs.existsSync(backup)) throw new Error("备份不存在");
  await verifyBackup(backup);
  await fsp.mkdir(source, { recursive: true, mode: 0o700 });
  for (const entry of await fsp.readdir(backup, { withFileTypes: true })) {
    if (entry.name === MANIFEST_FILE) continue;
    const sourcePath = path.join(backup, entry.name);
    const targetPath = path.join(source, entry.name);
    if (entry.isDirectory()) await copyDirectory(sourcePath, targetPath);
    else await fsp.copyFile(sourcePath, targetPath);
  }
}

async function verify() {
  const backup = path.resolve(process.argv[3] || "");
  if (!backup) throw new Error("校验需要指定备份目录");
  await verifyBackup(backup);
  process.stdout.write("备份完整性校验通过\n");
}

async function exportData() {
  const destination = path.resolve(process.argv[3] || path.join(backupRoot, `export-${Date.now()}`));
  assertInside(destination, backupRoot);
  await copyDirectory(source, destination);
  process.stdout.write(`${destination}\n`);
}

({ init, migrate, backup, restore, verify, export: exportData }[command]?.() || Promise.reject(new Error("命令必须是 init、migrate、backup、restore、verify 或 export")))
  .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
