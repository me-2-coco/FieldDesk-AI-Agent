const path = require("path");
const { LocalRepairAttachmentStore } = require("./repair-attachment-store");

const DEFAULT_DIRECTORY = path.join(__dirname, "uploads", "shipments");

class LocalShippingAttachmentStore extends LocalRepairAttachmentStore {
  constructor(directory = DEFAULT_DIRECTORY) {
    super(directory);
  }

  async save(input) {
    if (!String(input?.mimeType || "").startsWith("image/")) {
      throw Object.assign(new Error("发货凭证仅支持照片"), {
        code: "SHIPPING_ATTACHMENT_INVALID", status: 400,
      });
    }
    return super.save(input);
  }
}

module.exports = { LocalShippingAttachmentStore, DEFAULT_DIRECTORY };
