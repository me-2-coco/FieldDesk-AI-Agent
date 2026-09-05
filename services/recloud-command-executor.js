const { validateNodePayload } = require("../connectors/recloud-sync-mapping");
const { orchestrateRepairCompletion } = require("./recloud-repair-completion-orchestrator");

function commandError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  error.permanent = true;
  Object.assign(error, details);
  return error;
}

function createRecloudCommandExecutor(options = {}) {
  const repairAdapterProvider = options.repairAdapterProvider || null;
  const checkpointStore = options.checkpointStore || null;

  return {
    async syncRepairCompleted(task) {
      validateNodePayload("REPAIR_COMPLETED", task?.payload);
      if (!repairAdapterProvider || typeof repairAdapterProvider.open !== "function") {
        throw commandError(
          "瑞云维修完工页面执行器尚未装配",
          "RECLOUD_REPAIR_PAGE_ADAPTER_NOT_CONFIGURED",
          { nodeKey: "repair" }
        );
      }
      const adapter = await repairAdapterProvider.open(task);
      if (!adapter) {
        throw commandError(
          "无法打开瑞云维修完工页面执行器",
          "RECLOUD_REPAIR_PAGE_ADAPTER_UNAVAILABLE",
          { nodeKey: "repair" }
        );
      }
      try {
        return await orchestrateRepairCompletion(
          task.rmaNo || task.workOrderNo,
          task.payload,
          adapter,
          {
            writeEnabled: options.writeEnabled === true,
            checkpointStore,
            submitReadyTimeoutMs: options.submitReadyTimeoutMs,
            submitReadyPollIntervalMs: options.submitReadyPollIntervalMs,
            preparationCompleted: Boolean(task.payload?.repairPreparationCompletedAt),
          }
        );
      } finally {
        if (typeof repairAdapterProvider.release === "function") {
          await repairAdapterProvider.release(adapter, task);
        }
      }
    },
  };
}

module.exports = { commandError, createRecloudCommandExecutor };
