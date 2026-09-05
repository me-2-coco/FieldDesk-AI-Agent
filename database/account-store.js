const crypto = require("crypto");
const path = require("path");
const { createDocumentBackend } = require("./storage-backend");
const { USER_ROLES } = require("../config/local-users");

const SPECIALTIES = new Set(["扫地机", "洗地机"]);
const ROLES = new Set(Object.values(USER_ROLES));
const RECLOUD_ASSIGNMENT_MODES = new Set(["DIRECT", "FALLBACK"]);
const MANAGED_ACCOUNT_PREFIX = "FieldDesk";
const MANAGED_ACCOUNT_START_SEQUENCE = 5;
const MANAGED_ACCOUNT_DEFAULT_PASSWORD = "0000";
const MANAGED_ACCOUNT_ROLES = new Set([USER_ROLES.TECHNICIAN, USER_ROLES.WAREHOUSE, USER_ROLES.INFORMATION_CLERK]);

function nextManagedUserId(users) {
  const highestSequence = users.reduce((highest, user) => {
    const match = new RegExp(`^${MANAGED_ACCOUNT_PREFIX}(\\d+)$`).exec(String(user.userId || ""));
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, MANAGED_ACCOUNT_START_SEQUENCE - 1);
  return `${MANAGED_ACCOUNT_PREFIX}${String(highestSequence + 1).padStart(4, "0")}`;
}

function normalizeTechnicianPhone(value) {
  return String(value || "").replace(/[\s-]/g, "");
}

class AccountStore {
  constructor(options = {}) {
    const driver = options.driver || process.env.FIELDDESK_STORAGE_DRIVER || "json";
    this.backend = options.backend || createDocumentBackend({
      driver,
      filePath: options.filePath || (driver === "sqlite"
        ? process.env.FIELDDESK_SQLITE_FILE || path.join(__dirname, "data", "fielddesk.sqlite")
        : path.join(__dirname, "data", "accounts.json")),
      namespace: "accounts",
      initialValue: { users: [] },
    });
  }
  ensureBootstrap(accessToken, displayName = "系统管理员") {
    if (!accessToken) return Promise.resolve(false);
    return this.backend.update((data) => {
      if (data.users.length) return false;
      data.users.push({
        userId: "ADMIN-BOOTSTRAP",
        displayName,
        role: USER_ROLES.ADMIN,
        repairSpecialties: ["扫地机", "洗地机"],
        active: true,
        allowBearer: true,
        tokenHash: crypto.createHash("sha256").update(String(accessToken)).digest("hex"),
        tokenExpiresAt: new Date(Date.now() + Math.min(168, Math.max(1, Number(process.env.FIELDDESK_SESSION_HOURS || 12))) * 3600_000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return true;
    });
  }
  async list() {
    const data = await this.backend.read();
    return data.users.filter((user) => !user.deletedAt).map(({ tokenHash, allowBearer, tokenExpiresAt, ...user }) => user);
  }
  async getNextManagedUserId() {
    const data = await this.backend.read();
    return nextManagedUserId(data.users);
  }
  async findByUserId(userId) {
    const data = await this.backend.read();
    const user = data.users.find((item) => item.active !== false && item.userId === String(userId || "").trim());
    if (!user) return null;
    const { tokenHash: ignored, allowBearer, tokenExpiresAt, ...safe } = user;
    return safe;
  }
  async findByToken(token) {
    if (!token) return null;
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const data = await this.backend.read();
    const now = Date.now();
    const user = data.users.find((item) => item.active !== false && item.allowBearer !== false && item.tokenHash === tokenHash && (!item.tokenExpiresAt || Date.parse(item.tokenExpiresAt) > now));
    if (!user) return null;
    const { tokenHash: ignored, ...safe } = user;
    return safe;
  }
  async findByCredentials(userId, password) {
    const normalizedUserId = String(userId || "").trim();
    const tokenHash = crypto.createHash("sha256").update(String(password || "")).digest("hex");
    const data = await this.backend.read();
    const user = data.users.find((item) => item.active !== false && item.userId === normalizedUserId && item.tokenHash === tokenHash);
    if (!user) return null;
    const { tokenHash: ignored, ...safe } = user;
    return safe;
  }
  createManagedAccount(input, operator) {
    if (operator?.role !== USER_ROLES.ADMIN) throw Object.assign(new Error("只有管理员可以创建账号"), { code: "ACCOUNT_ADMIN_REQUIRED", status: 403 });
    const displayName = String(input.displayName || "").trim();
    const phone = normalizeTechnicianPhone(input.phone);
    const role = String(input.role || "").trim().toUpperCase();
    const specialties = [...new Set(input.repairSpecialties || [])];
    if (!displayName) throw Object.assign(new Error("请填写姓名"), { code: "ACCOUNT_DISPLAY_NAME_REQUIRED", status: 400 });
    if (!/^1[3-9]\d{9}$/.test(phone)) throw Object.assign(new Error("请填写正确的11位手机号"), { code: "ACCOUNT_PHONE_INVALID", status: 400 });
    if (!MANAGED_ACCOUNT_ROLES.has(role)) throw Object.assign(new Error("请选择账号角色"), { code: "ACCOUNT_ROLE_INVALID", status: 400 });
    if (specialties.some((item) => !SPECIALTIES.has(item))) throw Object.assign(new Error("维修品类无效"), { code: "ACCOUNT_SPECIALTY_INVALID", status: 400 });
    if (role === USER_ROLES.TECHNICIAN && specialties.length === 0) throw Object.assign(new Error("维修师傅至少选择一个维修权限"), { code: "ACCOUNT_SPECIALTY_REQUIRED", status: 400 });
    if (role !== USER_ROLES.TECHNICIAN && specialties.length) throw Object.assign(new Error("库管和信息员不能配置维修权限"), { code: "ACCOUNT_SPECIALTY_FORBIDDEN", status: 400 });
    return this.backend.update((data) => {
      if (data.users.some((item) => !item.deletedAt && normalizeTechnicianPhone(item.phone) === phone)) {
        throw Object.assign(new Error("该手机号已创建 FieldDesk 账号"), { code: "ACCOUNT_PHONE_EXISTS", status: 409 });
      }
      const userId = nextManagedUserId(data.users);
      const now = new Date().toISOString();
      const user = {
        userId,
        displayName,
        phone,
        role,
        repairSpecialties: specialties,
        recloudAssignmentMode: "DIRECT",
        recloudAssigneeName: role === USER_ROLES.TECHNICIAN ? displayName : "",
        recloudFallbackAssigneeName: "",
        active: true,
        allowBearer: false,
        tokenHash: crypto.createHash("sha256").update(MANAGED_ACCOUNT_DEFAULT_PASSWORD).digest("hex"),
        tokenExpiresAt: null,
        createdAt: now,
        updatedAt: now,
      };
      data.users.push(user);
      const { tokenHash: ignored, ...safe } = user;
      return { ...safe, initialPassword: MANAGED_ACCOUNT_DEFAULT_PASSWORD };
    });
  }
  delete(userId, operator) {
    if (operator?.role !== USER_ROLES.ADMIN) throw Object.assign(new Error("只有管理员可以删除账号"), { code: "ACCOUNT_ADMIN_REQUIRED", status: 403 });
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) throw Object.assign(new Error("请选择要删除的账号"), { code: "ACCOUNT_USER_ID_REQUIRED", status: 400 });
    if (normalizedUserId === operator.userId) throw Object.assign(new Error("不能删除当前登录的管理员账号"), { code: "ACCOUNT_SELF_DELETE_FORBIDDEN", status: 409 });
    return this.backend.update((data) => {
      const index = data.users.findIndex((item) => item.userId === normalizedUserId && !item.deletedAt);
      if (index < 0) throw Object.assign(new Error("账号不存在"), { code: "ACCOUNT_NOT_FOUND", status: 404 });
      if (data.users[index].role === USER_ROLES.ADMIN) throw Object.assign(new Error("管理员账号不能在这里删除"), { code: "ACCOUNT_ADMIN_DELETE_FORBIDDEN", status: 409 });
      const removed = data.users[index];
      removed.active = false;
      removed.deletedAt = new Date().toISOString();
      removed.updatedAt = removed.deletedAt;
      return { userId: removed.userId, displayName: removed.displayName };
    });
  }
  upsert(input, operator) {
    if (operator?.role !== USER_ROLES.ADMIN) throw Object.assign(new Error("只有管理员可以配置账号"), { code: "ACCOUNT_ADMIN_REQUIRED", status: 403 });
    const role = String(input.role || "");
    if (!ROLES.has(role)) throw Object.assign(new Error("账号角色无效"), { code: "ACCOUNT_ROLE_INVALID", status: 400 });
    const specialties = [...new Set(input.repairSpecialties || [])];
    if (specialties.some((item) => !SPECIALTIES.has(item))) throw Object.assign(new Error("维修品类无效"), { code: "ACCOUNT_SPECIALTY_INVALID", status: 400 });
    if (role === USER_ROLES.TECHNICIAN && specialties.length === 0) throw Object.assign(new Error("维修师傅至少选择一个维修权限"), { code: "ACCOUNT_SPECIALTY_REQUIRED", status: 400 });
    if (role !== USER_ROLES.TECHNICIAN && specialties.length && role !== USER_ROLES.ADMIN) throw Object.assign(new Error("该角色不能配置维修品类"), { code: "ACCOUNT_SPECIALTY_FORBIDDEN", status: 400 });
    const recloudAssignmentMode = String(input.recloudAssignmentMode || "DIRECT").trim().toUpperCase();
    const recloudAssigneeName = String(input.recloudAssigneeName || "").trim();
    const recloudFallbackAssigneeName = String(input.recloudFallbackAssigneeName || "").trim();
    if (!RECLOUD_ASSIGNMENT_MODES.has(recloudAssignmentMode)) throw Object.assign(new Error("瑞云改派方式无效"), { code: "ACCOUNT_RECLOUD_ASSIGNMENT_MODE_INVALID", status: 400 });
    if (role === USER_ROLES.TECHNICIAN && recloudAssignmentMode === "FALLBACK" && !recloudFallbackAssigneeName) {
      throw Object.assign(new Error("新员工暂未进入瑞云时，必须填写兜底负责人"), { code: "ACCOUNT_RECLOUD_FALLBACK_REQUIRED", status: 400 });
    }
    return this.backend.update((data) => {
      const userId = String(input.userId || "").trim();
      const existing = data.users.find((item) => item.userId === userId);
      const password = input.password || input.accessToken;
      const tokenHash = password
        ? crypto.createHash("sha256").update(String(password)).digest("hex")
        : existing?.tokenHash;
      if (!userId || !input.displayName || !tokenHash) throw Object.assign(new Error("账号资料不完整"), { code: "ACCOUNT_FIELDS_REQUIRED", status: 400 });
      const next = { userId, displayName: String(input.displayName).trim(), phone: normalizeTechnicianPhone(input.phone ?? existing?.phone), role, repairSpecialties: specialties, recloudAssignmentMode, recloudAssigneeName, recloudFallbackAssigneeName, active: input.active !== false, allowBearer: false, tokenHash, tokenExpiresAt: null, updatedAt: new Date().toISOString() };
      if (existing) Object.assign(existing, next); else data.users.push({ ...next, createdAt: next.updatedAt });
      const { tokenHash: ignored, ...safe } = next;
      return safe;
    });
  }
}

module.exports = { AccountStore, SPECIALTIES, MANAGED_ACCOUNT_PREFIX, MANAGED_ACCOUNT_DEFAULT_PASSWORD, nextManagedUserId };
