const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_DIRECTORY = path.join(__dirname, "uploads", "repairs");

class LocalRepairAttachmentStore {
  constructor(directory = DEFAULT_DIRECTORY, options = {}) {
    this.directory = directory;
    this.maxFileBytes = Number(options.maxFileBytes || process.env.UPLOAD_MAX_FILE_BYTES || 25 * 1024 * 1024);
    this.maxStorageBytes = Number(options.maxStorageBytes || process.env.UPLOAD_MAX_STORAGE_BYTES || 5 * 1024 * 1024 * 1024);
    this.allowedMimeTypes = new Set(options.allowedMimeTypes || ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"]);
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

  async save({ rmaNo, name, mimeType, data }) {
    const orderNo = String(rmaNo || "").trim();
    const safeName = path.basename(String(name || "attachment"));
    const type = String(mimeType || "");
    const content = String(data || "");
    if (!orderNo || !this.allowedMimeTypes.has(type) || !content) {
      throw Object.assign(new Error("仅支持维修照片或视频"), {
        code: "REPAIR_ATTACHMENT_INVALID", status: 400,
      });
    }
    const payload = content.includes(",") ? content.slice(content.indexOf(",") + 1) : content;
    const buffer = Buffer.from(payload, "base64");
    if (!buffer.length || buffer.length > this.maxFileBytes) {
      throw Object.assign(new Error("附件为空或超过 25MB"), {
        code: "REPAIR_ATTACHMENT_INVALID", status: 400,
      });
    }
    const extension = path.extname(safeName).replace(/[^.a-zA-Z0-9]/g, "").slice(0, 10);
    const extensionsByType = {
      "image/jpeg": new Set([".jpg", ".jpeg"]),
      "image/png": new Set([".png"]),
      "image/webp": new Set([".webp"]),
      "video/mp4": new Set([".mp4"]),
      "video/quicktime": new Set([".mov"]),
    };
    const allowedExtensions = extensionsByType[type] || new Set();
    if (extension && !allowedExtensions.has(extension.toLowerCase())) throw Object.assign(new Error("附件扩展名与类型不匹配"), { code: "REPAIR_ATTACHMENT_INVALID", status: 400 });
    if ((await this.storageUsage()) + buffer.length > this.maxStorageBytes) throw Object.assign(new Error("附件存储容量不足"), { code: "ATTACHMENT_STORAGE_LIMIT", status: 507 });
    const fileName = `${crypto.randomUUID()}${extension}`;
    const orderDirectory = path.join(this.directory, crypto.createHash("sha256").update(orderNo).digest("hex"));
    const resolvedRoot = path.resolve(this.directory);
    if (!path.resolve(orderDirectory).startsWith(`${resolvedRoot}${path.sep}`)) throw Object.assign(new Error("附件路径无效"), { code: "ATTACHMENT_PATH_INVALID", status: 400 });
    await fs.mkdir(orderDirectory, { recursive: true });
    await fs.writeFile(path.join(orderDirectory, fileName), buffer, { mode: 0o600 });
    return { id: crypto.randomUUID(), name: safeName, mimeType: type, fileName, size: buffer.length, localOnly: true };
  }
}

module.exports = { LocalRepairAttachmentStore, DEFAULT_DIRECTORY };
