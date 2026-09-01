const path = require("path");

function normalizeAttachmentName(value) {
  return path.basename(String(value || "").trim()).toLowerCase();
}

function normalizeAttachmentSize(value) {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? Math.round(size) : 0;
}

function attachmentPlanError(message, code, fileName = "") {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  error.fileName = fileName;
  return error;
}

function normalizeDesiredAttachments(attachments) {
  const result = [];
  const names = new Set();
  for (const source of Array.isArray(attachments) ? attachments : []) {
    const fileName = path.basename(String(source?.fileName || source?.name || source?.path || "").trim());
    const normalizedName = normalizeAttachmentName(fileName);
    const size = normalizeAttachmentSize(source?.size);
    if (!fileName || !size) {
      throw attachmentPlanError("完工附件缺少文件名或大小", "RECLOUD_REPAIR_ATTACHMENT_INVALID", fileName);
    }
    if (names.has(normalizedName)) {
      throw attachmentPlanError("待上传完工附件存在重复文件名", "RECLOUD_REPAIR_ATTACHMENT_DUPLICATE", fileName);
    }
    names.add(normalizedName);
    result.push({
      fileName,
      normalizedName,
      size,
      mimeType: String(source?.mimeType || source?.type || "").trim().toLowerCase(),
      path: String(source?.path || "").trim(),
    });
  }
  return result;
}

function buildRecloudRepairAttachmentsPlan(desiredAttachments, existingAttachments, options = {}) {
  const desired = normalizeDesiredAttachments(desiredAttachments);
  const existingByName = new Map();
  for (const source of Array.isArray(existingAttachments) ? existingAttachments : []) {
    const fileName = path.basename(String(source?.fileName || source?.name || "").trim());
    const normalizedName = normalizeAttachmentName(fileName);
    if (!normalizedName) continue;
    const entries = existingByName.get(normalizedName) || [];
    entries.push({
      fileName,
      size: normalizeAttachmentSize(source?.size),
      mimeType: String(source?.mimeType || source?.type || "").trim().toLowerCase(),
    });
    existingByName.set(normalizedName, entries);
  }

  const additions = [];
  const skipped = [];
  const conflicts = [];
  const tolerance = Number.isFinite(Number(options.sizeToleranceBytes))
    ? Math.max(0, Number(options.sizeToleranceBytes))
    : 1024;
  for (const attachment of desired) {
    const matches = existingByName.get(attachment.normalizedName) || [];
    if (!matches.length) {
      additions.push(attachment);
      continue;
    }
    if (matches.length > 1) {
      conflicts.push({ fileName: attachment.fileName, reason: "DUPLICATE_EXISTING_NAME", existingCount: matches.length });
      continue;
    }
    const existing = matches[0];
    if (!existing.size) {
      conflicts.push({ fileName: attachment.fileName, reason: "EXISTING_SIZE_UNKNOWN" });
      continue;
    }
    if (Math.abs(existing.size - attachment.size) > tolerance) {
      conflicts.push({
        fileName: attachment.fileName,
        reason: "SIZE_MISMATCH",
        expectedSize: attachment.size,
        existingSize: existing.size,
      });
      continue;
    }
    if (attachment.mimeType && existing.mimeType && attachment.mimeType !== existing.mimeType) {
      conflicts.push({ fileName: attachment.fileName, reason: "TYPE_MISMATCH" });
      continue;
    }
    skipped.push({ fileName: attachment.fileName, reason: "ALREADY_MATCHED" });
  }
  return {
    additions,
    skipped,
    conflicts,
    readyToUpload: conflicts.length === 0,
    ignoredExistingCount: [...existingByName.entries()].filter(([name]) => !desired.some((item) => item.normalizedName === name)).length,
    mayDeleteExisting: false,
    mayOverwriteExisting: false,
  };
}

module.exports = {
  normalizeAttachmentName,
  normalizeAttachmentSize,
  normalizeDesiredAttachments,
  buildRecloudRepairAttachmentsPlan,
};
