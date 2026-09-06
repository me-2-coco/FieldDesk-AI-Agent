const crypto = require("crypto");
const path = require("path");
const { createDocumentBackend } = require("./storage-backend");

const DEFAULT_FILE = path.join(__dirname, "data", "print-jobs.json");
const ONLINE_WINDOW_MS = 45_000;
const LEASE_MS = 90_000;

function clean(value, max = 120) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/"/g, "'").trim().slice(0, max);
}

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function publicTerminal(terminal = {}) {
  const { tokenHash, ...safe } = terminal;
  return safe;
}

function buildTsplLabel(input = {}) {
  const rmaNo = clean(input.rmaNo || input.workOrderNo, 40);
  const sn = clean(input.sn, 48);
  const partCode = clean(input.partCode, 48);
  const partName = clean(input.partName, 48);
  const technicianName = clean(input.technicianName, 32);
  const quantity = Math.max(1, Math.min(99, Number(input.quantity || 1)));
  const lines = [
    "SIZE 70 mm,50 mm",
    "GAP 2 mm,0 mm",
    "DENSITY 8",
    "DIRECTION 1",
    "CODEPAGE UTF-8",
    "CLS",
    `TEXT 28,24,"3",0,1,1,"FieldDesk OLD PART"`,
    `TEXT 28,66,"3",0,1,1,"RMA: ${rmaNo || "-"}"`,
    `TEXT 28,104,"3",0,1,1,"SN: ${sn || "-"}"`,
    `TEXT 28,142,"3",0,1,1,"PART: ${partCode || "-"}  QTY:${quantity}"`,
    `TEXT 28,180,"3",0,1,1,"NAME: ${partName || "-"}"`,
    `TEXT 28,218,"3",0,1,1,"TECH: ${technicianName || "-"}"`,
  ];
  if (rmaNo) lines.push(`BARCODE 28,270,"128",64,1,0,2,2,"${rmaNo}"`);
  lines.push("PRINT 1,1", "");
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64");
}

class PrintJobStore {
  constructor(options = {}) {
    const driver = options.driver || process.env.FIELDDESK_STORAGE_DRIVER || "json";
    this.backend = options.backend || createDocumentBackend({
      driver,
      filePath: options.filePath || (driver === "sqlite"
        ? process.env.FIELDDESK_SQLITE_FILE || path.join(__dirname, "data", "fielddesk.sqlite")
        : DEFAULT_FILE),
      namespace: "print_jobs",
      initialValue: { terminals: [], jobs: [] },
    });
  }

  async list() {
    const data = await this.backend.read();
    const now = Date.now();
    return (data.terminals || []).filter((item) => !item.deletedAt).map(({ tokenHash, ...terminal }) => {
      const jobs = (data.jobs || []).filter((job) => job.terminalId === terminal.id);
      return {
        ...terminal,
        online: terminal.active !== false && Number.isFinite(Date.parse(terminal.lastSeenAt || ""))
          && now - Date.parse(terminal.lastSeenAt) <= ONLINE_WINDOW_MS,
        queue: {
          pending: jobs.filter((job) => ["PENDING", "PRINTING"].includes(job.status)).length,
          failed: jobs.filter((job) => job.status === "FAILED").length,
          success: jobs.filter((job) => job.status === "SUCCESS").length,
        },
      };
    });
  }

  saveTerminal(input = {}) {
    return this.backend.update((data) => {
      data.terminals ||= [];
      data.jobs ||= [];
      const now = new Date().toISOString();
      const id = clean(input.id, 80) || crypto.randomUUID();
      const name = clean(input.name, 80);
      const printerName = clean(input.printerName, 120);
      if (!name || !printerName) throw Object.assign(new Error("终端名称和 Windows 打印机名称必填"), { code: "PRINT_TERMINAL_INVALID", status: 400 });
      const memberUserIds = [...new Set((input.memberUserIds || []).map((item) => clean(item, 80)).filter(Boolean))];
      const existing = data.terminals.find((item) => item.id === id && !item.deletedAt);
      const duplicateMember = memberUserIds.find((userId) => data.terminals.some((item) => (
        item.id !== id && !item.deletedAt && item.active !== false && (item.memberUserIds || []).includes(userId)
      )));
      if (duplicateMember) {
        throw Object.assign(new Error(`账号 ${duplicateMember} 已分配给其他打印终端`), { code: "PRINT_TERMINAL_MEMBER_DUPLICATE", status: 409 });
      }
      if (existing) {
        Object.assign(existing, { name, printerName, memberUserIds, backupTerminalId: clean(input.backupTerminalId, 80), active: input.active !== false, updatedAt: now });
        return { terminal: publicTerminal(existing), enrollmentToken: "" };
      }
      const enrollmentToken = crypto.randomBytes(32).toString("base64url");
      const terminal = {
        id, name, platform: "WINDOWS", printerName, memberUserIds,
        backupTerminalId: clean(input.backupTerminalId, 80), active: input.active !== false,
        tokenHash: hashToken(enrollmentToken), createdAt: now, updatedAt: now, lastSeenAt: "",
      };
      data.terminals.push(terminal);
      return { terminal: publicTerminal(terminal), enrollmentToken };
    });
  }

  deleteTerminal(id) {
    return this.backend.update((data) => {
      const terminal = (data.terminals || []).find((item) => item.id === clean(id, 80) && !item.deletedAt);
      if (!terminal) throw Object.assign(new Error("打印终端不存在"), { code: "PRINT_TERMINAL_NOT_FOUND", status: 404 });
      terminal.active = false;
      terminal.deletedAt = new Date().toISOString();
      terminal.updatedAt = terminal.deletedAt;
      return { id: terminal.id, deleted: true };
    });
  }

