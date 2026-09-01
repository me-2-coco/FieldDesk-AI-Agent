const { phoneMatches } = require("./repair-history-query");

function attachmentSummary(item, category) {
  return {
    id: item.id,
    category,
    name: item.name,
    mimeType: item.mimeType,
    size: Number(item.size) || 0,
  };
}

function reportAttachments(order) {
  return [
    ...(order.receiptAttachments || []).map((item) => attachmentSummary(item, "receipt")),
    ...(order.repairCompletion?.attachments || []).map((item) => attachmentSummary(item, "repair")),
    ...(order.returnShipment?.attachments || []).map((item) => attachmentSummary(item, "shipping")),
  ];
}

function searchInformationRepairReports(records, keyword) {
  const query = String(keyword || "").trim();
  const upper = query.toUpperCase();
  return (Array.isArray(records) ? records : [])
    .filter((order) => phoneMatches(order.phoneMasked || order.phone, query)
      || String(order.logisticsNo || "").toUpperCase() === upper
      || String(order.rmaNo || "").toUpperCase().includes(upper))
    .map((order) => ({
      rmaNo: order.rmaNo,
      logisticsNo: order.logisticsNo,
      sn: order.sn,
      productLine: order.productLine || order.specialty || "",
      status: order.status,
      technicianName: order.technicianName || order.repairCompletion?.operatorName || order.operatorName || "未分配",
      updatedAt: order.updatedAt || "",
      hasRepairReport: Boolean(order.repairCompletion),
      attachmentCount: reportAttachments(order).length,
    }))
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

function buildInformationRepairReport(order) {
  const completion = order.repairCompletion || {};
  const parts = completion.usedParts?.length ? completion.usedParts : (order.partApplications || []);
  return {
    rmaNo: order.rmaNo,
    logisticsNo: order.logisticsNo,
    sn: order.sn,
    productLine: order.productLine || order.specialty || "",
    status: order.status,
    technicianName: order.technicianName || completion.operatorName || order.operatorName || "未分配",
    receivedAt: order.receiptCompletedAt || "",
    inspection: {
      result: order.inspectionResult || order.detectionResult || "",
      remark: order.inspectionRemark || "",
      faultCategory: order.faultCategory || "",
      warranty: order.technicianWarranty || "",
      updatedAt: order.inspectionUpdatedAt || "",
    },
    repairCompletion: {
      faultClassification: [completion.faultLevel1, completion.faultLevel2, completion.faultLevel3].filter(Boolean).join(" / "),
      responsibilityType: completion.responsibilityType || "",
      detectionResult: completion.detectionResult || "",
      repairMeasure: completion.repairMeasure || "",
      speechTemplate: completion.speechTemplate || "",
      primaryRemark: completion.primaryRemark || "",
      secondaryRemark: completion.secondaryRemark || "",
      pricing: completion.pricing || null,
      submittedAt: completion.submittedAt || "",
      operatorName: completion.operatorName || "",
    },
    usedParts: parts.map((part) => ({
      partCode: part.partCode || "",
      partName: part.partName || "",
      quantity: Number(part.quantity) || 0,
      repairLevel: part.repairLevel || "",
      retailPrice: Number(part.retailPrice) || 0,
      returnRequired: Boolean(part.returnRequired),
    })),
    returnShipment: order.returnShipment ? {
      logisticsCompany: order.returnShipment.logisticsCompany || "",
      trackingNo: order.returnShipment.trackingNo || "",
      shippedAt: order.returnShipment.shippedAt || "",
      operatorName: order.returnShipment.operatorName || "",
    } : null,
    attachments: reportAttachments(order),
    timeline: (order.timeline || []).map((item) => ({
      type: item.type || "",
      label: item.label || "",
      operatorName: item.operatorName || item.operator || "",
      createdAt: item.createdAt || item.timestamp || item.at || "",
    })),
  };
}

function findAttachment(order, category, attachmentId) {
  const sources = {
    receipt: order.receiptAttachments || [],
    repair: order.repairCompletion?.attachments || [],
    shipping: order.returnShipment?.attachments || [],
  };
  return (sources[category] || []).find((item) => item.id === attachmentId) || null;
}

module.exports = { buildInformationRepairReport, findAttachment, reportAttachments, searchInformationRepairReports };
