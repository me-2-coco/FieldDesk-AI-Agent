const {
  FIELD_LABELS,
  normalizeFieldTitle,
} = require("./recloud-rma-parser");

function isDomDiagnosticsEnabled(env = process.env) {
  return String(env.RECLOUD_DOM_DIAGNOSTICS ?? "false").toLowerCase() === "true";
}

function sanitizeFieldTitle(value) {
  const title = normalizeFieldTitle(value)
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/JXTH[A-Z0-9-]+/gi, "")
    .replace(/\b1[3-9]\d{9}\b/g, "")
    .replace(/\b(?=[A-Z0-9-]{8,}\b)(?=[A-Z0-9-]*\d{5,})[A-Z0-9-]+\b/gi, "")
    .trim()
    .slice(0, 80);

  return title;
}

function sanitizeFieldTitles(values = []) {
  return [...new Set(
    values
      .map(sanitizeFieldTitle)
      .filter(Boolean)
  )].sort((left, right) => left.localeCompare(right, "zh-CN"));
}

async function collectSafeFieldTitles(page) {
  const knownTitles = Object.values(FIELD_LABELS).flat();
  const titles = await page.evaluate((fallbackTitles) => {
    const normalize = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .replace(/[：:]$/, "")
        .trim();

    return [...document.querySelectorAll(".rtxpc-form-item")]
      .map((item) => {
        const label = item.querySelector(
          "label, .rtxpc-form-item__label, [class*='form-item__label']"
        );
        const title =
          item.getAttribute("fieldTitle") ||
          item.getAttribute("field-title") ||
          item.fieldTitle ||
          label?.textContent ||
          "";
        return normalize(title);
      })
      .filter((title) => title && (fallbackTitles.includes(title) || title.length <= 40));
  }, knownTitles);

  return sanitizeFieldTitles(titles);
}

function logSafeFieldTitles(fieldTitles, logger = console) {
  logger.warn(
    "RECLOUD_FIELD_TITLES:",
    JSON.stringify(sanitizeFieldTitles(fieldTitles))
  );
}

module.exports = {
  collectSafeFieldTitles,
  isDomDiagnosticsEnabled,
  logSafeFieldTitles,
  sanitizeFieldTitle,
  sanitizeFieldTitles,
};
