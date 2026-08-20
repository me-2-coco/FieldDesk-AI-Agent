const fs = require("fs/promises");
const path = require("path");

class MemoryDocumentBackend {
  constructor(initialValue) {
    this.value = structuredClone(initialValue);
    this.queue = Promise.resolve();
  }
  async read() { return structuredClone(this.value); }
  async write(value) { this.value = structuredClone(value); }
  update(work) {
    const operation = this.queue.then(async () => {
      const value = await this.read();
      const result = await work(value);
      await this.write(value);
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

class JsonDocumentBackend extends MemoryDocumentBackend {
  constructor(filePath, initialValue) {
    super(initialValue);
    this.filePath = filePath;
    this.initialValue = structuredClone(initialValue);
  }
  async read() {
    try { return JSON.parse(await fs.readFile(this.filePath, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return structuredClone(this.initialValue);
      throw error;
    }
  }
  async write(value) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
  }
}

class SqliteDocumentBackend extends MemoryDocumentBackend {
  constructor(filePath, namespace, initialValue) {
    super(initialValue);
    const { DatabaseSync } = require("node:sqlite");
    this.database = new DatabaseSync(filePath);
    this.namespace = namespace;
    this.initialValue = structuredClone(initialValue);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS fielddesk_documents (namespace TEXT PRIMARY KEY, payload TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL)");
  }
  async read() {
    const row = this.database.prepare("SELECT payload FROM fielddesk_documents WHERE namespace = ?").get(this.namespace);
    return row ? JSON.parse(row.payload) : structuredClone(this.initialValue);
  }
  async write(value) {
    this.database.prepare(`INSERT INTO fielddesk_documents(namespace,payload,version,updated_at)
      VALUES(?,?,1,?) ON CONFLICT(namespace) DO UPDATE SET payload=excluded.payload,
      version=fielddesk_documents.version+1,updated_at=excluded.updated_at`)
      .run(this.namespace, JSON.stringify(value), new Date().toISOString());
  }
  close() { this.database.close(); }
}

function createDocumentBackend({ driver = "json", filePath, namespace, initialValue }) {
  if (driver === "memory") return new MemoryDocumentBackend(initialValue);
  if (driver === "sqlite") return new SqliteDocumentBackend(filePath, namespace, initialValue);
  if (driver !== "json") throw new Error(`不支持的存储驱动: ${driver}`);
  return new JsonDocumentBackend(filePath, initialValue);
}

module.exports = { MemoryDocumentBackend, JsonDocumentBackend, SqliteDocumentBackend, createDocumentBackend };
