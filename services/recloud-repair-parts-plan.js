function normalizePartCode(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeQuantity(value) {
  const quantity = Number(value);
  return Number.isInteger(quantity) && quantity > 0 ? quantity : 0;
}

function partsPlanError(message, code, partCode = "") {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  error.partCode = partCode;
  return error;
}

function compactDesiredParts(parts) {
  const compacted = new Map();
  for (const source of Array.isArray(parts) ? parts : []) {
    const partCode = normalizePartCode(source?.partCode || source?.code);
    const quantity = normalizeQuantity(source?.quantity);
    if (!partCode || !quantity) {
      throw partsPlanError("待新增配件编码或数量无效", "RECLOUD_REPAIR_PART_INVALID", partCode);
    }
    const normalized = {
      partCode,
      partName: String(source?.partName || source?.name || "").trim(),
      quantity,
      repairLevel: String(source?.repairLevel || "").trim(),
    };
    const current = compacted.get(partCode);
    if (!current) {
      compacted.set(partCode, normalized);
      continue;
    }
    if (
      current.partName && normalized.partName && current.partName !== normalized.partName ||
      current.repairLevel && normalized.repairLevel && current.repairLevel !== normalized.repairLevel
    ) {
      throw partsPlanError("同一配件编码对应的名称或维修等级不一致", "RECLOUD_REPAIR_PART_CONFLICT", partCode);
    }
    current.quantity += quantity;
    current.partName ||= normalized.partName;
    current.repairLevel ||= normalized.repairLevel;
  }
  return [...compacted.values()];
}

function indexExistingParts(parts) {
  const indexed = new Map();
  for (const source of Array.isArray(parts) ? parts : []) {
    const partCode = normalizePartCode(source?.partCode || source?.code);
    const quantity = normalizeQuantity(source?.quantity);
    if (!partCode || !quantity) continue;
    if (indexed.has(partCode)) {
      throw partsPlanError("瑞云更换件明细存在重复配件编码", "RECLOUD_REPAIR_EXISTING_PART_DUPLICATE", partCode);
    }
    indexed.set(partCode, {
      partCode,
      partName: String(source?.partName || source?.name || "").trim(),
      quantity,
    });
  }
  return indexed;
}

function buildRecloudRepairPartsPlan(desiredParts, existingParts) {
  const desired = compactDesiredParts(desiredParts);
  const existing = indexExistingParts(existingParts);
  const additions = [];
  const skipped = [];
  const conflicts = [];

  for (const part of desired) {
    const found = existing.get(part.partCode);
    if (!found) {
      additions.push(part);
      continue;
    }
    existing.delete(part.partCode);
    if (found.quantity === part.quantity) {
      skipped.push({ partCode: part.partCode, quantity: part.quantity, reason: "ALREADY_MATCHED" });
    } else {
      conflicts.push({
        partCode: part.partCode,
        expectedQuantity: part.quantity,
        existingQuantity: found.quantity,
        reason: "QUANTITY_MISMATCH",
      });
    }
  }
  for (const found of existing.values()) {
    conflicts.push({
      partCode: found.partCode,
      existingQuantity: found.quantity,
      reason: "UNPLANNED_EXISTING_PART",
    });
  }

  return {
    additions,
    skipped,
    conflicts,
    readyToAdd: conflicts.length === 0,
    mayDeleteExisting: false,
    mayUpdateExisting: false,
  };
}

module.exports = {
  normalizePartCode,
  compactDesiredParts,
  indexExistingParts,
  buildRecloudRepairPartsPlan,
};
