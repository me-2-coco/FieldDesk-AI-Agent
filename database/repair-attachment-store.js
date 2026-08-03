const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_DIRECTORY = path.join(__dirname, "uploads", "repairs");

class LocalRepairAttachmentStore {
  constructor(directory = DEFAULT_DIRECTORY) {
    this.directory = directory;
  }

  async save({ rmaNo, name, mimeType, data }) {
    const orderNo = String(rmaNo || "").trim();
    const safeName = path.basename(String(name || "attachment"));
    const type = String(mimeType || "");
    const content = String(data || "");
    if (!orderNo || !/^(image|video)\//.test(type) || !content) {
      throw Object.assign(new Error("仅支持维修照片或视频"), {
        code: "REPAIR_ATTACHMENT_INVALID", status: 400,
      });
    }
    const payload = content.includes(",") ? content.slice(content.indexOf(",") + 1) : content;
    const buffer = Buffer.from(payload, "base64");
    if (!buffer.length || buffer.length > 25 * 1024 * 1024) {
      throw Object.assign(new Error("附件为空或超过 25MB"), {
        code: "REPAIR_ATTACHMENT_INVALID", status: 400,
      });
    }
    const extension = path.extname(safeName).replace(/[^.a-zA-Z0-9]/g, "").slice(0, 10);
    const fileName = `${crypto.randomUUID()}${extension}`;
    const orderDirectory = path.join(this.directory, crypto.createHash("sha256").update(orderNo).digest("hex"));
    await fs.mkdir(orderDirectory, { recursive: true });
    await fs.writeFile(path.join(orderDirectory, fileName), buffer, { mode: 0o600 });
    return { id: crypto.randomUUID(), name: safeName, mimeType: type, fileName, size: buffer.length, localOnly: true };
  }
}

module.exports = { LocalRepairAttachmentStore, DEFAULT_DIRECTORY };
