const DIAGNOSTIC_STATUS = Object.freeze({
  UNCONFIGURED: "UNCONFIGURED",
  WAITING_CAPTURE: "WAITING_CAPTURE",
  CAPTURED: "CAPTURED",
  READY: "READY",
  FAILED: "FAILED",
});

const REQUIRED_CAPTURE_FIELDS = Object.freeze([
  "entryFeatures",
  "httpMethod",
  "urlPathTemplate",
  "requestFieldNames",
  "responseStatus",
  "responseFieldNames",
  "successCriteriaFieldNames",
  "idempotencyFieldNames",
  "enumStatusValues",
]);

const RECLOUD_SYNC_NODE_TEMPLATES = Object.freeze({
  receipt: Object.freeze({
    nodeType: "RECEIPT", label: "签收",
    requiredBusinessFields: Object.freeze(["rmaNo", "logisticsNo", "sn", "remark"]),
    unresolvedRules: Object.freeze(["签收入口", "产品行唯一键", "签收请求路径与方法", "成功状态字段", "幂等查询字段"]),
  }),
  inspection: Object.freeze({
    nodeType: "INSPECTION_COMPLETED", label: "检测",
    requiredBusinessFields: Object.freeze(["rmaNo", "sn", "inspectionResult"]),
    unresolvedRules: Object.freeze(["检测节点入口", "检测结果枚举", "检测提交请求字段", "成功状态字段", "幂等查询字段"]),
  }),
  repair: Object.freeze({
    nodeType: "REPAIR_COMPLETED", label: "维修完工",
    requiredBusinessFields: Object.freeze(["rmaNo", "sn", "faultLevel1", "faultLevel2", "faultLevel3", "responsibilityType", "repairMeasure"]),
    unresolvedRules: Object.freeze(["维修节点入口", "三级故障代码", "责任类型代码", "配件与附件字段", "完工按钮", "完工后可提交状态", "提交按钮", "提交后锁定状态与幂等字段"]),
  }),
  shipping: Object.freeze({
    nodeType: "RETURN_SHIPPED", label: "返件发货",
    requiredBusinessFields: Object.freeze(["rmaNo", "logisticsCompany", "trackingNo"]),
    unresolvedRules: Object.freeze(["发货入口", "物流公司代码", "发货请求字段", "凭证上传规则", "成功状态与幂等字段"]),
  }),
  completion: Object.freeze({
    nodeType: "ORDER_COMPLETED", label: "工单完结",
    requiredBusinessFields: Object.freeze(["rmaNo", "completedAt"]),
    unresolvedRules: Object.freeze(["完结入口", "完结必填字段", "完结请求路径与方法", "成功状态字段", "幂等查询字段"]),
  }),
});

module.exports = { DIAGNOSTIC_STATUS, REQUIRED_CAPTURE_FIELDS, RECLOUD_SYNC_NODE_TEMPLATES };
