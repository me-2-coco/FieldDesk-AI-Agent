const crypto = require("crypto");
const path = require("path");
const { createDocumentBackend } = require("./storage-backend");
const { USER_ROLES } = require("../config/local-users");

const SPECIALTIES = new Set(["扫地机", "洗地机"]);
const ROLES = new Set(Object.values(USER_ROLES));
const RECLOUD_ASSIGNMENT_MODES = new Set(["DIRECT", "FALLBACK"]);
const MANAGED_ACCOUNT_PREFIX = "FieldDesk";
const MANAGED_ACCOUNT_START_SEQUENCE = 5;
const RECLOUD_TEST_USER_ID = "FieldDesk0004";
const MANAGED_ACCOUNT_DEFAULT_PASSWORD = "000000";
const MANAGED_ACCOUNT_ROLES = new Set([USER_ROLES.ADMIN, USER_ROLES.TECHNICIAN, USER_ROLES.WAREHOUSE, USER_ROLES.INFORMATION_CLERK]);
const OWNER_USER_ID = "FieldDesk0001";
const OWNER_AUTHORITY = "OWNER";

function isOwner(user) {
  return user?.accountAuthority === OWNER_AUTHORITY && user?.userId === OWNER_USER_ID;
}

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
  ensureBootstrap(accessToken, displayName = "负责人") {
    if (!accessToken) return Promise.resolve(false);
    return this.backend.update((data) => {
      const now = new Date().toISOString();
      let changed = false;
      if (!data.users.some((user) => isOwner(user))) {
        data.users.push({
          userId: OWNER_USER_ID,
          displayName: displayName || "负责人",
          phone: "",
          role: USER_ROLES.ADMIN,
          accountAuthority: OWNER_AUTHORITY,
          repairSpecialties: ["扫地机", "洗地机"],
          active: true,
          allowBearer: true,
          tokenHash: crypto.createHash("sha256").update(String(accessToken)).digest("hex"),
          passwordHash: crypto.createHash("sha256").update(MANAGED_ACCOUNT_DEFAULT_PASSWORD).digest("hex"),
          mustChangePassword: true,
          tokenExpiresAt: new Date(Date.now() + Math.min(168, Math.max(1, Number(process.env.FIELDDESK_SESSION_HOURS || 12))) * 3600_000).toISOString(),
          createdAt: now,
          updatedAt: now,
        });
        changed = true;
      }
      if (!data.users.some((user) => user.userId === RECLOUD_TEST_USER_ID)) {
        data.users.push({
          userId: RECLOUD_TEST_USER_ID,
          displayName: "瑞云测试师傅",
          phone: "",
          role: USER_ROLES.TECHNICIAN,
          accountPurpose: "RECLOUD_TECHNICIAN_TEST",
          repairSpecialties: ["扫地机", "洗地机"],
          recloudAssignmentMode: "DIRECT",
          recloudAssigneeName: "瑞云测试师傅",
          recloudFallbackAssigneeName: "",
          active: true,
          allowBearer: false,
          tokenHash: null,
          passwordHash: crypto.createHash("sha256").update(MANAGED_ACCOUNT_DEFAULT_PASSWORD).digest("hex"),
          mustChangePassword: true,
          tokenExpiresAt: null,
          createdAt: now,
          updatedAt: now,
        });
        changed = true;
      }
      return changed;
    });
  }
  async list(operator) {
    const data = await this.backend.read();
    return data.users
      .filter((user) => !user.deletedAt && (!operator || isOwner(operator) || (user.role !== USER_ROLES.ADMIN && user.userId !== RECLOUD_TEST_USER_ID)))
      .map(({ tokenHash, passwordHash, allowBearer, tokenExpiresAt, ...user }) => user);
  }
  async getNextManagedUserId() {
    const data = await this.backend.read();
    return nextManagedUserId(data.users);
  }
  async findByUserId(userId) {
    const data = await this.backend.read();
    const user = data.users.find((item) => item.active !== false && item.userId === String(userId || "").trim());
    if (!user) return null;
    const { tokenHash: ignoredToken, passwordHash: ignoredPassword, allowBearer, tokenExpiresAt, ...safe } = user;
    return safe;
  }
  async findByToken(token) {
    if (!token) return null;
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const data = await this.backend.read();
    const now = Date.now();
    const user = data.users.find((item) => item.active !== false && item.allowBearer !== false && item.tokenHash === tokenHash && (!item.tokenExpiresAt || Date.parse(item.tokenExpiresAt) > now));
    if (!user) return null;
    const { tokenHash: ignoredToken, passwordHash: ignoredPassword, ...safe } = user;
    return safe;
  }
  async findByCredentials(userId, password) {
    const normalizedUserId = String(userId || "").trim();
    const tokenHash = crypto.createHash("sha256").update(String(password || "")).digest("hex");
    const data = await this.backend.read();
    const user = data.users.find((item) => item.active !== false && item.userId === normalizedUserId && (item.passwordHash || item.tokenHash) === tokenHash);
    if (!user) return null;
    const { tokenHash: ignoredToken, passwordHash: ignoredPassword, ...safe } = user;
    return safe;
  }
  createSession(token, userId, expiresAt) {
    const normalizedUserId = String(userId || "").trim();
    const tokenHash = crypto.createHash("sha256").update(String(token || "")).digest("hex");
    const expiry = new Date(expiresAt).toISOString();
    return this.backend.update((data) => {
      const now = Date.now();
      const user = data.users.find((item) => item.userId === normalizedUserId && item.active !== false && !item.deletedAt);
      if (!user) throw Object.assign(new Error("账号不存在或已停用"), { code: "ACCOUNT_NOT_FOUND", status: 404 });
      const activeSessions = (data.sessions || []).filter((session) => Date.parse(session.expiresAt) > now);
      const otherUserSessions = activeSessions.filter((session) => session.userId !== normalizedUserId);
      const userSessions = activeSessions.filter((session) => session.userId === normalizedUserId).slice(-9);
      data.sessions = [...otherUserSessions, ...userSessions, {
        tokenHash,
        userId: normalizedUserId,
        expiresAt: expiry,
        createdAt: new Date().toISOString(),
      }];
      return { userId: normalizedUserId, expiresAt: expiry };
    });
  }
  async findSession(token) {
    if (!token) return null;
    const tokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");
    const data = await this.backend.read();
    const session = (data.sessions || []).find((item) => (
      item.tokenHash === tokenHash && Date.parse(item.expiresAt) > Date.now()
    ));
    return session ? { userId: session.userId, expiresAt: session.expiresAt } : null;
  }
  revokeSession(token) {
    if (!token) return Promise.resolve(false);
    const tokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");
    return this.backend.update((data) => {
      const before = (data.sessions || []).length;
      data.sessions = (data.sessions || []).filter((session) => session.tokenHash !== tokenHash);
      return data.sessions.length !== before;
    });
  }
  revokeSessionsForUser(userId) {
    const normalizedUserId = String(userId || "").trim();
    return this.backend.update((data) => {
      const before = (data.sessions || []).length;
      data.sessions = (data.sessions || []).filter((session) => session.userId !== normalizedUserId);
      return before - data.sessions.length;
    });
  }
  createManagedAccount(input, operator) {
    if (operator?.role !== USER_ROLES.ADMIN) throw Object.assign(new Error("只有管理员可以创建账号"), { code: "ACCOUNT_ADMIN_REQUIRED", status: 403 });
    const displayName = String(input.displayName || "").trim();
    const phone = normalizeTechnicianPhone(input.phone);
    const role = String(input.role || "").trim().toUpperCase();
    const requestedUserId = String(input.userId || "").trim();
    const isRecloudTestAccount = requestedUserId === RECLOUD_TEST_USER_ID;
    const specialties = [...new Set(input.repairSpecialties || [])];
    if (!displayName) throw Object.assign(new Error("请填写姓名"), { code: "ACCOUNT_DISPLAY_NAME_REQUIRED", status: 400 });
    if (!/^1[3-9]\d{9}$/.test(phone)) throw Object.assign(new Error("请填写正确的11位手机号"), { code: "ACCOUNT_PHONE_INVALID", status: 400 });
    if (!MANAGED_ACCOUNT_ROLES.has(role)) throw Object.assign(new Error("请选择账号角色"), { code: "ACCOUNT_ROLE_INVALID", status: 400 });
    if (role === USER_ROLES.ADMIN && !isOwner(operator)) throw Object.assign(new Error("只有负责人可以创建管理员账号"), { code: "ACCOUNT_OWNER_REQUIRED", status: 403 });
    if (isRecloudTestAccount && !isOwner(operator)) throw Object.assign(new Error("只有负责人可以创建和管理 FieldDesk0004 测试账号"), { code: "ACCOUNT_OWNER_REQUIRED", status: 403 });
    if (requestedUserId && !/^FieldDesk\d{4,}$/.test(requestedUserId)) throw Object.assign(new Error("账号必须由 FieldDesk 加4位以上数字组成"), { code: "ACCOUNT_USER_ID_INVALID", status: 400 });
    if (requestedUserId && Number(requestedUserId.slice(MANAGED_ACCOUNT_PREFIX.length)) < Number(RECLOUD_TEST_USER_ID.slice(MANAGED_ACCOUNT_PREFIX.length))) throw Object.assign(new Error("账号数字不能小于0004"), { code: "ACCOUNT_USER_ID_BELOW_MINIMUM", status: 400 });
    if (isRecloudTestAccount && role !== USER_ROLES.TECHNICIAN) throw Object.assign(new Error("FieldDesk0004 是瑞云对接测试师傅账号，请选择扫地机或洗地机师傅"), { code: "ACCOUNT_RECLOUD_TEST_ROLE_REQUIRED", status: 400 });
    if (specialties.some((item) => !SPECIALTIES.has(item))) throw Object.assign(new Error("维修品类无效"), { code: "ACCOUNT_SPECIALTY_INVALID", status: 400 });
    if (role === USER_ROLES.TECHNICIAN && isRecloudTestAccount && !(specialties.length === SPECIALTIES.size && specialties.every((item) => SPECIALTIES.has(item)))) throw Object.assign(new Error("FieldDesk0004 必须同时拥有扫地机和洗地机权限"), { code: "ACCOUNT_SPECIALTY_REQUIRED", status: 400 });
    if (role === USER_ROLES.TECHNICIAN && !isRecloudTestAccount && specialties.length !== 1) throw Object.assign(new Error("维修师傅必须且只能选择一个维修品类"), { code: "ACCOUNT_SPECIALTY_REQUIRED", status: 400 });
    if (role !== USER_ROLES.TECHNICIAN && specialties.length) throw Object.assign(new Error("库管和信息员不能配置维修权限"), { code: "ACCOUNT_SPECIALTY_FORBIDDEN", status: 400 });
    return this.backend.update((data) => {
      const userId = requestedUserId || nextManagedUserId(data.users);
      if (data.users.some((item) => item.userId === userId)) {
        throw Object.assign(new Error("该 FieldDesk 账号已被使用，请更换后面的数字"), { code: "ACCOUNT_USER_ID_EXISTS", status: 409 });
      }
      if (data.users.some((item) => !item.deletedAt && normalizeTechnicianPhone(item.phone) === phone)) {
        throw Object.assign(new Error("该手机号已创建 FieldDesk 账号"), { code: "ACCOUNT_PHONE_EXISTS", status: 409 });
      }
      const now = new Date().toISOString();
      const user = {
        userId,
        displayName,
        phone,
        role,
        accountPurpose: isRecloudTestAccount ? "RECLOUD_TECHNICIAN_TEST" : "",
        repairSpecialties: specialties,
        recloudAssignmentMode: "DIRECT",
        recloudAssigneeName: role === USER_ROLES.TECHNICIAN ? displayName : "",
        recloudFallbackAssigneeName: "",
        active: true,
        allowBearer: false,
        tokenHash: null,
        passwordHash: crypto.createHash("sha256").update(MANAGED_ACCOUNT_DEFAULT_PASSWORD).digest("hex"),
        mustChangePassword: true,
        tokenExpiresAt: null,
        createdAt: now,
        updatedAt: now,
      };
      data.users.push(user);
      const { tokenHash: ignoredToken, passwordHash: ignoredPassword, ...safe } = user;
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
      if (isOwner(data.users[index])) throw Object.assign(new Error("负责人账号不能删除"), { code: "ACCOUNT_OWNER_PROTECTED", status: 409 });
      if (data.users[index].userId === RECLOUD_TEST_USER_ID && !isOwner(operator)) throw Object.assign(new Error("只有负责人可以删除 FieldDesk0004 测试账号"), { code: "ACCOUNT_OWNER_REQUIRED", status: 403 });
      if (data.users[index].role === USER_ROLES.ADMIN && !isOwner(operator)) throw Object.assign(new Error("只有负责人可以删除管理员账号"), { code: "ACCOUNT_OWNER_REQUIRED", status: 403 });
      const removed = data.users[index];
      removed.active = false;
      removed.deletedAt = new Date().toISOString();
      removed.updatedAt = removed.deletedAt;
      return { userId: removed.userId, displayName: removed.displayName };
    });
  }
  resetPassword(userId, operator) {
    if (operator?.role !== USER_ROLES.ADMIN) throw Object.assign(new Error("只有管理员可以重置密码"), { code: "ACCOUNT_ADMIN_REQUIRED", status: 403 });
    const normalizedUserId = String(userId || "").trim();
    return this.backend.update((data) => {
      const user = data.users.find((item) => item.userId === normalizedUserId && !item.deletedAt);
      if (!user) throw Object.assign(new Error("账号不存在"), { code: "ACCOUNT_NOT_FOUND", status: 404 });
      if (isOwner(user)) throw Object.assign(new Error("负责人账号不能由账号管理页重置"), { code: "ACCOUNT_OWNER_PROTECTED", status: 409 });
      if (user.userId === RECLOUD_TEST_USER_ID && !isOwner(operator)) throw Object.assign(new Error("只有负责人可以重置 FieldDesk0004 测试账号密码"), { code: "ACCOUNT_OWNER_REQUIRED", status: 403 });
      if (user.role === USER_ROLES.ADMIN && !isOwner(operator)) throw Object.assign(new Error("只有负责人可以重置管理员密码"), { code: "ACCOUNT_OWNER_REQUIRED", status: 403 });
      user.passwordHash = crypto.createHash("sha256").update(MANAGED_ACCOUNT_DEFAULT_PASSWORD).digest("hex");
      user.mustChangePassword = true;
      user.updatedAt = new Date().toISOString();
      return { userId: user.userId, displayName: user.displayName, initialPassword: MANAGED_ACCOUNT_DEFAULT_PASSWORD };
    });
  }
  changePassword(userId, newPassword) {
    const normalizedUserId = String(userId || "").trim();
    const password = String(newPassword || "");
    if (password === MANAGED_ACCOUNT_DEFAULT_PASSWORD) throw Object.assign(new Error("新密码不能继续使用初始密码000000"), { code: "ACCOUNT_PASSWORD_UNCHANGED", status: 400 });
    if (password.length < 6) throw Object.assign(new Error("新密码至少需要6位"), { code: "ACCOUNT_PASSWORD_TOO_SHORT", status: 400 });
    return this.backend.update((data) => {
      const user = data.users.find((item) => item.userId === normalizedUserId && !item.deletedAt && item.active !== false);
      if (!user) throw Object.assign(new Error("账号不存在或已停用"), { code: "ACCOUNT_NOT_FOUND", status: 404 });
      user.passwordHash = crypto.createHash("sha256").update(password).digest("hex");
      user.mustChangePassword = false;
      user.updatedAt = new Date().toISOString();
      return { userId: user.userId, displayName: user.displayName };
    });
  }
  updateRecloudOperatorName(userId, value) {
    const normalizedUserId = String(userId || "").trim();
    const recloudAssigneeName = String(value || "").trim();
    if (![OWNER_USER_ID, RECLOUD_TEST_USER_ID].includes(normalizedUserId)) throw Object.assign(new Error("当前账号不能自行修改瑞云操作姓名"), { code: "ACCOUNT_RECLOUD_OPERATOR_NAME_FORBIDDEN", status: 403 });
    if (!recloudAssigneeName) throw Object.assign(new Error("请填写瑞云中的操作人姓名"), { code: "ACCOUNT_RECLOUD_OPERATOR_NAME_REQUIRED", status: 400 });
    return this.backend.update((data) => {
      const user = data.users.find((item) => item.userId === normalizedUserId && !item.deletedAt && item.active !== false);
      if (!user) throw Object.assign(new Error("账号不存在或已停用"), { code: "ACCOUNT_NOT_FOUND", status: 404 });
      if (normalizedUserId === RECLOUD_TEST_USER_ID) user.displayName = recloudAssigneeName;
      user.recloudAssignmentMode = "DIRECT";
      user.recloudAssigneeName = recloudAssigneeName;
      user.recloudFallbackAssigneeName = "";
      user.updatedAt = new Date().toISOString();
      return { userId: user.userId, displayName: user.displayName, recloudAssigneeName };
    });
  }
  upsert(input, operator) {
    if (operator?.role !== USER_ROLES.ADMIN) throw Object.assign(new Error("只有管理员可以配置账号"), { code: "ACCOUNT_ADMIN_REQUIRED", status: 403 });
    const role = String(input.role || "");
    const userId = String(input.userId || "").trim();
    const isRecloudTestAccount = userId === RECLOUD_TEST_USER_ID;
    if (userId === OWNER_USER_ID) throw Object.assign(new Error("负责人账号和权限不能修改"), { code: "ACCOUNT_OWNER_PROTECTED", status: 409 });
    if (!ROLES.has(role)) throw Object.assign(new Error("账号角色无效"), { code: "ACCOUNT_ROLE_INVALID", status: 400 });
    if (isRecloudTestAccount && role !== USER_ROLES.TECHNICIAN) throw Object.assign(new Error("FieldDesk0004 必须保持为瑞云对接测试师傅账号"), { code: "ACCOUNT_RECLOUD_TEST_ROLE_REQUIRED", status: 400 });
    if (isRecloudTestAccount && !isOwner(operator)) throw Object.assign(new Error("只有负责人可以管理 FieldDesk0004 测试账号"), { code: "ACCOUNT_OWNER_REQUIRED", status: 403 });
    const specialties = [...new Set(input.repairSpecialties || [])];
    if (specialties.some((item) => !SPECIALTIES.has(item))) throw Object.assign(new Error("维修品类无效"), { code: "ACCOUNT_SPECIALTY_INVALID", status: 400 });
    if (role === USER_ROLES.TECHNICIAN && specialties.length === 0) throw Object.assign(new Error("维修师傅至少选择一个维修权限"), { code: "ACCOUNT_SPECIALTY_REQUIRED", status: 400 });
    if (isRecloudTestAccount && !(specialties.length === SPECIALTIES.size && specialties.every((item) => SPECIALTIES.has(item)))) throw Object.assign(new Error("FieldDesk0004 必须同时拥有扫地机和洗地机权限"), { code: "ACCOUNT_SPECIALTY_REQUIRED", status: 400 });
    if (!isRecloudTestAccount && /^FieldDesk\d+$/.test(userId) && role === USER_ROLES.TECHNICIAN && specialties.length !== 1) throw Object.assign(new Error("正式维修账号必须且只能选择一个维修品类"), { code: "ACCOUNT_SPECIALTY_REQUIRED", status: 400 });
    if (role !== USER_ROLES.TECHNICIAN && specialties.length && role !== USER_ROLES.ADMIN) throw Object.assign(new Error("该角色不能配置维修品类"), { code: "ACCOUNT_SPECIALTY_FORBIDDEN", status: 400 });
    const displayName = String(input.displayName || "").trim();
    const recloudAssignmentMode = isRecloudTestAccount ? "DIRECT" : String(input.recloudAssignmentMode || "DIRECT").trim().toUpperCase();
    const recloudAssigneeName = isRecloudTestAccount ? displayName : String(input.recloudAssigneeName || "").trim();
    const recloudFallbackAssigneeName = String(input.recloudFallbackAssigneeName || "").trim();
    if (!RECLOUD_ASSIGNMENT_MODES.has(recloudAssignmentMode)) throw Object.assign(new Error("瑞云改派方式无效"), { code: "ACCOUNT_RECLOUD_ASSIGNMENT_MODE_INVALID", status: 400 });
    if (role === USER_ROLES.TECHNICIAN && recloudAssignmentMode === "FALLBACK" && !recloudFallbackAssigneeName) {
      throw Object.assign(new Error("新员工暂未进入瑞云时，必须填写兜底负责人"), { code: "ACCOUNT_RECLOUD_FALLBACK_REQUIRED", status: 400 });
    }
    return this.backend.update((data) => {
      const existing = data.users.find((item) => item.userId === userId);
      if ((role === USER_ROLES.ADMIN || existing?.role === USER_ROLES.ADMIN) && !isOwner(operator)) throw Object.assign(new Error("只有负责人可以管理管理员账号及权限"), { code: "ACCOUNT_OWNER_REQUIRED", status: 403 });
      const password = input.password || input.accessToken;
      const passwordHash = password
        ? crypto.createHash("sha256").update(String(password)).digest("hex")
        : existing?.passwordHash || existing?.tokenHash;
      if (!userId || !input.displayName || !passwordHash) throw Object.assign(new Error("账号资料不完整"), { code: "ACCOUNT_FIELDS_REQUIRED", status: 400 });
      const next = { userId, displayName, phone: normalizeTechnicianPhone(input.phone ?? existing?.phone), role, accountPurpose: isRecloudTestAccount ? "RECLOUD_TECHNICIAN_TEST" : existing?.accountPurpose || "", repairSpecialties: specialties, recloudAssignmentMode, recloudAssigneeName, recloudFallbackAssigneeName: isRecloudTestAccount ? "" : recloudFallbackAssigneeName, active: input.active !== false, allowBearer: false, tokenHash: null, passwordHash, mustChangePassword: password ? true : existing?.mustChangePassword === true, tokenExpiresAt: null, updatedAt: new Date().toISOString() };
      if (existing) Object.assign(existing, next); else data.users.push({ ...next, createdAt: next.updatedAt });
      const { tokenHash: ignoredToken, passwordHash: ignoredPassword, ...safe } = next;
      return safe;
    });
  }
}

module.exports = { AccountStore, SPECIALTIES, MANAGED_ACCOUNT_PREFIX, MANAGED_ACCOUNT_DEFAULT_PASSWORD, RECLOUD_TEST_USER_ID, OWNER_USER_ID, OWNER_AUTHORITY, nextManagedUserId };
