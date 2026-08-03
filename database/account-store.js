const crypto = require("crypto");
const path = require("path");
const { createDocumentBackend } = require("./storage-backend");
const { USER_ROLES } = require("../config/local-users");

const SPECIALTIES = new Set(["扫地机", "洗地机"]);
const ROLES = new Set(Object.values(USER_ROLES));

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
        tokenHash: crypto.createHash("sha256").update(String(accessToken)).digest("hex"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return true;
    });
  }
  async list() {
    const data = await this.backend.read();
    return data.users.map(({ tokenHash, ...user }) => user);
  }
  async findByToken(token) {
    if (!token) return null;
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const data = await this.backend.read();
    const user = data.users.find((item) => item.active !== false && item.tokenHash === tokenHash);
    if (!user) return null;
    const { tokenHash: ignored, ...safe } = user;
    return safe;
  }
  upsert(input, operator) {
    if (operator?.role !== USER_ROLES.ADMIN) throw Object.assign(new Error("只有管理员可以配置账号"), { code: "ACCOUNT_ADMIN_REQUIRED", status: 403 });
    const role = String(input.role || "");
    if (!ROLES.has(role)) throw Object.assign(new Error("账号角色无效"), { code: "ACCOUNT_ROLE_INVALID", status: 400 });
    const specialties = [...new Set(input.repairSpecialties || [])];
    if (specialties.some((item) => !SPECIALTIES.has(item))) throw Object.assign(new Error("维修品类无效"), { code: "ACCOUNT_SPECIALTY_INVALID", status: 400 });
    if (role !== USER_ROLES.TECHNICIAN && specialties.length && role !== USER_ROLES.ADMIN) throw Object.assign(new Error("该角色不能配置维修品类"), { code: "ACCOUNT_SPECIALTY_FORBIDDEN", status: 400 });
    return this.backend.update((data) => {
      const userId = String(input.userId || "").trim();
      const existing = data.users.find((item) => item.userId === userId);
      const tokenHash = input.accessToken
        ? crypto.createHash("sha256").update(String(input.accessToken)).digest("hex")
        : existing?.tokenHash;
      if (!userId || !input.displayName || !tokenHash) throw Object.assign(new Error("账号资料不完整"), { code: "ACCOUNT_FIELDS_REQUIRED", status: 400 });
      const next = { userId, displayName: String(input.displayName).trim(), role, repairSpecialties: specialties, active: input.active !== false, tokenHash, updatedAt: new Date().toISOString() };
      if (existing) Object.assign(existing, next); else data.users.push({ ...next, createdAt: next.updatedAt });
      const { tokenHash: ignored, ...safe } = next;
      return safe;
    });
  }
}

module.exports = { AccountStore, SPECIALTIES };
