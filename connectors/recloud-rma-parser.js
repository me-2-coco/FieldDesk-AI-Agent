const FIELD_LABELS = {
  rmaNo: ["寄修单号", "RMA单号", "RMA 单号"],
  customerName: ["用户姓名", "客户姓名", "姓名"],
  customerPhone: ["用户手机号", "客户手机号", "手机号码", "联系电话", "手机号"],
  customerAddress: ["所在地区/地址", "所在地区", "用户地址", "客户地址", "地址"],
  reportedFault: ["用户报修描述", "报修描述", "故障描述"],
  pickupLogisticsNo: ["取件物流单号", "取件运单号", "取件单号"],
};

class RecloudQueryError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "RecloudQueryError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    )
    .replace(/&([a-z]+);/gi, (entity, name) => named[name.toLowerCase()] ?? entity);
}

function htmlToText(value) {
  return normalizeText(
    decodeHtmlEntities(
      String(value || "")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(dd|div|dt|li|p|td|th|tr)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
    )
  );
}

function extractHtmlFieldPairs(html) {
  const pairs = [];
  const source = String(html || "");
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const definitionPattern =
    /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
  let match;

  while ((match = rowPattern.exec(source))) {
    const cells = [...match[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)]
      .map((cell) => htmlToText(cell[1]))
      .filter(Boolean);
    if (cells.length >= 2) pairs.push([cells[0], cells.slice(1).join(" ")]);
  }

  while ((match = definitionPattern.exec(source))) {
    pairs.push([htmlToText(match[1]), htmlToText(match[2])]);
  }

  return pairs;
}

function extractTextFieldPairs(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(normalizeText)
    .filter(Boolean);
  const pairs = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const inlineMatch = line.match(/^(.{1,30}?)[：:]\s*(.+)$/);
    if (inlineMatch) {
      pairs.push([inlineMatch[1], inlineMatch[2]]);
      continue;
    }

    if (Object.values(FIELD_LABELS).flat().includes(line) && lines[index + 1]) {
      pairs.push([line, lines[index + 1]]);
      index += 1;
    }
  }

  return pairs;
}

function findFieldValue(pairs, labels) {
  const normalizedLabels = labels.map(normalizeText);
  const pair = pairs.find(([label]) => normalizedLabels.includes(normalizeText(label)));
  return pair ? normalizeText(pair[1]) : "";
}

function parseRmaFieldPairs(pairs, logisticsNo = "") {
  const normalizedPairs = pairs.map(([label, value]) => [
    normalizeText(label).replace(/[：:]$/, ""),
    normalizeText(value),
  ]);
  const detail = {
    logisticsNo: normalizeText(logisticsNo),
    rmaNo: findFieldValue(normalizedPairs, FIELD_LABELS.rmaNo),
    customer: {
      name: findFieldValue(normalizedPairs, FIELD_LABELS.customerName),
      phoneMasked: findFieldValue(normalizedPairs, FIELD_LABELS.customerPhone),
      regionAddress: findFieldValue(normalizedPairs, FIELD_LABELS.customerAddress),
    },
    reportedFault: findFieldValue(normalizedPairs, FIELD_LABELS.reportedFault),
    pickupLogisticsNo: findFieldValue(
      normalizedPairs,
      FIELD_LABELS.pickupLogisticsNo
    ),
    readOnly: true,
  };

  const missingFields = [];
  if (!detail.rmaNo) missingFields.push("rmaNo");
  if (!detail.customer.name) missingFields.push("customer.name");
  if (!detail.customer.phoneMasked) missingFields.push("customer.phoneMasked");
  if (!detail.customer.regionAddress) missingFields.push("customer.regionAddress");
  if (!detail.reportedFault) missingFields.push("reportedFault");
  if (!detail.pickupLogisticsNo) missingFields.push("pickupLogisticsNo");

  if (missingFields.length > 0) {
    throw new RecloudQueryError(
      "RECLOUD_SCHEMA_CHANGED",
      `瑞云 RMA 详情页字段结构已变化：缺少 ${missingFields.join(", ")}`,
      { status: 502, retryable: false }
    );
  }

  if (
    !detail.customer.phoneMasked.includes("*") ||
    /\b1[3-9]\d{9}\b/.test(detail.customer.phoneMasked)
  ) {
    throw new RecloudQueryError(
      "RECLOUD_SCHEMA_CHANGED",
      "瑞云返回的手机号不是预期的脱敏格式",
      { status: 502, retryable: false }
    );
  }

  return detail;
}

function parseRmaDetailHtml(html, logisticsNo = "") {
  const structuralPairs = extractHtmlFieldPairs(html);
  const textPairs = extractTextFieldPairs(htmlToText(html));
  return parseRmaFieldPairs([...structuralPairs, ...textPairs], logisticsNo);
}

module.exports = {
  FIELD_LABELS,
  RecloudQueryError,
  extractHtmlFieldPairs,
  extractTextFieldPairs,
  htmlToText,
  parseRmaDetailHtml,
  parseRmaFieldPairs,
};
