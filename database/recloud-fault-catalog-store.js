const fs = require("fs/promises");
const path = require("path");

const DEFAULT_FILE = path.join(__dirname, "data", "recloud-fault-catalog.json");

function normalizeItems(items) {
  return [...new Set((items || []).map((item) => String(item || "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

class JsonRecloudFaultCatalogStore {
  constructor(filePath = DEFAULT_FILE) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      return { items: normalizeItems(data.items), syncedAt: data.syncedAt || null, complete: data.complete === true };
    } catch (error) {
      if (error.code === "ENOENT") return { items: [], syncedAt: null, complete: false };
      throw error;
    }
  }

  async search(keyword, limit = 80) {
    const catalog = await this.read();
    const query = String(keyword || "").trim().toLocaleLowerCase("zh-CN");
    const completePaths = catalog.items.filter((item) => item.split("/").filter(Boolean).length >= 3);
    const items = query
      ? completePaths.filter((item) => item.toLocaleLowerCase("zh-CN").includes(query))
      : completePaths;
    return { ...catalog, complete: catalog.complete && completePaths.length === catalog.items.length, items: items.slice(0, Math.max(1, Math.min(Number(limit) || 80, 200))) };
  }

  replace(items, complete = true) {
    const normalized = normalizeItems(items);
    if (!normalized.length) throw new Error("瑞云三级故障目录为空，拒绝覆盖本地目录");
    const operation = this.queue.then(async () => {
      const data = { source: "RECLOUD", syncedAt: new Date().toISOString(), complete, items: normalized };
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, this.filePath);
      return data;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async merge(items) {
    const existing = await this.read();
    const merged = normalizeItems([...existing.items, ...(items || [])]);
    if (!merged.length) return existing;
    return this.replace(merged, existing.complete === true);
  }
}

module.exports = { DEFAULT_FILE, JsonRecloudFaultCatalogStore, normalizeItems };
