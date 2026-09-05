const FIELD_LABELS = {
  rmaNo: ["寄修单号", "RMA单号", "RMA 单号"],
  customerName: [
    "客户",
    "反馈人",
    "用户姓名",
    "客户姓名",
    "联系人",
    "联系人姓名",
    "姓名",
  ],
  customerPhone: [
    "反馈电话",
    "用户手机号",
    "客户手机号",
    "联系电话",
    "联系手机",
    "手机号码",
    "手机号",
  ],
  customerAddress: ["所在地区/地址", "用户地址", "客户地址", "联系地址"],
  customerRegion: ["所在地区", "地区", "省市区"],
  customerDetailedAddress: ["详细地址", "地址"],
  reportedFault: ["用户报修描述", "报修描述", "故障描述", "描述"],
  pickupLogisticsNo: ["取件物流单号", "取件运单号", "取件单号"],
  technicianName: ["服务人员", "维修师傅"],
  orderStatus: ["寄修单状态", "工单状态", "维修状态", "当前状态"],
  receiptStatus: ["签收状态", "取件签收状态"],
  pickupStatus: ["取件物流状态"],
  receiptSignedAt: ["取件物流签收时间", "签收时间"],
};

const { classifyRecloudReceiptState } = require("./recloud-receipt-state");

