const OWNER_USER_ID = "FieldDesk0001";
const RECLOUD_TEST_USER_ID = "FieldDesk0004";

function userIdOf(user = {}) {
  return String(user.userId || user.id || "").trim();
}

function isOwnerAccount(user = {}) {
  return userIdOf(user) === OWNER_USER_ID;
}

function isRecloudTestAccount(user = {}) {
  return userIdOf(user) === RECLOUD_TEST_USER_ID;
}

function isBusinessRuleExempt(user = {}) {
  return isOwnerAccount(user) || isRecloudTestAccount(user);
}

function hasBusinessRole(user = {}, ...roles) {
  return isBusinessRuleExempt(user) || roles.includes(user.role);
}

function isInformationClerkReadOnlyByDefault(user = {}) {
  return !isBusinessRuleExempt(user) && user.role === "INFORMATION_CLERK";
}

module.exports = {
  OWNER_USER_ID,
  RECLOUD_TEST_USER_ID,
  isOwnerAccount,
  isRecloudTestAccount,
  isBusinessRuleExempt,
  hasBusinessRole,
  isInformationClerkReadOnlyByDefault,
};
