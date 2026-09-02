const DEFAULT_RANGE = "A1:K5000";

function text(value) { return String(value ?? "").trim(); }
function comparable(value) { return text(value).toUpperCase().replace(/[\s_-]+/g, ""); }
function retailPrice(value) {
  const normalized = text(value).replace(/[,，￥¥\s]/g, "");
  if (!normalized) return null;
  const amount = Number.parseFloat(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function columnIndex(row = [], aliases = []) {
  const normalizedAliases = aliases.map((item) => comparable(item));
  return row.findIndex((value) => {
    const header = comparable(value).replace(/[（(].*?[）)]/g, "");
    return normalizedAliases.some((alias) => header === alias || header.startsWith(alias));
  });
}

function parsePartRows(values = []) {
  const parts = [];
  let columns = null;
  for (let index = 0; index < values.length; index += 1) {
    const row = Array.isArray(values[index]) ? values[index] : [];
    const normalized = row.map(text);
    if (normalized.includes("物料编号") && normalized.includes("售后配件名称")) {
      columns = {
        code: normalized.indexOf("物料编号"),
        name: normalized.indexOf("售后配件名称"),
        price: columnIndex(normalized, ["零售价", "零售价格", "建议零售价", "最终零售价"]),
        repairLevel: normalized.indexOf("维修等级"),
        returnRequired: normalized.indexOf("旧件返厂"),
        projectCode: normalized.indexOf("适用机型"),
      };
      continue;
    }
    if (!columns) continue;
    const code = text(row[columns.code]);
    const name = text(row[columns.name]);
    const projectCode = text(row[columns.projectCode]);
    const repairLevel = text(row[columns.repairLevel]);
    if (!/^\d{8,}$/.test(code) || !name || !projectCode || !["小修", "中修", "大修"].includes(repairLevel)) continue;
    parts.push({
      sourceRow: index + 1,
      code,
      name,
      retailPrice: retailPrice(row[columns.price]),
      repairLevel,
      returnRequired: text(row[columns.returnRequired]) === "是",
      projectCode,
      productLine: "洗地机",
    });
  }
  return parts;
}

function partSupportsProject(part, projectCode) {
  const expected = comparable(projectCode);
  const candidates = text(part.projectCode).split(/[,，;；/&\s]+/).map(comparable).filter(Boolean);
  return candidates.includes("*") || candidates.includes(expected);
}

function projectCodesFromTitle(title) {
  const value = text(title).toUpperCase();
  const codes = [];
  let prefix = "";
  for (const token of value.match(/[RPW]\d+[A-Z0-9]*|(?<=&)\d+[A-Z0-9]*/g) || []) {
    if (/^[RPW]/.test(token)) prefix = token[0];
    const code = /^[RPW]/.test(token) ? token : `${prefix}${token}`;
    if (prefix && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

function parseSweepPartRows(values = [], sheet = {}) {
  let columns = null;
  const projectCodes = projectCodesFromTitle(sheet.title);
  const parts = [];
  for (let index = 0; index < values.length; index += 1) {
    const row = Array.isArray(values[index]) ? values[index] : [];
    const normalized = row.map(text);
    const nameIndex = normalized.findIndex((value) => ["备件名称", "售后配件名称", "物料名称"].includes(value));
    if (normalized.includes("物料编号") && nameIndex >= 0) {
      columns = {
        code: normalized.indexOf("物料编号"), name: nameIndex,
        repairLevel: normalized.indexOf("维修等级"), price: columnIndex(normalized, ["零售价", "零售价格", "建议零售价", "最终零售价"]),
        returnRequired: normalized.indexOf("旧件返厂"),
      };
      continue;
    }
    if (!columns) continue;
    const code = text(row[columns.code]);
    const name = text(row[columns.name]);
    const levelText = text(row[columns.repairLevel]);
    const repairLevel = ["大修", "中修", "小修"].find((level) => levelText.startsWith(level));
    if (!/^\d{8,}$/.test(code) || !name || !repairLevel || (!sheet.common && !projectCodes.length)) continue;
    parts.push({
      sourceRow: index + 1, sourceSheetId: sheet.sheetId, sourceSheetTitle: sheet.title,
      code, name, retailPrice: retailPrice(row[columns.price]),
      repairLevel, returnRequired: columns.returnRequired >= 0 && text(row[columns.returnRequired]) === "是",
      projectCode: sheet.common ? "*" : projectCodes.join("/"), productLine: sheet.productLine || "扫地机",
    });
  }
  return parts;
}

class FeishuPartsCatalog {
  constructor(options = {}) { this.env = options.env || process.env; this.fetch = options.fetch || globalThis.fetch; }
  async readRows() {
    const appId = text(this.env.FEISHU_APP_ID);
    const appSecret = text(this.env.FEISHU_APP_SECRET);
    const spreadsheetToken = text(this.env.FEISHU_PARTS_SPREADSHEET_TOKEN);
    const sheetId = text(this.env.FEISHU_PARTS_SHEET_ID);
    if (!appId || !appSecret || !spreadsheetToken || !sheetId) throw Object.assign(new Error("飞书配件表配置不完整"), { code: "FEISHU_PARTS_CONFIG_MISSING" });
    const auth = await this.fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }) });
    const authData = await auth.json();
    if (!auth.ok || authData.code !== 0 || !authData.tenant_access_token) throw Object.assign(new Error("获取飞书只读凭证失败"), { code: "FEISHU_AUTH_FAILED" });
    const range = `${sheetId}!${text(this.env.FEISHU_PARTS_RANGE) || DEFAULT_RANGE}`;
    const url = `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`;
    const response = await this.fetch(url, { headers: { Authorization: `Bearer ${authData.tenant_access_token}` } });
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw Object.assign(new Error("读取飞书配件表失败"), { code: "FEISHU_PARTS_READ_FAILED" });
    return parsePartRows(result.data?.valueRange?.values || []);
  }

  async tenantToken() {
    const auth = await this.fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: text(this.env.FEISHU_APP_ID), app_secret: text(this.env.FEISHU_APP_SECRET) }) });
    const data = await auth.json();
    if (!auth.ok || data.code !== 0 || !data.tenant_access_token) throw Object.assign(new Error("获取飞书只读凭证失败"), { code: "FEISHU_AUTH_FAILED" });
    return data.tenant_access_token;
  }

  async readSweepRows() {
    const spreadsheetToken = text(this.env.FEISHU_SWEEP_PARTS_SPREADSHEET_TOKEN);
    if (!spreadsheetToken) throw Object.assign(new Error("飞书扫地机配件表配置不完整"), { code: "FEISHU_SWEEP_PARTS_CONFIG_MISSING" });
    const tenantToken = await this.tenantToken();
    const listResponse = await this.fetch(`https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`, { headers: { Authorization: `Bearer ${tenantToken}` } });
    const list = await listResponse.json();
    if (!listResponse.ok || list.code !== 0) throw Object.assign(new Error("读取扫地机工作表列表失败"), { code: "FEISHU_SWEEP_SHEETS_FAILED" });
    const sheets = (list.data?.sheets || []).filter((sheet) => sheet.sheet_id === "Aix38w" || (sheet.index >= 6 && projectCodesFromTitle(sheet.title).length));
    const items = [];
    for (let offset = 0; offset < sheets.length; offset += 5) {
      const rows = await Promise.all(sheets.slice(offset, offset + 5).map(async (sheet) => {
        const range = `${sheet.sheet_id}!A1:T${sheet.grid_properties?.row_count || 1000}`;
        const response = await this.fetch(`https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`, { headers: { Authorization: `Bearer ${tenantToken}` } });
        const result = await response.json();
        if (!response.ok || result.code !== 0) throw Object.assign(new Error(`读取扫地机配件工作表失败：${sheet.title}`), { code: "FEISHU_SWEEP_PARTS_READ_FAILED" });
        return parseSweepPartRows(result.data?.valueRange?.values || [], { sheetId: sheet.sheet_id, title: sheet.title, common: sheet.sheet_id === "Aix38w" });
      }));
      items.push(...rows.flat());
    }
    const unique = new Map();
    for (const item of items) unique.set(`${item.code}:${item.projectCode}`, item);
    return [...unique.values()];
  }

  async search(input = {}) {
    const projectCode = comparable(input.projectCode);
    const keyword = text(input.keyword).toUpperCase();
    let items;
    if (text(input.productLine) === "扫地机") {
      items = await this.readSweepProjectRows(projectCode);
    } else {
      items = await this.readWashProjectRows(projectCode);
    }
    return items.filter((part) =>
      partSupportsProject(part, projectCode) &&
      (!keyword || part.code.toUpperCase().includes(keyword) || part.name.toUpperCase().includes(keyword))
    ).slice(0, 100);
  }

  async readSweepProjectRows(projectCode) {
    const spreadsheetToken = text(this.env.FEISHU_SWEEP_PARTS_SPREADSHEET_TOKEN);
    if (!spreadsheetToken) throw Object.assign(new Error("飞书扫地机配件表配置不完整"), { code: "FEISHU_SWEEP_PARTS_CONFIG_MISSING" });
    const tenantToken = await this.tenantToken();
    const listResponse = await this.fetch(`https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`, { headers: { Authorization: `Bearer ${tenantToken}` } });
    const list = await listResponse.json();
    if (!listResponse.ok || list.code !== 0) throw Object.assign(new Error("读取扫地机工作表列表失败"), { code: "FEISHU_SWEEP_SHEETS_FAILED" });
    const expected = comparable(projectCode);
    const sheets = (list.data?.sheets || []).filter((sheet) =>
      sheet.sheet_id === "Aix38w" || projectCodesFromTitle(sheet.title).some((code) => comparable(code) === expected)
    );
    if (!sheets.some((sheet) => sheet.sheet_id !== "Aix38w")) return [];
    const rows = await Promise.all(sheets.map(async (sheet) => {
      const range = `${sheet.sheet_id}!A1:T${sheet.grid_properties?.row_count || 1000}`;
      const response = await this.fetch(`https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`, { headers: { Authorization: `Bearer ${tenantToken}` } });
      const result = await response.json();
      if (!response.ok || result.code !== 0) throw Object.assign(new Error(`读取扫地机配件工作表失败：${sheet.title}`), { code: "FEISHU_SWEEP_PARTS_READ_FAILED" });
      return parseSweepPartRows(result.data?.valueRange?.values || [], { sheetId: sheet.sheet_id, title: sheet.title, common: sheet.sheet_id === "Aix38w" });
    }));
    const unique = new Map();
    for (const item of rows.flat()) unique.set(item.code, item);
    return [...unique.values()];
  }

  async readWashProjectRows(projectCode) {
    const spreadsheetToken = text(this.env.FEISHU_PARTS_SPREADSHEET_TOKEN);
    if (!spreadsheetToken) throw Object.assign(new Error("飞书洗地机配件表配置不完整"), { code: "FEISHU_PARTS_CONFIG_MISSING" });
    const tenantToken = await this.tenantToken();
    const listResponse = await this.fetch(`https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`, { headers: { Authorization: `Bearer ${tenantToken}` } });
    const list = await listResponse.json();
    if (!listResponse.ok || list.code !== 0) throw Object.assign(new Error("读取洗地机工作表列表失败"), { code: "FEISHU_WASH_SHEETS_FAILED" });
    const expected = comparable(projectCode);
    const sheets = (list.data?.sheets || []).filter((sheet) =>
      projectCodesFromTitle(sheet.title).some((code) => comparable(code) === expected)
    );
    if (!sheets.length) return [];
    const rows = await Promise.all(sheets.map(async (sheet) => {
      const range = `${sheet.sheet_id}!A1:V${sheet.grid_properties?.row_count || 1000}`;
      const response = await this.fetch(`https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`, { headers: { Authorization: `Bearer ${tenantToken}` } });
      const result = await response.json();
      if (!response.ok || result.code !== 0) throw Object.assign(new Error(`读取洗地机配件工作表失败：${sheet.title}`), { code: "FEISHU_WASH_PARTS_READ_FAILED" });
      return parseSweepPartRows(result.data?.valueRange?.values || [], { sheetId: sheet.sheet_id, title: sheet.title, productLine: "洗地机" });
    }));
    const unique = new Map();
    for (const item of rows.flat()) unique.set(item.code, item);
    return [...unique.values()];
  }
}

module.exports = { FeishuPartsCatalog, parsePartRows, parseSweepPartRows, projectCodesFromTitle, partSupportsProject, retailPrice, columnIndex };