class RecloudQueryError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "RecloudQueryError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.missingFields = options.missingFields ?? [];
  }
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function normalizeFieldTitle(value) {
  return normalizeText(value).replace(/[：:]$/, "").trim();
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

function extractElementBlocksByClass(html, targetClass) {
  const source = String(html || "");
  const tagPattern = /<\/?([a-z][\w-]*)\b[^>]*>/gi;
  const stack = [];
  const active = [];
  const blocks = [];
  let match;

  while ((match = tagPattern.exec(source))) {
    const tagText = match[0];
    const tagName = match[1].toLowerCase();
    const isClosing = tagText.startsWith("</");
    const isSelfClosing = /\/>$/.test(tagText);

    if (!isClosing) {
      const classMatch = tagText.match(/\bclass\s*=\s*(["'])(.*?)\1/i);
      const classes = classMatch ? classMatch[2].split(/\s+/) : [];
      const depth = stack.length;
      if (classes.includes(targetClass)) {
        active.push({
          tagName,
          depth,
          openTag: tagText,
          contentStart: tagPattern.lastIndex,
        });
      }
      if (!isSelfClosing) stack.push(tagName);
      continue;
    }

    const depth = Math.max(0, stack.length - 1);
    stack.pop();
    for (let index = active.length - 1; index >= 0; index -= 1) {
      const item = active[index];
      if (item.tagName === tagName && item.depth === depth) {
        blocks.push({
          openTag: item.openTag,
          innerHtml: source.slice(item.contentStart, match.index),
        });
        active.splice(index, 1);
        break;
      }
    }
  }

  return blocks;
}

function readAttribute(openTag, attributeName) {
  const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(openTag || "").match(
    new RegExp(`\\b${escapedName}\\s*=\\s*([\"'])(.*?)\\1`, "i")
  );
  return match ? decodeHtmlEntities(match[2]) : "";
}

function extractRtxpcFormItemPairs(html) {
  return extractElementBlocksByClass(html, "rtxpc-form-item")
    .map(({ openTag, innerHtml }) => {
      const labelMatch = innerHtml.match(
        /<label\b[^>]*>([\s\S]*?)<\/label>/i
      );
      const labelBlock = extractElementBlocksByClass(
        innerHtml,
        "rtxpc-form-item__label"
      )[0];
      const contentBlock = extractElementBlocksByClass(
        innerHtml,
        "rtxpc-form-item__content"
      )[0];
      const title =
        readAttribute(openTag, "fieldTitle") ||
        readAttribute(openTag, "field-title") ||
        htmlToText(labelMatch?.[1] || labelBlock?.innerHtml || "");
      const value = htmlToText(contentBlock?.innerHtml || "");
      return [normalizeFieldTitle(title), value];
    })
    .filter(([title, value]) => title && value);
}

function selectProductLine(headers, rows, logger = console) {
  const normalizedHeaders = headers.map(normalizeFieldTitle);
  const productLineIndex = normalizedHeaders.indexOf("产品线");
  if (productLineIndex < 0 || rows.length === 0) return "";

  const operationIndex = normalizedHeaders.indexOf("操作");
  const pendingRows =
    operationIndex >= 0
      ? rows.filter((row) => /签收/.test(normalizeText(row[operationIndex])))
      : [];
  const candidates = pendingRows.length > 0 ? pendingRows : rows;

  if (candidates.length > 1) {
    logger.warn("RECLOUD_PRODUCT_LINE: ambiguous_rows_using_first");
  }

  return normalizeText(candidates[0]?.[productLineIndex]);
}

function extractProductLineFromHtml(html, logger = console) {
  const tables = String(html || "").match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) || [];
  for (const table of tables) {
    const headerRow = table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/i)?.[0] || "";
    const headers = [...headerRow.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)]
      .map((match) => htmlToText(match[1]));
    if (!headers.map(normalizeFieldTitle).includes("产品线")) continue;

    const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((match) =>
        [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
          .map((cell) => htmlToText(cell[1]))
      )
      .filter((cells) => cells.length > 0);
    return selectProductLine(headers, rows, logger);
  }
  return "";
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
  const normalizedLabels = labels.map(normalizeFieldTitle);
  for (const expectedLabel of normalizedLabels) {
    const pair = pairs.find(
      ([label]) => normalizeFieldTitle(label) === expectedLabel
    );
    if (pair && normalizeText(pair[1])) return normalizeText(pair[1]);
  }
  return "";
}

function joinAddressParts(parts) {
  const uniqueParts = [...new Set(parts.map(normalizeText).filter(Boolean))];
  return uniqueParts.join(" ");
}

function formatCustomerPhone(value, options = {}) {
  const phone = normalizeText(value);
  if (options.allowFullPhone === true && /^1[3-9]\d{9}$/.test(phone)) {
    return phone;
  }
  const masked = phone.replace(
    /\b(1[3-9]\d)\d{4}(\d{4})\b/g,
    "$1****$2"
  );
  if (!masked.includes("*") || /\b1[3-9]\d{9}\b/.test(masked)) {
    throw new RecloudQueryError(
      "RECLOUD_SCHEMA_CHANGED",
      "瑞云手机号格式无法安全脱敏",
      {
        status: 502,
        retryable: false,
        missingFields: ["customer.phoneMasked"],
      }
    );
  }
  return masked;
}

function extractRmaNoFromTitle(text) {
  const match = String(text || "").match(
    /RMA[\s\S]{0,200}?(JXTH\d+)/i
  );
  return match ? match[1].toUpperCase() : "";
}

function parseRmaFieldPairs(pairs, logisticsNo = "", options = {}) {
  const normalizedPairs = pairs.map(([label, value]) => [
    normalizeFieldTitle(label),
    normalizeText(value),
  ]);
  const combinedAddress = findFieldValue(
    normalizedPairs,
    FIELD_LABELS.customerAddress
  );
  const region = findFieldValue(
    normalizedPairs,
    FIELD_LABELS.customerRegion
  );
  const detailedAddress = findFieldValue(
    normalizedPairs,
    FIELD_LABELS.customerDetailedAddress
  );
  const rawPhone = findFieldValue(normalizedPairs, FIELD_LABELS.customerPhone);
  const detail = {
    logisticsNo: normalizeText(logisticsNo),
    rmaNo:
      findFieldValue(normalizedPairs, FIELD_LABELS.rmaNo) ||
      normalizeText(options.rmaNoFromTitle),
    customer: {
      name: findFieldValue(normalizedPairs, FIELD_LABELS.customerName),
      phoneMasked: rawPhone
        ? formatCustomerPhone(rawPhone, {
            allowFullPhone: options.allowFullPhone,
          })
        : "",
      regionAddress: joinAddressParts([
        combinedAddress || region,
        detailedAddress,
      ]),
    },
    reportedFault: findFieldValue(normalizedPairs, FIELD_LABELS.reportedFault),
    ...(findFieldValue(normalizedPairs, FIELD_LABELS.technicianName)
      ? { technicianName: findFieldValue(normalizedPairs, FIELD_LABELS.technicianName) }
      : {}),
    pickupLogisticsNo: findFieldValue(
      normalizedPairs,
      FIELD_LABELS.pickupLogisticsNo
    ),
    ...(findFieldValue(normalizedPairs, FIELD_LABELS.orderStatus)
      ? { orderStatus: findFieldValue(normalizedPairs, FIELD_LABELS.orderStatus) }
      : {}),
    ...(findFieldValue(normalizedPairs, FIELD_LABELS.receiptStatus)
      ? { receiptStatus: findFieldValue(normalizedPairs, FIELD_LABELS.receiptStatus) }
      : {}),
    ...(findFieldValue(normalizedPairs, FIELD_LABELS.pickupStatus)
      ? { pickupStatus: findFieldValue(normalizedPairs, FIELD_LABELS.pickupStatus) }
      : {}),
    ...(findFieldValue(normalizedPairs, FIELD_LABELS.receiptSignedAt)
      ? { receiptSignedAt: findFieldValue(normalizedPairs, FIELD_LABELS.receiptSignedAt) }
      : {}),
    productLine: normalizeText(options.productLine),
    ...(normalizeText(options.projectCode)
      ? { projectCode: normalizeText(options.projectCode) }
      : {}),
    readOnly: true,
  };

  const receiptState = classifyRecloudReceiptState(detail);
  if (receiptState.receiptRequired !== null) detail.receiptState = receiptState;

  const missingFields = [];
  if (!detail.rmaNo) missingFields.push("rmaNo");
  if (!detail.reportedFault) missingFields.push("reportedFault");
  if (options.requirePickupLogisticsNo !== false && !detail.pickupLogisticsNo) {
    missingFields.push("pickupLogisticsNo");
  }

  if (missingFields.length > 0) {
    throw new RecloudQueryError(
      "RECLOUD_SCHEMA_CHANGED",
      `瑞云 RMA 详情页字段结构已变化：缺少 ${missingFields.join(", ")}`,
      { status: 502, retryable: false, missingFields }
    );
  }

  return detail;
}

function parseRmaDetailHtml(html, logisticsNo = "") {
  const structuralPairs = extractHtmlFieldPairs(html);
  const formItemPairs = extractRtxpcFormItemPairs(html);
  const text = htmlToText(html);
  const textPairs = extractTextFieldPairs(text);
  return parseRmaFieldPairs(
    [...formItemPairs, ...structuralPairs, ...textPairs],
    logisticsNo,
    {
      rmaNoFromTitle: extractRmaNoFromTitle(text),
      productLine: extractProductLineFromHtml(html),
    }
  );
}

module.exports = {
  FIELD_LABELS,
  RecloudQueryError,
  extractHtmlFieldPairs,
  extractRtxpcFormItemPairs,
  extractRmaNoFromTitle,
  extractProductLineFromHtml,
  extractTextFieldPairs,
  htmlToText,
  formatCustomerPhone,
  normalizeFieldTitle,
  parseRmaDetailHtml,
  parseRmaFieldPairs,
  selectProductLine,
};
