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

function buildPricingPreview({ modelRepairFees = {}, usedParts = [], warrantyStatus = "" } = {}) {
  const partsFee = (Array.isArray(usedParts) ? usedParts : []).reduce(
    (sum, part) => sum + (Number(part.retailPrice) || 0) * (Number(part.quantity) || 0),
    0
  );
  const repairSchedule = Object.fromEntries(
    Object.keys(REPAIR_LEVEL_RANK).map((level) => [level, Number(modelRepairFees[level]) || 0])
  );

  if (String(warrantyStatus || "").trim() !== "保外") {
    return {
      status: "PREPARED_NOT_APPLIED",
      applied: false,
      canPrice: false,
      warrantyStatus: String(warrantyStatus || "").trim(),
      repairSchedule,
      repairFee: 0,
      partsFee,
      knownTotal: partsFee,
    };
  }

  const repair = resolveOutOfWarrantyFee(modelRepairFees, usedParts);
  return {
    ...repair,
    applied: repair.canPrice === true,
    warrantyStatus: "保外",
    repairSchedule,
    repairFee: repair.canPrice ? repair.fee : 0,
    partsFee,
    knownTotal: partsFee + (repair.canPrice ? repair.fee : 0),
  };
}

module.exports = { REPAIR_LEVEL_RANK, resolveOutOfWarrantyFee, buildPricingPreview };
