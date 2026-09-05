const {
  buildRecloudReceiptFormPlan,
  buildRecloudInspectionFormPlan,
  buildRecloudRepairFormPlan,
  validateNodePayload,
} = require("./recloud-sync-mapping");

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
  async syncReceipt(task) {
    const result = this.result("RECEIPT", task);
    return { ...result, formPlan: buildRecloudReceiptFormPlan(task.payload) };
  }
  async syncInspectionCompleted(task) {
    const result = this.result("INSPECTION_COMPLETED", task);
    return { ...result, formPlan: buildRecloudInspectionFormPlan(task.payload) };
  }
  async syncRepairCompleted(task) {
    const result = this.result("REPAIR_COMPLETED", task);
    return { ...result, status: "READY_DRY_RUN", formPlan: buildRecloudRepairFormPlan(task.payload) };
  }
  async syncReturnShipped(task) { return this.result("RETURN_SHIPPED", task); }
  async syncOrderCompleted(task) { return this.result("ORDER_COMPLETED", task); }
}

class RealRecloudAdapter extends RecloudAdapter {
  constructor(options = {}) {
    super();
    this.readinessProvider = options.readinessProvider || null;
    this.commandExecutor = options.commandExecutor || null;
  }

  async assertReady(nodeKey) {
    if (this.commandExecutor?.isReady?.(nodeKey) === true) return { status: "READY", source: "LIVE_EXECUTOR" };
    const diagnostic = await this.readinessProvider?.inspect?.(nodeKey);
    if (!diagnostic || diagnostic.status !== "READY") {
      throw Object.assign(new Error("瑞云同步节点诊断尚未完成"), {
        code: "RECLOUD_SYNC_DIAGNOSTICS_NOT_READY",
        permanent: true,
        nodeKey,
        missingFields: diagnostic?.missingFields || ["syncDiagnostics"],
      });
    }
    return diagnostic;
  }

  async execute(nodeKey, method, task) {
    await this.assertReady(nodeKey);
    if (typeof this.commandExecutor?.[method] !== "function") {
      throw Object.assign(new Error("瑞云真实同步命令尚未接入"), {
        code: "RECLOUD_SYNC_COMMAND_NOT_IMPLEMENTED",
        permanent: true,
        nodeKey,
      });
    }
    return this.commandExecutor[method](task);
  }

  async syncReceipt(task) { return this.execute("receipt", "syncReceipt", task); }
  async syncInspectionCompleted(task) { return this.execute("inspection", "syncInspectionCompleted", task); }
  async syncRepairCompleted(task) { return this.execute("repair", "syncRepairCompleted", task); }
  async syncReturnShipped(task) { return this.execute("shipping", "syncReturnShipped", task); }
  async syncOrderCompleted(task) { return this.execute("completion", "syncOrderCompleted", task); }

}

function createRecloudAdapter(env = process.env, options = {}) {
  const dryRun = String(env.DRY_RUN || "true").toLowerCase() !== "false";
  const writeEnabled = String(env.RECLOUD_WRITE_ENABLED || "false").toLowerCase() === "true";
  const completionWriteEnabled = String(env.RECLOUD_COMPLETION_WRITE_ENABLED || "false").toLowerCase() === "true";
  if (!dryRun && writeEnabled) return new RealRecloudAdapter(options);
  if (completionWriteEnabled) {
    const dry = new DryRunRecloudAdapter();
    const real = new RealRecloudAdapter(options);
    dry.syncRepairCompleted = (task) => real.syncRepairCompleted(task);
    return dry;
  }
  return new DryRunRecloudAdapter();
}

module.exports = { RecloudAdapter, DryRunRecloudAdapter, RealRecloudAdapter, createRecloudAdapter };
