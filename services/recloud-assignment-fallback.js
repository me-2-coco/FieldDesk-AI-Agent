const DEFAULT_ASSIGNEE = '刘朝阳';
async function resolveAssignmentTarget(name, search, confirmAbsent) {
  let rows = await search(name);
  if (rows.length === 1) return { name, rows, fallback: false };
  if (rows.length !== 0 || name === DEFAULT_ASSIGNEE || !await confirmAbsent(name)) {
    throw Object.assign(new Error(`瑞云人员未能唯一确认：${name}，未触发兜底改派`), {code:'RECLOUD_ASSIGNMENT_TARGET_NOT_UNIQUE'});
  }
  rows = await search(DEFAULT_ASSIGNEE);
  if (rows.length !== 1) throw Object.assign(new Error('兜底负责人刘朝阳未能唯一确认，已停止改派'), {code:'RECLOUD_ASSIGNMENT_FALLBACK_NOT_UNIQUE'});
  return {name:DEFAULT_ASSIGNEE, rows, fallback:true};
}
module.exports = { DEFAULT_ASSIGNEE, resolveAssignmentTarget };
