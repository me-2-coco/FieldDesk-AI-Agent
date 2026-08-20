const REPAIR_LEVEL_RANK = Object.freeze({ 小修: 1, 中修: 2, 大修: 3 });

function normalizeLevel(value) {
  const level = String(value || "").trim();
  return Object.hasOwn(REPAIR_LEVEL_RANK, level) ? level : "";
}

function resolveOutOfWarrantyFee(modelRepairFees = {}, usedParts = []) {
  if (!Array.isArray(usedParts) || usedParts.length === 0) {
    return { status: "PARTS_REQUIRED", canPrice: false };
  }
  const normalized = usedParts.map((part) => ({
    partCode: String(part.partCode || part.code || "").trim(),
    partName: String(part.partName || part.name || "").trim(),
    repairLevel: normalizeLevel(part.repairLevel),
  }));
  const unresolvedParts = normalized.filter((part) => !part.repairLevel);
  if (unresolvedParts.length) {
    return { status: "PART_LEVEL_MISSING", canPrice: false, unresolvedParts };
  }
  const highestLevel = normalized
    .map((part) => part.repairLevel)
    .sort((left, right) => REPAIR_LEVEL_RANK[right] - REPAIR_LEVEL_RANK[left])[0];
  const fee = Number(modelRepairFees[highestLevel]);
  if (!Number.isFinite(fee) || fee <= 0) {
    return { status: "MODEL_FEE_MISSING", canPrice: false, highestLevel };
  }
  return { status: "READY", canPrice: true, highestLevel, fee };
}

module.exports = { REPAIR_LEVEL_RANK, resolveOutOfWarrantyFee };
