const USER_ROLES = Object.freeze({
  ADMIN: "ADMIN",
  TECHNICIAN: "TECHNICIAN",
  WAREHOUSE: "WAREHOUSE",
});

const LOCAL_DEVELOPMENT_USERS = Object.freeze([
  Object.freeze({
    userId: "LOCAL-TECH-SWEEP",
    displayName: "本地测试师傅（扫地机）",
    role: USER_ROLES.TECHNICIAN,
    repairSpecialties: Object.freeze(["扫地机"]),
  }),
  Object.freeze({
    userId: "LOCAL-TECH-WASH",
    displayName: "本地测试师傅（洗地机）",
    role: USER_ROLES.TECHNICIAN,
    repairSpecialties: Object.freeze(["洗地机"]),
  }),
  Object.freeze({
    userId: "LOCAL-TECH-DUAL",
    displayName: "本地测试师傅（双品类）",
    role: USER_ROLES.TECHNICIAN,
    repairSpecialties: Object.freeze(["扫地机", "洗地机"]),
  }),
  Object.freeze({
    userId: "LOCAL-WAREHOUSE",
    displayName: "本地测试库房",
    role: USER_ROLES.WAREHOUSE,
    repairSpecialties: Object.freeze([]),
  }),
  Object.freeze({
    userId: "LOCAL-ADMIN",
    displayName: "本地测试管理员",
    role: USER_ROLES.ADMIN,
    repairSpecialties: Object.freeze(["扫地机", "洗地机"]),
  }),
]);

const DEFAULT_LOCAL_USER_ID = "LOCAL-TECH-DUAL";
const LOCAL_FRONTEND_USER_IDS = Object.freeze({
  "USER-001": "LOCAL-TECH-SWEEP",
  "USER-002": "LOCAL-WAREHOUSE",
  "USER-003": "LOCAL-ADMIN",
  "USER-004": "LOCAL-TECH-WASH",
  "USER-005": "LOCAL-TECH-DUAL",
});

function getLocalCurrentUser(env = process.env, requestedId = "") {
  const configuredId =
    String(requestedId || env.FIELDDESK_LOCAL_USER_ID || "").trim() ||
    DEFAULT_LOCAL_USER_ID;
  const resolvedId = LOCAL_FRONTEND_USER_IDS[configuredId] || configuredId;
  const user =
    LOCAL_DEVELOPMENT_USERS.find((item) => item.userId === resolvedId) ||
    LOCAL_DEVELOPMENT_USERS.find(
      (item) => item.userId === DEFAULT_LOCAL_USER_ID
    );
  return {
    userId: user.userId,
    displayName: user.displayName,
    role: user.role,
    repairSpecialties: [...user.repairSpecialties],
    localDevelopmentAccount: true,
  };
}

module.exports = {
  DEFAULT_LOCAL_USER_ID,
  LOCAL_FRONTEND_USER_IDS,
  LOCAL_DEVELOPMENT_USERS,
  USER_ROLES,
  getLocalCurrentUser,
};
