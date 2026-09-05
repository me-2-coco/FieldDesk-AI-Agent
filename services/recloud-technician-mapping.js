const ASSIGNMENT_MODES = Object.freeze({
  DIRECT: "DIRECT",
  FALLBACK: "FALLBACK",
});

function normalizeName(value) {
  return String(value || "").trim();
}

function resolveRecloudTechnician(user = {}, options = {}) {
  const mode = String(user.recloudAssignmentMode || "").trim().toUpperCase();
  const directName = normalizeName(user.recloudAssigneeName);
  const fallbackName = normalizeName(
    user.recloudFallbackAssigneeName || options.defaultFallbackAssignee
  );

  if (mode === ASSIGNMENT_MODES.FALLBACK) {
    if (!fallbackName) {
      const error = new Error("该师傅尚未配置瑞云姓名或兜底负责人");
      error.code = "RECLOUD_TECHNICIAN_FALLBACK_REQUIRED";
      error.status = 409;
      throw error;
    }
    return {
      fieldDeskUserId: normalizeName(user.userId),
      fieldDeskDisplayName: normalizeName(user.displayName),
      servicePerson: fallbackName,
      source: "FALLBACK",
    };
  }

  if (directName) {
    return {
      fieldDeskUserId: normalizeName(user.userId),
      fieldDeskDisplayName: normalizeName(user.displayName),
      servicePerson: directName,
      source: "DIRECT",
    };
  }

  const displayName = normalizeName(user.displayName);
  if (displayName) {
    return {
      fieldDeskUserId: normalizeName(user.userId),
      fieldDeskDisplayName: displayName,
      servicePerson: displayName,
      source: "DISPLAY_NAME",
    };
  }

  const error = new Error("无法确定瑞云改派负责人");
  error.code = "RECLOUD_TECHNICIAN_MAPPING_REQUIRED";
  error.status = 409;
  throw error;
}

module.exports = {
  ASSIGNMENT_MODES,
  resolveRecloudTechnician,
};