  async authenticate(id, token) {
    const data = await this.backend.read();
    const terminal = (data.terminals || []).find((item) => item.id === clean(id, 80) && item.active !== false && !item.deletedAt);
    if (!terminal) return null;
    const actual = Buffer.from(hashToken(token));
    const expected = Buffer.from(String(terminal.tokenHash || ""));
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected) ? terminal : null;
  }

  heartbeat(id, details = {}) {
    return this.backend.update((data) => {
      const terminal = (data.terminals || []).find((item) => item.id === id && item.active !== false && !item.deletedAt);
      if (!terminal) throw Object.assign(new Error("打印终端不存在"), { code: "PRINT_TERMINAL_NOT_FOUND", status: 404 });
      terminal.lastSeenAt = new Date().toISOString();
      terminal.agentVersion = clean(details.agentVersion, 32);
      terminal.computerName = clean(details.computerName, 80);
      terminal.currentPrinterName = clean(details.printerName, 120);
      terminal.lastError = clean(details.lastError, 300);
      return { id: terminal.id, serverTime: terminal.lastSeenAt };
    });
  }

  enqueue(input = {}) {
    return this.backend.update((data) => {
      data.terminals ||= [];
      data.jobs ||= [];
      const requestedTerminalId = clean(input.terminalId, 80);
      const userId = clean(input.userId, 80);
      const terminal = data.terminals.find((item) => !item.deletedAt && item.active !== false && (
        requestedTerminalId
          ? item.id === requestedTerminalId && (input.allowAnyTerminal === true || (item.memberUserIds || []).includes(userId))
          : (item.memberUserIds || []).includes(userId)
      ));
      if (requestedTerminalId && !terminal) {
        throw Object.assign(new Error("当前账号不能使用该打印终端"), { code: "PRINT_TERMINAL_FORBIDDEN", status: 403 });
      }
      const idempotencyKey = clean(input.idempotencyKey, 180);
      const existing = idempotencyKey && data.jobs.find((item) => item.idempotencyKey === idempotencyKey && item.status !== "CANCELLED");
      if (existing) return existing;
      const now = new Date().toISOString();
      const job = {
        id: crypto.randomUUID(), terminalId: terminal?.id || "", requestedBy: userId,
        requestedByName: clean(input.userName, 80), documentType: clean(input.documentType || "OLD_PART_LABEL", 40),
        title: clean(input.title || "旧件标签", 120), rmaNo: clean(input.rmaNo, 40),
        copies: Math.max(1, Math.min(20, Number(input.copies || 1))),
        payloadBase64: input.trustedPayloadBase64 || buildTsplLabel(input), idempotencyKey,
        status: terminal ? "PENDING" : "UNASSIGNED", attempts: 0, lastError: "",
        createdAt: now, updatedAt: now, leaseExpiresAt: "", printedAt: "",
      };
      data.jobs.push(job);
      if (data.jobs.length > 5000) data.jobs = data.jobs.slice(-5000);
      return job;
    });
  }

  leaseNext(terminalId) {
    return this.backend.update((data) => {
      const now = Date.now();
      for (const job of data.jobs || []) {
        if (job.status === "PRINTING" && Date.parse(job.leaseExpiresAt || "") <= now) {
          job.status = "PENDING";
          job.leaseExpiresAt = "";
        }
      }
      const job = (data.jobs || []).find((item) => item.terminalId === terminalId && item.status === "PENDING");
      if (!job) return null;
      job.status = "PRINTING";
      job.attempts = Number(job.attempts || 0) + 1;
      job.updatedAt = new Date(now).toISOString();
      job.leaseExpiresAt = new Date(now + LEASE_MS).toISOString();
      return job;
    });
  }

  finish(terminalId, jobId, success, errorMessage = "") {
    return this.backend.update((data) => {
      const job = (data.jobs || []).find((item) => item.id === clean(jobId, 80) && item.terminalId === terminalId);
      if (!job) throw Object.assign(new Error("打印任务不存在"), { code: "PRINT_JOB_NOT_FOUND", status: 404 });
      if (job.status === "SUCCESS") return job;
      const now = new Date().toISOString();
      job.status = success ? "SUCCESS" : "FAILED";
      job.lastError = success ? "" : clean(errorMessage || "打印失败", 300);
      job.printedAt = success ? now : "";
      job.leaseExpiresAt = "";
      job.updatedAt = now;
      return job;
    });
  }

  retry(jobId, terminalId = "") {
    return this.backend.update((data) => {
      const job = (data.jobs || []).find((item) => item.id === clean(jobId, 80));
      if (!job) throw Object.assign(new Error("打印任务不存在"), { code: "PRINT_JOB_NOT_FOUND", status: 404 });
      const targetId = clean(terminalId, 80) || job.terminalId || (data.terminals || []).find((item) => (
        item.active !== false && !item.deletedAt && (item.memberUserIds || []).includes(job.requestedBy)
      ))?.id || "";
      const terminal = (data.terminals || []).find((item) => item.id === targetId && item.active !== false && !item.deletedAt);
      if (!terminal) throw Object.assign(new Error("请选择可用打印终端"), { code: "PRINT_TERMINAL_NOT_FOUND", status: 404 });
      Object.assign(job, { terminalId: targetId, status: "PENDING", lastError: "", leaseExpiresAt: "", updatedAt: new Date().toISOString() });
      return job;
    });
  }

  async listJobs(limit = 100) {
    const data = await this.backend.read();
    return [...(data.jobs || [])]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, Math.max(1, Math.min(500, Number(limit || 100))))
      .map(({ payloadBase64, ...job }) => job);
  }
}

module.exports = { DEFAULT_FILE, ONLINE_WINDOW_MS, PrintJobStore, buildTsplLabel };
