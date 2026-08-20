const { buildRecloudRepairFormPlan, validateNodePayload } = require("./recloud-sync-mapping");

class RecloudAdapter {
  async syncReceipt() { throw new Error("syncReceipt must be implemented"); }
  async syncInspectionCompleted() { throw new Error("syncInspectionCompleted must be implemented"); }
  async syncRepairCompleted() { throw new Error("syncRepairCompleted must be implemented"); }
  async syncReturnShipped() { throw new Error("syncReturnShipped must be implemented"); }
  async syncOrderCompleted() { throw new Error("syncOrderCompleted must be implemented"); }
}

class DryRunRecloudAdapter extends RecloudAdapter {
  result(nodeType, task) {
    validateNodePayload(nodeType, task.payload);
    return {
      success: true,
      dryRun: true,
      nodeType,
      idempotencyKey: task.idempotencyKey,
      mappingVersion: task.mappingVersion,
      mappedFields: Object.keys(task.payload).sort(),
    };
  }
  async syncReceipt(task) { return this.result("RECEIPT", task); }
  async syncInspectionCompleted(task) { return this.result("INSPECTION_COMPLETED", task); }
  async syncRepairCompleted(task) {
    const result = this.result("REPAIR_COMPLETED", task);
    return { ...result, formPlan: buildRecloudRepairFormPlan(task.payload) };
  }
  async syncReturnShipped(task) { return this.result("RETURN_SHIPPED", task); }
  async syncOrderCompleted(task) { return this.result("ORDER_COMPLETED", task); }
}

class RealRecloudAdapter extends RecloudAdapter {
  unavailable() {
    throw Object.assign(new Error("瑞云真实同步适配器尚未启用"), {
      code: "RECLOUD_SYNC_NOT_ENABLED",
      permanent: true,
    });
  }
  async syncReceipt() { return this.unavailable(); }
  async syncInspectionCompleted() { return this.unavailable(); }
  async syncRepairCompleted() { return this.unavailable(); }
  async syncReturnShipped() { return this.unavailable(); }
  async syncOrderCompleted() { return this.unavailable(); }
}

function createRecloudAdapter(env = process.env) {
  const dryRun = String(env.DRY_RUN || "true").toLowerCase() !== "false";
  const writeEnabled = String(env.RECLOUD_WRITE_ENABLED || "false").toLowerCase() === "true";
  return dryRun || !writeEnabled ? new DryRunRecloudAdapter() : new RealRecloudAdapter();
}

module.exports = { RecloudAdapter, DryRunRecloudAdapter, RealRecloudAdapter, createRecloudAdapter };
