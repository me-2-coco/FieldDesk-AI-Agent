const DEFAULT_RANGE = "A1:Z5000";

const HEADER_ALIASES = Object.freeze({
  model: ["型号", "产品型号", "机器型号", "机型型号", "model"],
  modelCode: ["产品型号的编码", "产品型号编码", "型号编码"],
  productLine: ["产品线", "品类", "产品品类", "类型"],
  productName: ["产品名称", "产品名", "产品"],
  projectCode: ["项目编码", "项目代码", "项目号"],
  snPrefix: ["SN前缀", "SN规则", "序列号规则"],
  majorRepairFee: ["大修", "大修费", "大修费用"],
  mediumRepairFee: ["中修", "中修费", "中修费用"],
  minorRepairFee: ["小修", "小修费", "小修费用"],
});

function normalize(value) {
  return String(value || "").trim();
}

function comparable(value) {
  return normalize(value).toUpperCase().replace(/[\s_-]+/g, "");
}

function comparableProjectCode(value) {
  return normalize(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function findColumn(headers, aliases) {
  const normalized = headers.map((header) => comparable(header));
  return aliases.map(comparable).map((alias) => normalized.indexOf(alias)).find((index) => index >= 0) ?? -1;
}

function parseModelRows(values = []) {
  if (!Array.isArray(values) || values.length < 2) return [];
  const headerRowIndex = values.slice(0, 10).findIndex((row) => {
    const cells = Array.isArray(row) ? row.map(comparable) : [];
    return cells.some((cell) => HEADER_ALIASES.projectCode.map(comparable).includes(cell)) &&
      cells.some((cell) => [...HEADER_ALIASES.model, ...HEADER_ALIASES.modelCode].map(comparable).includes(cell));
  });
  if (headerRowIndex < 0) {
    const error = new Error("飞书型号表未找到列头");
    error.code = "FEISHU_MODEL_HEADER_MISSING";
    throw error;
  }
  const headers = values[headerRowIndex].map(normalize);
  const columns = Object.fromEntries(
    Object.entries(HEADER_ALIASES).map(([key, aliases]) => [key, findColumn(headers, aliases)])
  );
  if (columns.model < 0 || columns.modelCode < 0 || columns.projectCode < 0) {
    const error = new Error("飞书型号表缺少机器型号、项目编码或产品型号编码列");
    error.code = "FEISHU_MODEL_COLUMN_MISSING";
    throw error;
  }
  return values.slice(headerRowIndex + 1).map((row, index) => ({
    sourceRow: headerRowIndex + index + 2,
    model: normalize(row[columns.model]),
    modelCode: normalize(row[columns.modelCode]),
    productLine: columns.productLine >= 0 ? normalize(row[columns.productLine]) : "",
    productName: columns.productName >= 0 ? normalize(row[columns.productName]) : "",
    projectCode: columns.projectCode >= 0 ? normalize(row[columns.projectCode]) : "",
    snPrefix: columns.snPrefix >= 0 ? normalize(row[columns.snPrefix]) : "",
    repairFees: {
      大修: columns.majorRepairFee >= 0 ? Number(row[columns.majorRepairFee]) || 0 : 0,
      中修: columns.mediumRepairFee >= 0 ? Number(row[columns.mediumRepairFee]) || 0 : 0,
      小修: columns.minorRepairFee >= 0 ? Number(row[columns.minorRepairFee]) || 0 : 0,
    },
  })).filter((row) => row.model && row.modelCode && row.projectCode);
}

function getSnProjectMatch(sn) {
  const prefix = comparable(sn).slice(0, 6);
  if (prefix.length < 6) return { projectCode: "", comparisonLength: 0 };
  return prefix[5] === "0"
    ? { projectCode: prefix.slice(0, 5), comparisonLength: 5 }
    : { projectCode: prefix, comparisonLength: 6 };
}

function projectCodeMatches(value, expected) {
  const expectedCode = comparableProjectCode(expected);
  const extractedCodes = normalize(value).toUpperCase().match(/[A-Z]\d{4}[A-Z0-9]?/g) || [];
  const candidates = [
    ...extractedCodes.map(comparableProjectCode),
    ...normalize(value).split(/[/,，;；\s]+/).map(comparableProjectCode),
  ].filter(Boolean);
  return candidates.includes(expectedCode);
}

function resolveProjectModel(rows, input = {}) {
  const snProject = getSnProjectMatch(input.sn);
  if (!snProject.projectCode) return { status: "INVALID_SN", canContinue: false, correctionLookupRequired: false };
  const currentProjectCode = comparableProjectCode(input.currentProjectCode);
  const matches = rows.filter((row) => projectCodeMatches(row.projectCode, snProject.projectCode));
  const modelCodes = [...new Set(matches.map((row) => row.modelCode).filter(Boolean))];
  const numericModelCodes = modelCodes.filter((code) => /^\d/.test(code));
  const repairFeeOptions = [...new Map(matches
    .filter((row) => row.repairFees)
    .map((row) => [JSON.stringify(row.repairFees), row.repairFees])).values()];
  if (matches.length === 0) {
    return {
      status: "TRANSFER_TO_HEADQUARTERS",
      repairability: "UNSUPPORTED",
      canContinue: false,
      correctionLookupRequired: false,
      projectCode: snProject.projectCode,
      reason: "网点派单机型汇总未收录该项目编码",
    };
  }
  if (!currentProjectCode) {
    return {
      status: "CURRENT_PROJECT_MISSING",
      repairability: "REVIEW_REQUIRED",
      canContinue: false,
      correctionLookupRequired: false,
      projectCode: snProject.projectCode,
      ...(repairFeeOptions.length === 1 ? { repairFees: repairFeeOptions[0] } : {}),
      reason: "未读取到瑞云当前项目号，不能判断是否需要修改",
    };
  }
  if (projectCodeMatches(input.currentProjectCode, snProject.projectCode)) {
    const selectedCode = numericModelCodes.length === 1 ? numericModelCodes[0] : "";
    const selectedRow = matches.find((row) => row.modelCode === selectedCode) || matches[0];
    return {
      status: "MATCHED",
      repairability: "SUPPORTED",
      canContinue: true,
      correctionLookupRequired: false,
      projectCode: snProject.projectCode,
      currentProjectCode: normalize(input.currentProjectCode),
      productModelCode: selectedCode,
      model: selectedRow?.model || "",
      repairFees: selectedRow?.repairFees || { 大修: 0, 中修: 0, 小修: 0 },
    };
  }
  if (numericModelCodes.length !== 1) {
    return { status: numericModelCodes.length ? "DATA_ANOMALY" : "NO_NUMERIC_MODEL_CODE", repairability: "REVIEW_REQUIRED", canContinue: false, correctionLookupRequired: true, projectCode: snProject.projectCode, candidates: modelCodes };
  }
  const selectedCode = numericModelCodes[0];
  const selectedRow = matches.find((row) => row.modelCode === selectedCode);
  return {
    status: "CHANGE_REQUIRED",
    repairability: "SUPPORTED",
    canContinue: false,
    correctionLookupRequired: true,
    projectCode: snProject.projectCode,
    currentProjectCode: normalize(input.currentProjectCode),
    productModelCode: selectedCode,
    model: selectedRow?.model || "",
    repairFees: selectedRow?.repairFees || { 大修: 0, 中修: 0, 小修: 0 },
  };
}

function resolveLocalSnAuthorization(rows, input = {}) {
  const snProject = getSnProjectMatch(input.sn);
  if (!snProject.projectCode) {
    return {
      status: "INVALID_SN",
      repairability: "REVIEW_REQUIRED",
      canContinue: false,
      correctionLookupRequired: false,
      reason: "SN 格式无效，无法识别项目编码",
    };
  }
  const matches = rows.filter((row) => projectCodeMatches(row.projectCode, snProject.projectCode));
  if (matches.length === 0) {
    return {
      status: "TRANSFER_TO_HEADQUARTERS",
      repairability: "UNSUPPORTED",
      canContinue: false,
      correctionLookupRequired: false,
      projectCode: snProject.projectCode,
      reason: "该 SN 对应机型未下放网点，需转寄总部",
    };
  }

  const numericModelCodes = [...new Set(matches
    .map((row) => row.modelCode)
    .filter((code) => /^\d/.test(code)))];
  const productLines = [...new Set(matches
    .map((row) => normalize(row.productLine))
    .filter(Boolean))];
  const repairFeeOptions = [...new Map(matches
    .filter((row) => row.repairFees)
    .map((row) => [JSON.stringify(row.repairFees), row.repairFees])).values()];
  const selectedCode = numericModelCodes.length === 1 ? numericModelCodes[0] : "";
  const selectedRow = matches.find((row) => row.modelCode === selectedCode) || matches[0];

  return {
    status: "SN_AUTHORIZED",
    repairability: "SUPPORTED",
    canContinue: true,
    correctionLookupRequired: false,
    projectCode: snProject.projectCode,
    productModelCode: selectedCode,
    model: selectedRow?.model || "",
    ...(productLines.length === 1 ? { productLine: productLines[0] } : {}),
    ...(repairFeeOptions.length === 1 ? { repairFees: repairFeeOptions[0] } : {}),
  };
}

function snMatchesRule(sn, rule) {
  if (!rule) return true;
  const normalizedSn = comparable(sn);
  const prefixes = normalize(rule).split(/[,，;；/\s]+/).map(comparable).filter(Boolean);
  return prefixes.some((prefix) => normalizedSn.startsWith(prefix));
}

function resolveModel(rows, input = {}) {
  const productLine = comparable(input.productLine);
  const productName = comparable(input.productName);
  const projectCode = comparable(input.projectCode);
  const sn = comparable(input.sn);
  const candidates = rows.filter((row) => {
    if (row.productLine && productLine && comparable(row.productLine) !== productLine) return false;
    if (row.productName && productName && comparable(row.productName) !== productName) return false;
    if (row.projectCode && projectCode && comparable(row.projectCode) !== projectCode) return false;
    if (row.snPrefix && sn && !snMatchesRule(sn, row.snPrefix)) return false;
    return true;
  });
  const models = [...new Set(candidates.map((row) => row.model))];
  if (models.length !== 1) return { status: models.length ? "AMBIGUOUS" : "NOT_FOUND", candidates: models };
  const expectedModel = models[0];
  const currentModel = normalize(input.currentModel);
  return {
    status: currentModel && comparable(currentModel) === comparable(expectedModel) ? "MATCHED" : "CHANGE_REQUIRED",
    expectedModel,
    currentModel,
    candidates: models,
  };
}

class FeishuModelCatalog {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.fetch = options.fetch || globalThis.fetch;
  }

  async readRows() {
    const appId = normalize(this.env.FEISHU_APP_ID);
    const appSecret = normalize(this.env.FEISHU_APP_SECRET);
    const spreadsheetToken = normalize(this.env.FEISHU_SPREADSHEET_TOKEN);
    let sheetId = normalize(this.env.FEISHU_MODEL_SHEET_ID);
    if (!appId || !appSecret || !spreadsheetToken) {
      const error = new Error("飞书型号表配置不完整");
      error.code = "FEISHU_MODEL_CONFIG_MISSING";
      throw error;
    }
    const tokenResponse = await this.fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const tokenResult = await tokenResponse.json();
    if (!tokenResponse.ok || tokenResult.code !== 0 || !tokenResult.tenant_access_token) {
      const error = new Error("获取飞书只读凭证失败"); error.code = "FEISHU_AUTH_FAILED"; throw error;
    }
    if (!sheetId) {
      const sheetResponse = await this.fetch(
        `https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`,
        { headers: { Authorization: `Bearer ${tokenResult.tenant_access_token}` } }
      );
      const sheetResult = await sheetResponse.json();
      if (!sheetResponse.ok || sheetResult.code !== 0) {
        const error = new Error("读取飞书型号工作表列表失败"); error.code = "FEISHU_MODEL_SHEETS_FAILED"; throw error;
      }
      const preferredTitle = normalize(this.env.FEISHU_MODEL_SHEET_TITLE) || "网点派单机型汇总";
      const sheets = sheetResult.data?.sheets || [];
      const selected = sheets.find((sheet) => comparable(sheet.title) === comparable(preferredTitle))
        || (sheets.length === 1 ? sheets[0] : null);
      if (!selected?.sheet_id) {
        const error = new Error(`飞书型号表中未找到工作表：${preferredTitle}`); error.code = "FEISHU_MODEL_SHEET_NOT_FOUND"; throw error;
      }
      sheetId = selected.sheet_id;
    }
    const range = `${sheetId}!${normalize(this.env.FEISHU_MODEL_RANGE) || DEFAULT_RANGE}`;
    const url = `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`;
    const response = await this.fetch(url, { headers: { Authorization: `Bearer ${tokenResult.tenant_access_token}` } });
    const result = await response.json();
    if (!response.ok || result.code !== 0) {
      const error = new Error("读取飞书型号表失败"); error.code = "FEISHU_MODEL_READ_FAILED"; throw error;
    }
    return parseModelRows(result.data?.valueRange?.values || []);
  }

  async match(input) {
    return resolveModel(await this.readRows(), input);
  }

  async authorize(input) {
    return resolveProjectModel(await this.readRows(), input);
  }

  async authorizeLocal(input) {
    return resolveLocalSnAuthorization(await this.readRows(), input);
  }
}

module.exports = { FeishuModelCatalog, parseModelRows, resolveModel, resolveProjectModel, resolveLocalSnAuthorization, getSnProjectMatch, projectCodeMatches, snMatchesRule };
