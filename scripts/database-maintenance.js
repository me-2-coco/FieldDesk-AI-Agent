#!/usr/bin/env node
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const command = process.argv[2];
const source = path.resolve(process.env.FIELDDESK_DATA_DIRECTORY || path.join(__dirname, "..", "database", "data"));
const backupRoot = path.resolve(process.env.FIELDDESK_BACKUP_DIRECTORY || path.join(__dirname, "..", "backups"));
const sqliteFile = path.resolve(process.env.FIELDDESK_SQLITE_FILE || path.join(source, "fielddesk.sqlite"));

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
  await fsp.mkdir(source, { recursive: true, mode: 0o700 });
  await copyDirectory(backup, source);
}

async function exportData() {
  const destination = path.resolve(process.argv[3] || path.join(backupRoot, `export-${Date.now()}`));
  assertInside(destination, backupRoot);
  await copyDirectory(source, destination);
  process.stdout.write(`${destination}\n`);
}

({ init, migrate, backup, restore, export: exportData }[command]?.() || Promise.reject(new Error("命令必须是 init、migrate、backup、restore 或 export")))
  .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
