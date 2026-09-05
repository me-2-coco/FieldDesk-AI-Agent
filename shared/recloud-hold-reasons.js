const RECLOUD_HOLD_REASON_GROUPS = Object.freeze([
  Object.freeze({ category: "保内", reasons: Object.freeze([
    "待补寄配件", "待技术支持", "待客服核实", "待提供sn/购机凭证", "功能类未复现", "体验类未复现",
    "网点缺件", "无异常核实中", "用户拒绝沟通需客服介入", "用户无法联系", "用户要求暂放", "总部缺件",
  ]) }),
  Object.freeze({ category: "保外", reasons: Object.freeze([
    "不认可费用，沟通中", "待补寄配件", "待技术支持", "待提供sn/购机凭证", "待用户付费", "功能类未复现",
    "机器进液/人为损坏，待沟通费用", "客户认可收费，待付费/已付费，待维修", "体验类未复现", "网点缺件",
    "用户拒绝沟通需客服介入", "用户无法联系", "用户要求暂放", "用户有折扣需求，需沟通", "总部缺件",
  ]) }),
  Object.freeze({ category: "待检测", reasons: Object.freeze(["文字描述签收后未进行检测原因"]) }),
  Object.freeze({ category: "样机", reasons: Object.freeze(["待确认"]) }),
]);

function normalizeHoldReason(value) {
  return String(value || "").trim();
}

function validateHoldInput(input = {}) {
  const category = normalizeHoldReason(input.category);
  const reason = normalizeHoldReason(input.reason);
  const remark = String(input.remark || "").trim();
  const group = RECLOUD_HOLD_REASON_GROUPS.find((item) => item.category === category);
  if (!group || !group.reasons.includes(reason)) {
    throw Object.assign(new Error("请选择有效的瑞云滞处理原因"), {
      code: "HOLD_REASON_INVALID",
      status: 400,
    });
  }
  if (!remark) {
    throw Object.assign(new Error("请填写暂存备注，说明为什么需要暂存"), {
      code: "HOLD_REMARK_REQUIRED",
      status: 400,
    });
  }
  return { category, reason, remark: remark.slice(0, 5000) };
}

module.exports = { RECLOUD_HOLD_REASON_GROUPS, normalizeHoldReason, validateHoldInput };
