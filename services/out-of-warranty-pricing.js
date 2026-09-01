const REPAIR_LEVEL_RANK = Object.freeze({ 小修: 1, 中修: 2, 大修: 3 });

function normalizeLevel(value) {
  const level = String(value || "").trim();
  return Object.hasOwn(REPAIR_LEVEL_RANK, level) ? level : "";
}

function resolvePartsFee(usedParts = []) {
  const unresolvedParts = [];
  let partsFee = 0;
  for (const part of Array.isArray(usedParts) ? usedParts : []) {
    const partCode = String(part?.partCode || part?.code || "").trim();
    const partName = String(part?.partName || part?.name || "").trim();
    const quantity = Number(part?.quantity);
    const rawPrice = part?.retailPrice;
    const retailPrice = Number(rawPrice);
    if (
      rawPrice === null || rawPrice === undefined || rawPrice === "" ||
      !Number.isFinite(retailPrice) || retailPrice < 0 ||
      !Number.isInteger(quantity) || quantity <= 0
    ) {
      unresolvedParts.push({ partCode, partName });
      continue;
    }
    partsFee += retailPrice * quantity;
  }
  return unresolvedParts.length
    ? { status: "PART_PRICE_MISSING", canPrice: false, partsFee: null, unresolvedParts }
    : { status: "READY", canPrice: true, partsFee: Number(partsFee.toFixed(2)), unresolvedParts: [] };
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
  const parts = resolvePartsFee(usedParts);
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
      partsFee: parts.partsFee,
      knownTotal: parts.canPrice ? parts.partsFee : null,
    };
  }

  const repair = resolveOutOfWarrantyFee(modelRepairFees, usedParts);
  const canPrice = repair.canPrice === true && parts.canPrice === true;
  return {
    ...repair,
    ...(parts.canPrice ? {} : { status: parts.status, unresolvedParts: parts.unresolvedParts }),
    canPrice,
    applied: canPrice,
    warrantyStatus: "保外",
    repairSchedule,
    repairFee: repair.canPrice ? repair.fee : 0,
    partsFee: parts.partsFee,
    knownTotal: canPrice ? Number((parts.partsFee + repair.fee).toFixed(2)) : null,
  };
}

module.exports = { REPAIR_LEVEL_RANK, resolvePartsFee, resolveOutOfWarrantyFee, buildPricingPreview };
