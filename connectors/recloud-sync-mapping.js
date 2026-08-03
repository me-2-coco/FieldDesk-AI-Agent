const MAPPING_VERSION = "v1";

const NODE_REQUIRED_FIELDS = Object.freeze({
  RECEIPT: ["sn", "remark"],
  INSPECTION_COMPLETED: ["inspectionResult"],
  REPAIR_COMPLETED: ["faultLevel1", "faultLevel2", "faultLevel3", "responsibilityType", "repairMeasure"],
  RETURN_SHIPPED: ["logisticsCompany", "trackingNo", "shippedAt"],
  ORDER_COMPLETED: ["completedAt"],
});

function compactParts(parts) {
  return (Array.isArray(parts) ? parts : []).map((part) => ({
    partCode: String(part.partCode || part.code || "").trim(),
    partName: String(part.partName || part.name || "").trim(),
    quantity: Number(part.quantity || 0),
  })).filter((part) => part.partCode && part.quantity > 0);
}

function buildNodePayload(order, nodeType) {
  const completion = order.repairCompletion || {};
  const shipment = order.returnShipment || {};
  const payloads = {
    RECEIPT: {
      sn: order.sn,
      remark: order.remark,
      specialty: order.specialty,
      productLine: order.productLine,
      receiptCompletedAt: order.receiptCompletedAt,
    },
    INSPECTION_COMPLETED: {
      inspectionResult: order.inspectionResult,
      inspectionRemark: order.inspectionRemark,
      inspectionCompletedAt: order.inspectionUpdatedAt,
    },
    REPAIR_COMPLETED: {
      faultLevel1: completion.faultLevel1,
      faultLevel2: completion.faultLevel2,
      faultLevel3: completion.faultLevel3,
      responsibilityType: completion.responsibilityType,
      repairMeasure: completion.repairMeasure,
      usedParts: compactParts(completion.usedParts),
      attachmentCount: Array.isArray(completion.attachments) ? completion.attachments.length : 0,
      completedAt: completion.submittedAt,
    },
    RETURN_SHIPPED: {
      logisticsCompany: shipment.logisticsCompany,
      trackingNo: shipment.trackingNo,
      shippedAt: shipment.shippedAt,
      proofCount: Array.isArray(shipment.attachments) ? shipment.attachments.length : 0,
    },
    ORDER_COMPLETED: {
      completedAt: order.completedAt,
    },
  };
  return Object.fromEntries(
    Object.entries(payloads[nodeType] || {}).filter(([, value]) => value !== undefined && value !== null)
  );
}

function validateNodePayload(nodeType, payload = {}) {
  const required = NODE_REQUIRED_FIELDS[nodeType];
  if (!required) {
    throw Object.assign(new Error("不支持的瑞云同步节点"), {
      code: "SYNC_NODE_UNSUPPORTED", permanent: true,
    });
  }
  const missingFields = required.filter((field) => {
    const value = payload[field];
    return value === undefined || value === null || String(value).trim() === "";
  });
  if (missingFields.length) {
    throw Object.assign(new Error("同步字段不完整"), {
      code: "RECLOUD_SYNC_VALIDATION_FAILED", permanent: true, missingFields,
    });
  }
  return payload;
}

module.exports = { MAPPING_VERSION, NODE_REQUIRED_FIELDS, buildNodePayload, validateNodePayload };
