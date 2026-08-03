const fs = require("fs/promises");
const path = require("path");

const DEFAULT_FILE = path.join(__dirname, "data", "recloud-sync-diagnostics.json");

class JsonRecloudSyncDiagnosticsStore {
  constructor(filePath = DEFAULT_FILE) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }
  async read() {
    try { return JSON.parse(await fs.readFile(this.filePath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  }
  async write(data) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
  }
  save(nodeKey, capture) {
    const operation = this.queue.then(async () => {
      const data = await this.read();
      data[nodeKey] = capture;
      await this.write(data);
      return capture;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

module.exports = { DEFAULT_FILE, JsonRecloudSyncDiagnosticsStore };
