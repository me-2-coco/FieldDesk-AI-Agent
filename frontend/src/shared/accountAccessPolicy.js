export const OWNER_USER_ID = "FieldDesk0001"
export const RECLOUD_TEST_USER_ID = "FieldDesk0004"

function userIdOf(user = {}) {
  return String(user.id || user.userId || "").trim()
}

export function isOwnerAccount(user = {}) {
  return userIdOf(user) === OWNER_USER_ID
}

export function isRecloudTestAccount(user = {}) {
  return userIdOf(user) === RECLOUD_TEST_USER_ID
}

export function isBusinessRuleExempt(user = {}) {
  return isOwnerAccount(user) || isRecloudTestAccount(user)
}

export function hasBusinessRole(user = {}, ...roles) {
  return isBusinessRuleExempt(user) || roles.includes(user.role)
}

export function isInformationClerkReadOnlyByDefault(user = {}) {
  return !isBusinessRuleExempt(user) && String(user.role || "").toLowerCase() === "information_clerk"
}
