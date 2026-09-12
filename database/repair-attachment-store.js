const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const mediaFormats = require("../shared/media-formats.json");

const DEFAULT_DIRECTORY = path.join(__dirname, "uploads", "repairs");
const DEFAULT_MAX_FILE_BYTES = 100_000_000;
const directoryQueues = new Map();

class LocalRepairAttachmentStore {
  constructor(directory = DEFAULT_DIRECTORY, options = {}) {
    this.directory = directory;
    this.maxFileBytes = Number(options.maxFileBytes || process.env.UPLOAD_MAX_FILE_BYTES || DEFAULT_MAX_FILE_BYTES);
    this.maxStorageBytes = Number(options.maxStorageBytes || process.env.UPLOAD_MAX_STORAGE_BYTES || 5 * 1024 * 1024 * 1024);
    this.allowedMimeTypes = new Set(options.allowedMimeTypes || Object.keys(mediaFormats.types));
  }

  async storageUsage(directory = this.directory) {
    let total = 0;
    try {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const location = path.join(directory, entry.name);
        total += entry.isDirectory() ? await this.storageUsage(location) : (await fs.stat(location)).size;
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    return total;
  }

  save(input) {
    // Serialize quota checks and writes across store instances in this process.
    const key = path.resolve(this.directory);
    const previous = directoryQueues.get(key) || Promise.resolve();
    const work = previous.catch(() => {}).then(() => this.saveOnce(input));
    directoryQueues.set(key, work);
    const clear = () => { if (directoryQueues.get(key) === work) directoryQueues.delete(key); };
    work.then(clear, clear);
    return work;
  }

  async saveOnce({ rmaNo, name, mimeType, data }) {
    const orderNo = String(rmaNo || "").trim();
    const safeName = path.basename(String(name || "attachment"));
    const rawType = String(mimeType || "").split(";")[0].trim().toLowerCase();
    const suffix = path.extname(safeName).slice(1).toLowerCase();
    const inferred = Object.entries(mediaFormats.types).find(([, extensions]) => extensions.includes(suffix))?.[0];
    const type = mediaFormats.aliases[rawType] || (["", "application/octet-stream", "binary/octet-stream"].includes(rawType) ? inferred : rawType);
    const content = String(data || "");
    if (!orderNo || !this.allowedMimeTypes.has(type) || !content) {
      throw Object.assign(new Error("仅支持维修照片、视频或 PDF 检测报告"), {
        code: "REPAIR_ATTACHMENT_INVALID", status: 400,
      });
    }
    const payload = content.includes(",") ? content.slice(content.indexOf(",") + 1) : content;
    const buffer = Buffer.from(payload, "base64");
    if (!buffer.length || buffer.length > this.maxFileBytes) {
      const maxFileMb = Math.floor(this.maxFileBytes / 1_000_000);
      throw Object.assign(new Error(`附件为空或超过 ${maxFileMb}MB`), {
        code: "REPAIR_ATTACHMENT_INVALID", status: 400,
      });
    }
    const extension = path.extname(safeName).replace(/[^.a-zA-Z0-9]/g, "").slice(0, 10);
    const allowedExtensions = new Set((mediaFormats.types[type] || []).map(ext => `.${ext}`));
    if (extension && !allowedExtensions.has(extension.toLowerCase())) throw Object.assign(new Error("附件扩展名与类型不匹配"), { code: "REPAIR_ATTACHMENT_INVALID", status: 400 });
    const digest = crypto.createHash("sha256").update(JSON.stringify([orderNo, safeName, type])).update(buffer).digest("hex");
    const fileName = `${digest}${extension}`;
    const orderDirectory = path.join(this.directory, crypto.createHash("sha256").update(orderNo).digest("hex"));
    const resolvedRoot = path.resolve(this.directory);
    if (!path.resolve(orderDirectory).startsWith(`${resolvedRoot}${path.sep}`)) throw Object.assign(new Error("附件路径无效"), { code: "ATTACHMENT_PATH_INVALID", status: 400 });
    await fs.mkdir(orderDirectory, { recursive: true });
    const location = path.join(orderDirectory, fileName);
    const result = { id: digest, name: safeName, mimeType: type, fileName, size: buffer.length, localOnly: true };
    try {
      const existing = await fs.readFile(location);
      if (existing.equals(buffer)) return result;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if ((await this.storageUsage()) + buffer.length > this.maxStorageBytes) throw Object.assign(new Error("附件存储容量不足"), { code: "ATTACHMENT_STORAGE_LIMIT", status: 507 });
    const temporary = `${location}.${crypto.randomUUID()}.tmp`;
    try {
      const file = await fs.open(temporary, "wx", 0o600);
      try { await file.writeFile(buffer); await file.sync(); }
      finally { await file.close(); }
      await fs.rename(temporary, location);
    } finally {
      await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
    return result;
  }

  async read(rmaNo, attachment = {}) {
    const orderNo = String(rmaNo || "").trim();
    const fileName = path.basename(String(attachment.fileName || ""));
    if (!orderNo || !fileName || fileName !== attachment.fileName) {
      throw Object.assign(new Error("附件路径无效"), { code: "ATTACHMENT_PATH_INVALID", status: 400 });
    }
    const orderDirectory = path.join(this.directory, crypto.createHash("sha256").update(orderNo).digest("hex"));
    const location = path.resolve(orderDirectory, fileName);
    const resolvedRoot = path.resolve(this.directory);
    if (!location.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw Object.assign(new Error("附件路径无效"), { code: "ATTACHMENT_PATH_INVALID", status: 400 });
    }
    try { return await fs.readFile(location); }
    catch (error) {
      if (error.code === "ENOENT") throw Object.assign(new Error("附件文件不存在"), { code: "ATTACHMENT_NOT_FOUND", status: 404 });
      throw error;
    }
  }

  async deleteOrder(rmaNo) {
    const orderNo = String(rmaNo || "").trim();
    if (!orderNo) throw Object.assign(new Error("缺少寄修单号"), { code: "RMA_NO_REQUIRED", status: 400 });
    const orderDirectory = path.join(this.directory, crypto.createHash("sha256").update(orderNo).digest("hex"));
    const resolvedRoot = path.resolve(this.directory);
    if (!path.resolve(orderDirectory).startsWith(`${resolvedRoot}${path.sep}`)) {
      throw Object.assign(new Error("附件路径无效"), { code: "ATTACHMENT_PATH_INVALID", status: 400 });
    }
    await fs.rm(orderDirectory, { recursive: true, force: true });
    return { deleted: true };
  }
}

module.exports = { LocalRepairAttachmentStore, DEFAULT_DIRECTORY, DEFAULT_MAX_FILE_BYTES };
