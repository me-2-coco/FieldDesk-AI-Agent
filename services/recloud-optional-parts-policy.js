const OPTIONAL_WHEN_OUT_OF_STOCK_PART_CODES = new Set([
  "20020100011511", // 售后通用主机物流箱
  "20020100011510", // 售后通用大号物流箱
  "20020100011509", // 售后通用中号物流箱
  "04170200001111", // 售后通用中号物流箱(临时)
  "04170200001110", // 售后通用大号物流箱(临时)
  "04170200001112", // 售后通用主机物流箱(临时)
]);

function normalizePartCode(value) {
  return String(value || "").trim().toUpperCase();
}

function isOptionalWhenOutOfStockPart(part) {
  return OPTIONAL_WHEN_OUT_OF_STOCK_PART_CODES.has(normalizePartCode(part?.partCode ?? part));
}

function onlyOptionalWhenOutOfStockParts(parts) {
  return Array.isArray(parts) && parts.length > 0 && parts.every(isOptionalWhenOutOfStockPart);
}

module.exports = {
  OPTIONAL_WHEN_OUT_OF_STOCK_PART_CODES,
  isOptionalWhenOutOfStockPart,
  onlyOptionalWhenOutOfStockParts,
};
